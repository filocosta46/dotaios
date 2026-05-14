import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SHELVES,
  isShelf,
  isDurableShelf,
  shelfNeedsName,
  shelfMarkdownPath
} from "../../packages/cli/src/ingest/placement.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("placement helpers describe the shelf set", () => {
  assert.deepEqual(SHELVES, ["raw", "wiki", "company", "person", "signal"]);
  assert.equal(isShelf("wiki"), true);
  assert.equal(isShelf("nope"), false);
  assert.equal(isDurableShelf("wiki"), true);
  assert.equal(isDurableShelf("company"), true);
  assert.equal(isDurableShelf("person"), true);
  assert.equal(isDurableShelf("raw"), false);
  assert.equal(isDurableShelf("signal"), false);
  assert.equal(shelfNeedsName("company"), true);
  assert.equal(shelfNeedsName("person"), true);
  assert.equal(shelfNeedsName("wiki"), false);
});

test("shelfMarkdownPath maps each markdown shelf to its file", () => {
  const vaultRoot = "/v";
  assert.equal(shelfMarkdownPath({ shelf: "wiki", vaultRoot, slug: "ai" }), "/v/wiki/ai/_index.md");
  assert.equal(shelfMarkdownPath({ shelf: "company", vaultRoot, slug: "acme" }), "/v/org/companies/acme.md");
  assert.equal(shelfMarkdownPath({ shelf: "person", vaultRoot, slug: "jane" }), "/v/org/people/jane.md");
});

test("ingest with no --to keeps the vault/raw default and points at --to", () => {
  const { aiosPath, file } = setup("note.txt", "A quick working note.");

  const result = run(["ingest", file, "--path", aiosPath]);

  assert.match(result.stdout, /vault\/raw/);
  assert.match(result.stdout, /--to wiki\|company\|person\|signal/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "raw", "note.md")), true);
});

test("ingest --to raw writes to vault/raw", () => {
  const { aiosPath, file } = setup("ref.txt", "Raw source body.");

  run(["ingest", file, "--path", aiosPath, "--to", "raw"]);

  assert.match(read(path.join(aiosPath, "vault", "raw", "ref.md")), /Raw source body/);
});

test("ingest --to with an unknown shelf fails", () => {
  const { aiosPath, file } = setup("x.txt", "body");
  const result = runFail(["ingest", file, "--path", aiosPath, "--to", "bogus"]);
  assert.match(result.stderr, /Unknown shelf/);
});

test("ingest --to wiki without --apply previews and writes nothing", () => {
  const { aiosPath, file } = setup("guide.txt", "A lasting reference.");

  const result = run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--name", "ai-research"]);

  assert.match(result.stdout, /\[preview\]/);
  assert.match(result.stdout, /--apply/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "wiki", "ai-research", "_index.md")), false);
});

test("ingest --to wiki --apply writes the durable knowledge shelf", () => {
  const { aiosPath, file } = setup("guide.txt", "A lasting reference.");

  run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--name", "ai-research", "--apply"]);

  const written = read(path.join(aiosPath, "vault", "wiki", "ai-research", "_index.md"));
  assert.match(written, /A lasting reference/);
});

test("ingest --to company requires --name when not interactive", () => {
  const { aiosPath, file } = setup("brief.txt", "Company brief.");
  const result = runFail(["ingest", file, "--path", aiosPath, "--to", "company"]);
  assert.match(result.stderr, /needs --name/);
});

test("ingest --to company --apply writes an org record and appends on repeat", () => {
  const { aiosPath, tempRoot } = setup("brief.txt", "First brief about Acme.");
  const fileA = path.join(tempRoot, "brief.txt");
  const fileB = path.join(tempRoot, "update.txt");
  fs.writeFileSync(fileB, "Second brief about Acme.");

  run(["ingest", fileA, "--path", aiosPath, "--to", "company", "--name", "acme", "--apply"]);
  const recordPath = path.join(aiosPath, "vault", "org", "companies", "acme.md");
  assert.match(read(recordPath), /First brief about Acme/);

  const second = run(["ingest", fileB, "--path", aiosPath, "--to", "company", "--name", "acme", "--apply"]);
  assert.match(second.stdout, /Appended/);
  const merged = read(recordPath);
  assert.match(merged, /First brief about Acme/);
  assert.match(merged, /Second brief about Acme/);
  assert.match(merged, /## Ingested \d{4}-\d{2}-\d{2}/);
});

test("ingest --to person --apply writes to vault/org/people", () => {
  const { aiosPath, file } = setup("bio.txt", "Notes on Jane Doe.");

  run(["ingest", file, "--path", aiosPath, "--to", "person", "--name", "jane-doe", "--apply"]);

  assert.match(read(path.join(aiosPath, "vault", "org", "people", "jane-doe.md")), /Notes on Jane Doe/);
});

test("ingest --to signal logs a working note in memory/signals", () => {
  const { aiosPath, file } = setup("call.txt", "Quick call note: follow up next week.");

  const result = run(["ingest", file, "--path", aiosPath, "--to", "signal"]);

  assert.match(result.stdout, /memory\/signals/);
  const today = new Date().toISOString().slice(0, 10);
  const signalFile = path.join(aiosPath, "memory", "signals", `${today}.jsonl`);
  assert.equal(fs.existsSync(signalFile), true);
  const entry = JSON.parse(read(signalFile).trim().split(/\r?\n/).pop());
  assert.equal(entry.type, "ingest-note");
  assert.match(entry.note, /follow up next week/);
});

test("ingest --dry-run --to wiki shows the shelf and target without writing", () => {
  const { aiosPath, file } = setup("plan.txt", "body");

  const result = run(["ingest", file, "--path", aiosPath, "--to", "wiki", "--name", "planning", "--dry-run"]);

  assert.match(result.stdout, /shelf:\s+wiki/);
  assert.match(result.stdout, /wiki\/planning\/_index\.md/);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault", "wiki", "planning", "_index.md")), false);
});

function setup(fileName, body) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-ingest-route-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  const file = path.join(tempRoot, fileName);
  fs.writeFileSync(file, body);
  return { aiosPath, tempRoot, file };
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status === 0) {
    throw new Error(`Command unexpectedly passed: dotaios ${args.join(" ")}\n${result.stdout}`);
  }
  return result;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}
