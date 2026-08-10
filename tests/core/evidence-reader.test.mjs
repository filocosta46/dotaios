import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-evidence-reader-"));
}

test("evidence reader lists one directory deterministically without traversing it", async () => {
  const root = tmpDir();
  const dir = path.join(root, "skills");
  fs.mkdirSync(path.join(dir, "zeta"), { recursive: true });
  fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });

  const reader = createEvidenceReader({ roots: [root] });
  const entries = await reader.listDirectory(root, dir);

  assert.deepEqual(entries.map((entry) => entry.name), ["alpha", "zeta"]);
  assert.deepEqual(reader.snapshot(), { bytes: 0, files: 0, entries: 2 });
});

test("evidence frontmatter reads reserve declared bytes but return only metadata", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "SKILL.md");
  fs.writeFileSync(filePath, `---\nname: bounded\ndescription: Prefix only.\n---\n${"body ".repeat(30_000)}`);

  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 256 * 1024, maxFiles: 1, maxEntries: 1, maxFileBytes: 256 * 1024 }
  });
  const prefix = await reader.readFrontmatter(root, filePath, { maxBytes: 4096 });

  assert.ok(Buffer.byteLength(prefix, "utf8") < 100);
  assert.match(prefix, /name: bounded/);
  assert.deepEqual(reader.snapshot(), { bytes: fs.statSync(filePath).size, files: 1, entries: 0 });
});

test("evidence frontmatter rejects a delimiter beyond the bounded prefix", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "SKILL.md");
  const original = `---\nname: bounded\ndescription: ${"x".repeat(70 * 1024)}\n---\n`;
  fs.writeFileSync(filePath, original);
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 128 * 1024, maxFiles: 1, maxEntries: 1, maxFileBytes: 128 * 1024 }
  });

  await assert.rejects(
    () => reader.readFrontmatter(root, filePath, { maxBytes: 64 * 1024 }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_FRONTMATTER_INVALID"
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});

test("evidence reader enforces one aggregate byte budget across sources", async () => {
  const root = tmpDir();
  const first = path.join(root, "first.md");
  const second = path.join(root, "second.md");
  fs.writeFileSync(first, "first\n");
  fs.writeFileSync(second, "other\n");
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 10, maxFiles: 2, maxEntries: 2, maxFileBytes: 10 }
  });

  assert.equal(await reader.readText(root, first), "first\n");
  await assert.rejects(
    () => reader.readText(root, second),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("evidence reader enforces one aggregate directory-entry budget", async () => {
  const root = tmpDir();
  for (const name of ["alpha", "beta", "gamma"]) fs.writeFileSync(path.join(root, name), name);
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 100, maxFiles: 3, maxEntries: 2, maxDirectoryEntries: 10 }
  });

  await assert.rejects(
    () => reader.listDirectory(root, root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("evidence reader charges every JSONL record to the aggregate entry budget", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "events.jsonl");
  fs.writeFileSync(filePath, '{"id":1}\n{not-json}\n{"id":2}\n');
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 100, maxFiles: 1, maxEntries: 2, maxFileBytes: 100 }
  });

  await assert.rejects(
    () => reader.readJsonl(root, filePath),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("evidence reader rejects an atomic source replacement before reading bytes", async () => {
  const root = tmpDir();
  const source = path.join(root, "source.md");
  const parked = path.join(root, "source.parked.md");
  const original = "# Original\n\nINSIDE_CANARY\n";
  fs.writeFileSync(source, original);
  let replaced = false;
  const filesystem = new Proxy(fsp, {
    get(target, property) {
      if (property === "open") {
        return async (candidate, flags) => {
          if (candidate !== source || replaced) return fsp.open(candidate, flags);
          replaced = true;
          await fsp.rename(source, parked);
          await fsp.writeFile(source, "# Replacement\n\nOUTSIDE_CANARY\n");
          return fsp.open(source, flags);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const reader = createEvidenceReader({ roots: [root], filesystem });

  try {
    await assert.rejects(
      () => reader.readText(root, source),
      (error) => replaced && error?.code === "DOTAIOS_EVIDENCE_CHANGED"
    );
  } finally {
    fs.rmSync(source, { force: true });
    fs.renameSync(parked, source);
  }
  assert.equal(fs.readFileSync(source, "utf8"), original);
});

test("evidence reader rejects a real directory replacement after enumeration", async () => {
  const root = tmpDir();
  const corpus = path.join(root, "context");
  const parked = path.join(root, "context-parked");
  const source = path.join(corpus, "note.md");
  fs.mkdirSync(corpus);
  fs.writeFileSync(source, "# Original\n\nINSIDE_CANARY\n");
  const reader = createEvidenceReader({ roots: [root] });
  const [listed] = await reader.listFiles(root, corpus, { extensions: [".md"] });

  fs.renameSync(corpus, parked);
  fs.mkdirSync(corpus);
  fs.writeFileSync(source, "# Replacement\n\nREPLACEMENT_CANARY\n");

  await assert.rejects(
    () => reader.readText(root, listed),
    (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  );
});
