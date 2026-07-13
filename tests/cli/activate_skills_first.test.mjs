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

async function snapshotTree(root) {
  const snapshot = [];

  async function walk(current, relative = "") {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        snapshot.push({ path: childRelative, type: "symlink", target: await fs.readlink(absolute) });
      } else if (entry.isDirectory()) {
        snapshot.push({ path: childRelative, type: "directory" });
        await walk(absolute, childRelative);
      } else {
        snapshot.push({
          path: childRelative,
          type: "file",
          content: await fs.readFile(absolute, "utf8")
        });
      }
    }
  }

  await walk(root);
  return snapshot;
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

  it("dry-run previews skills-first activation without changing any filesystem state", async () => {
    const dryRunDirs = await makeTmpDirs();
    const indexPath = path.join(dryRunDirs.aiosPath, "skills", "INDEX.md");
    const resolverPath = path.join(dryRunDirs.aiosPath, "skills", "RESOLVER.md");
    const bridgePath = path.join(dryRunDirs.homePath, ".claude", "CLAUDE.md");
    const staleLink = path.join(dryRunDirs.homePath, ".claude", "skills", "stale-skill");
    const hermesConfig = path.join(dryRunDirs.homePath, ".hermes", "config.yaml");

    await fs.writeFile(indexPath, "stale index\n");
    await fs.writeFile(resolverPath, "stale resolver\n");
    await fs.mkdir(path.dirname(bridgePath), { recursive: true });
    await fs.writeFile(
      bridgePath,
      "# Existing\n<!-- dotaios-managed:start -->\nstale\n<!-- dotaios-managed:end -->\n"
    );
    await fs.mkdir(path.dirname(staleLink), { recursive: true });
    await fs.symlink(path.join(dryRunDirs.aiosPath, "skills", "missing-skill"), staleLink);
    await fs.mkdir(path.dirname(hermesConfig), { recursive: true });
    await fs.writeFile(hermesConfig, "skills:\n  external_dirs: []\n");

    const before = await snapshotTree(dryRunDirs.base);
    const output = [];
    const originalLog = console.log;
    console.log = (...values) => output.push(values.join(" "));

    try {
      const { activateCommand } = await import(
        path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
      );
      await activateCommand([
        "--path", dryRunDirs.aiosPath,
        "--home", dryRunDirs.homePath,
        "--all",
        "--dry-run",
        "--skills-first"
      ]);
    } finally {
      console.log = originalLog;
    }

    const after = await snapshotTree(dryRunDirs.base);
    assert.deepEqual(after, before);
    assert.match(output.join("\n"), /\[would refresh\].*INDEX\.md.*RESOLVER\.md/);
    assert.match(output.join("\n"), /\[skills-first\] bridge files would inline the current skill catalog/);
    assert.match(output.join("\n"), /\[would link\].*test-skill/);
    // The target basename differs from the link name, so ownership is not
    // provable and the dry-run must preserve the foreign alias.
    assert.doesNotMatch(output.join("\n"), /\[would remove\].*stale-skill/);

    await fs.rm(dryRunDirs.base, { recursive: true, force: true });
  });
});
