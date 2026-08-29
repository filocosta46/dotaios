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

function runApprovedProjectAdd({ homePath, aiosPath, projectPath, name }) {
  const env = { ...process.env, HOME: homePath };
  const baseArgs = [cli, "project", "add", projectPath, "--path", aiosPath, "--name", name];
  const preview = spawnSync(process.execPath, [...baseArgs, "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(preview.status, 0, `preview failed:\n${preview.stdout}\n${preview.stderr}`);
  const proof = JSON.parse(preview.stdout).plan;
  return spawnSync(process.execPath, [
    ...baseArgs,
    "--operation-id", proof.operation_id,
    "--plan-fingerprint", proof.plan_fingerprint,
    "--yes"
  ], { cwd: repoRoot, encoding: "utf8", env });
}

test("a spawned command with HOME pinned never writes outside that home", () => {
  const { homePath, aiosPath, projectPath } = makeSandbox();

  // Deliberately omit --home. HOME alone must be enough to contain the write.
  const result = runApprovedProjectAdd({ homePath, aiosPath, projectPath, name: "isolation-probe" });

  assert.equal(result.status, 0, `attach failed:\n${result.stdout}\n${result.stderr}`);

  const sandboxState = path.join(homePath, ".dotaios", "projects.json");
  assert.ok(fs.existsSync(sandboxState), "the registry must land inside the pinned HOME");

  // The machine-local registry keeps both the checkout path and the directory
  // identity used to revalidate it before disclosure. Portable project truth
  // remains in AIOS under projects/<slug>/README.md.
  const state = JSON.parse(fs.readFileSync(sandboxState, "utf8"));
  const mappings = Object.values(state.paths || {});
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].path, projectPath);
  assert.deepEqual(Object.keys(mappings[0].root_identity).sort(), ["dev", "ino", "type"]);
  assert.equal(mappings[0].root_identity.type, "directory");
});

test("the real user registry is untouched by a HOME-pinned run", () => {
  const { homePath, aiosPath, projectPath } = makeSandbox();
  const realState = path.join(os.homedir(), ".dotaios", "projects.json");
  const before = fs.existsSync(realState) ? fs.readFileSync(realState, "utf8") : null;

  runApprovedProjectAdd({ homePath, aiosPath, projectPath, name: "must-not-leak" });

  const after = fs.existsSync(realState) ? fs.readFileSync(realState, "utf8") : null;
  assert.equal(after, before, "the developer's own ~/.dotaios/projects.json must not change");
  if (after) assert.doesNotMatch(after, /must-not-leak/);
});
