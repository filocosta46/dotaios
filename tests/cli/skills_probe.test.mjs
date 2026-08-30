import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runSkillInvocationProbe } from "../../packages/cli/src/lib/skill-invocation-probe.mjs";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-probe-test-"));
  const aiosPath = path.join(root, "aios");
  fs.mkdirSync(path.join(aiosPath, "skills", "source-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "skills", "source-skill", "SKILL.md"),
    "---\nname: source-skill\ndescription: test source\n---\n"
  );
  return { root, aiosPath };
}

test("skills probe dry-run emits a receipt without invoking Codex", () => {
  const { root, aiosPath } = setupAios();
  try {
    const result = run([
      "skills", "probe", "--client", "codex", "--dry-run", "--json",
      "--path", aiosPath
    ]);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schema, "dotaios.skill-invocation.v1");
    assert.equal(receipt.client, "Codex");
    assert.equal(receipt.evidence.configured, "yes");
    assert.equal(receipt.evidence.discoverable, "path-ready");
    assert.equal(receipt.evidence.invoked, "not-run");
    assert.equal(receipt.evidence.produced, "not-run");
    assert.match(receipt.command.join(" "), /--sandbox read-only/);
    assert.equal(fs.existsSync(receipt.skill.path), false, "fixture is disposable by default");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe exposes the project-native route through the shipped CLI in dry-run mode", () => {
  const { root, aiosPath } = setupAios();
  try {
    const result = run([
      "skills", "probe", "--client", "codex", "--project-native-route",
      "--dry-run", "--json", "--path", aiosPath
    ]);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt.projectRoute, {
      schema: "dotaios.project-native-invocation.v1",
      candidate: "candidate",
      exact: "ready",
      approvalBinding: "retained-opaque",
      exactLocation: "<temporary-project>",
      launchLocation: "<temporary-project>",
      rootMatch: "yes",
      outcomeBoundary: "same-caller-receipt"
    });
    assert.equal(receipt.evidence.invoked, "not-run");
    assert.equal(receipt.evidence.produced, "not-run");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe project-native CLI mode reaches a controlled fake client at the exact route root", () => {
  const { root, aiosPath } = setupAios();
  const fakeBin = path.join(root, "bin");
  const invocationLog = path.join(root, "codex-invocations.jsonl");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCodex = path.join(fakeBin, "codex");
  fs.writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(args) + '\\n');`,
    "if (args[0] === '--version') { process.stdout.write('codex-fake 1.0\\n'); process.exit(0); }",
    "const rootIndex = args.indexOf('-C');",
    "const outputIndex = args.indexOf('--output-last-message');",
    "if (rootIndex < 0 || outputIndex < 0) process.exit(2);",
    "const projectRoot = args[rootIndex + 1];",
    "const skill = fs.readFileSync(path.join(projectRoot, '.agents', 'skills', 'dotaios-probe', 'SKILL.md'), 'utf8');",
    "const marker = /DOTAIOS_PROBE_OK_[a-f0-9]+/u.exec(skill)?.[0];",
    "if (!marker) process.exit(3);",
    "fs.writeFileSync(args[outputIndex + 1], 'CWD: ' + fs.realpathSync(projectRoot) + '\\n' + marker + '\\n');"
  ].join("\n") + "\n");
  fs.chmodSync(fakeCodex, 0o755);

  try {
    const result = spawnSync(process.execPath, [
      cli,
      "skills", "probe", "--client", "codex", "--project-native-route",
      "--run", "--json", "--path", aiosPath
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.clientVersion, "codex-fake 1.0");
    assert.equal(receipt.evidence.invoked, "yes");
    assert.equal(receipt.evidence.produced, "yes");
    assert.equal(receipt.projectRoute.candidate, "candidate");
    assert.equal(receipt.projectRoute.exact, "ready");
    assert.equal(receipt.projectRoute.rootMatch, "yes");
    const invocations = fs.readFileSync(invocationLog, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    assert.equal(invocations.length, 2, "one version check and one controlled invocation are expected");
    assert.equal(invocations[1][0], "exec");
    assert.ok(invocations[1].includes("-C"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe dry-run never spawns the client, including a version probe", () => {
  const { root, aiosPath } = setupAios();
  const fakeBin = path.join(root, "bin");
  const sentinel = path.join(root, "spawned");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCodex = path.join(fakeBin, "codex");
  fs.writeFileSync(fakeCodex, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`);
  fs.chmodSync(fakeCodex, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "skills",
        "probe",
        "--client",
        "codex",
        "--dry-run",
        "--json",
        "--path",
        aiosPath
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).clientVersion, null);
    assert.equal(fs.existsSync(sentinel), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude probe stays project-local when CLAUDE_CONFIG_DIR relocates the user root", () => {
  const { root, aiosPath } = setupAios();
  const activeRoot = path.join(root, "profiles", "personal");
  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "skills",
        "probe",
        "--client",
        "claude-code",
        "--dry-run",
        "--json",
        "--path",
        aiosPath
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: activeRoot }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.evidence.discoverable, "path-ready");
    assert.match(receipt.targetPath, /project[\\/]\.claude[\\/]skills$/);
    assert.match(receipt.command.join(" "), /--setting-sources project/);
    assert.equal(JSON.stringify(receipt).includes(activeRoot), false);
    assert.equal(JSON.stringify(receipt).includes(path.join(os.homedir(), ".claude")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe requires an explicit client", () => {
  const { root, aiosPath } = setupAios();
  try {
    const result = run(["skills", "probe", "--path", aiosPath], { allowNonZero: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--client is required/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe records a limitation without claiming invocation for Hermes", () => {
  const { root, aiosPath } = setupAios();
  try {
    const result = run([
      "skills", "probe", "--client", "hermes", "--json", "--path", aiosPath
    ]);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.evidence.configured, "no");
    assert.equal(receipt.evidence.discoverable, "no");
    assert.equal(receipt.evidence.invoked, "not-run");
    assert.equal(receipt.evidence.produced, "not-run");
    assert.match(receipt.limitation, /no verified project-local config selector/i);
    assert.match(receipt.limitation, /global skill registration remains supported/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes probe does not stage or bless an inert project config", async () => {
  const { root, aiosPath } = setupAios();
  let fixturePath = null;
  try {
    const result = await runSkillInvocationProbe({
      client: "hermes",
      aiosPath,
      keep: true
    });
    fixturePath = result.fixturePath;
    const projectPath = path.join(fixturePath, "project");
    const configPath = path.join(projectPath, ".hermes", "config.yaml");
    assert.equal(result.receipt.evidence.configured, "no");
    assert.equal(result.receipt.evidence.discoverable, "no");
    assert.equal(result.receipt.evidence.invoked, "not-run");
    assert.equal(result.receipt.evidence.produced, "not-run");
    assert.equal(result.receipt.targetPath, null);
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    if (fixturePath) fs.rmSync(fixturePath, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe writes the requested receipt without touching the source AIOS", () => {
  const { root, aiosPath } = setupAios();
  const receiptPath = path.join(root, "receipt.json");
  const sourceBefore = fs.readFileSync(
    path.join(aiosPath, "skills", "source-skill", "SKILL.md"),
    "utf8"
  );
  try {
    run([
      "skills", "probe", "--client", "hermes", "--json", "--path", aiosPath,
      "--receipt", receiptPath
    ]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.schema, "dotaios.skill-invocation.v1");
    assert.equal(
      fs.readFileSync(path.join(aiosPath, "skills", "source-skill", "SKILL.md"), "utf8"),
      sourceBefore
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills probe rejects unknown clients", () => {
  const { root, aiosPath } = setupAios();
  try {
    const result = run([
      "skills", "probe", "--client", "unknown", "--path", aiosPath
    ], { allowNonZero: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown probe client/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
