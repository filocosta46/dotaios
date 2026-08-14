import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" }
  });
}

test("search Off prints the fixed receipt without opening or creating an AIOS folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-search-off-"));
  const absentAios = path.join(root, "must-stay-absent");
  try {
    const result = run([
      "search", "anything",
      "--memory", "off",
      "--project", "not-a-real-project",
      "--path", absentAios
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Memory: Off$/m);
    assert.match(result.stdout, /AI app may still keep its own conversation history/i);
    assert.match(result.stdout, /No results found\./);
    assert.equal(fs.existsSync(absentAios), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update Off skips path checks, project lookup, prompting, and writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-update-off-"));
  const absentAios = path.join(root, "must-stay-absent");
  try {
    const result = run([
      "update",
      "--memory", "off",
      "--project", "not-a-real-project",
      "--path", absentAios
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Memory: Off$/m);
    assert.match(result.stdout, /did not read, search, save, or capture this turn/i);
    assert.doesNotMatch(result.stdout, /Saved\./);
    assert.equal(fs.existsSync(absentAios), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("search and update reject contradictory Shared plus project inputs before AIOS access", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-memory-conflict-"));
  const absentAios = path.join(root, "must-stay-absent");
  try {
    for (const args of [
      ["search", "anything", "--memory", "shared", "--project", "alpha", "--path", absentAios],
      ["update", "anything", "--memory", "shared", "--project", "alpha", "--path", absentAios]
    ]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Cannot combine shared memory with a project selector/i);
      assert.equal(fs.existsSync(absentAios), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project search explains when a requested global scope is forbidden", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-search-project-omission-"));
  const aiosPath = path.join(root, "aios");
  try {
    const initialized = run(["init", "--path", aiosPath, "--yes"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const readme = path.join(aiosPath, "projects", "alpha", "README.md");
    fs.mkdirSync(path.dirname(readme), { recursive: true });
    fs.writeFileSync(readme, "---\nid: project-alpha-001\nproject: alpha\n---\n# Alpha\n");

    const result = run([
      "search", "anything",
      "--memory", "project",
      "--project", "project-alpha-001",
      "--scope", "vault",
      "--path", aiosPath
    ]);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /No results found in inspected sources.*Search incomplete.*vault/is);
    assert.match(result.stderr, /Search incomplete for vault.*choose Shared memory.*scope_forbidden_by_memory_policy/is);
    assert.doesNotMatch(result.stderr, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project update prints its receipt and attributes both save representations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-update-project-"));
  const aiosPath = path.join(root, "aios");
  try {
    const initialized = run(["init", "--path", aiosPath, "--yes"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const readme = path.join(aiosPath, "projects", "alpha", "README.md");
    fs.mkdirSync(path.dirname(readme), { recursive: true });
    fs.writeFileSync(readme, "---\nid: project-alpha-001\nproject: alpha\nstatus: active\n---\n# Alpha\n");

    const result = run([
      "update", "PROJECT_UPDATE_POLICY_CANARY",
      "--project", "project-alpha-001",
      "--path", aiosPath
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Memory: This project$/m);
    assert.match(result.stdout, /Saved\./);

    const event = JSON.parse(fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8").trim());
    const signalFile = fs.readdirSync(path.join(aiosPath, "memory", "signals")).find((file) => file.endsWith(".jsonl"));
    const signal = JSON.parse(fs.readFileSync(path.join(aiosPath, "memory", "signals", signalFile), "utf8").trim());
    assert.equal(event.project, "alpha");
    assert.equal(event.project_id, "project-alpha-001");
    assert.equal(signal.project, "alpha");
    assert.equal(signal.project_id, "project-alpha-001");
    assert.equal(signal.record_id, event.record_id, "one save keeps one operation id across representations");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Shared updates stay unscoped and separate identical saves remain distinct", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-update-shared-"));
  const aiosPath = path.join(root, "aios");
  try {
    const initialized = run(["init", "--path", aiosPath, "--yes"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const first = run(["update", "SHARED_SAVE_POLICY_CANARY", "--path", aiosPath]);
    const second = run(["update", "SHARED_SAVE_POLICY_CANARY", "--path", aiosPath]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /^Memory: Shared$/m);

    const events = fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.notEqual(events[0].record_id, events[1].record_id);
    assert.equal("project" in events[0], false);
    assert.equal("project_id" in events[0], false);

    const found = run([
      "search", "SHARED_SAVE_POLICY_CANARY",
      "--scope", "memory",
      "--memory", "shared",
      "--path", aiosPath
    ]);
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.stdout, /^Memory: Shared$/m);
    assert.match(found.stdout, /2 result\(s\) found\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
