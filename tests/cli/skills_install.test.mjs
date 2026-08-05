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

test("skills doctor human output labels configuration evidence separately from invocation", () => {
  const { aiosPath, homePath } = setupAios();
  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);

  const result = run(
    ["skills", "doctor", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  assert.match(result.stdout, /Verification scope: configuration-only; invocation=not-run/);
  assert.match(result.stdout, /configured=yes discoverable=path-ready/);
});

test("alias pruning is explicit, dry-run first, and preserves the ordinary install path", () => {
  const { aiosPath, homePath } = setupAios();
  const source = path.join(aiosPath, "skills", "plan-today");
  fs.writeFileSync(
    path.join(source, "SKILL.md"),
    "---\nname: daily-planning\ndescription: test\n---\n# Plan\n"
  );

  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);
  const targetDir = path.join(homePath, ".agents", "skills");
  const alias = path.join(targetDir, "daily-planning");
  fs.symlinkSync(source, alias, "dir");

  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);

  const preview = run([
    "skills", "install", "--path", aiosPath, "--home", homePath, "--all",
    "--prune-aliases", "--dry-run"
  ]);
  assert.match(preview.stdout, /would-remove.*daily-planning/);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);

  run([
    "skills", "install", "--path", aiosPath, "--home", homePath, "--all",
    "--prune-aliases"
  ]);
  assert.equal(fs.existsSync(alias), false);
  assert.equal(fs.readlinkSync(path.join(targetDir, "plan-today")), source);
});

test("activation covers detected native clients and every Hermes profile without clobbering foreign skills", async () => {
  const { aiosPath, homePath } = setupAios();
  const skillName = "plan-today";
  const source = path.join(aiosPath, "skills", skillName);
  const canonicalSkills = path.join(aiosPath, "skills");
  const profilePath = path.join(homePath, ".hermes", "profiles", "bill", "config.yaml");

  for (const dir of [".claude", ".codex", ".gemini", ".cursor", ".gemini/antigravity"]) {
    fs.mkdirSync(path.join(homePath, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(homePath, ".hermes", "profiles", "bill"), { recursive: true });
  fs.writeFileSync(
    path.join(homePath, ".hermes", "config.yaml"),
    "model:\n  provider: openrouter\nskills:\n  external_dirs: []\n"
  );
  fs.writeFileSync(
    profilePath,
    "model:\n  provider: openrouter\nskills:\n    external_dirs:\n      - /Users/filo/aios/skills\n"
  );

  const foreign = path.join(homePath, ".cursor", "skills", "humanizer");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "foreign skill\n");
  for (const retiredDir of [
    path.join(homePath, ".cursor", "skills"),
    path.join(homePath, ".gemini", "skills"),
    path.join(homePath, ".gemini", "config", "skills")
  ]) {
    fs.mkdirSync(retiredDir, { recursive: true });
    fs.symlinkSync(source, path.join(retiredDir, skillName), "dir");
    fs.mkdirSync(path.join(retiredDir, "coding-standards"), { recursive: true });
    fs.writeFileSync(path.join(retiredDir, "coding-standards", "SKILL.md"), "foreign skill\n");
  }

  run(["activate", "--path", aiosPath, "--home", homePath]);
  run(["activate", "--path", aiosPath, "--home", homePath]);

  for (const targetDir of [
    ".agents/skills",
    ".claude/skills",
    ".gemini/antigravity/skills"
  ]) {
    const link = path.join(homePath, targetDir, skillName);
    assert.equal(fs.readlinkSync(link), source, `${targetDir} should expose the canonical skill`);
  }
  assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "foreign skill\n");
  for (const retiredDir of [path.join(homePath, ".cursor", "skills"), path.join(homePath, ".gemini", "skills")]) {
    assert.equal(fs.existsSync(path.join(retiredDir, skillName)), false);
    assert.equal(fs.readFileSync(path.join(retiredDir, "coding-standards", "SKILL.md"), "utf8"), "foreign skill\n");
  }

  for (const configPath of [path.join(homePath, ".hermes", "config.yaml"), profilePath]) {
    const config = fs.readFileSync(configPath, "utf8");
    assert.equal(config.split(canonicalSkills).length - 1, 1);
  }
  assert.match(fs.readFileSync(profilePath, "utf8"), /- \/Users\/filo\/aios\/skills/);

  const doctor = run(
    ["skills", "doctor", "--json", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.hermes.configs.length, 2);
  assert.ok(report.hermes.configs.every((entry) => entry.status === "healthy"));
});
