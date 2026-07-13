import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectSkillHealth } from "../../packages/core/src/skill-health.mjs";
import { installSymlinkSkills } from "../../packages/core/src/skills-install.mjs";
import { writeSkillsIndex } from "../../packages/core/src/skills.mjs";

async function makeAios() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-health-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  await fs.mkdir(path.join(aiosPath, "skills", "today"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "today", "SKILL.md"),
    "---\nname: today\ndescription: plan today\ntriggers:\n  - plan today\n---\n"
  );
  await writeSkillsIndex(aiosPath);
  await fs.mkdir(path.join(homePath, ".hermes"), { recursive: true });
  await fs.writeFile(
    path.join(homePath, ".hermes", "config.yaml"),
    `skills:\n  external_dirs:\n    - ${path.join(aiosPath, "skills")}\n`
  );
  return { aiosPath, homePath };
}

test("inspectSkillHealth reports complete native coverage and fresh catalogs", async () => {
  const { aiosPath, homePath } = await makeAios();
  for (const targetDir of [
    path.join(homePath, ".agents", "skills"),
    path.join(homePath, ".claude", "skills")
  ]) {
    await installSymlinkSkills({ aiosPath, targetDir });
  }

  const report = await inspectSkillHealth({ aiosPath, homePath });
  assert.equal(report.source.count, 1);
  assert.equal(report.catalogs.index.current, true);
  assert.equal(report.catalogs.resolver.current, true);
  assert.equal(report.targets.every((target) => target.complete), true);
  assert.equal(report.hermes.configs[0].status, "healthy");
});

test("inspectSkillHealth accepts a valid indirect link through the shared agents directory", async () => {
  const { aiosPath, homePath } = await makeAios();
  const shared = path.join(homePath, ".agents", "skills");
  const claude = path.join(homePath, ".claude", "skills");
  await installSymlinkSkills({ aiosPath, targetDir: shared });
  await fs.mkdir(path.dirname(claude), { recursive: true });
  await fs.symlink(shared, claude, "dir");

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const target = report.targets.find((entry) => entry.dir === ".claude/skills");
  assert.deepEqual(target.foreign, []);
  assert.deepEqual(target.broken, []);
  assert.deepEqual(target.linked, ["today"]);
});

test("inspectSkillHealth reports missing, foreign, stale, and absent Hermes surfaces without writing", async () => {
  const { aiosPath, homePath } = await makeAios();
  const agentsDir = path.join(homePath, ".agents", "skills");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(path.join(agentsDir, "today"), { recursive: true });
  await fs.mkdir(path.join(homePath, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(homePath, ".claude", "CLAUDE.md"),
    "<!-- dotaios-managed:start -->\n@/var/folders/old/aios/AGENTS.md\n<!-- dotaios-managed:end -->\n"
  );
  await fs.writeFile(path.join(aiosPath, "skills", "RESOLVER.md"), "stale\n");
  await fs.rm(path.join(homePath, ".hermes", "config.yaml"));

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const shared = report.targets.find((target) => target.dir === ".agents/skills");
  assert.deepEqual(shared.missing, []);
  assert.equal(shared.foreign.length, 1);
  assert.equal(report.catalogs.resolver.current, false);
  assert.equal(report.bridges.find((bridge) => bridge.name === "Claude Code").status, "stale");
  assert.equal(report.hermes.configs[0].status, "missing");
  assert.equal(report.healthy, false);
});

test("inspectSkillHealth does not fail for agents and Hermes that are not installed", async () => {
  const { aiosPath, homePath } = await makeAios();
  await fs.rm(path.join(homePath, ".hermes"), { recursive: true, force: true });

  const report = await inspectSkillHealth({ aiosPath, homePath });
  assert.equal(report.healthy, true);
  assert.ok(report.targets.every((target) => target.status === "not-detected"));
  assert.ok(report.bridges.every((bridge) => bridge.status === "not-detected"));
  assert.equal(report.hermes.available, false);
});

test("inspectSkillHealth enumerates stale extra native links", async () => {
  const { aiosPath, homePath } = await makeAios();
  const targetDir = path.join(homePath, ".agents", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  const staleSource = path.join(aiosPath, "skills", "removed-skill");
  await fs.symlink(staleSource, path.join(targetDir, "removed-skill"), "dir");

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const target = report.targets.find((entry) => entry.dir === ".agents/skills");
  assert.equal(target.extra.length, 1);
  assert.equal(target.stale.length, 1);
  assert.equal(target.extra[0].kind, "stale-owned");
  assert.equal(report.healthy, false);
});
