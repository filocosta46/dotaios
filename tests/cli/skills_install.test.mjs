import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-install-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, homePath, tempRoot };
}

test("skills install fans the canonical skills into native agent directories", async () => {
  const { aiosPath, homePath } = setupAios();

  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);

  const source = path.join(aiosPath, "skills", "plan-today");
  for (const target of [
    path.join(homePath, ".agents", "skills", "plan-today"),
    path.join(homePath, ".claude", "skills", "plan-today")
  ]) {
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(target), source);
  }
});

test("installing a raw skill also propagates it to native agent directories", () => {
  const { aiosPath, homePath, tempRoot } = setupAios();
  const rawSkill = path.join(tempRoot, "demo-skill");
  fs.mkdirSync(rawSkill, { recursive: true });
  fs.writeFileSync(
    path.join(rawSkill, "SKILL.md"),
    "---\nname: demo-skill\ndescription: A test skill\n---\n\n# Demo\n"
  );

  run(["install", rawSkill, "--path", aiosPath, "--home", homePath]);

  const source = path.join(aiosPath, "skills", "demo-skill");
  for (const target of [
    path.join(homePath, ".agents", "skills", "demo-skill"),
    path.join(homePath, ".claude", "skills", "demo-skill")
  ]) {
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(target), source);
  }
});

test("installing a plugin exposes its declared skill and propagates it natively", () => {
  const { aiosPath, homePath } = setupAios();
  const pluginPath = path.join(repoRoot, "examples", "plugins", "hello-memory");

  run(["install", pluginPath, "--path", aiosPath, "--home", homePath]);

  const source = path.join(aiosPath, "skills", "hello-memory");
  assert.ok(fs.existsSync(path.join(source, "SKILL.md")));
  for (const target of [
    path.join(homePath, ".agents", "skills", "hello-memory"),
    path.join(homePath, ".claude", "skills", "hello-memory")
  ]) {
    assert.equal(fs.readlinkSync(target), source);
  }
});

test("removing a plugin removes its exposed skill and native links", () => {
  const { aiosPath, homePath } = setupAios();
  const pluginPath = path.join(repoRoot, "examples", "plugins", "hello-memory");
  run(["install", pluginPath, "--path", aiosPath, "--home", homePath]);
  run(["skill", "remove", "hello-memory", "--path", aiosPath, "--home", homePath]);

  assert.equal(fs.existsSync(path.join(aiosPath, "skills", "hello-memory")), false);
  assert.equal(fs.existsSync(path.join(homePath, ".agents", "skills", "hello-memory")), false);
});

test("skills doctor returns a read-only JSON coverage report", () => {
  const { aiosPath, homePath } = setupAios();
  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);

  const result = run(
    ["skills", "doctor", "--json", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  const report = JSON.parse(result.stdout);
  assert.ok(report.source.count > 0);
  assert.equal(report.targets.find((target) => target.dir === ".agents/skills").missing.length, 0);
  assert.equal(report.targets.find((target) => target.dir === ".agents/skills").foreign.length, 0);
});
