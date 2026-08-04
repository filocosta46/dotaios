import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// Regression guard. `createContext` (packages/core/src/projects.mjs) resolves the
// project registry to `os.homedir()/.dotaios/projects.json` whenever no explicit
// home is supplied. A CLI test that spawns without pinning HOME therefore writes
// the developer's real registry — which is exactly what happened: the maintainer's
// ~/.dotaios/projects.json grew to 351 KB of temp-directory entries, and the
// suite went intermittently red because runs raced on that shared file.
//
// These tests fail if any spawned command can reach a home the caller did not
// choose.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-isolation-"));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "project");
  for (const dir of [homePath, aiosPath, projectPath]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [] })
  );
  fs.writeFileSync(path.join(aiosPath, "AGENTS.md"), "# Sandbox AIOS\n");
  return { root, homePath, aiosPath, projectPath };
}

test("a spawned command with HOME pinned never writes outside that home", () => {
  const { homePath, aiosPath, projectPath } = makeSandbox();

  // Deliberately omit --home. HOME alone must be enough to contain the write.
  const result = spawnSync(
    process.execPath,
    [cli, "project", "add", projectPath, "--path", aiosPath, "--name", "isolation-probe", "--yes"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: homePath } }
  );

  assert.equal(result.status, 0, `attach failed:\n${result.stdout}\n${result.stderr}`);

  const sandboxState = path.join(homePath, ".dotaios", "projects.json");
  assert.ok(fs.existsSync(sandboxState), "the registry must land inside the pinned HOME");

  // The machine-local registry maps project id -> checkout path only; the
  // portable name lives in AIOS under projects/<slug>/README.md. Assert on the
  // path mapping, which is what this file is actually contracted to hold.
  const state = JSON.parse(fs.readFileSync(sandboxState, "utf8"));
  assert.deepEqual(Object.values(state.paths || {}), [projectPath]);
});

test("the real user registry is untouched by a HOME-pinned run", () => {
  const { homePath, aiosPath, projectPath } = makeSandbox();
  const realState = path.join(os.homedir(), ".dotaios", "projects.json");
  const before = fs.existsSync(realState) ? fs.readFileSync(realState, "utf8") : null;

  spawnSync(
    process.execPath,
    [cli, "project", "add", projectPath, "--path", aiosPath, "--name", "must-not-leak", "--yes"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, HOME: homePath } }
  );

  const after = fs.existsSync(realState) ? fs.readFileSync(realState, "utf8") : null;
  assert.equal(after, before, "the developer's own ~/.dotaios/projects.json must not change");
  if (after) assert.doesNotMatch(after, /must-not-leak/);
});
