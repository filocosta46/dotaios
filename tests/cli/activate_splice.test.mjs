import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANAGED_END, MANAGED_START } from "../../packages/core/src/bridges.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

// Everything below runs inside a fresh mkdtemp sandbox and always passes an
// explicit --home. The real ~/.claude, ~/.codex and ~/.gemini are never touched.
async function makeTmpDirs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-activate-splice-"));
  const aiosPath = path.join(base, "aios");
  const homePath = path.join(base, "home");
  await fs.mkdir(path.join(aiosPath, "skills", "test-skill"), { recursive: true });
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  await fs.mkdir(homePath, { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  await fs.writeFile(
    path.join(aiosPath, "skills", "test-skill", "SKILL.md"),
    "---\nname: test-skill\ndescription: a test skill\n---\n\n# Test Skill\n"
  );
  return { base, aiosPath, homePath };
}

async function activate(args) {
  const { activateCommand } = await import(
    path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
  );
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await activateCommand(args);
  } finally {
    console.log = originalLog;
  }
}

const BEFORE = "# My own notes\n\nKeep this paragraph exactly as written.\n\n";
const AFTER = "\n\n## My own rules\n\n- Never delete this line.\n";
const STALE_BLOCK = `${MANAGED_START}\nstale generated content\n${MANAGED_END}`;

function splitAroundBlock(content) {
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END, start + MANAGED_START.length);
  assert.ok(start >= 0, "expected a managed start marker");
  assert.ok(end >= 0, "expected a managed end marker");
  return {
    before: content.slice(0, start),
    block: content.slice(start, end + MANAGED_END.length),
    after: content.slice(end + MANAGED_END.length)
  };
}

async function seedManagedBridge(homePath) {
  const bridge = path.join(homePath, ".claude", "CLAUDE.md");
  await fs.mkdir(path.dirname(bridge), { recursive: true });
  const original = `${BEFORE}${STALE_BLOCK}${AFTER}`;
  await fs.writeFile(bridge, original);
  return { bridge, original, backup: `${bridge}.dotaios-backup` };
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function snapshotTree(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const snapshot = {};
  for (const entry of entries) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const key = path.relative(root, full);
    if (entry.isDirectory()) {
      snapshot[key] = "<dir>";
    } else if (entry.isSymbolicLink()) {
      snapshot[key] = `<link>${await fs.readlink(full)}`;
    } else {
      snapshot[key] = await fs.readFile(full, "utf8");
    }
  }
  return snapshot;
}

describe("activate — managed block splicing", () => {
  it("preserves user content before and after the managed block across repeated runs", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge } = await seedManagedBridge(dirs.homePath);
      const blocks = [];

      for (let run = 0; run < 3; run += 1) {
        await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
        const parts = splitAroundBlock(await fs.readFile(bridge, "utf8"));
        assert.equal(parts.before, BEFORE, `run ${run + 1} must keep the text before the block byte-identical`);
        assert.equal(parts.after, AFTER, `run ${run + 1} must keep the text after the block byte-identical`);
        blocks.push(parts.block);
      }

      // The block itself is regenerated, and its content is stable run to run.
      assert.doesNotMatch(blocks[0], /stale generated content/);
      assert.match(blocks[0], /DotAIOS context/);
      assert.equal(blocks[1], blocks[0]);
      assert.equal(blocks[2], blocks[0]);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("updates the managed block when the generated content changes", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge } = await seedManagedBridge(dirs.homePath);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all", "--no-skills-first"]);
      const pointer = splitAroundBlock(await fs.readFile(bridge, "utf8"));
      assert.doesNotMatch(pointer.block, /Skills first \(inlined by/);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all", "--skills-first"]);
      const inlined = splitAroundBlock(await fs.readFile(bridge, "utf8"));

      assert.match(inlined.block, /Skills first \(inlined by/);
      assert.match(inlined.block, /test-skill/);
      assert.notEqual(inlined.block, pointer.block);
      assert.equal(inlined.before, BEFORE);
      assert.equal(inlined.after, AFTER);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("keeps a file without markers untouched when overwrite is false", async () => {
    const dirs = await makeTmpDirs();
    try {
      const unmanaged = path.join(dirs.homePath, ".codex", "AGENTS.md");
      await fs.mkdir(path.dirname(unmanaged), { recursive: true });
      const original = "# Existing\n\nKeep me.\n";
      await fs.writeFile(unmanaged, original);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);

      assert.equal(await fs.readFile(unmanaged, "utf8"), original);
      assert.equal(await exists(`${unmanaged}.dotaios-backup`), false, "unmanaged files are kept, not backed up");
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("writes the backup exactly once and never overwrites it", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original, backup } = await seedManagedBridge(dirs.homePath);
      await fs.chmod(bridge, 0o600);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
      assert.equal(await fs.readFile(backup, "utf8"), original, "the first spliced write backs up the pre-existing file");
      const firstStat = await fs.stat(backup);
      assert.equal(firstStat.mode & 0o777, 0o600, "the backup preserves the bridge file mode");
      const filesAfterFirstRun = (await fs.readdir(path.dirname(bridge))).sort();

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);

      assert.deepEqual(
        (await fs.readdir(path.dirname(bridge))).sort(),
        filesAfterFirstRun,
        "a no-op re-run must not litter more backups beside the bridge"
      );
      assert.equal(
        await fs.readFile(backup, "utf8"),
        original,
        "later runs must not replace the backup with the already-spliced file"
      );
      assert.equal((await fs.stat(backup)).mtimeMs, firstStat.mtimeMs, "the backup must be written only once");
      assert.equal(await exists(`${backup}.dotaios-backup`), false, "the backup is never itself backed up");
      assert.notEqual(await fs.readFile(bridge, "utf8"), original);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("writes nothing at all on a dry run", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original, backup } = await seedManagedBridge(dirs.homePath);

      const before = await snapshotTree(dirs.base);
      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all", "--dry-run"]);
      const after = await snapshotTree(dirs.base);

      assert.deepEqual(after, before, "a dry run must leave every file byte-identical");
      assert.equal(await fs.readFile(bridge, "utf8"), original);
      assert.equal(await exists(backup), false, "a dry run must not write a backup");
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("creates a missing bridge file without writing a backup", async () => {
    const dirs = await makeTmpDirs();
    try {
      const bridge = path.join(dirs.homePath, ".claude", "CLAUDE.md");
      assert.equal(await exists(bridge), false);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);

      const created = await fs.readFile(bridge, "utf8");
      assert.match(created, new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
      assert.equal(await exists(`${bridge}.dotaios-backup`), false, "a newly created file has nothing to back up");
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked global bridge file without touching its target", async (t) => {
    if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
    const dirs = await makeTmpDirs();
    try {
      const bridge = path.join(dirs.homePath, ".codex", "AGENTS.md");
      const outside = path.join(dirs.base, "outside.md");
      const original = `${BEFORE}${STALE_BLOCK}${AFTER}`;
      await fs.mkdir(path.dirname(bridge), { recursive: true });
      await fs.writeFile(outside, original);
      await fs.symlink(outside, bridge, "file");

      const activation = await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
      const result = activation.results.find((entry) => entry.path === bridge);

      assert.equal(result?.action, "unsafe-target");
      assert.match(result?.note ?? "", /regular file/i);
      assert.equal(await fs.readFile(outside, "utf8"), original);
      assert.equal((await fs.lstat(bridge)).isSymbolicLink(), true);
      assert.equal(await exists(`${bridge}.dotaios-backup`), false, "a refused symlink must not create a backup");
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });
});
