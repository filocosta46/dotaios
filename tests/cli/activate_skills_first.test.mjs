import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function makeTmpDirs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-skillsfirst-"));
  const aiosPath = path.join(base, "aios");
  const homePath = path.join(base, "home");
  await fs.mkdir(path.join(aiosPath, "skills"), { recursive: true });
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  await fs.mkdir(path.join(aiosPath, "skills", "test-skill"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "test-skill", "SKILL.md"),
    "---\nname: test-skill\ndescription: A test skill.\ntriggers: test this, run a test\n---\n# test-skill\n"
  );
  return { base, aiosPath, homePath };
}

describe("activateCommand --skills-first", () => {
  let dirs;

  before(async () => { dirs = await makeTmpDirs(); });
  after(async () => { await fs.rm(dirs.base, { recursive: true, force: true }); });

  it("inlines the skill catalog into the bridge and persists skills_first into aios.json", async () => {
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await activateCommand([
      "--path", dirs.aiosPath,
      "--home", dirs.homePath,
      "--all",
      "--skills-first"
    ]);

    const cfg = JSON.parse(await fs.readFile(path.join(dirs.aiosPath, "aios.json"), "utf8"));
    assert.equal(cfg.skills_first, true);

    const bridge = await fs.readFile(path.join(dirs.homePath, ".claude", "CLAUDE.md"), "utf8");
    assert.match(bridge, /Skills first \(inlined by/);
    assert.match(bridge, /test-skill/);
    assert.match(bridge, /run a test/);

    // INDEX.md and RESOLVER.md must be regenerated so the inlined catalog is current.
    const index = await fs.readFile(path.join(dirs.aiosPath, "skills", "INDEX.md"), "utf8");
    assert.match(index, /## test-skill/);
  });

  it("default activate keeps pointer-mode (no inlined catalog) when skills_first is unset", async () => {
    const { aiosPath, homePath } = dirs;
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await activateCommand([
      "--path", aiosPath,
      "--home", homePath,
      "--all",
      "--no-skills-first",
      "--overwrite"
    ]);

    const cfg = JSON.parse(await fs.readFile(path.join(aiosPath, "aios.json"), "utf8"));
    assert.equal(cfg.skills_first, false);

    const bridge = await fs.readFile(path.join(homePath, ".claude", "CLAUDE.md"), "utf8");
    assert.doesNotMatch(bridge, /Skills first \(inlined by/);
    assert.match(bridge, /read .*skills\/INDEX\.md/);
  });
});
