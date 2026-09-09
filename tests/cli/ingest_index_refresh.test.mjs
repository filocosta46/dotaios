import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// `dotaios index` builds _index.md from what is on disk, but for a long time
// nothing called it after a write. Every ingest left the table of contents one
// file further behind, silently, until someone re-ran the command by hand.

test("ingesting a text file refreshes _index.md so the new file is listed", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");

  run(["ingest", file, "--path", aiosPath]);

  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "note.md")), true);
  assert.match(indexOf(aiosPath), /raw\/note\.md/);
});

test("--no-index saves the file but leaves the index alone", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");

  run(["ingest", file, "--path", aiosPath, "--no-index"]);

  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "note.md")), true);
  assert.doesNotMatch(indexOf(aiosPath), /raw\/note\.md/);
});

test("a durable-shelf write refreshes the index once approved", () => {
  const { aiosPath, file } = setup("note.txt", "A lasting reference.");

  // Without --apply this is a preview: nothing written, nothing indexed.
  run(["ingest", file, "--path", aiosPath, "--to", "wiki"]);
  assert.doesNotMatch(indexOf(aiosPath), /wiki\/note/);

  run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--apply"]);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "wiki", "note", "_index.md")), true);
  assert.match(indexOf(aiosPath), /wiki\/note\/_index\.md/);
});

test("--dry-run writes nothing and touches no index", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");

  run(["ingest", file, "--path", aiosPath, "--dry-run"]);

  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "note.md")), false);
  assert.doesNotMatch(indexOf(aiosPath), /raw\/note\.md/);
});

test("a skipped re-ingest does not rewrite the index", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");

  run(["ingest", file, "--path", aiosPath]);
  const indexPath = path.join(aiosPath, "_index.md");
  assert.equal(fs.existsSync(indexPath), true);

  // Delete it so a second refresh would be unmistakable.
  fs.rmSync(indexPath);
  const second = run(["ingest", file, "--path", aiosPath]);

  assert.match(second.stdout, /Already ingested/);
  assert.equal(fs.existsSync(indexPath), false);
});

test("a binary asset produces no markdown, so it does not refresh the index", () => {
  const { aiosPath, tempRoot } = setup("note.txt", "unused");
  const binary = path.join(tempRoot, "blob.bin");
  fs.writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

  const result = run(["ingest", binary, "--path", aiosPath]);

  assert.match(result.stdout, /No markdown was generated/);
  assert.doesNotMatch(indexOf(aiosPath), /blob/);
});

test("dotaios index still writes on its own and still honours --dry-run", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");
  run(["ingest", file, "--path", aiosPath, "--no-index"]);

  const dry = run(["index", "--path", aiosPath, "--dry-run"]);
  assert.match(dry.stdout, /dry run/);
  assert.match(dry.stdout, /raw\/note\.md/);
  assert.doesNotMatch(indexOf(aiosPath), /raw\/note\.md/);

  const written = run(["index", "--path", aiosPath]);
  assert.match(written.stdout, /markdown file\(s\) across/);
  assert.match(indexOf(aiosPath), /raw\/note\.md/);
});

// --- helpers ---

function setup(fileName, body) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-ingest-index-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  const file = path.join(tempRoot, fileName);
  fs.writeFileSync(file, body);
  return { aiosPath, tempRoot, file };
}

function indexOf(aiosPath) {
  const indexPath = path.join(aiosPath, "_index.md");
  return fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
