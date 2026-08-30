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
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });
  const rawSkill = path.join(tempRoot, "demo-skill");
  fs.mkdirSync(rawSkill, { recursive: true });
  fs.writeFileSync(
    path.join(rawSkill, "SKILL.md"),
    "---\nname: demo-skill\ndescription: A test skill\n---\n\n# Demo\n"
  );

  const preview = run(["skills", "adopt", rawSkill, "--path", aiosPath, "--home", homePath, "--json"]);
  const proof = JSON.parse(preview.stdout);
  run([
    "skills", "adopt", rawSkill, "--path", aiosPath, "--home", homePath,
    "--apply", proof.operation_id, "--fingerprint", proof.plan_fingerprint
  ]);

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

test("adoption refuses a plain-Markdown raw skill without required Agent Skills metadata", () => {
  const { aiosPath, homePath, tempRoot } = setupAios();
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });
  const rawSkill = path.join(tempRoot, "plain-skill");
  fs.mkdirSync(rawSkill, { recursive: true });
  fs.writeFileSync(path.join(rawSkill, "SKILL.md"), "# Plain Skill\n\nFollow the reviewed workflow.\n");

  const result = run(["skills", "adopt", rawSkill, "--path", aiosPath, "--home", homePath], { allowNonZero: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /frontmatter/i);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills", "plain-skill")), false);
});

test("installing a plugin exposes its declared skill and propagates it natively", () => {
  const { aiosPath, homePath } = setupAios();
  fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true });
  const pluginPath = path.join(repoRoot, "examples", "plugins", "hello-memory");

  const preview = run(["skills", "adopt", pluginPath, "--path", aiosPath, "--home", homePath, "--json"]);
  const proof = JSON.parse(preview.stdout);
  run([
    "skills", "adopt", pluginPath, "--path", aiosPath, "--home", homePath,
    "--apply", proof.operation_id, "--fingerprint", proof.plan_fingerprint
  ]);

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
  fs.mkdirSync(homePath, { recursive: true });
  const pluginPath = path.join(repoRoot, "examples", "plugins", "hello-memory");
  const adoption = JSON.parse(run([
    "skills", "adopt", pluginPath, "--path", aiosPath, "--home", homePath, "--json"
  ]).stdout);
  run([
    "skills", "adopt", pluginPath, "--path", aiosPath, "--home", homePath,
    "--apply", adoption.operation_id, "--fingerprint", adoption.plan_fingerprint
  ]);
  const removal = JSON.parse(run([
    "skills", "remove", "hello-memory", "--path", aiosPath, "--home", homePath, "--json"
  ]).stdout);
  run([
    "skills", "remove", "hello-memory", "--path", aiosPath, "--home", homePath,
    "--apply", removal.operation_id, "--fingerprint", removal.plan_fingerprint
  ]);

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

test("skills doctor keeps real skills available beside a linked top-level entry", () => {
  const { aiosPath, homePath, tempRoot } = setupAios();
  const outside = path.join(tempRoot, "outside-skill");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(outside, "SKILL.md"),
    "---\nname: OUTSIDE_SKILL_CANARY\ndescription: Must never be read.\n---\n",
  );
  fs.symlinkSync(outside, path.join(aiosPath, "skills", "linked-entry"), "dir");
  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);

  const result = run(
    ["skills", "doctor", "--json", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true },
  );
  const report = JSON.parse(result.stdout);

  assert.ok(report.source.count > 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /OUTSIDE_SKILL_CANARY|linked-entry/);
});

test("skills doctor human output labels configuration evidence separately from invocation", () => {
  const { aiosPath, homePath } = setupAios();
  run(["skills", "install", "--path", aiosPath, "--home", homePath, "--all"]);

  const result = run(
    ["skills", "doctor", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  assert.match(result.stdout, /Verification scope: configuration-and-projection-only; invocation=not-run/);
  assert.match(result.stdout, /configured=yes projected=yes discoverable=not-probed/);
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

  const refused = run([
    "skills", "install", "--path", aiosPath, "--home", homePath, "--all",
    "--prune-aliases"
  ], { allowNonZero: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /ManagedSkillStore removal proof/i);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(targetDir, "plan-today")), source);
});

test("activation covers detected native clients and every Hermes profile without clobbering foreign skills", async () => {
  const { aiosPath, homePath } = setupAios();
  const skillName = "plan-today";
  const source = path.join(aiosPath, "skills", skillName);
  const canonicalSkills = path.join(aiosPath, "skills");
  const profilePath = path.join(homePath, ".hermes", "profiles", "bill", "config.yaml");

  for (const dir of [".claude", ".codex", ".gemini", ".cursor", ".gemini/antigravity", ".grok"]) {
    fs.mkdirSync(path.join(homePath, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(homePath, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(homePath, ".gemini", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(homePath, ".grok", "config.toml"), "\n");
  fs.mkdirSync(path.join(homePath, ".hermes", "profiles", "bill"), { recursive: true });
  fs.writeFileSync(
    path.join(homePath, ".hermes", "config.yaml"),
    "model:\n  provider: openrouter\nskills:\n  external_dirs: []\n"
  );
  fs.writeFileSync(
    profilePath,
    "model:\n  provider: openrouter\nskills:\n    external_dirs:\n      - /Users/tester/aios/skills\n"
  );

  const foreign = path.join(homePath, ".cursor", "skills", "humanizer");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "SKILL.md"), "foreign skill\n");
  for (const retiredDir of [
    path.join(homePath, ".cursor", "skills"),
    path.join(homePath, ".gemini", "skills"),
    path.join(homePath, ".gemini", "antigravity", "skills")
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
    ".gemini/config/skills",
    ".grok/skills"
  ]) {
    const link = path.join(homePath, targetDir, skillName);
    assert.equal(fs.readlinkSync(link), source, `${targetDir} should expose the canonical skill`);
  }
  assert.equal(fs.readFileSync(path.join(foreign, "SKILL.md"), "utf8"), "foreign skill\n");
  // Retiring a target must never delete what is already sitting in it. Real
  // installs have years of entries under `~/.gemini/antigravity/skills`, so the
  // retired list is a migration marker, not a cleanup instruction: activate
  // leaves both DotAIOS-owned links and foreign directories in place there.
  for (const retiredDir of [
    path.join(homePath, ".cursor", "skills"),
    path.join(homePath, ".gemini", "skills"),
    path.join(homePath, ".gemini", "antigravity", "skills")
  ]) {
    assert.equal(fs.lstatSync(path.join(retiredDir, skillName)).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(retiredDir, "coding-standards", "SKILL.md"), "utf8"), "foreign skill\n");
  }

  for (const configPath of [path.join(homePath, ".hermes", "config.yaml"), profilePath]) {
    const config = fs.readFileSync(configPath, "utf8");
    assert.equal(config.split(canonicalSkills).length - 1, 1);
  }
  assert.match(fs.readFileSync(profilePath, "utf8"), /- \/Users\/tester\/aios\/skills/);

  const doctor = run(
    ["skills", "doctor", "--json", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.hermes.configs.length, 2);
  assert.ok(report.hermes.configs.every((entry) => entry.status === "healthy"));
});
