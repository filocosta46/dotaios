import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildDailyBrief } from "../../packages/cli/src/commands/brief.mjs";
import { isoDate } from "../../packages/core/src/memory.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-brief-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

function today() {
  return isoDate(new Date());
}

function yesterday() {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return isoDate(date);
}

test("compact brief never injects owned skill bodies", () => {
  const { aiosPath } = setupAios();
  const canary = "FULL_SKILL_BODY_MUST_STAY_LAZY_94A7";
  fs.appendFileSync(
    path.join(aiosPath, "skills", "plan-today", "SKILL.md"),
    `\n## Lazy-only instructions\n\n${canary}\n${"body ".repeat(20_000)}\n`
  );

  const result = run(["brief", "--compact", "--budget", "6000", "--path", aiosPath]);
  assert.match(result.stdout, /^Memory: Shared\b/);
  assert.doesNotMatch(result.stdout, new RegExp(canary));
  assert.ok(result.stdout.length <= 6000);
});

test("compact Off returns the fixed text and hook envelope without opening or creating an AIOS folder", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-brief-off-"));
  const missingAios = path.join(tempRoot, "must-not-exist");
  try {
    const plain = run(["brief", "--compact", "--memory", "off", "--path", missingAios]);
    const hook = JSON.parse(run([
      "brief", "--compact", "--memory", "off", "--json", "--path", missingAios,
    ]).stdout);
    const expected = "Memory: Off\n\nDotAIOS is off; your AI app may still keep its own conversation history. DotAIOS did not read, search, save, or capture this turn.";

    assert.equal(plain.stdout.trimEnd(), expected);
    assert.equal(hook.hookSpecificOutput.additionalContext, expected);
    assert.equal(fs.existsSync(missingAios), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("explicit compact Off stays closed when a host also forwards Use my memory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-brief-explicit-off-"));
  const missing = path.join(root, "must-stay-missing");
  try {
    const result = run(["brief", "--compact", "--memory", "off", "--first-message", "Use my memory", "--path", missing]);
    assert.match(result.stdout, /^Memory: Off\b/);
    assert.equal(fs.existsSync(missing), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Off never writes the daily brief", () => {
  const { aiosPath } = setupAios();
  const result = run(["brief", "--memory", "off", "--path", aiosPath]);
  assert.match(result.stdout, /^Memory: Off\b/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "daily", `${today()}.md`)), false);
});

test("lean brief discloses that it uses Shared memory", () => {
  const { aiosPath } = setupAios();
  const result = run(["brief", "--lean", "--path", aiosPath]);
  assert.match(result.stdout, /^Memory: Shared\b/);
});

test("brief writes a ## Brief section into today's daily note", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), [
    "# Priorities",
    "",
    "## Current Bets",
    "",
    "- Ship Output Loop v1",
    "- Keep the ICP path simple",
    ""
  ].join("\n"));
  fs.appendFileSync(path.join(aiosPath, "memory", "events.jsonl"), `${JSON.stringify({
    ts: new Date().toISOString(),
    type: "test",
    summary: "Follow up on the output loop blocker",
    source: "test"
  })}\n`);

  const result = run(["brief", "--path", aiosPath]);

  const note = fs.readFileSync(path.join(aiosPath, "memory", "daily", `${today()}.md`), "utf8");
  assert.match(result.stdout, /Memory: Shared/);
  assert.match(note, /Memory: Shared/);
  assert.match(note, /## Brief/);
  assert.match(note, /Ship Output Loop v1/);
  assert.match(note, /Follow up on the output loop blocker/);
  assert.match(note, /## Focus/);
  assert.match(note, /## Plan/);
  assert.match(note, /## Close/);
});

test("standard brief uses the canonical bounded timeline selection", async () => {
  const { aiosPath } = setupAios();
  const now = new Date(2026, 6, 15, 18, 0, 0);
  const date = isoDate(now);
  const staleDate = new Date(now.getTime());
  staleDate.setDate(staleDate.getDate() - 2);
  const events = [
    {
      ts: `${isoDate(staleDate)}T08:00:00.000Z`,
      summary: "TODO stale event must not reach the standard brief"
    },
    {
      ts: `${date}T09:00:00.000Z`,
      summary: "TODO ninth event must stay outside the canonical cap"
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      ts: `${date}T${String(index + 10).padStart(2, "0")}:00:00.000Z`,
      summary: `Routine observation ${index + 1}`
    }))
  ];
  fs.writeFileSync(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
  fs.writeFileSync(
    path.join(aiosPath, "memory", "signals", `mini-${date}.jsonl`),
    `${JSON.stringify({
      ts: `${date}T18:00:00.000Z`,
      summary: "Follow up from the selected signal"
    })}\n`
  );

  const brief = await buildDailyBrief(aiosPath, date, now);

  assert.match(brief, /Follow up from the selected signal/);
  assert.doesNotMatch(brief, /ninth event|stale event/);
});

test("brief replaces only the ## Brief section in an existing daily note", () => {
  const { aiosPath } = setupAios();
  const dailyDir = path.join(aiosPath, "memory", "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, `${today()}.md`), [
    "---",
    `date: ${today()}`,
    "source: test",
    "---",
    "",
    `# ${today()}`,
    "",
    "## Brief",
    "",
    "Old brief",
    "",
    "## Focus",
    "Keep this focus.",
    "",
    "## Plan",
    "Keep this plan.",
    "",
    "## Close",
    "Keep this close.",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), "# Priorities\n\n## Current Bets\n\n- New priority\n");

  run(["brief", "--path", aiosPath]);

  const note = fs.readFileSync(path.join(dailyDir, `${today()}.md`), "utf8");
  assert.doesNotMatch(note, /Old brief/);
  assert.match(note, /New priority/);
  assert.match(note, /Keep this focus/);
  assert.match(note, /Keep this plan/);
  assert.match(note, /Keep this close/);
});

test("brief carries over yesterday's closeout items", () => {
  const { aiosPath } = setupAios();
  const dailyDir = path.join(aiosPath, "memory", "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, `${yesterday()}.md`), [
    `# ${yesterday()}`,
    "",
    "## Close",
    "",
    "### Done",
    "Something finished",
    "",
    "### Carry-over",
    "- Send the beta note",
    "",
    "### Reflection",
    "Ship earlier",
    ""
  ].join("\n"));

  run(["brief", "--path", aiosPath]);

  const note = fs.readFileSync(path.join(dailyDir, `${today()}.md`), "utf8");
  assert.match(note, /Send the beta note/);
});

test("brief --dry-run does not write today's note", () => {
  const { aiosPath } = setupAios();
  const result = run(["brief", "--path", aiosPath, "--dry-run"]);

  assert.match(result.stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "daily", `${today()}.md`)), false);
});

test("compact brief rejects a supplied blank project selector", () => {
  const { aiosPath, tempRoot } = setupAios();
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "brief", "--compact", "--project", "   ", "--path", aiosPath],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /project filter must not be blank/i);
    assert.doesNotMatch(result.stdout, /## Active Context/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compact CLI documents and enforces the shared project selector contract", () => {
  const { aiosPath, tempRoot } = setupAios();
  try {
    const help = run(["brief", "--help"]);
    assert.match(help.stdout, /nonblank.*no control characters.*200 Unicode code points/is);
    assert.match(help.stdout, /--memory <mode>.*shared, project, or off/is);
    assert.match(help.stdout, /off may be used alone.*no DotAIOS write/is);
    assert.match(help.stdout, /--cwd <dir>.*With --compact.*with or without.*--first-message/is);

    const projectDir = path.join(aiosPath, "projects", "client-work");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "README.md"),
      "---\nid: café:client/01\nproject: client-work\nstatus: active\n---\n# Client Work\n"
    );
    const accepted = run([
      "brief", "--compact", "--project", "café:client/01", "--path", aiosPath
    ]);
    assert.match(accepted.stdout, /^Memory: This project\b/);
    assert.match(accepted.stdout, /Client Work/);
    const explicitProject = run([
      "brief", "--compact", "--memory", "project", "--project", "café:client/01", "--path", aiosPath,
    ]);
    const explicitShared = run([
      "brief", "--compact", "--memory", "shared", "--path", aiosPath,
    ]);
    assert.match(explicitProject.stdout, /^Memory: This project\b/);
    assert.match(explicitShared.stdout, /^Memory: Shared\b/);

    for (const project of ["🚀".repeat(201), "bad\u0007id"]) {
      const rejected = spawnSync(
        process.execPath,
        [cli, "brief", "--compact", "--project", project, "--path", aiosPath],
        { cwd: repoRoot, encoding: "utf8" }
      );
      assert.notEqual(rejected.status, 0);
      assert.doesNotMatch(rejected.stdout, /## Active Context/);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compact CLI and hook reads fail safely on oversized source input", () => {
  const { aiosPath, tempRoot } = setupAios();
  try {
    const identityPath = path.join(aiosPath, "context", "identity.md");
    fs.writeFileSync(identityPath, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const before = snapshotTree(aiosPath);

    for (const extra of [[], ["--json"]]) {
      const result = spawnSync(
        process.execPath,
        [cli, "brief", "--compact", ...extra, "--path", aiosPath],
        { cwd: repoRoot, encoding: "utf8" }
      );
      assert.notEqual(result.status, 0);
      assert.equal(result.stderr.trim(), "DotAIOS could not read working context safely.");
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.deepEqual(snapshotTree(aiosPath), before);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("init ships the daily brief schedule disabled by default", () => {
  const { aiosPath } = setupAios();
  const schedules = fs.readFileSync(path.join(aiosPath, "schedules.yml"), "utf8");

  assert.match(schedules, /name: daily-brief/);
  assert.match(schedules, /cadence: daily/);
  // A scheduled command is executed, so it carries the invocation resolved at
  // init time: the bare name when a real binary exists, the version-pinned npx
  // form otherwise. Either spelling is correct; a bare name on a machine
  // without the binary is the bug this shape prevents.
  assert.match(schedules, /command: "(?:npx )?dotaios(?:@[\w.-]+)? brief"/);
  assert.match(schedules, /enabled: false/);

  const list = run(["schedule", "list", "--path", aiosPath]);
  assert.match(list.stdout, /daily-brief/);
  assert.match(list.stdout, /dotaios(?:@[\w.-]+)? brief/);
});

test("compact text and Gemini hook JSON expose the same stale-schema action without changing the digest budget", () => {
  const { aiosPath, tempRoot } = setupAios();
  try {
    const currentJson = JSON.parse(run(["brief", "--compact", "--json", "--budget", "512", "--path", aiosPath]).stdout);
    const configPath = path.join(aiosPath, "aios.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.schema_version = "1.1.0";
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const plain = run(["brief", "--compact", "--budget", "512", "--path", aiosPath]).stdout;
    const hook = JSON.parse(run(["brief", "--compact", "--json", "--budget", "512", "--path", aiosPath]).stdout);

    assert.match(plain, /\[DotAIOS\].*schema 1\.1\.0.*1\.2\.0.*dotaios migrate/s);
    assert.match(hook.hookSpecificOutput.additionalContext, /\[DotAIOS\].*schema 1\.1\.0.*1\.2\.0.*dotaios migrate/s);
    assert.match(plain, /dotaios migrate --path <this-aios-folder>/);
    assert.match(hook.hookSpecificOutput.additionalContext, /dotaios migrate --path <this-aios-folder>/);
    assert.doesNotMatch(`${plain}\n${JSON.stringify(hook)}`, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(hook.contextBudget, currentJson.contextBudget);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compact output surfaces transaction and failed inspection state but stays silent when current", () => {
  const { aiosPath, tempRoot } = setupAios();
  try {
    const current = run(["brief", "--compact", "--path", aiosPath]).stdout;
    assert.doesNotMatch(current, /\[DotAIOS\]/);

    const migrationsRoot = path.join(aiosPath, ".dotaios", "migrations");
    const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
    fs.mkdirSync(path.join(migrationsRoot, "transactions", planId), { recursive: true });
    fs.writeFileSync(path.join(migrationsRoot, "owner.json"), `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`);
    const transaction = run(["brief", "--compact", "--path", aiosPath]).stdout;
    assert.match(transaction, /\[DotAIOS\].*transaction metadata.*liveness is not verified.*dotaios doctor/s);
    const transactionHook = JSON.parse(run(["brief", "--compact", "--json", "--path", aiosPath]).stdout);
    assert.match(transactionHook.hookSpecificOutput.additionalContext, /transaction metadata.*liveness is not verified.*dotaios doctor/s);
    assert.doesNotMatch(transactionHook.hookSpecificOutput.additionalContext, /migrate --recover/);

    fs.rmSync(path.join(aiosPath, ".dotaios"), { recursive: true, force: true });
    fs.writeFileSync(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"invalid\"}\n");
    const failed = run(["brief", "--compact", "--path", aiosPath]).stdout;
    assert.match(failed, /\[DotAIOS\].*could not be verified.*dotaios doctor/s);
    assert.match(failed, /## Active Context/);
    assert.doesNotMatch(failed, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const failedHook = JSON.parse(run(["brief", "--compact", "--json", "--path", aiosPath]).stdout);
    assert.match(failedHook.hookSpecificOutput.additionalContext, /could not be verified.*dotaios doctor/s);
    assert.doesNotMatch(JSON.stringify(failedHook), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("compact CLI text and hook JSON are byte-read-only in every migration state", () => {
  const fixtures = [
    ["current", () => {}],
    ["schema_outdated", (aiosPath) => {
      const configPath = path.join(aiosPath, "aios.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      config.schema_version = "1.1.0";
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }],
    ["transaction_present", (aiosPath) => {
      const migrationsRoot = path.join(aiosPath, ".dotaios", "migrations");
      const planId = "migrate-1_1_0-to-1_2_0-0123456789abcdef";
      fs.mkdirSync(path.join(migrationsRoot, "transactions", planId), { recursive: true });
      fs.writeFileSync(
        path.join(migrationsRoot, "owner.json"),
        `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`
      );
    }],
    ["inspection_failed", (aiosPath) => {
      fs.writeFileSync(path.join(aiosPath, "aios.json"), '{"schema_version":"invalid"}\n');
    }],
    ["corrupt_signal", (aiosPath) => {
      const signalPath = path.join(aiosPath, "memory", "signals", `${today()}.jsonl`);
      fs.mkdirSync(path.dirname(signalPath), { recursive: true });
      fs.writeFileSync(signalPath, "{not-json}\n");
    }]
  ];

  for (const [name, arrange] of fixtures) {
    const { aiosPath, tempRoot } = setupAios();
    try {
      arrange(aiosPath);
      const before = snapshotTree(aiosPath);
      run(["brief", "--compact", "--path", aiosPath]);
      run(["brief", "--compact", "--json", "--path", aiosPath]);
      assert.deepEqual(snapshotTree(aiosPath), before, `${name} access mutated the AIOS tree`);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
});

function snapshotTree(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(root, entry.name);
    const mode = fs.lstatSync(absolute).mode & 0o777;
    if (entry.isDirectory()) {
      result.push([entry.name, "directory", mode]);
      for (const [nested, kind, nestedMode, bytes] of snapshotTree(absolute)) {
        result.push([path.posix.join(entry.name, nested), kind, nestedMode, bytes]);
      }
    } else {
      result.push([entry.name, "file", mode, fs.readFileSync(absolute).toString("base64")]);
    }
  }
  return result;
}
