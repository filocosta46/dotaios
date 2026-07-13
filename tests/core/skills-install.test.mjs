import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installSymlinkSkills, cleanupStaleLinks, removeManagedSkillLinks } from "../../packages/core/src/skills-install.mjs";

async function tmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "aios-test-"));
}
async function makeSkill(aios, name) {
  const dir = path.join(aios, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test ${name}\n---\nbody\n`);
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
