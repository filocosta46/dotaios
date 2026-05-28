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

function writePilotRows(aiosPath, rows) {
  const metricsDir = path.join(aiosPath, "memory", "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(path.join(metricsDir, "pilot.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("pilot-report ships pilot but not public on a small two-scorer sample", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-pilot-report-"));
  const aiosPath = path.join(tempRoot, "aios");
  writePilotRows(aiosPath, [
    { type: "install_end", outcome: "ok" },
    { type: "install_end", outcome: "ok" },
    { type: "pilot_score", first_recall_min: 5, p_at_5: 0.9, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:00:00.000Z" },
    { type: "pilot_score", first_recall_min: 6, p_at_5: 0.9, scorer_id: "qa2", scorer_method_version: "v1", scored_at: "2026-05-01T00:10:00.000Z" },
    { type: "pilot_score", first_recall_min: 7, p_at_5: 0.9, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:20:00.000Z" },
    { type: "pilot_score", first_recall_min: 8, p_at_5: 0.9, scorer_id: "qa2", scorer_method_version: "v1", scored_at: "2026-05-01T00:30:00.000Z" },
    { type: "pilot_score", first_recall_min: 9, p_at_5: 0.9, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:40:00.000Z" },
  ]);

  const result = run(["pilot-report", "--path", aiosPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ship pilot: yes/);
  assert.match(result.stdout, /Ship public: no/);
  assert.match(result.stdout, /Block reasons:\s+none/);
  assert.match(result.stdout, /insufficient_public_sample/);
});

test("pilot-report --json returns machine-readable object", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-pilot-report-json-"));
  const aiosPath = path.join(tempRoot, "aios");
  writePilotRows(aiosPath, [
    { type: "pilot_score", first_recall_min: 9, p_at_5: 0.5, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:00:00.000Z" },
  ]);

  const result = run(["pilot-report", "--path", aiosPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(typeof out.go, "boolean");
  assert.equal(typeof out.incomplete, "boolean");
  assert.ok(Array.isArray(out.block_reasons));
  assert.ok(out.block_reasons.includes("missing_install_data"));
  assert.ok(out.block_reasons.includes("insufficient_sample"));
});
