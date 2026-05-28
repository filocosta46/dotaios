import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

test("pilot-score writes pilot_score row with provenance fields", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-pilot-score-"));
  const aiosPath = path.join(tempRoot, "aios");
  fs.mkdirSync(path.join(aiosPath, "memory", "metrics"), { recursive: true });

  const result = run([
    "pilot-score",
    "--path", aiosPath,
    "--first-recall-min", "9",
    "--p-at-5", "0.7",
    "--scorer-id", "qa-runner",
    "--method-version", "v1.0.0"
  ]);
  assert.equal(result.status, 0, result.stderr);

  const metricsFile = path.join(aiosPath, "memory", "metrics", "pilot.jsonl");
  const rows = fs.readFileSync(metricsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const row = rows[rows.length - 1];
  assert.equal(row.type, "pilot_score");
  assert.equal(row.first_recall_min, 9);
  assert.equal(row.p_at_5, 0.7);
  assert.equal(row.scorer_id, "qa-runner");
  assert.equal(row.scorer_method_version, "v1.0.0");
  assert.equal(typeof row.scored_at, "string");
  assert.ok(Number.isFinite(Date.parse(row.scored_at)));
});

test("pilot-score rejects missing required flags", () => {
  const result = run([
    "pilot-score",
    "--first-recall-min", "9",
    "--p-at-5", "0.7",
    "--scorer-id", "qa-runner"
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--method-version requires a value|Missing required option: --method-version/);
});

test("pilot-score rejects invalid numeric fields", () => {
  const result = run([
    "pilot-score",
    "--first-recall-min", "bad",
    "--p-at-5", "2",
    "--scorer-id", "qa-runner",
    "--method-version", "v1"
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --first-recall-min|Invalid --p-at-5/);
});
