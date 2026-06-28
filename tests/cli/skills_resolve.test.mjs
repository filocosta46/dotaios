import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args, { allowNonZero = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (!allowNonZero && result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-resolve-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

test("skills resolve matches a trigger phrase and returns the right skill", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "plan my day", "--path", aiosPath]);
  assert.match(result.stdout, /plan-today/);
  assert.match(result.stdout, /skills\/plan-today\/SKILL\.md/);
});

test("skills resolve exits 2 when nothing matches", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "zzzzz qzzzz", "--path", aiosPath], { allowNonZero: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No skill matched/);
});

test("skills resolve --json returns the documented shape", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "plan my day", "--json", "--path", aiosPath]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.intent, "plan my day");
  assert.ok(Array.isArray(payload.matches));
  assert.ok(payload.matches.length > 0);
  const top = payload.matches[0];
  assert.equal(top.name, "plan-today");
  assert.equal(typeof top.score, "number");
  assert.equal(typeof top.skillPath, "string");
  assert.ok(Array.isArray(top.triggers));
});

test("skills resolve --json with no match returns an empty matches array and exit 2", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "zzzzz qzzzz", "--json", "--path", aiosPath], { allowNonZero: true });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.matches, []);
});

test("skills resolve --all prints more than one ranked match for a broad intent", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "research", "--all", "--path", aiosPath]);
  assert.match(result.stdout, /research/);
});

test("skills resolve --full prints the SKILL.md body", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "plan my day", "--full", "--path", aiosPath]);
  assert.match(result.stdout, /^# plan-today/m);
});

test("skills resolve --boot-context prints a Skills first block", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "--boot-context", "--path", aiosPath]);
  assert.match(result.stdout, /## Skills first/);
  assert.match(result.stdout, /plan-today/);
  assert.match(result.stdout, /open that skill's SKILL\.md/i);
});

test("skills resolve with no intent and no --boot-context exits 2", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "resolve", "--path", aiosPath], { allowNonZero: true });
  assert.equal(result.status, 2);
});

test("skills <name> still works after the resolve subcommand was added", () => {
  const { aiosPath } = setupAios();
  const result = run(["skills", "plan-today", "--path", aiosPath]);
  assert.match(result.stdout, /^# plan-today/m);
});
