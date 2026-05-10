import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("reveal --dry-run prints command without spawning", () => {
  const { aiosPath } = setupAios();

  const result = run(["reveal", "--path", aiosPath, "--dry-run"]);
  assert.match(result.stdout, /^Would open /m);
  assert.ok(result.stdout.includes(aiosPath), "should mention target path");
  assert.match(result.stdout, /open|explorer|xdg-open/);
});

test("reveal errors when AIOS folder is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v131-noaios-"));
  const result = runFail(["reveal", "--path", path.join(tempRoot, "nope")]);
  assert.match(result.stderr, /No AIOS folder found/);
});

test("reveal --help prints usage", () => {
  const result = run(["reveal", "--help"]);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /dotaios reveal/);
});

test("init renders templates with source provenance frontmatter", () => {
  const { aiosPath } = setupAios();

  const contextFiles = [
    "context/identity.md",
    "context/work.md",
    "context/priorities.md",
    "context/north-star.md"
  ];

  for (const relative of contextFiles) {
    const content = fs.readFileSync(path.join(aiosPath, relative), "utf8");
    assert.match(content, /^---\n/, `${relative} should start with frontmatter`);
    assert.match(content, /source: dotaios init/, `${relative} missing source field`);
    assert.match(content, /kind: context/, `${relative} missing kind: context`);
    assert.match(content, /created_at: \d{4}-\d{2}-\d{2}T/, `${relative} missing created_at ISO timestamp`);
  }

  const domainFiles = [
    "context/domains/build.md",
    "context/domains/make.md",
    "context/domains/sell.md"
  ];
  for (const relative of domainFiles) {
    const content = fs.readFileSync(path.join(aiosPath, relative), "utf8");
    assert.match(content, /source: dotaios init/, `${relative} missing source field`);
    assert.match(content, /kind: domain/, `${relative} missing kind: domain`);
  }
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v131-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }

  return result;
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status === 0) {
    throw new Error(`Command unexpectedly passed: dotaios ${args.join(" ")}\n${result.stdout}`);
  }

  return result;
}
