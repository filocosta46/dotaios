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

test("real setup keeps init detail concise by default and restores it with --verbose", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-real-"));
  const conciseHome = path.join(tempRoot, "concise-home");
  const conciseAios = path.join(conciseHome, "aios");
  const verboseHome = path.join(tempRoot, "verbose-home");
  const verboseAios = path.join(verboseHome, "aios");
  fs.mkdirSync(path.join(conciseHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(verboseHome, ".claude"), { recursive: true });

  try {
    const concise = run([
      "setup", "--yes", "--skip-reveal",
      "--path", conciseAios, "--home", conciseHome
    ]);
    assert.equal(concise.status, 0, `${concise.stdout}\n${concise.stderr}`);
    const conciseOutput = `${concise.stdout}\n${concise.stderr}`;
    assert.match(conciseOutput, /Folder ready\. Claude Code can now use your context\./);
    assert.doesNotMatch(conciseOutput, new RegExp(escapeRegExp(tempRoot)));
    assert.doesNotMatch(conciseOutput, /AIOS path:|Vault path:|Files: \d+ created|\nNext steps:\n/);
    assert.doesNotMatch(conciseOutput, /not detected on this machine/);

    const verbose = run([
      "setup", "--yes", "--skip-reveal", "--verbose",
      "--path", verboseAios, "--home", verboseHome
    ]);
    assert.equal(verbose.status, 0, `${verbose.stdout}\n${verbose.stderr}`);
    assert.match(verbose.stdout, new RegExp(`AIOS path: ${escapeRegExp(verboseAios)}`));
    assert.match(verbose.stdout, new RegExp(`Vault path: ${escapeRegExp(path.join(verboseAios, "vault"))}`));
    assert.match(verbose.stdout, /Files: \d+ created, \d+ updated, \d+ kept/);
    assert.match(verbose.stdout, /\nNext steps:\n/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("direct init retains its detailed completion output", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-init-"));
  const aiosPath = path.join(tempRoot, "aios");

  try {
    const result = run(["init", "--yes", "--path", aiosPath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`AIOS path: ${escapeRegExp(aiosPath)}`));
    assert.match(result.stdout, new RegExp(`Vault path: ${escapeRegExp(path.join(aiosPath, "vault"))}`));
    assert.match(result.stdout, /Files: \d+ created, \d+ updated, \d+ kept/);
    assert.match(result.stdout, /\nNext steps:\n/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("real setup names only clients whose context bridge was configured", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-mixed-clients-"));
  const homePath = path.join(tempRoot, "home");
  const aiosPath = path.join(homePath, "aios");
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homePath, ".cursor"), { recursive: true });

  try {
    const result = run([
      "setup", "--yes", "--skip-reveal",
      "--path", aiosPath, "--home", homePath
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Folder ready\. Claude Code can now use your context\./);
    assert.doesNotMatch(result.stdout, /Folder ready\.[^\n]*Cursor[^\n]*can now use your context/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup preview distinguishes bridge clients from bridge-less detected apps", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-first-run-mixed-preview-"));
  const homePath = path.join(tempRoot, "home");
  const aiosPath = path.join(homePath, "aios");
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homePath, ".cursor"), { recursive: true });

  try {
    const result = run(["setup", "--dry-run", "--path", aiosPath, "--home", homePath]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[detected\] Claude Code — setup will connect it to your context\./);
    assert.match(
      result.stdout,
      /\[detected\] Cursor — needs native or project-specific setup before it can use your context\./
    );
    assert.doesNotMatch(result.stdout, /\[detected\] Cursor — setup will connect it to your context\./);
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
