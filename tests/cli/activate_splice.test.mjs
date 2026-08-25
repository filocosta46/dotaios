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

async function activate(args, commandOptions) {
  const { activateCommand } = await import(
    path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
  );
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = () => {};
  try {
    return await activateCommand(args, commandOptions);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
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
      assert.ok(
        blocks[0].includes(path.join(dirs.aiosPath, "AGENTS.md")),
        "the regenerated block must point at this AIOS folder"
      );
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
      assert.doesNotMatch(pointer.block, /Skills first \(inlined during DotAIOS activation\)/);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all", "--skills-first"]);
      const inlined = splitAroundBlock(await fs.readFile(bridge, "utf8"));

      assert.match(inlined.block, /Skills first \(inlined during DotAIOS activation\)/);
      assert.match(inlined.block, /test-skill/);
      assert.notEqual(inlined.block, pointer.block);
      assert.equal(inlined.before, BEFORE);
      assert.equal(inlined.after, AFTER);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("leaves a concurrent bridge edit untouched when it lands before replacement", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original, backup } = await seedManagedBridge(dirs.homePath);
      const concurrent = `${original}\nConcurrent edit made during activation.\n`;
      let edited = false;

      const activation = await activate(
        ["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"],
        {
          lifecycle: {
            beforeBridgeReplace: async ({ destination }) => {
              if (destination !== bridge || edited) return;
              edited = true;
              await fs.writeFile(bridge, concurrent);
            }
          }
        }
      );
      const result = activation.results.find((entry) => entry.path === bridge);

      assert.equal(edited, true, "the test must exercise the read-to-replacement race");
      assert.equal(result?.action, "conflict");
      assert.match(result?.note ?? "", /changed during bridge update/i);
      assert.equal(await fs.readFile(bridge, "utf8"), concurrent);
      assert.equal(await exists(backup), false, "a rejected replacement must not create a backup");
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("keeps the live bridge visible when activation stops after staging", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original, backup } = await seedManagedBridge(dirs.homePath);
      let observedStagedState = false;

      // This used to assert that activation rejected. It no longer does: one
      // client's write failing is now reported and the run carries on to the
      // rest. The staging invariants below are what this test is actually for,
      // and they are unchanged — plus the interruption is now reported at all,
      // which it was not when the rejection discarded every result.
      const activation = await activate(
        ["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"],
        {
          lifecycle: {
            beforeBridgePublish: async ({ destination, staged }) => {
              if (destination !== bridge) return;
              observedStagedState = true;
              assert.equal(await fs.readFile(bridge, "utf8"), original);
              assert.equal(await exists(staged), true, "the replacement must already be staged");
              throw new Error("simulated interruption after staging");
            }
          }
        }
      );

      const failed = activation.results.find((entry) => entry.action === "failed" && entry.path === bridge);
      assert.ok(failed, "the interrupted client is reported, not silently dropped");
      assert.match(failed.note, /simulated interruption after staging/);
      assert.equal(observedStagedState, true, "the test must stop at the staged pre-publication state");
      assert.equal(await fs.readFile(bridge, "utf8"), original);
      assert.equal(await exists(backup), false, "an interrupted replacement must not create a backup");
      assert.deepEqual(
        (await fs.readdir(path.dirname(bridge))).filter((name) => name.includes(".dotaios-") && name.endsWith(".next")),
        [],
        "a handled interruption must clean its staged sibling"
      );
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent edit injected at the guarded publication checkpoint", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original } = await seedManagedBridge(dirs.homePath);
      const concurrent = `${original}\nConcurrent replacement at commit.\n`;
      let raced = false;

      const activation = await activate(
        ["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"],
        {
          lifecycle: {
            beforeBridgeCommit: async ({ destination }) => {
              if (destination !== bridge || raced) return;
              raced = true;
              await fs.writeFile(destination, concurrent);
            }
          }
        }
      );
      const result = activation.results.find((entry) => entry.path === bridge);

      assert.equal(raced, true, "the test must race the no-clobber publication boundary");
      assert.equal(result?.action, "conflict");
      assert.equal(await fs.readFile(bridge, "utf8"), concurrent);
      const preserved = (await fs.readdir(path.dirname(bridge)))
        .filter((name) => name.startsWith("CLAUDE.md.dotaios-backup-"));
      assert.equal(preserved.length, 1);
      assert.equal(await fs.readFile(path.join(path.dirname(bridge), preserved[0]), "utf8"), original);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("keeps the original bridge visible when activation stops after preserving it", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original } = await seedManagedBridge(dirs.homePath);
      let claimed = false;

      // Same contract change as the staging test above: reported, not thrown.
      const activation = await activate(
        ["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"],
        {
          lifecycle: {
            beforeBridgeCommit: async ({ destination, preservedPath }) => {
              if (destination !== bridge) return;
              claimed = true;
              assert.equal(await fs.readFile(destination, "utf8"), original);
              assert.equal(await fs.readFile(preservedPath, "utf8"), original);
              throw new Error("simulated interruption after preservation");
            }
          }
        }
      );

      const failed = activation.results.find((entry) => entry.action === "failed" && entry.path === bridge);
      assert.ok(failed, "the interrupted client is reported, not silently dropped");
      assert.match(failed.note, /simulated interruption after preservation/);
      assert.equal(claimed, true, "the test must stop after the old bytes are preserved");
      assert.equal(await fs.readFile(bridge, "utf8"), original);
      const preserved = (await fs.readdir(path.dirname(bridge)))
        .filter((name) => name.startsWith("CLAUDE.md.dotaios-backup-"));
      assert.equal(preserved.length, 1);
      assert.equal(await fs.readFile(path.join(path.dirname(bridge), preserved[0]), "utf8"), original);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("reports a guarded Hermes config conflict as activation attention", async () => {
    const dirs = await makeTmpDirs();
    try {
      const configPath = path.join(dirs.homePath, ".hermes", "config.yaml");
      const concurrent = "skills:\n  external_dirs:\n    - /concurrent/skills\n";
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, "skills:\n  external_dirs: []\n");
      let edited = false;

      const activation = await activate(
        ["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"],
        {
          lifecycle: {
            beforeHermesReplace: async ({ destination }) => {
              if (destination !== configPath || edited) return;
              edited = true;
              await fs.writeFile(destination, concurrent);
            }
          }
        }
      );

      assert.equal(edited, true);
      assert.equal(activation.blockedHermesCount, 1);
      assert.equal(
        activation.results.find((entry) => entry.path === configPath)?.action,
        "hermes:conflict"
      );
      assert.equal(await fs.readFile(configPath, "utf8"), concurrent);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("reports current managed bridges as unchanged and configured", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge } = await seedManagedBridge(dirs.homePath);
      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);

      const activation = await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
      const result = activation.results.find((entry) => entry.path === bridge);

      assert.equal(result?.action, "unchanged");
      const unchangedBridges = activation.results.filter((entry) => entry.action === "unchanged");
      assert.ok(unchangedBridges.length > 0);
      assert.equal(activation.configuredContextCount, unchangedBridges.length);
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

  it("keeps malformed managed markers byte-identical and reports the collision", async () => {
    const malformedFiles = [
      `${MANAGED_END}\nuser content\n${MANAGED_START}\n`,
      `${STALE_BLOCK}\n${STALE_BLOCK}\n`,
      `${MANAGED_END}\n${STALE_BLOCK}\n`
    ];

    for (const original of malformedFiles) {
      const dirs = await makeTmpDirs();
      try {
        const bridge = path.join(dirs.homePath, ".codex", "AGENTS.md");
        await fs.mkdir(path.dirname(bridge), { recursive: true });
        await fs.writeFile(bridge, original);

        const activation = await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
        const result = activation.results.find((entry) => entry.path === bridge);

        assert.equal(result?.action, "kept");
        assert.match(result?.note || "", /managed markers are malformed/);
        assert.equal(await fs.readFile(bridge, "utf8"), original);
      } finally {
        await fs.rm(dirs.base, { recursive: true, force: true });
      }
    }
  });

  it("never treats overwrite as permission to replace malformed managed markers", async () => {
    const dirs = await makeTmpDirs();
    try {
      const bridge = path.join(dirs.homePath, ".codex", "AGENTS.md");
      const original = `${STALE_BLOCK}\n${STALE_BLOCK}\nuser content\n`;
      await fs.mkdir(path.dirname(bridge), { recursive: true });
      await fs.writeFile(bridge, original);

      const activation = await activate([
        "--path", dirs.aiosPath,
        "--home", dirs.homePath,
        "--all",
        "--overwrite"
      ]);
      const result = activation.results.find((entry) => entry.path === bridge);

      assert.equal(result?.action, "kept");
      assert.match(result?.note || "", /managed markers are malformed/);
      assert.equal(await fs.readFile(bridge, "utf8"), original);
    } finally {
      await fs.rm(dirs.base, { recursive: true, force: true });
    }
  });

  it("writes the backup exactly once and never overwrites it", async () => {
    const dirs = await makeTmpDirs();
    try {
      const { bridge, original } = await seedManagedBridge(dirs.homePath);
      await fs.chmod(bridge, 0o600);

      await activate(["--path", dirs.aiosPath, "--home", dirs.homePath, "--all"]);
      const backups = (await fs.readdir(path.dirname(bridge)))
        .filter((name) => name.startsWith("CLAUDE.md.dotaios-backup-"));
      assert.equal(backups.length, 1, "the update must preserve exactly one prior bridge");
      const backup = path.join(path.dirname(bridge), backups[0]);
      assert.equal(await fs.readFile(backup, "utf8"), original, "the first spliced write backs up the pre-existing file");
      const firstStat = await fs.stat(backup);
      assert.equal(firstStat.mode & 0o777, 0o600, "the backup preserves the bridge file mode");
      assert.equal((await fs.stat(bridge)).mode & 0o777, 0o600, "the replacement preserves the bridge file mode");
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
      assert.equal(
        (await fs.readdir(path.dirname(bridge)))
          .filter((name) => name.startsWith(`${path.basename(backup)}.dotaios-backup-`)).length,
        0,
        "the backup is never itself backed up"
      );
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
