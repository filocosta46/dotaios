import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const quietEnv = { ...process.env, PATH: "/usr/bin:/bin", DOTAIOS_NO_UPDATE_CHECK: "1" };

test("default setup preview names only detected clients and keeps operator detail behind --verbose", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-setup-"));
  const homePath = path.join(tempRoot, "home");
  const aiosPath = path.join(homePath, "aios");
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });

  try {
    const concise = run(["setup", "--dry-run", "--path", aiosPath, "--home", homePath]);
    assert.equal(concise.status, 0, concise.stderr);
    assert.match(concise.stdout, /Claude Code/);
    assert.match(concise.stdout, /Your context stays in|After setup/i);
    assert.match(concise.stdout, /~\/aios/);
    assert.doesNotMatch(concise.stdout, /not detected|managed (?:bridge|skill)|projection|DotAIOS-managed/i);
    assert.doesNotMatch(concise.stdout, new RegExp(escapeRegExp(tempRoot)));

    const verbose = run(["setup", "--dry-run", "--verbose", "--path", aiosPath, "--home", homePath]);
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stdout, /managed (?:bridge|skill)|DotAIOS-managed/i);
    assert.match(verbose.stdout, new RegExp(escapeRegExp(tempRoot)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("default setup preview gives a clear next step when no supported app is detected", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-no-client-"));
  const homePath = path.join(tempRoot, "home");
  const aiosPath = path.join(homePath, "aios");
  fs.mkdirSync(homePath, { recursive: true });

  try {
    const result = run(["setup", "--dry-run", "--path", aiosPath, "--home", homePath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No supported local AI app was detected/);
    assert.match(result.stdout, /Install Claude Code, Codex, or Gemini CLI, then run setup again/);
    assert.doesNotMatch(result.stdout, /managed (?:bridge|skill)|projection|DotAIOS-managed/i);
    assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(tempRoot)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("default doctor reports the user outcome without listing absent clients", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-doctor-"));
  const homePath = path.join(tempRoot, "home");
  const aiosPath = path.join(homePath, "aios");
  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.2.0", ai_tools: [] })}\n`);
  fs.writeFileSync(path.join(aiosPath, "AGENTS.md"), "# AIOS\n");

  try {
    const concise = run(["doctor", "--path", aiosPath, "--home", homePath]);
    assert.match(concise.stdout, /No supported local AI app was detected|No local AI app is connected/i);
    assert.match(concise.stdout, /install|activate/i);
    assert.match(concise.stdout, /~\/aios/);
    assert.doesNotMatch(concise.stdout, /\(not installed\)|native skills|managed bridge|projection/i);
    assert.doesNotMatch(concise.stdout, new RegExp(escapeRegExp(tempRoot)));

    const verbose = run(["doctor", "--verbose", "--path", aiosPath, "--home", homePath]);
    assert.match(verbose.stdout, /\(not installed\)|native skills/i);
    assert.match(verbose.stdout, new RegExp(escapeRegExp(tempRoot)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup and doctor document --verbose and continue rejecting unknown options", () => {
  for (const command of ["setup", "doctor"]) {
    const help = run([command, "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--verbose/);

    const invalid = run([command, "--definitely-unknown"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown option|unknown/i);
  }
});

test("default doctor blocking output states the outcome and one safe next action", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-blocked-"));
  const homePath = path.join(tempRoot, "home");
  const missingAios = path.join(homePath, "aios");
  fs.mkdirSync(homePath, { recursive: true });

  try {
    const result = run(["doctor", "--path", missingAios, "--home", homePath]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /blocking issue/i);
    assert.match(result.stdout, /npx dotaios setup/);
    assert.match(result.stdout, /~\/aios/);
    assert.doesNotMatch(result.stdout, /\(not installed\)|managed (?:bridge|skill)|projection/i);
    assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(tempRoot)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: quietEnv
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
