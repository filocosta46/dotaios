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

test("doctor shows pilot metrics/backend health lines", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-doctor-pilot-"));
  const aiosPath = path.join(tempRoot, "aios");
  const setupResult = run(["init", "--path", aiosPath, "--yes"]);
  assert.equal(setupResult.status, 0, setupResult.stderr);

  const doctor = run(["doctor", "--path", aiosPath, "--home", tempRoot]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /Pilot metrics/);
  assert.match(doctor.stdout, /Pilot memory backend/);
  assert.match(doctor.stdout, /adapter detected but not live|fallback \(local\) path available/i);
});

test("status shows pilot metrics/backend block", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-status-pilot-"));
  const aiosPath = path.join(tempRoot, "aios");
  const init = run(["init", "--path", aiosPath, "--yes"]);
  assert.equal(init.status, 0, init.stderr);

  const status = run(["status", "--path", aiosPath, "--home", tempRoot]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /pilot metrics:/i);
  assert.match(status.stdout, /Pilot health/);
  assert.match(status.stdout, /backend state:/i);
});
