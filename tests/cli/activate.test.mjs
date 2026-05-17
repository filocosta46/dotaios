import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Resolve to repo root from this file's location
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function makeTmpDirs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-activate-"));
  const aiosPath = path.join(base, "aios");
  const homePath = path.join(base, "home");
  await fs.mkdir(path.join(aiosPath, "skills"), { recursive: true });
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  // Write minimal aios.json so ensureAiosFolder passes
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  // Create a fake skill so bridgeSkillsToClaude has something to link
  await fs.mkdir(path.join(aiosPath, "skills", "test-skill"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "test-skill", "SKILL.md"),
    "# Test Skill\nA test skill.\n"
  );
  return { base, aiosPath, homePath };
}

describe("activateCommand — symlinks", () => {
  let dirs;

  before(async () => {
    dirs = await makeTmpDirs();
  });

  after(async () => {
    await fs.rm(dirs.base, { recursive: true, force: true });
  });

  it("creates skill symlink that resolves on this platform", async () => {
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await activateCommand([
      "--path", dirs.aiosPath,
      "--home", dirs.homePath,
      "--all"
    ]);

    const symlinkPath = path.join(dirs.homePath, ".claude", "skills", "test-skill");
    const stat = await fs.lstat(symlinkPath);
    assert.ok(stat.isSymbolicLink(), "expected a symlink");

    const target = await fs.readlink(symlinkPath);
    assert.equal(target, path.join(dirs.aiosPath, "skills", "test-skill"));

    // Verify the symlink is actually traversable (resolves correctly)
    const skillFile = path.join(symlinkPath, "SKILL.md");
    const content = await fs.readFile(skillFile, "utf8");
    assert.ok(content.includes("Test Skill"), "symlink should resolve to skill content");
  });
});
