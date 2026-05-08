import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("search finds keyword across context and vault", () => {
  const { aiosPath } = setupAios();

  // Write searchable content
  fs.writeFileSync(
    path.join(aiosPath, "context", "work.md"),
    "# Work\n\n## Current Work\n\nBuilding the DotAIOS memory system for thesis research.\n"
  );
  fs.mkdirSync(path.join(aiosPath, "vault", "wiki", "ai-agents"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "vault", "wiki", "ai-agents", "_index.md"),
    "# AI Agents\n\nAgents use local context to make better decisions.\n"
  );

  // Ingest a file so there's a memory event
  run(["ingest", path.join(repoRoot, "README.md"), "--path", aiosPath]);

  // Search for "agent" — should find context + vault + memory
  const result = run(["search", "agent", "--path", aiosPath]);
  assert.match(result.stdout, /context\//);
  assert.match(result.stdout, /vault\//);
  assert.match(result.stdout, /result\(s\) found/);

  // Search with scope filter
  const vaultOnly = run(["search", "agent", "--scope", "vault", "--path", aiosPath]);
  assert.match(vaultOnly.stdout, /vault\//);
  assert.doesNotMatch(vaultOnly.stdout, /── context\//);

  // Search for something that doesn't exist
  const noResults = run(["search", "xyznonexistent123", "--path", aiosPath]);
  assert.match(noResults.stdout, /No results found/);
});

test("cleanup compacts events and trims old signals", () => {
  const { aiosPath } = setupAios();

  // Create 60 events (more than the limit of 50)
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  const events = [];
  for (let i = 0; i < 60; i++) {
    events.push(JSON.stringify({ ts: `2026-05-0${Math.floor(i / 10) + 1}T12:00:00Z`, type: "test", summary: `event ${i}` }));
  }
  fs.writeFileSync(eventsPath, events.join("\n") + "\n");

  // Create an old signal file (40 days ago) and a recent one
  const signalsDir = path.join(aiosPath, "memory", "signals");
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(signalsDir, `${oldDate}.jsonl`),
    JSON.stringify({ ts: `${oldDate}T12:00:00Z`, type: "old-signal" }) + "\n"
  );
  fs.writeFileSync(
    path.join(signalsDir, `${todayDate}.jsonl`),
    JSON.stringify({ ts: `${todayDate}T12:00:00Z`, type: "fresh-signal" }) + "\n"
  );

  // Dry run first — nothing should change
  const dryResult = run(["cleanup", "--dry-run", "--path", aiosPath]);
  assert.match(dryResult.stdout, /dry run/i);
  assert.match(dryResult.stdout, /Would archive 10 events/);
  assert.match(dryResult.stdout, /Would remove 1 signal/);
  // Verify files untouched
  const eventsBefore = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  assert.equal(eventsBefore.length, 60);

  // Real cleanup
  const realResult = run(["cleanup", "--path", aiosPath]);
  assert.match(realResult.stdout, /Archived 10 entries, kept 50/);
  assert.match(realResult.stdout, /Removed 1 file/);

  // Verify events compacted
  const eventsAfter = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  assert.equal(eventsAfter.length, 50);

  // Verify archive created
  const archivePath = path.join(aiosPath, "memory", "events-archive.jsonl");
  const archived = fs.readFileSync(archivePath, "utf8").split("\n").filter(Boolean);
  assert.equal(archived.length, 10);

  // Verify old signal deleted, fresh signal kept
  assert.equal(fs.existsSync(path.join(signalsDir, `${oldDate}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(signalsDir, `${todayDate}.jsonl`)), true);
});

test("cleanup handles empty memory gracefully", () => {
  const { aiosPath } = setupAios();
  const result = run(["cleanup", "--path", aiosPath]);
  assert.match(result.stdout, /nothing to compact/i);
  assert.match(result.stdout, /nothing to trim/i);
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v12-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  fs.mkdirSync(path.join(tempRoot, "project"), { recursive: true });
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

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
