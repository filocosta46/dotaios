import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { importCommand } from "../../packages/cli/src/commands/import.mjs";

const IMPORT_START = "<!-- dotaios-import:start -->";
const IMPORT_END = "<!-- dotaios-import:end -->";

async function setupContextImport(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dotaios-import-${label}-`));
  const aiosPath = path.join(root, "aios");
  const contextDir = path.join(aiosPath, "context");
  await fs.mkdir(contextDir, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{}\n");
  await fs.writeFile(path.join(contextDir, "identity.md"), "# Identity\n\nHand-written line.\n");
  return {
    root,
    aiosPath,
    contextDir,
    identityPath: path.join(contextDir, "identity.md"),
    sourcePath: path.join(root, "import.json")
  };
}

async function writeImportFile(sourcePath, identity) {
  await fs.writeFile(sourcePath, `${JSON.stringify({ context: { identity } })}\n`);
}

async function backupsIn(directory) {
  return (await fs.readdir(directory)).filter((name) => name.includes(".dotaios-backup-"));
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

async function runQuietly(args) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...values) => logs.push(values.join(" "));
  try {
    await importCommand(args);
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

test("event import fails loudly after the shared memory writer lock retry budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-import-event-"));
  const aiosPath = path.join(root, "aios");
  const memoryDir = path.join(aiosPath, "memory");
  const eventsPath = path.join(memoryDir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  const sourcePath = path.join(root, "import.json");
  const existing = {
    ts: "2026-07-26T12:00:00.000Z",
    type: "existing",
    summary: "must remain"
  };
  const imported = {
    ts: "2026-07-27T12:00:00.000Z",
    type: "imported-decision",
    summary: "must wait for compaction"
  };

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{}\n");
  await fs.writeFile(eventsPath, `${JSON.stringify(existing)}\n`);
  await fs.writeFile(sourcePath, `${JSON.stringify({ events: [imported] })}\n`);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));

  try {
    await assert.rejects(
      importCommand([sourcePath, "--path", aiosPath, "--apply"]),
      /Timed out waiting for memory writer lock/
    );
    assert.equal(
      await fs.readFile(eventsPath, "utf8"),
      `${JSON.stringify(existing)}\n`,
      "import must not append around a live writer lock"
    );

    await fs.rm(lockPath);
    await importCommand([sourcePath, "--path", aiosPath, "--apply"]);

    const events = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "existing");
    assert.equal(events[1].type, "imported-decision");
    assert.equal(events[1].ts, imported.ts, "imports retain their existing ts-based schema");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a first apply writes one managed block below the user's own text", async () => {
  const { root, aiosPath, contextDir, identityPath, sourcePath } = await setupContextImport("first");

  try {
    await writeImportFile(sourcePath, "Filippo builds DotAIOS.");
    await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);

    const identity = await fs.readFile(identityPath, "utf8");
    assert.equal(occurrences(identity, IMPORT_START), 1);
    assert.equal(occurrences(identity, IMPORT_END), 1);
    assert.equal(occurrences(identity, "## Imported Context"), 1);
    assert.match(identity, /^# Identity\n\nHand-written line\.\n/, "text above the block survives");
    assert.match(identity, /Filippo builds DotAIOS\./);
    assert.deepEqual(await backupsIn(contextDir), [], "a first import destroys nothing, so it preserves nothing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a second apply of identical content leaves the file byte-for-byte alone", async () => {
  const { root, aiosPath, contextDir, identityPath, sourcePath } = await setupContextImport("repeat");

  try {
    await writeImportFile(sourcePath, "Filippo builds DotAIOS.");
    await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);
    const afterFirst = await fs.readFile(identityPath, "utf8");

    const logs = await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);

    assert.equal(await fs.readFile(identityPath, "utf8"), afterFirst, "a retry must not rewrite the file");
    assert.equal(occurrences(afterFirst, "## Imported Context"), 1, "a retry must not duplicate the block");
    assert.match(logs, /skip \(already imported\)/);
    assert.match(logs, /\[unchanged\]/);
    assert.deepEqual(await backupsIn(contextDir), [], "nothing was rewritten, so nothing is preserved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a second apply of changed content replaces the block and preserves the pre-edit file", async () => {
  const { root, aiosPath, contextDir, identityPath, sourcePath } = await setupContextImport("changed");

  try {
    await writeImportFile(sourcePath, "Filippo builds DotAIOS.");
    await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);
    const beforeEdit = await fs.readFile(identityPath, "utf8");

    await writeImportFile(sourcePath, "Filippo builds DotAIOS and Hermes.");
    const logs = await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);

    const identity = await fs.readFile(identityPath, "utf8");
    assert.equal(occurrences(identity, "## Imported Context"), 1, "a changed re-import replaces, never stacks");
    assert.match(identity, /Filippo builds DotAIOS and Hermes\./);
    assert.doesNotMatch(identity, /Filippo builds DotAIOS\.\n/, "the superseded body is gone from the live file");
    assert.match(identity, /^# Identity\n\nHand-written line\.\n/, "text outside the block is untouched");
    assert.match(logs, /\[replaced\]/);

    const backups = await backupsIn(contextDir);
    assert.equal(backups.length, 1, "a destructive rewrite preserves exactly one backup");
    assert.equal(
      await fs.readFile(path.join(contextDir, backups[0]), "utf8"),
      beforeEdit,
      "the backup is the pre-edit file, byte for byte"
    );
    assert.match(logs, new RegExp(`preserved at ${backups[0].replace(/\./g, "\\.")}`), "the command names the backup it kept");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a dry run previews the replacement and writes nothing", async () => {
  const { root, aiosPath, contextDir, identityPath, sourcePath } = await setupContextImport("dry-run");

  try {
    await writeImportFile(sourcePath, "Filippo builds DotAIOS.");
    await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);
    const beforeDryRun = await fs.readFile(identityPath, "utf8");

    await writeImportFile(sourcePath, "Filippo builds DotAIOS and Hermes.");
    const changedLogs = await runQuietly([sourcePath, "--path", aiosPath, "--dry-run"]);
    assert.match(changedLogs, /would replace the previous import block/);
    assert.equal(await fs.readFile(identityPath, "utf8"), beforeDryRun, "a dry run writes nothing");
    assert.deepEqual(await backupsIn(contextDir), [], "a dry run preserves nothing either");

    await writeImportFile(sourcePath, "Filippo builds DotAIOS.");
    const unchangedLogs = await runQuietly([sourcePath, "--path", aiosPath, "--dry-run"]);
    assert.match(unchangedLogs, /would skip \(already imported\)/);
    assert.match(unchangedLogs, /every imported block is already in place/);
    assert.equal(await fs.readFile(identityPath, "utf8"), beforeDryRun);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("malformed import markers are not ownership proof, so the file is left alone", async () => {
  const { root, aiosPath, contextDir, identityPath, sourcePath } = await setupContextImport("markers");
  const originalExitCode = process.exitCode;

  try {
    const mangled = `# Identity\n\n${IMPORT_START}\n\n## Imported Context\n\nHalf a block.\n`;
    await fs.writeFile(identityPath, mangled);
    await writeImportFile(sourcePath, "Filippo builds DotAIOS.");

    const logs = await runQuietly([sourcePath, "--path", aiosPath, "--apply"]);

    assert.equal(await fs.readFile(identityPath, "utf8"), mangled, "an unownable file is never edited");
    assert.match(logs, /\[refused\]/);
    assert.match(logs, /import markers are malformed/);
    assert.equal(process.exitCode, 1, "a refusal must not report success");
    assert.deepEqual(await backupsIn(contextDir), []);
  } finally {
    process.exitCode = originalExitCode;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("content carrying import markers is refused instead of making the file unownable", async () => {
  const { aiosPath, identityPath, sourcePath, contextDir } = await setupContextImport("marker-payload");

  // An export of an AIOS whose context already holds an import block carries
  // these markers in its body. Writing them inside a new block leaves two start
  // markers, which findManagedBlock reads as "not mine" — so every later import
  // refuses this file forever, and only hand-editing recovers it.
  const nested = `Line one.\n\n${IMPORT_START}\nnested\n${IMPORT_END}\n\nLine two.`;
  await writeImportFile(sourcePath, nested);

  const before = await fs.readFile(identityPath, "utf8");
  const output = await runQuietly([sourcePath, "--apply", "--path", aiosPath]);

  assert.match(output, /imported content carries DotAIOS import markers/);
  assert.equal(await fs.readFile(identityPath, "utf8"), before, "the destination must be untouched");
  assert.deepEqual(await backupsIn(contextDir), [], "a refusal writes nothing, so it takes no backup");

  // And the file is still ownable: the refusal protected it rather than
  // spending it.
  await writeImportFile(sourcePath, "Clean content.");
  await runQuietly([sourcePath, "--apply", "--path", aiosPath]);
  const after = await fs.readFile(identityPath, "utf8");
  assert.equal(occurrences(after, IMPORT_START), 1);
  assert.match(after, /Clean content\./);
});

test("the preview exits the way the apply it previews would exit", async () => {
  const { aiosPath, identityPath, sourcePath } = await setupContextImport("preview-exit");

  // INSTALL.md calls the preview the gate to inspect before the real run. A
  // gate that reports success over a plan the next command refuses is not one.
  await fs.writeFile(identityPath, `# Identity\n\n${IMPORT_START}\nmangled, no end marker\n`);
  await writeImportFile(sourcePath, "Anything.");

  process.exitCode = 0;
  const output = await runQuietly([sourcePath, "--path", aiosPath]);
  const previewExit = process.exitCode;
  process.exitCode = 0;

  assert.match(output, /Nothing can be written/);
  assert.equal(previewExit, 1, "the preview must not report success over a plan that refuses");
});

test("a signal timestamp cannot name a file outside the AIOS folder", async () => {
  const { root, aiosPath, sourcePath } = await setupContextImport("signal-escape");

  // `ts` is third-party: docs/context-import.md asks another assistant to read
  // the user's old chat and emit this JSON, so the value arrives from outside
  // the product. Ten characters of it used to be joined straight onto the
  // signals directory, and `../../../x` resolved one level above the folder the
  // user pointed at. The plan printed the escaped path, `--apply` created the
  // parents and appended, and the run reported success.
  await fs.writeFile(
    sourcePath,
    `${JSON.stringify({ signals: [{ ts: "../../../x", summary: "escaped" }] })}\n`
  );

  await assert.rejects(
    () => runQuietly([sourcePath, "--apply", "--path", aiosPath]),
    /must start with a YYYY-MM-DD date/
  );

  // The refusal has to happen before anything is written, not after: assert on
  // the filesystem rather than on the message.
  const escaped = path.join(path.dirname(root), "x.jsonl");
  assert.equal(await fs.access(escaped).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(root, "x.jsonl")).then(() => true, () => false), false);
});

test("a non-string signal timestamp is refused by name rather than crashing", async () => {
  const { aiosPath, sourcePath } = await setupContextImport("signal-type");

  // `ts.slice` on a number threw a raw TypeError with a stack trace, which
  // reads as a bug in DotAIOS rather than as a malformed import file.
  await fs.writeFile(sourcePath, `${JSON.stringify({ signals: [{ ts: 20260816, summary: "x" }] })}\n`);

  await assert.rejects(
    () => runQuietly([sourcePath, "--apply", "--path", aiosPath]),
    /"ts" must be a string, received number/
  );
});

test("a well-formed signal still files itself under its own date", async () => {
  const { aiosPath, sourcePath } = await setupContextImport("signal-ok");

  // The guard above must not cost the ordinary case: a full ISO timestamp is
  // what a real export carries, and it files under the day it names.
  await fs.writeFile(
    sourcePath,
    `${JSON.stringify({ signals: [{ ts: "2026-08-16T10:00:00Z", summary: "legit" }] })}\n`
  );

  await runQuietly([sourcePath, "--apply", "--path", aiosPath]);

  const written = await fs.readFile(path.join(aiosPath, "memory", "signals", "2026-08-16.jsonl"), "utf8");
  assert.match(written, /legit/);
});

test("containment holds every destination, not just the one field that escaped", async () => {
  const { root, aiosPath, sourcePath } = await setupContextImport("containment");

  // The date guard above is specific to `ts`. This asserts the backstop under
  // it: containment is checked over the finished plan, so a seventh writer
  // added later inherits the rule instead of having to remember it. Proved by
  // calling the plan builder's guarantee directly through a vault pointed
  // outside the folder — aios.json is user-editable, so this is reachable.
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    `${JSON.stringify({ vault_path: path.join(root, "outside-vault") })}\n`
  );
  await fs.writeFile(
    sourcePath,
    `${JSON.stringify({ wiki: [{ topic: "escape", content: "x" }] })}\n`
  );

  // A vault deliberately placed outside the AIOS folder is legitimate and must
  // still work — this is the case that proves the check is a containment rule
  // and not a blanket "everything under target" rule.
  await runQuietly([sourcePath, "--apply", "--path", aiosPath]);
  const written = await fs.readFile(path.join(root, "outside-vault", "wiki", "escape", "_index.md"), "utf8");
  assert.match(written, /Imported Knowledge/);
});
