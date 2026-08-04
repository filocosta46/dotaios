import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// `dotaios setup` is the one command a brand-new user runs, and in 1.27.1 it
// lied to its caller three ways when step 1 failed:
//
//   1. it printed "Setup could not complete." and exited 0, so every wrapper,
//      CI step, and agent that checks the status code was told the install
//      worked;
//   2. the failure path itself emitted pilot metrics, and the metrics writer
//      mkdir -p's its parent — so a failed `init` still left <aios>/memory/
//      metrics/pilot.jsonl behind, and the documented retry (`dotaios setup`)
//      then died on "Target already exists and is not empty";
//   3. nothing ever cleared that wreck, so the retry could not recover.
//
// These tests pin all three. Every spawn pins HOME so no run can reach the
// developer's real ~/.dotaios (see state_isolation.test.mjs).

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function makeSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  const processHomePath = path.join(root, "process-home");
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  fs.mkdirSync(processHomePath, { recursive: true });
  fs.mkdirSync(homePath, { recursive: true });
  return { root, processHomePath, homePath, aiosPath };
}

// stdin is "ignore" so process.stdin.isTTY is undefined — the exact shape of a
// run pasted into a chat window, a CI job, or an agent shell.
function runSetup(sandbox, args) {
  return spawnSync(process.execPath, [cli, "setup", "--path", sandbox.aiosPath, "--home", sandbox.homePath, "--skip-reveal", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // PATH is trimmed for the same reason setup.test.mjs trims it:
    // resolveLightpanda falls back to `which lightpanda`.
    env: { ...process.env, HOME: sandbox.processHomePath, PATH: "/usr/bin:/bin" }
  });
}

function listTree(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

test("a failed setup exits non-zero", () => {
  const sandbox = makeSandbox("setup-exit");
  // No TTY and no --yes: init cannot ask its questions, so step 1 fails.
  const result = runSetup(sandbox, []);

  assert.match(result.stderr, /Setup could not complete/);
  assert.notEqual(
    result.status,
    0,
    "a caller checking the exit code must be told setup failed, not that it succeeded"
  );
});

test("a failed setup does not create the AIOS folder", () => {
  const sandbox = makeSandbox("setup-nofolder");
  const result = runSetup(sandbox, []);

  assert.notEqual(result.status, 0);
  assert.equal(
    fs.existsSync(sandbox.aiosPath),
    false,
    `setup failed before creating anything, so nothing may be left behind: ${
      fs.existsSync(sandbox.aiosPath) ? JSON.stringify(listTree(sandbox.aiosPath)) : ""
    }`
  );
});

test("an activation failure exits non-zero and records a failed install", () => {
  const sandbox = makeSandbox("setup-activate-exit");
  const invalidHomePath = path.join(sandbox.root, "home-is-a-file");
  fs.writeFileSync(invalidHomePath, "not a directory\n");

  const result = runSetup(sandbox, ["--yes", "--all", "--home", invalidHomePath]);

  assert.ok(
    fs.existsSync(path.join(sandbox.aiosPath, "aios.json")),
    "init must finish before the invalid home makes activation fail"
  );
  assert.match(result.stderr, /Step 2 failed:/);
  assert.notEqual(result.status, 0, "an activation failure must be observable to the caller");

  const rows = fs.readFileSync(
    path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl"),
    "utf8"
  ).trim().split("\n").map((line) => JSON.parse(line));
  const installEnd = rows.findLast((row) => row.type === "install_end");
  assert.equal(installEnd?.outcome, "fail", "a failed activation is a failed install, not a warning");
});

test("the retry after a failed setup reports the original error, not a folder collision", () => {
  const sandbox = makeSandbox("setup-retry-error");
  const first = runSetup(sandbox, []);
  const second = runSetup(sandbox, []);

  assert.notEqual(first.status, 0);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /interactive terminal required/);
  assert.doesNotMatch(
    second.stderr,
    /already exists and is not empty/,
    "the retry must not be poisoned by residue the first run left behind"
  );
});

test("setup completes on a folder an earlier failed run left half-made", () => {
  const sandbox = makeSandbox("setup-recover");
  // Exactly what a 1.27.1 failed run leaves behind: the metrics file its own
  // error path wrote, and nothing else. Users upgrading are already in this
  // state, so the fix has to clear it rather than only stop creating it.
  const metricsDir = path.join(sandbox.aiosPath, "memory", "metrics");
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    path.join(metricsDir, "pilot.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), type: "setup_phase_end", phase: "init", outcome: "fail" })}\n`
  );

  const result = runSetup(sandbox, ["--yes"]);

  assert.equal(result.status, 0, `setup must recover the half-made folder:\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    fs.existsSync(path.join(sandbox.aiosPath, "aios.json")),
    "recovery means the folder is actually finished, not just reported as fine"
  );
  assert.match(
    `${result.stdout}${result.stderr}`,
    /unfinished folder/i,
    "the recovery must be stated once, not performed silently"
  );
  // The residue is evidence, not garbage — recovery adds missing files, it
  // never overwrites what is already there.
  assert.match(fs.readFileSync(path.join(metricsDir, "pilot.jsonl"), "utf8"), /"outcome":"fail"/);
});

test("setup refuses malformed failed-run residue", () => {
  const sandbox = makeSandbox("setup-malformed-residue");
  const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl");
  fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
  fs.writeFileSync(metricsFile, "{not valid json}\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "malformed metrics do not prove this is safe setup residue");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.match(fs.readFileSync(metricsFile, "utf8"), /^\{not valid json\}\n/);
});

test("setup refuses failed-run metrics mixed with an unknown JSON row", () => {
  const sandbox = makeSandbox("setup-foreign-metric");
  const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl");
  fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
  fs.writeFileSync(metricsFile, [
    JSON.stringify({ type: "setup_phase_end", phase: "init", outcome: "fail" }),
    JSON.stringify({ type: "private_note", text: "not setup residue" })
  ].join("\n") + "\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "an unknown JSON row must make recovery fail closed");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.match(fs.readFileSync(metricsFile, "utf8"), /"type":"private_note"/);
});

test("setup refuses failed-run residue when any extra file is present", () => {
  const sandbox = makeSandbox("setup-extra-residue");
  const metricsDir = path.join(sandbox.aiosPath, "memory", "metrics");
  const metricsFile = path.join(metricsDir, "pilot.jsonl");
  const extraFile = path.join(metricsDir, "private-notes.md");
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    metricsFile,
    `${JSON.stringify({ type: "setup_phase_end", phase: "init", outcome: "fail" })}\n`
  );
  fs.writeFileSync(extraFile, "keep me\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "only the exact 1.27.1 residue shape may be recovered");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.equal(fs.readFileSync(extraFile, "utf8"), "keep me\n");
});

test("setup refuses to auto-force a complete AIOS folder", () => {
  const sandbox = makeSandbox("setup-healthy");
  const first = runSetup(sandbox, ["--yes"]);
  assert.equal(first.status, 0, `first setup should succeed:\n${first.stdout}\n${first.stderr}`);

  const second = runSetup(sandbox, ["--yes"]);
  assert.notEqual(
    second.status,
    0,
    "a second setup over a working AIOS must not be silently forced through"
  );
  assert.match(second.stderr, /already exists and is not empty/);
  assert.doesNotMatch(`${second.stdout}${second.stderr}`, /unfinished folder/i);
});

test("setup refuses to auto-force a folder holding foreign content", () => {
  const sandbox = makeSandbox("setup-foreign");
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });
  fs.writeFileSync(path.join(sandbox.aiosPath, "tax-return-2025.pdf"), "not ours\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "a folder with the user's own files must fail closed");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
});

test("setup refuses foreign content nested under a generated folder name", () => {
  const sandbox = makeSandbox("setup-nested-foreign");
  const foreignFile = path.join(sandbox.aiosPath, "projects", "client-work", "private-notes.md");
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(foreignFile, "private client notes\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "foreign nested content must fail closed");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.equal(fs.readFileSync(foreignFile, "utf8"), "private client notes\n");
});

test("a folder needing migration surfaces the migration error, not the retry", () => {
  const sandbox = makeSandbox("setup-migration");
  // init refuses --force on a folder whose schema needs a versioned migration
  // (init.mjs), so the auto-force retry must never be attempted here.
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });
  fs.writeFileSync(
    path.join(sandbox.aiosPath, "aios.json"),
    `${JSON.stringify({ schema_version: "1.0.0", ai_tools: [] }, null, 2)}\n`
  );

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs a versioned migration/);
  assert.doesNotMatch(
    result.stderr,
    /already exists and is not empty/,
    "the migration refusal is the real answer and must not be replaced by a collision message"
  );
});

test("pilot-score still creates its metrics directory", () => {
  // appendMetric has callers that legitimately depend on the mkdir. Making
  // setup's failure path non-creating must not take that away from them.
  const sandbox = makeSandbox("setup-metrics-caller");
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });

  const result = spawnSync(process.execPath, [
    cli, "pilot-score",
    "--path", sandbox.aiosPath,
    "--first-recall-min", "3",
    "--p-at-5", "0.8",
    "--scorer-id", "tester",
    "--method-version", "1"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: sandbox.processHomePath, PATH: "/usr/bin:/bin" }
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl");
  assert.ok(fs.existsSync(metricsFile), "pilot-score must still create memory/metrics/ on its own");
  assert.match(fs.readFileSync(metricsFile, "utf8"), /"type":"pilot_score"/);
});
