import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

test("setup and capture emit metrics while read-only search records nothing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-reliability-metrics-"));
  const aiosPath = path.join(tempRoot, "aios");
  const processHomePath = path.join(tempRoot, "process-home");
  const activationHomePath = path.join(tempRoot, "activation-home");
  const convFile = path.join(tempRoot, "conv.md");
  fs.mkdirSync(processHomePath, { recursive: true });
  fs.writeFileSync(convFile, "Human: hi\nAssistant: hello\n", "utf8");

  run(["setup", "--path", aiosPath, "--home", activationHomePath, "--yes", "--skip-reveal"], {
    env: { ...process.env, HOME: processHomePath, DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD: "1" }
  });
  run(["search", "hello", "--path", aiosPath]);
  run(["capture", "import", "file", convFile, "--path", aiosPath]);

  const metricsFile = path.join(aiosPath, "memory", "metrics", "reliability.jsonl");
  assert.ok(fs.existsSync(metricsFile), "reliability metrics file should exist");
  const lines = fs.readFileSync(metricsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const types = new Set(lines.map((line) => line.type));

  assert.ok(types.has("install_start"));
  assert.ok(types.has("install_end"));
  assert.ok(types.has("capture_saved"));
  assert.equal(types.has("search_run"), false);
});

test("setup emits phase start/end events with stable run_id", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-phases-"));
  const aiosPath = path.join(tempRoot, "aios");
  const processHomePath = path.join(tempRoot, "process-home");
  const activationHomePath = path.join(tempRoot, "activation-home");
  fs.mkdirSync(processHomePath, { recursive: true });

  run(["setup", "--path", aiosPath, "--home", activationHomePath, "--yes", "--skip-reveal"], {
    env: { ...process.env, HOME: processHomePath, DOTAIOS_SKIP_LIGHTPANDA_DOWNLOAD: "1" }
  });

  const metricsFile = path.join(aiosPath, "memory", "metrics", "reliability.jsonl");
  const rows = fs.readFileSync(metricsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const phaseRows = rows.filter((row) => row.type === "setup_phase_start" || row.type === "setup_phase_end");
  assert.ok(phaseRows.length >= 6, "expected start/end events for init, activate, reveal");

  const runIds = new Set(phaseRows.map((row) => row.run_id).filter(Boolean));
  assert.equal(runIds.size, 1, "all setup phase events should share one run_id");

  const phaseSteps = phaseRows.map((row) => `${row.type}:${row.phase}`);
  const initStart = phaseSteps.indexOf("setup_phase_start:init");
  const initEnd = phaseSteps.indexOf("setup_phase_end:init");
  const activateStart = phaseSteps.indexOf("setup_phase_start:activate");
  const activateEnd = phaseSteps.indexOf("setup_phase_end:activate");
  const revealStart = phaseSteps.indexOf("setup_phase_start:reveal");
  const revealEnd = phaseSteps.indexOf("setup_phase_end:reveal");

  assert.ok(initStart !== -1 && initEnd !== -1 && initStart < initEnd);
  assert.ok(activateStart !== -1 && activateEnd !== -1 && activateStart < activateEnd);
  assert.ok(revealStart !== -1 && revealEnd !== -1 && revealStart < revealEnd);
});
