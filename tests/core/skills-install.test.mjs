import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSymlinkSkills, cleanupStaleLinks, removeManagedSkillLinks, removeManagedSkillAliases } from "../../packages/core/src/skills-install.mjs";

async function tmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "aios-test-"));
}
async function makeSkill(aios, name, frontmatterName = name) {
  const dir = path.join(aios, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${frontmatterName}\ndescription: test ${name}\n---\nbody\n`);
}

test("installSymlinkSkills links each source skill into the target dir", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  await makeSkill(aios, "closeday");
  const targetDir = path.join(home, ".agents", "skills");

  const results = await installSymlinkSkills({ aiosPath: aios, targetDir });

  const linked = results.filter((r) => r.action === "linked").map((r) => path.basename(r.path)).sort();
  assert.deepEqual(linked, ["closeday", "today"]);
  const stat = await fs.lstat(path.join(targetDir, "today"));
  assert.ok(stat.isSymbolicLink());
  assert.equal(await fs.readlink(path.join(targetDir, "today")), path.join(aios, "skills", "today"));
});

test("installSymlinkSkills is idempotent (already-linked skips)", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".agents", "skills");
  await installSymlinkSkills({ aiosPath: aios, targetDir });
  const second = await installSymlinkSkills({ aiosPath: aios, targetDir });
  assert.equal(second.find((r) => path.basename(r.path) === "today").action, "already-linked");
});

test("installSymlinkSkills keeps an unmanaged real dir unless overwrite", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".agents", "skills");
  await fs.mkdir(path.join(targetDir, "today"), { recursive: true });
  const res = await installSymlinkSkills({ aiosPath: aios, targetDir });
  assert.equal(res.find((r) => path.basename(r.path) === "today").action, "kept");
});

test("installSymlinkSkills repairs a stale temporary DotAIOS link without overwrite", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".agents", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  const stale = path.join(os.tmpdir(), "dotaios-activate-dead", "aios", "skills", "today");
  await fs.symlink(stale, path.join(targetDir, "today"), "dir");

  const result = await installSymlinkSkills({ aiosPath: aios, targetDir });
  assert.equal(result.find((entry) => path.basename(entry.path) === "today").action, "repaired");
  assert.equal(await fs.readlink(path.join(targetDir, "today")), path.join(aios, "skills", "today"));
});

test("keeps a live temporary-looking link instead of repairing it", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".agents", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  const live = path.join(os.tmpdir(), "dotaios-live-link", "aios", "skills", "today");
  await fs.mkdir(live, { recursive: true });
  await fs.symlink(live, path.join(targetDir, "today"), "dir");

  const result = await installSymlinkSkills({ aiosPath: aios, targetDir });
  assert.equal(result.find((entry) => path.basename(entry.path) === "today").action, "kept");
  assert.equal(await fs.readlink(path.join(targetDir, "today")), live);
  await fs.rm(path.join(os.tmpdir(), "dotaios-live-link"), { recursive: true, force: true });
});

test("installSymlinkSkills dry-run writes nothing", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".agents", "skills");
  const res = await installSymlinkSkills({ aiosPath: aios, targetDir, dryRun: true });
  assert.equal(res.find((r) => path.basename(r.path) === "today").action, "would link");
  await assert.rejects(fs.lstat(path.join(targetDir, "today")));
});

test("installSymlinkSkills rejects a project source root symlink before reading it", async () => {
  const project = await tmp();
  const outside = await tmp();
  await makeSkill(outside, "external");
  await fs.symlink(path.join(outside, "skills"), path.join(project, "skills"), "dir");
  const targetDir = path.join(project, ".agents", "skills");

  const result = await installSymlinkSkills({
    aiosPath: project,
    sourceDir: path.join(project, "skills"),
    targetDir,
    projectRoot: project
  });

  assert.equal(result[0].action, "skipped-unsafe-source");
  assert.match(result[0].note, /source.*symlink/i);
  await assert.rejects(fs.lstat(path.join(targetDir, "external")));
  assert.equal((await fs.lstat(path.join(outside, "skills", "external"))).isDirectory(), true);
});

test("installSymlinkSkills rejects a project SKILL.md symlink before reading it", async () => {
  const project = await tmp();
  const outside = path.join(project, "outside-skill.md");
  await makeSkill(project, "project");
  await fs.writeFile(outside, "---\nname: external\ndescription: external\n---\n");
  await fs.rm(path.join(project, "skills", "project", "SKILL.md"));
  await fs.symlink(outside, path.join(project, "skills", "project", "SKILL.md"), "file");
  const targetDir = path.join(project, ".agents", "skills");

  const result = await installSymlinkSkills({
    aiosPath: project,
    sourceDir: path.join(project, "skills"),
    targetDir,
    projectRoot: project
  });

  assert.equal(result[0].action, "skipped-unsafe-source");
  assert.match(result[0].note, /skill file.*symlink/i);
  await assert.rejects(fs.lstat(path.join(targetDir, "project")));
  assert.equal(await fs.readFile(outside, "utf8"), "---\nname: external\ndescription: external\n---\n");
});

test("installSymlinkSkills never overwrites an overlapping project source", async () => {
  const project = await tmp();
  await makeSkill(project, "project");
  const skillsRoot = path.join(project, "skills");
  const skillFile = path.join(skillsRoot, "project", "SKILL.md");

  const result = await installSymlinkSkills({
    aiosPath: project,
    sourceDir: skillsRoot,
    targetDir: skillsRoot,
    projectRoot: project,
    overwrite: true
  });

  assert.equal(result[0].action, "skipped-unsafe-target");
  assert.match(result[0].note, /overlaps.*source/i);
  assert.equal((await fs.lstat(path.join(skillsRoot, "project"))).isDirectory(), true);
  assert.match(await fs.readFile(skillFile, "utf8"), /name: project/);
});

test("installSymlinkSkills rejects a symlink alias of the source as an overwrite target", async () => {
  const project = await tmp();
  await makeSkill(project, "project");
  const skillsRoot = path.join(project, "skills");
  const targetDir = path.join(project, ".custom", "skills");
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.symlink(skillsRoot, targetDir, "dir");

  const result = await installSymlinkSkills({
    aiosPath: project,
    sourceDir: skillsRoot,
    targetDir,
    overwrite: true
  });

  assert.equal(result[0].action, "skipped-unsafe-target");
  assert.match(result[0].note, /overlaps.*source/i);
  assert.equal((await fs.lstat(path.join(skillsRoot, "project"))).isDirectory(), true);
  assert.match(await fs.readFile(path.join(skillsRoot, "project", "SKILL.md"), "utf8"), /name: project/);
});

test("cleanupStaleLinks removes owned links whose source skill is gone, keeps others", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".agents", "skills");
  await installSymlinkSkills({ aiosPath: aios, targetDir });

  await fs.rm(path.join(aios, "skills", "today"), { recursive: true, force: true });
  await fs.mkdir(path.join(targetDir, "vendor-skill"), { recursive: true });

  const removed = await cleanupStaleLinks({ aiosPath: aios, targetDir });
  assert.deepEqual(removed.map((r) => path.basename(r.path)), ["today"]);
  await assert.rejects(fs.lstat(path.join(targetDir, "today")));
  assert.ok((await fs.lstat(path.join(targetDir, "vendor-skill"))).isDirectory());
});

test("cleanupStaleLinks preserves a broken foreign alias into the AIOS tree", async () => {
  const aios = await tmp();
  const home = await tmp();
  const targetDir = path.join(home, ".agents", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  const missingSource = path.join(aios, "skills", "removed-skill");
  await fs.symlink(missingSource, path.join(targetDir, "vendor-alias"), "dir");

  const removed = await cleanupStaleLinks({ aiosPath: aios, targetDir });

  assert.deepEqual(removed, []);
  assert.ok((await fs.lstat(path.join(targetDir, "vendor-alias"))).isSymbolicLink());
});

test("cleanupStaleLinks removes an owned dead temporary activation link", async () => {
  const aios = await tmp();
  const home = await tmp();
  const targetDir = path.join(home, ".agents", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  const staleSource = path.join(os.tmpdir(), "dotaios-cleanup-dead", "aios", "skills", "today");
  await fs.symlink(staleSource, path.join(targetDir, "today"), "dir");

  const removed = await cleanupStaleLinks({ aiosPath: aios, targetDir });

  assert.deepEqual(removed.map((entry) => path.basename(entry.path)), ["today"]);
  await assert.rejects(fs.lstat(path.join(targetDir, "today")));
});

test("removeManagedSkillLinks retires only DotAIOS-owned links", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".gemini", "skills");
  await installSymlinkSkills({ aiosPath: aios, targetDir });
  await fs.mkdir(path.join(targetDir, "vendor-skill"), { recursive: true });
  await fs.writeFile(path.join(targetDir, "vendor-skill", "SKILL.md"), "vendor\n");
  await fs.symlink("/Users/vendor/skill", path.join(targetDir, "vendor-link"), "dir");

  const removed = await removeManagedSkillLinks({ aiosPath: aios, targetDir });

  assert.deepEqual(removed.map((entry) => path.basename(entry.path)), ["today"]);
  await assert.rejects(fs.lstat(path.join(targetDir, "today")));
  assert.ok((await fs.lstat(path.join(targetDir, "vendor-skill"))).isDirectory());
  assert.ok((await fs.lstat(path.join(targetDir, "vendor-link"))).isSymbolicLink());
});

test("removeManagedSkillLinks preserves a foreign alias into the AIOS skill tree", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "today");
  const targetDir = path.join(home, ".gemini", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.symlink(path.join(aios, "skills", "today"), path.join(targetDir, "vendor-today"), "dir");

  const removed = await removeManagedSkillLinks({ aiosPath: aios, targetDir });

  assert.deepEqual(removed, []);
  assert.ok((await fs.lstat(path.join(targetDir, "vendor-today"))).isSymbolicLink());
});

test("removeManagedSkillAliases removes only frontmatter aliases and preserves foreign entries", async () => {
  const aios = await tmp();
  const home = await tmp();
  await makeSkill(aios, "taste-skill", "design-taste-frontend");
  const targetDir = path.join(home, ".agents", "skills");
  await fs.mkdir(targetDir, { recursive: true });
  const canonical = path.join(aios, "skills", "taste-skill");
  await fs.symlink(canonical, path.join(targetDir, "design-taste-frontend"), "dir");
  await fs.symlink(canonical, path.join(targetDir, "vendor-taste"), "dir");
  await fs.mkdir(path.join(targetDir, "design-taste-frontend-real"), { recursive: true });

  const preview = await removeManagedSkillAliases({ aiosPath: aios, targetDir, dryRun: true });
  assert.deepEqual(preview.map((entry) => path.basename(entry.path)), ["design-taste-frontend"]);
  assert.ok((await fs.lstat(path.join(targetDir, "design-taste-frontend"))).isSymbolicLink());

  const removed = await removeManagedSkillAliases({ aiosPath: aios, targetDir });
  assert.deepEqual(removed.map((entry) => path.basename(entry.path)), ["design-taste-frontend"]);
  await assert.rejects(fs.lstat(path.join(targetDir, "design-taste-frontend")));
  assert.ok((await fs.lstat(path.join(targetDir, "vendor-taste"))).isSymbolicLink());
  assert.ok((await fs.lstat(path.join(targetDir, "design-taste-frontend-real"))).isDirectory());
});
