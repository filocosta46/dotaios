import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findManagedBlock } from "../../packages/core/src/bridges.mjs";
import { symlinkTargets } from "../../packages/core/src/skill-targets.mjs";

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
    "---\nname: test-skill\ndescription: A test skill.\n---\n\n# Test Skill\n"
  );
  return { base, aiosPath, homePath };
}

async function projectedSkillDirs(homePath, skillName = "test-skill") {
  const roots = symlinkTargets().map(({ dir }) => dir);
  const present = [];
  for (const root of roots) {
    try {
      await fs.access(path.join(homePath, root, skillName));
      present.push(root);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return present.sort();
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

    const activation = await activateCommand([
      "--path", dirs.aiosPath,
      "--home", dirs.homePath,
      "--all"
    ], { env: { PATH: "" } });
    assert.ok(activation.configuredContextCount > 0);
    assert.ok(activation.detectedClientCount > 0);
    assert.deepEqual(
      activation.configuredClientNames,
      ["Claude Code", "Codex", "Gemini", "OpenCode"],
      "only clients with configured context bridges belong in the configured-name list"
    );
    assert.ok(activation.detectedClientNames.includes("Cursor"), "bridge-less apps remain visible as detected");
    assert.equal(activation.configuredClientNames.includes("Cursor"), false);

    const symlinkPath = path.join(dirs.homePath, ".claude", "skills", "test-skill");
    const stat = await fs.lstat(symlinkPath);
    assert.ok(stat.isSymbolicLink(), "expected a symlink");

    const target = await fs.readlink(symlinkPath);
    assert.equal(target, path.join(dirs.aiosPath, "skills", "test-skill"));

    assert.deepEqual(await projectedSkillDirs(dirs.homePath), [
      ".agents/skills",
      ".claude/skills",
      ".gemini/config/skills",
      ".grok/skills"
    ].sort(), "--all projects every registered target");

    // Verify the symlink is actually traversable (resolves correctly)
    const skillFile = path.join(symlinkPath, "SKILL.md");
    const content = await fs.readFile(skillFile, "utf8");
    assert.ok(content.includes("Test Skill"), "symlink should resolve to skill content");
  });

  it("writes Claude bridge and skills only to an absolute CLAUDE_CONFIG_DIR", async () => {
    const selected = await makeTmpDirs();
    const selectedRoot = path.join(selected.base, "claude-profile");
    const defaultRoot = path.join(selected.homePath, ".claude");
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      const activation = await activateCommand([
        "--path", selected.aiosPath,
        "--home", selected.homePath,
        "--all"
      ], {
        env: { PATH: "", CLAUDE_CONFIG_DIR: selectedRoot }
      });

      assert.ok(activation.configuredClientNames.includes("Claude Code"));
      assert.match(await fs.readFile(path.join(selectedRoot, "CLAUDE.md"), "utf8"), /dotaios-managed:start/);
      const skillLink = path.join(selectedRoot, "skills", "test-skill");
      assert.equal((await fs.lstat(skillLink)).isSymbolicLink(), true);
      assert.equal(await fs.readlink(skillLink), path.join(selected.aiosPath, "skills", "test-skill"));
      await assert.rejects(fs.access(defaultRoot), { code: "ENOENT" });
    } finally {
      await fs.rm(selected.base, { recursive: true, force: true });
    }
  });

  it("installs one universal customer-hidden project handoff in native host bridges", async () => {
    const isolated = await makeTmpDirs();
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      await activateCommand([
        "--path", isolated.aiosPath,
        "--home", isolated.homePath,
        "--all"
      ], { quiet: true, env: { PATH: "" } });
      const codex = await fs.readFile(path.join(isolated.homePath, ".codex", "AGENTS.md"), "utf8");
      const claude = await fs.readFile(path.join(isolated.homePath, ".claude", "CLAUDE.md"), "utf8");
      const codexBlock = findManagedBlock(codex);
      const claudeBlock = findManagedBlock(claude);

      assert.ok(codexBlock);
      assert.ok(claudeBlock);
      assert.equal(codexBlock.text, claudeBlock.text, "native hosts must receive one shared handoff flow");
      assert.match(codexBlock.text, /derive the current host's native support[\s\S]*implicit discovery/i);
      assert.match(codexBlock.text, /fresh direct customer turn[\s\S]*any other response[\s\S]*no automatic reprompt/i);
      assert.match(codexBlock.text, /fresh ephemeral[\s\S]*customer-hidden native child[\s\S]*same visible task/i);
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("projects only shared skills when no clients are detected", async () => {
    const isolated = await makeTmpDirs();
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      const args = ["--path", isolated.aiosPath, "--home", isolated.homePath];
      const first = await activateCommand(args, { quiet: true, env: { PATH: "" } });
      assert.equal(first.detectedClientCount, 0);

      await fs.access(path.join(isolated.homePath, ".agents/skills/test-skill"));
      await assert.rejects(
        fs.access(path.join(isolated.homePath, ".claude")),
        { code: "ENOENT" },
        "activation must not create an absent client's config root"
      );
      for (const projection of [
        ".claude/skills",
        ".gemini/config/skills",
        ".grok/skills"
      ]) {
        await assert.rejects(
          fs.access(path.join(isolated.homePath, projection)),
          { code: "ENOENT" },
          `${projection} must remain absent when its client is not detected`
        );
      }

      const second = await activateCommand(args, { quiet: true, env: { PATH: "" } });
      assert.equal(second.detectedClientCount, 0);
      for (const client of ["Claude Code", "Gemini", "Grok"]) {
        assert.equal(
          second.detectedClientNames.includes(client),
          false,
          `${client} must remain absent when only its DotAIOS projection exists`
        );
      }
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("uses only the shared target when Codex is the sole detected client", async () => {
    const isolated = await makeTmpDirs();
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      await fs.mkdir(path.join(isolated.homePath, ".codex"), { recursive: true });
      const activation = await activateCommand(
        ["--path", isolated.aiosPath, "--home", isolated.homePath],
        { quiet: true, env: { PATH: "" } }
      );

      assert.deepEqual(activation.detectedClientNames, ["Codex"]);
      assert.deepEqual(await projectedSkillDirs(isolated.homePath), [".agents/skills"]);
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("adds only Claude's native target when Claude is the sole detected client", async () => {
    const isolated = await makeTmpDirs();
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      await fs.mkdir(path.join(isolated.homePath, ".claude"), { recursive: true });
      await fs.writeFile(path.join(isolated.homePath, ".claude", "settings.json"), "{}\n");
      const activation = await activateCommand(
        ["--path", isolated.aiosPath, "--home", isolated.homePath],
        { quiet: true, env: { PATH: "" } }
      );

      assert.deepEqual(activation.detectedClientNames, ["Claude Code"]);
      assert.deepEqual(await projectedSkillDirs(isolated.homePath), [
        ".agents/skills",
        ".claude/skills"
      ].sort());
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("keeps activation dry-run and apply on the same target plan", async () => {
    const isolated = await makeTmpDirs();
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      const baseArgs = ["--path", isolated.aiosPath, "--home", isolated.homePath];
      const preview = await activateCommand(
        [...baseArgs, "--dry-run"],
        { quiet: true, env: { PATH: "" } }
      );
      const promised = preview.results
        .filter(({ action }) => action === "would link")
        .map(({ path: destination }) => path.relative(isolated.homePath, path.dirname(destination)))
        .sort();
      assert.deepEqual(promised, [".agents/skills"]);
      await assert.rejects(fs.access(isolated.homePath), { code: "ENOENT" });

      await activateCommand(baseArgs, { quiet: true, env: { PATH: "" } });
      assert.deepEqual(await projectedSkillDirs(isolated.homePath), promised);
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("preserves old managed links without projecting new skills after a client becomes undetected", async () => {
    const isolated = await makeTmpDirs();
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    try {
      const settings = path.join(isolated.homePath, ".claude", "settings.json");
      await fs.mkdir(path.dirname(settings), { recursive: true });
      await fs.writeFile(settings, "{}\n");
      const args = ["--path", isolated.aiosPath, "--home", isolated.homePath];
      await activateCommand(args, { quiet: true, env: { PATH: "" } });
      await fs.access(path.join(isolated.homePath, ".claude/skills/test-skill"));

      await fs.unlink(settings);
      await fs.mkdir(path.join(isolated.aiosPath, "skills", "later-skill"));
      await fs.writeFile(
        path.join(isolated.aiosPath, "skills", "later-skill", "SKILL.md"),
        "---\nname: later-skill\ndescription: Added later.\n---\n\n# Later Skill\n"
      );
      await activateCommand(args, { quiet: true, env: { PATH: "" } });

      await fs.access(path.join(isolated.homePath, ".claude/skills/test-skill"));
      await fs.access(path.join(isolated.homePath, ".agents/skills/later-skill"));
      await assert.rejects(
        fs.access(path.join(isolated.homePath, ".claude/skills/later-skill")),
        { code: "ENOENT" }
      );
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("labels activation dry-run as a preview", async () => {
    const isolated = await makeTmpDirs();
    const cli = path.join(repoRoot, "packages/cli/src/index.mjs");

    try {
      const result = spawnSync(process.execPath, [
        cli,
        "activate",
        "--dry-run",
        "--path", isolated.aiosPath,
        "--home", isolated.homePath
      ], {
        encoding: "utf8",
        env: { ...process.env, PATH: "" }
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Activation preview$/m);
      assert.doesNotMatch(result.stdout, /^DotAIOS activated$/m);
    } finally {
      await fs.rm(isolated.base, { recursive: true, force: true });
    }
  });

  it("returns the full stable activation result shape for a catalog conflict", async () => {
    const { catalogConflictActivationResult } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );
    const results = [{ action: "kept", path: "skills/INDEX.md" }];

    assert.deepEqual(
      catalogConflictActivationResult({ conflicts: [{ path: "skills/INDEX.md" }], results }),
      {
        detectedClientCount: 0,
        configuredContextCount: 0,
        detectedClientNames: [],
        configuredClientNames: [],
        blockedContextCount: 0,
        blockedHermesCount: 0,
        blockedCatalogCount: 1,
        results
      }
    );
  });

  it("refuses to connect a temporary AIOS into the real home", async () => {
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await assert.rejects(
      activateCommand([
        "--path", dirs.aiosPath,
        "--home", os.homedir(),
        "--all"
      ]),
      /temporary AIOS path/
    );
  });

  it("refuses a permanent-looking symlink that resolves into the temp root", async () => {
    const aliasRoot = await fs.mkdtemp(path.join(os.homedir(), ".dotaios-activate-alias-"));
    const alias = path.join(aliasRoot, "aios");
    await fs.symlink(dirs.aiosPath, alias, "dir");
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await assert.rejects(
      activateCommand([
        "--path", alias,
        "--home", os.homedir(),
        "--all"
      ]),
      /temporary AIOS path/
    );
    await fs.rm(aliasRoot, { recursive: true, force: true });
  });

  it("refuses a home alias that resolves to the real user home", async () => {
    const aliasHome = path.join(dirs.base, "home-alias");
    await fs.symlink(os.homedir(), aliasHome, "dir");
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await assert.rejects(
      activateCommand([
        "--path", dirs.aiosPath,
        "--home", aliasHome,
        "--all"
      ]),
      /temporary AIOS path/
    );
  });
});
