import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-memory-audit-"));
  const aiosPath = path.join(tempRoot, "aios");
  fs.mkdirSync(path.join(aiosPath, "memory"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "skills", "closeday"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), "{}\n");
  fs.writeFileSync(path.join(aiosPath, "AGENTS.md"), "Read context first.\n");
  fs.writeFileSync(path.join(aiosPath, "skills", "closeday", "SKILL.md"), "# closeday\n\nClose the day.\n");
  fs.writeFileSync(path.join(aiosPath, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    skill: "closeday",
    memory_decision: "skill-patch",
    summary: "The closeday skill should ask for carry-over before writing the final note."
  })}\n`);
  return { aiosPath };
}

test("memory audit prints a deterministic memory review", () => {
  const { aiosPath } = setupAios();

  const result = run(["memory", "audit", "--path", aiosPath]);

  assert.match(result.stdout, /DotAIOS memory audit/);
  assert.match(result.stdout, /Skill patch candidates: 1/);
  assert.match(result.stdout, /closeday/);
});

test("memory audit does not write a queue unless explicitly requested", () => {
  const { aiosPath } = setupAios();

  run(["memory", "audit", "--path", aiosPath]);

  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "skill-patches", "queue.md")), false);
});

test("memory audit --write-queue writes memory skill patch queue", () => {
  const { aiosPath } = setupAios();

  const result = run(["memory", "audit", "--path", aiosPath, "--write-queue"]);
  const queuePath = path.join(aiosPath, "memory", "skill-patches", "queue.md");
  const queue = fs.readFileSync(queuePath, "utf8");

  assert.match(result.stdout, /Wrote 1 candidate/);
  assert.match(queue, /# Skill Patch Queue/);
  assert.match(queue, /closeday/);
});

test("memory audit --write-queue is idempotent for existing candidates", () => {
  const { aiosPath } = setupAios();

  run(["memory", "audit", "--path", aiosPath, "--write-queue"]);
  const queuePath = path.join(aiosPath, "memory", "skill-patches", "queue.md");
  const first = fs.readFileSync(queuePath, "utf8");
  const secondRun = run(["memory", "audit", "--path", aiosPath, "--write-queue"]);
  const second = fs.readFileSync(queuePath, "utf8");

  assert.match(secondRun.stdout, /Wrote 0 candidate/);
  assert.equal(second, first);
});

test("memory audit --json prints the raw report", () => {
  const { aiosPath } = setupAios();

  const result = run(["memory", "audit", "--path", aiosPath, "--json"]);
  const report = JSON.parse(result.stdout);

  assert.equal(report.summary.skillPatchCandidates, 1);
  assert.equal(report.skillPatchCandidates[0].skill, "closeday");
});

test("memory audit --max-candidates reports truncation in JSON", () => {
  const { aiosPath } = setupAios();
  fs.appendFileSync(path.join(aiosPath, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:01:00.000Z",
    type: "lesson",
    skill: "closeday",
    memory_decision: "skill-patch",
    summary: "The closeday skill should summarize carried tasks separately."
  })}\n`);

  const result = run(["memory", "audit", "--path", aiosPath, "--json", "--max-candidates", "1"]);
  const report = JSON.parse(result.stdout);

  assert.equal(report.summary.skillPatchCandidates, 2);
  assert.equal(report.summary.skillPatchCandidatesShown, 1);
  assert.equal(report.summary.skillPatchCandidatesTruncated, true);
});

test("memory audit --json --write-queue keeps stdout parseable", () => {
  const { aiosPath } = setupAios();

  const result = run(["memory", "audit", "--path", aiosPath, "--json", "--write-queue"]);
  const report = JSON.parse(result.stdout);

  assert.equal(report.summary.skillPatchCandidates, 1);
  assert.equal(report.queue.count, 1);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "skill-patches", "queue.md")), true);
});

test("memory audit --apply-skills appends explicit lessons to existing skills", () => {
  const { aiosPath } = setupAios();

  const result = run(["memory", "audit", "--path", aiosPath, "--apply-skills"]);
  const skill = fs.readFileSync(path.join(aiosPath, "skills", "closeday", "SKILL.md"), "utf8");

  assert.match(result.stdout, /Applied 1 candidate/);
  assert.match(skill, /## Field Notes/);
  assert.match(skill, /closeday skill should ask for carry-over/);
});

test("memory audit --json --apply-skills keeps stdout parseable", () => {
  const { aiosPath } = setupAios();

  const result = run(["memory", "audit", "--path", aiosPath, "--json", "--apply-skills"]);
  const report = JSON.parse(result.stdout);

  assert.equal(report.applied.applied, 1);
  assert.equal(report.applied.results[0].skill, "closeday");
});
