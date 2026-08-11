import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { initCommand } from "../../packages/cli/src/commands/init.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("init fails fast on an unusable --vault-path before writing any files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const blocker = path.join(root, "blocker.txt");
  fs.writeFileSync(blocker, "not a directory\n");
  const target = path.join(root, "aios");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--path", target, "--vault-path", path.join(blocker, "vault")],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--vault-path/);
  assert.equal(fs.existsSync(target), false, "init must not create the AIOS folder when --vault-path is invalid");
});

test("init creates the vault at a creatable --vault-path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const target = path.join(root, "aios");
  const vault = path.join(root, "deep", "vault");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--path", target, "--vault-path", vault],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(vault, "wiki")), true);
  assert.equal(fs.existsSync(path.join(target, "aios.json")), true);
});

test("init rejects duplicate target and vault options before writing files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-duplicates-"));
  const firstTarget = path.join(root, "first-aios");
  const secondTarget = path.join(root, "second-aios");
  const foreignFile = path.join(secondTarget, "private-notes.md");
  fs.mkdirSync(secondTarget, { recursive: true });
  fs.writeFileSync(foreignFile, "preserve me\n");
  const before = fs.readFileSync(foreignFile);

  const duplicatePath = spawnSync(process.execPath, [
    cli, "init", "--yes", "--force", "--path", firstTarget, "--path", secondTarget
  ], { encoding: "utf8" });

  assert.notEqual(duplicatePath.status, 0);
  assert.match(duplicatePath.stderr, /--path may only be provided once/);
  assert.equal(fs.existsSync(firstTarget), false);
  assert.deepEqual(fs.readFileSync(foreignFile), before);
  assert.deepEqual(fs.readdirSync(secondTarget), ["private-notes.md"]);

  const target = path.join(root, "vault-duplicate-aios");
  const firstVault = path.join(root, "first-vault");
  const secondVault = path.join(root, "second-vault");
  const duplicateVault = spawnSync(process.execPath, [
    cli, "init", "--yes", "--path", target,
    "--vault-path", firstVault, "--vault-path", secondVault
  ], { encoding: "utf8" });

  assert.notEqual(duplicateVault.status, 0);
  assert.match(duplicateVault.stderr, /--vault-path may only be provided once/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(firstVault), false);
  assert.equal(fs.existsSync(secondVault), false);
});

test("init rejects an external vault equal to or inside the AIOS target before mutation", () => {
  for (const suffix of [[], ["vault"]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-contained-vault-"));
    const target = path.join(root, "aios");
    const vault = path.join(target, ...suffix);

    const result = spawnSync(
      process.execPath,
      [cli, "init", "--yes", "--path", target, "--vault-path", vault],
      { encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external.*outside the AIOS target/i);
    assert.equal(fs.existsSync(target), false, `contained vault ${vault} must not create the target`);
  }
});

test("a freshly initialized folder ships a lean memory-maintenance router", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const target = path.join(root, "aios");

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(
    fs.existsSync(path.join(target, "skills", "memory-maintenance", "SKILL.md")),
    true,
    "the skill must reach a new user, not just the repo"
  );

  const registry = JSON.parse(fs.readFileSync(path.join(target, "skills", "_registry.json"), "utf8"));
  assert.ok(registry.skills.includes("memory-maintenance"), "the registry must list it");

  const index = fs.readFileSync(path.join(target, "skills", "INDEX.md"), "utf8");
  assert.match(index, /memory-maintenance/, "the generated index must surface it");

  const agents = fs.readFileSync(path.join(target, "AGENTS.md"), "utf8");
  assert.match(agents, /## Keeping Knowledge True/, "the rendered AGENTS.md must retain the lifecycle boundary");
  assert.match(agents, /memory-maintenance/);
  assert.doesNotMatch(agents, /--operation supersede/, "the detailed procedure belongs in the skill");
  assert.doesNotMatch(agents, /git clone <url> \/tmp\/dotaios-plugin/, "third-party installation belongs in docs");
});

test("fresh init installs the exact managed-workspace privacy boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-boundary-"));
  const target = path.join(root, "aios");
  const home = path.join(root, "home");
  fs.mkdirSync(home);

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const ignorePath = path.join(target, ".gitignore");
  const ignoreBeforeRestore = fs.readFileSync(ignorePath, "utf8");
  const lines = ignoreBeforeRestore.split(/\r?\n/);
  assert.equal(lines.filter((line) => line === "/workspaces/").length, 1);
  assert.equal(lines.includes("workspaces/"), false, "the boundary must stay anchored at the AIOS root");

  const projectDir = path.join(target, "projects", "source-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), [
    "---",
    "id: source-project-id",
    "project: source-project",
    "name: Source Project",
    "status: active",
    "domain: [build]",
    "repo_url: https://github.com/acme/source-project.git",
    "---",
    "# Source Project",
    ""
  ].join("\n"));
  const restored = spawnSync(process.execPath, [
    cli, "project", "restore", "source-project",
    "--dry-run", "--json", "--path", target, "--home", home
  ], { encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).results[0].action, "would-clone");
  assert.equal(fs.readFileSync(ignorePath, "utf8"), ignoreBeforeRestore);
});

test("init --force preserves an existing gitignore byte-for-byte", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-preserve-ignore-"));
  const target = path.join(root, "aios");
  const custom = "custom-private-file\n/workspaces/\n";
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, ".gitignore"), custom);

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--force", "--path", target],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(target, ".gitignore"), "utf8"), custom);
});

test("init refuses force and overwrite skill/catalog writes against an existing live AIOS store", () => {
  for (const option of ["--force", "--overwrite"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-managed-skill-writer-"));
    const target = path.join(root, "aios");
    const initial = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], { encoding: "utf8" });
    assert.equal(initial.status, 0, initial.stderr);
    const skillName = fs.readdirSync(path.join(target, "skills"), { withFileTypes: true })
      .find((entry) => entry.isDirectory())?.name;
    assert.ok(skillName);
    fs.rmSync(path.join(target, "skills", skillName), { recursive: true });
    const indexPath = path.join(target, "skills", "INDEX.md");
    fs.writeFileSync(indexPath, "# user-preserved catalog\n");

    const result = spawnSync(
      process.execPath,
      [cli, "init", "--yes", option, "--path", target],
      { encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ManagedSkillStore|existing live AIOS/i);
    assert.equal(fs.existsSync(path.join(target, "skills", skillName)), false);
    assert.equal(fs.readFileSync(indexPath, "utf8"), "# user-preserved catalog\n");
  }
});

test("init --force refuses an existing ignore file that would strand current schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-unsafe-ignore-"));
  const target = path.join(root, "aios");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, ".gitignore"), "node_modules/\n");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--force", "--path", target],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stable exact \/workspaces\/ boundary/i);
  assert.deepEqual(fs.readdirSync(target), [".gitignore"], "preflight refusal must write nothing");
});

test("init --force refuses an unanchored workspace rule before writing current schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-unanchored-ignore-"));
  const target = path.join(root, "aios");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, ".gitignore"), "workspaces/\n");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--force", "--path", target],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact \/workspaces\/ boundary/i);
  assert.deepEqual(fs.readdirSync(target), [".gitignore"], "preflight refusal must write nothing");
});

test("init --force refuses a dangling .gitignore symlink before writing outside AIOS", (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-ignore-link-"));
  const target = path.join(root, "aios");
  const outside = path.join(root, "outside-ignore");
  fs.mkdirSync(target);
  fs.symlinkSync(outside, path.join(target, ".gitignore"));

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--force", "--path", target],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe existing ignore file/i);
  assert.equal(fs.existsSync(outside), false);
  assert.deepEqual(fs.readdirSync(target), [".gitignore"]);
});

test("init --overwrite refuses a .gitignore symlink without touching its external target or partially scaffolding", (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-overwrite-ignore-link-"));
  const target = path.join(root, "aios");
  const outside = path.join(root, "outside-ignore");
  fs.mkdirSync(target);
  fs.writeFileSync(outside, "external ignore bytes\n");
  fs.writeFileSync(path.join(target, "private-notes.md"), "keep private\n");
  fs.symlinkSync(outside, path.join(target, ".gitignore"));
  const beforeEntries = fs.readdirSync(target).sort();

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--overwrite", "--path", target],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe generated file/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "external ignore bytes\n");
  assert.equal(fs.readFileSync(path.join(target, "private-notes.md"), "utf8"), "keep private\n");
  assert.deepEqual(fs.readdirSync(target).sort(), beforeEntries);
  assert.equal(fs.existsSync(path.join(target, "aios.json")), false);
});

test("init --overwrite preflights generated skill indexes before changing any file", (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-overwrite-index-link-"));
  const target = path.join(root, "aios");
  const outside = path.join(root, "outside-index.md");
  fs.mkdirSync(path.join(target, "skills"), { recursive: true });
  fs.writeFileSync(outside, "external index bytes\n");
  fs.writeFileSync(path.join(target, "private-notes.md"), "keep private\n");
  fs.symlinkSync(outside, path.join(target, "skills", "INDEX.md"));
  const beforeRootEntries = fs.readdirSync(target).sort();
  const beforeSkillEntries = fs.readdirSync(path.join(target, "skills")).sort();

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--overwrite", "--path", target],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe generated file/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "external index bytes\n");
  assert.deepEqual(fs.readdirSync(target).sort(), beforeRootEntries);
  assert.deepEqual(fs.readdirSync(path.join(target, "skills")).sort(), beforeSkillEntries);
  assert.equal(fs.existsSync(path.join(target, "aios.json")), false);
});

test("init --overwrite refuses a generated parent-directory symlink before external or local mutation", (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-overwrite-parent-link-"));
  const target = path.join(root, "aios");
  const outsideContext = path.join(root, "outside-context");
  fs.mkdirSync(target);
  fs.mkdirSync(outsideContext);
  fs.writeFileSync(path.join(outsideContext, "identity.md"), "external identity bytes\n");
  fs.writeFileSync(path.join(target, "private-notes.md"), "keep private\n");
  fs.symlinkSync(outsideContext, path.join(target, "context"));
  const beforeEntries = fs.readdirSync(target).sort();

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--overwrite", "--path", target],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe generated directory/i);
  assert.equal(fs.readFileSync(path.join(outsideContext, "identity.md"), "utf8"), "external identity bytes\n");
  assert.deepEqual(fs.readdirSync(target).sort(), beforeEntries);
  assert.equal(fs.existsSync(path.join(target, "aios.json")), false);
});

test("init --overwrite also preflights parent-only built-in vault directories", (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-overwrite-vault-link-"));
  const target = path.join(root, "aios");
  const outsideVault = path.join(root, "outside-vault");
  fs.mkdirSync(target);
  fs.mkdirSync(outsideVault);
  fs.writeFileSync(path.join(outsideVault, "private-notes.md"), "keep external\n");
  fs.symlinkSync(outsideVault, path.join(target, "vault"));
  const beforeEntries = fs.readdirSync(target).sort();

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--overwrite", "--path", target],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe generated directory/i);
  assert.deepEqual(fs.readdirSync(target).sort(), beforeEntries);
  assert.deepEqual(fs.readdirSync(outsideVault), ["private-notes.md"]);
  assert.equal(fs.readFileSync(path.join(outsideVault, "private-notes.md"), "utf8"), "keep external\n");
});

test("init refuses a symlinked AIOS root before changing the linked directory", (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-root-link-"));
  const outsideTarget = path.join(root, "outside-aios");
  const target = path.join(root, "aios");
  fs.mkdirSync(outsideTarget);
  fs.writeFileSync(path.join(outsideTarget, "private-notes.md"), "keep external\n");
  fs.symlinkSync(outsideTarget, target);

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--overwrite", "--path", target],
    { encoding: "utf8" }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe AIOS target/i);
  assert.deepEqual(fs.readdirSync(outsideTarget), ["private-notes.md"]);
  assert.equal(fs.readFileSync(path.join(outsideTarget, "private-notes.md"), "utf8"), "keep external\n");
});

test("init revalidates generated parents after beforeScaffold before writing through a raced symlink", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-hook-parent-race-"));
  const target = path.join(root, "aios");
  const outsideContext = path.join(root, "outside-context");
  const outsideIdentity = path.join(outsideContext, "identity.md");
  fs.mkdirSync(target);
  fs.mkdirSync(outsideContext);
  fs.writeFileSync(path.join(target, ".gitignore"), "/workspaces/\n");
  fs.writeFileSync(path.join(target, "private-notes.md"), "keep local\n");
  fs.writeFileSync(outsideIdentity, "keep external\n");

  await assert.rejects(
    initCommand(["--yes", "--overwrite", "--path", target], {
      quiet: true,
      beforeScaffold: async () => {
        fs.symlinkSync(outsideContext, path.join(target, "context"));
      }
    }),
    /unsafe generated directory/i
  );

  assert.equal(fs.readFileSync(outsideIdentity, "utf8"), "keep external\n");
  assert.equal(fs.readFileSync(path.join(target, "private-notes.md"), "utf8"), "keep local\n");
  assert.equal(fs.existsSync(path.join(target, "aios.json")), false);
  assert.deepEqual(fs.readdirSync(target).sort(), [".gitignore", "context", "private-notes.md"]);
});

test("init revalidates a preserved workspace boundary after beforeScaffold", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-hook-ignore-race-"));
  const target = path.join(root, "aios");
  const ignorePath = path.join(target, ".gitignore");
  const privatePath = path.join(target, "private-notes.md");
  fs.mkdirSync(target);
  fs.writeFileSync(ignorePath, "/workspaces/\n");
  fs.writeFileSync(privatePath, "keep local\n");

  await assert.rejects(
    initCommand(["--yes", "--force", "--path", target], {
      quiet: true,
      beforeScaffold: async () => {
        fs.writeFileSync(ignorePath, "node_modules/\n");
      }
    }),
    /stable exact \/workspaces\/ boundary/i
  );

  assert.equal(fs.readFileSync(ignorePath, "utf8"), "node_modules/\n");
  assert.equal(fs.readFileSync(privatePath, "utf8"), "keep local\n");
  assert.equal(fs.existsSync(path.join(target, "aios.json")), false);
  assert.deepEqual(fs.readdirSync(target).sort(), [".gitignore", "private-notes.md"]);
});

test("init --force recovery with a safe exact boundary does not require Git on PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-no-git-"));
  const target = path.join(root, "aios");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, ".gitignore"), "custom-private-file\n/workspaces/\n");

  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--force", "--path", target],
    { encoding: "utf8", env: { ...process.env, PATH: "" } }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(target, "aios.json")), true);
});

test("a new folder ships a scheduled memory check, not just a skills-symlink check", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-init-"));
  const target = path.join(root, "aios");

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const schedules = fs.readFileSync(path.join(target, "schedules.yml"), "utf8");

  assert.match(schedules, /dotaios memory audit/, "staleness must be detectable on a clock, not only when someone remembers");
  assert.doesNotMatch(
    schedules,
    /dotaios skills doctor/,
    "the weekly health check must inspect memory, not skill symlinks"
  );
  assert.match(schedules, /dotaios doctor/, "the health check must be the one that reads memory and context freshness");

  // Scheduling must stay opt-in: DotAIOS may not install OS jobs a user never asked for.
  const enabled = schedules.split("\n").filter((line) => line.includes("enabled:"));
  assert.ok(enabled.length >= 3, "every shipped schedule declares its enabled state");
  assert.ok(enabled.every((line) => line.includes("false")), "shipped schedules must default to off");
});
