import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const rollupScript = path.join(repoRoot, "scripts", "pilot-rollup.mjs");

test("pilot rollup computes metrics and go=true", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-rollup-"));
  const aiosPath = path.join(tempRoot, "aios");
  const metricsDir = path.join(aiosPath, "memory", "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });

  const rows = [
    { type: "install_end", outcome: "ok" },
    { type: "install_end", outcome: "ok" },
    { type: "install_end", outcome: "fail" },
    { type: "pilot_score", first_recall_min: 5, p_at_5: 0.8, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:00:00.000Z" },
    { type: "pilot_score", first_recall_min: 7, p_at_5: 0.7, scorer_id: "qa2", scorer_method_version: "v1", scored_at: "2026-05-01T00:10:00.000Z" },
    { type: "pilot_score", first_recall_min: 6, p_at_5: 0.8, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:20:00.000Z" },
    { type: "pilot_score", first_recall_min: 5, p_at_5: 0.7, scorer_id: "qa2", scorer_method_version: "v1", scored_at: "2026-05-01T00:30:00.000Z" },
    { type: "pilot_score", first_recall_min: 8, p_at_5: 0.75, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:40:00.000Z" },
  ];
  fs.writeFileSync(path.join(metricsDir, "pilot.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const result = spawnSync(process.execPath, [rollupScript, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());

  assert.equal(Number(out.install_success_rate.toFixed(4)), 0.6667);
  assert.equal(out.median_first_recall_min, 6);
  assert.equal(Number(out.p_at_5_avg.toFixed(2)), 0.75);
  assert.equal(out.go, false);
  assert.equal(out.incomplete, false);
  assert.deepEqual(out.block_reasons, ["install_success_below_threshold"]);

  const written = JSON.parse(fs.readFileSync(path.join(metricsDir, "pilot-rollup.json"), "utf8"));
  assert.equal(written.go, false);
});

test("pilot rollup ignores non-pilot metric files", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-rollup-ignore-"));
  const aiosPath = path.join(tempRoot, "aios");
  const metricsDir = path.join(aiosPath, "memory", "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });

  const pilotRows = [
    { type: "install_end", outcome: "ok" },
    { type: "pilot_score", first_recall_min: 4, p_at_5: 0.8, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:00:00.000Z" },
    { type: "pilot_score", first_recall_min: 5, p_at_5: 0.8, scorer_id: "qa2", scorer_method_version: "v1", scored_at: "2026-05-01T00:10:00.000Z" },
    { type: "pilot_score", first_recall_min: 6, p_at_5: 0.8, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:20:00.000Z" },
    { type: "pilot_score", first_recall_min: 7, p_at_5: 0.8, scorer_id: "qa2", scorer_method_version: "v1", scored_at: "2026-05-01T00:30:00.000Z" },
    { type: "pilot_score", first_recall_min: 8, p_at_5: 0.8, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:40:00.000Z" },
  ];
  fs.writeFileSync(path.join(metricsDir, "pilot.jsonl"), pilotRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(metricsDir, "other.jsonl"), `${JSON.stringify({ type: "install_end", outcome: "fail" })}\n`);

  const result = spawnSync(process.execPath, [rollupScript, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.install_success_rate, 1);
  assert.equal(out.go, true);
});

test("pilot rollup marks incomplete on insufficient score sample", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-rollup-sample-"));
  const aiosPath = path.join(tempRoot, "aios");
  const metricsDir = path.join(aiosPath, "memory", "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });

  const rows = [
    { type: "install_end", outcome: "ok" },
    { type: "install_end", outcome: "ok" },
    { type: "pilot_score", first_recall_min: 5, p_at_5: 0.8, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:00:00.000Z" },
    { type: "pilot_score", first_recall_min: 6, p_at_5: 0.7, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:10:00.000Z" },
  ];
  fs.writeFileSync(path.join(metricsDir, "pilot.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const result = spawnSync(process.execPath, [rollupScript, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.go, false);
  assert.equal(out.incomplete, true);
  assert.ok(out.block_reasons.includes("insufficient_sample"));
});

test("pilot rollup ignores malformed lines and flags invalid score rows", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-rollup-invalid-"));
  const aiosPath = path.join(tempRoot, "aios");
  const metricsDir = path.join(aiosPath, "memory", "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "install_end", outcome: "ok" }),
    "not-json",
    JSON.stringify({ type: "pilot_score", first_recall_min: 4, p_at_5: 0.9 }),
    JSON.stringify({ type: "pilot_score", first_recall_min: 6, p_at_5: 0.7, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:10:00.000Z" }),
    JSON.stringify({ type: "pilot_score", first_recall_min: 7, p_at_5: 0.7, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:20:00.000Z" }),
    JSON.stringify({ type: "pilot_score", first_recall_min: 8, p_at_5: 0.7, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:30:00.000Z" }),
    JSON.stringify({ type: "pilot_score", first_recall_min: 9, p_at_5: 0.7, scorer_id: "qa", scorer_method_version: "v1", scored_at: "2026-05-01T00:40:00.000Z" }),
  ];
  fs.writeFileSync(path.join(metricsDir, "pilot.jsonl"), `${lines.join("\n")}\n`);

  const result = spawnSync(process.execPath, [rollupScript, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.pilot_score_rows_total, 5);
  assert.equal(out.pilot_score_rows_invalid, 1);
  assert.equal(out.pilot_score_rows_valid, 4);
  assert.ok(out.block_reasons.includes("invalid_score_rows"));
});
