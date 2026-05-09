import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("index generates _index.md with context and vault sections", () => {
  const { aiosPath } = setupAios();

  fs.writeFileSync(
    path.join(aiosPath, "context", "work.md"),
    "---\ndescription: Current work and active projects\n---\n# Work\n\nBuilding DotAIOS.\n"
  );
  fs.mkdirSync(path.join(aiosPath, "vault", "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "vault", "notes", "thesis.md"),
    "# Thesis Plan\n\nMSc thesis on distributed systems.\n"
  );
  fs.writeFileSync(
    path.join(aiosPath, "vault", "notes", "no-summary.md"),
    "Just body text, no heading or frontmatter.\n"
  );

  const result = run(["index", "--path", aiosPath]);
  assert.match(result.stdout, /Indexed \d+ markdown file/);
  assert.match(result.stdout, /_index\.md/);

  const indexPath = path.join(aiosPath, "_index.md");
  assert.ok(fs.existsSync(indexPath), "_index.md should exist");
  const content = fs.readFileSync(indexPath, "utf8");

  assert.match(content, /^# AIOS Index/);
  assert.match(content, /## context\//);
  assert.match(content, /## vault\//);
  assert.match(content, /work\.md.*Current work and active projects/);
  assert.match(content, /thesis\.md.*Thesis Plan/);
  assert.match(content, /no-summary\.md/);
});

test("index --dry-run prints output without writing the file", () => {
  const { aiosPath } = setupAios();

  fs.writeFileSync(
    path.join(aiosPath, "context", "identity.md"),
    "# Identity\n\nFilippo.\n"
  );

  const result = run(["index", "--dry-run", "--path", aiosPath]);
  assert.match(result.stdout, /dry run/);
  assert.match(result.stdout, /# AIOS Index/);
  assert.match(result.stdout, /identity\.md/);

  const indexPath = path.join(aiosPath, "_index.md");
  assert.ok(!fs.existsSync(indexPath), "_index.md should NOT exist after --dry-run");
});

test("index excludes _index.md itself from the listing", () => {
  const { aiosPath } = setupAios();

  fs.writeFileSync(
    path.join(aiosPath, "vault", "_index.md"),
    "# Stale index\n"
  );
  fs.writeFileSync(
    path.join(aiosPath, "vault", "real.md"),
    "# Real Note\n"
  );

  run(["index", "--path", aiosPath]);
  const content = fs.readFileSync(path.join(aiosPath, "_index.md"), "utf8");
  assert.doesNotMatch(content, /\(_index\.md\)/);
  assert.match(content, /real\.md/);
});

test("index skips dotfiles and ignored directories", () => {
  const { aiosPath } = setupAios();

  fs.mkdirSync(path.join(aiosPath, "vault", ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "vault", ".obsidian", "config.md"), "# Hidden\n");
  fs.writeFileSync(path.join(aiosPath, "vault", ".hidden.md"), "# Hidden\n");
  fs.writeFileSync(path.join(aiosPath, "vault", "visible.md"), "# Visible\n");

  run(["index", "--path", aiosPath]);
  const content = fs.readFileSync(path.join(aiosPath, "_index.md"), "utf8");
  assert.doesNotMatch(content, /\.obsidian/);
  assert.doesNotMatch(content, /\.hidden/);
  assert.match(content, /visible\.md/);
});

test("index errors when AIOS folder does not exist", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v13-noaios-"));
  const result = runFail(["index", "--path", path.join(tempRoot, "nope")]);
  assert.match(result.stderr, /No AIOS folder found/);
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v13-test-"));
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
