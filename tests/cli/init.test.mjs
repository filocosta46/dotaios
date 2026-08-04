import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("init fails fast on an unusable --vault-path before writing any files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const blocker = path.join(root, "blocker.txt");
  fs.writeFileSync(blocker, "not a directory\n");
  const target = path.join(root, "aios");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--path", target, "--vault-path", path.join(blocker, "vault")],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--vault-path/);
  assert.equal(fs.existsSync(target), false, "init must not create the AIOS folder when --vault-path is invalid");
});

test("init creates the vault at a creatable --vault-path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const target = path.join(root, "aios");
  const vault = path.join(root, "deep", "vault");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--path", target, "--vault-path", vault],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(vault, "wiki")), true);
  assert.equal(fs.existsSync(path.join(target, "aios.json")), true);
});

test("a freshly initialized folder ships a lean memory-maintenance router", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const target = path.join(root, "aios");

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(
    fs.existsSync(path.join(target, "skills", "memory-maintenance", "SKILL.md")),
    true,
    "the skill must reach a new user, not just the repo"
  );

  const registry = JSON.parse(fs.readFileSync(path.join(target, "skills", "_registry.json"), "utf8"));
  assert.ok(registry.skills.includes("memory-maintenance"), "the registry must list it");

  const index = fs.readFileSync(path.join(target, "skills", "INDEX.md"), "utf8");
  assert.match(index, /memory-maintenance/, "the generated index must surface it");

  const agents = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
  assert.match(agents, /## Keeping Knowledge True/, "the rendered AGENTS.md must retain the lifecycle boundary");
  assert.match(agents, /memory-maintenance/);
  assert.doesNotMatch(agents, /--operation supersede/, "the detailed procedure belongs in the skill");
  assert.doesNotMatch(agents, /git clone <url> \/tmp\/dotaios-plugin/, "third-party installation belongs in docs");
});

test("a new folder ships a scheduled memory check, not just a skills-symlink check", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const target = path.join(root, "aios");

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const schedules = fs.readFileSync(path.join(target, "schedules.yml"), "utf8");

  assert.match(schedules, /dotaios memory audit/, "staleness must be detectable on a clock, not only when someone remembers");
  assert.doesNotMatch(
    schedules,
    /dotaios skills doctor/,
    "the weekly health check must inspect memory, not skill symlinks"
  );
  assert.match(schedules, /dotaios doctor/, "the health check must be the one that reads memory and context freshness");

  // Scheduling must stay opt-in: DotAIOS may not install OS jobs a user never asked for.
  const enabled = schedules.split("\n").filter((line) => line.includes("enabled:"));
  assert.ok(enabled.length >= 3, "every shipped schedule declares its enabled state");
  assert.ok(enabled.every((line) => line.includes("false")), "shipped schedules must default to off");
});
