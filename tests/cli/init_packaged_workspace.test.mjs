import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("the packed CLI initializes a restorable, ignored workspace shelf", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-packed-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "pack", "--silent", "--pack-destination", root
  ], { cwd: repoRoot });

  const tarball = fs.readdirSync(root).find((entry) => entry.endsWith(".tgz"));
  assert.ok(tarball, "npm pack must create a tarball");
  const unpacked = path.join(root, "unpacked");
  fs.mkdirSync(unpacked);
  run("tar", ["-xzf", path.join(root, tarball), "-C", unpacked]);

  const packageRoot = path.join(unpacked, "package");
  assert.equal(fs.existsSync(path.join(packageRoot, "templates", "gitignore.template")), true);
  assert.equal(fs.existsSync(path.join(packageRoot, "templates", ".gitignore")), false);

  // The packed source resolves its normal dependencies through the checkout's
  // installed node_modules. The package files themselves remain untouched.
  fs.symlinkSync(
    dependencyNodeModules(repoRoot),
    path.join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );

  const cli = path.join(packageRoot, "packages", "cli", "src", "index.mjs");
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(homePath);

  const version = run(process.execPath, [cli, "--version"], { cwd: packageRoot });
  assert.equal(version.stdout.trim(), "2.0.5", "the packed CLI must report the release version");

  const help = run(process.execPath, [cli, "--help"], { cwd: packageRoot });
  assert.match(help.stdout, /dotaios/i, "the packed CLI entrypoint must load from extracted bytes");

  const setupPath = path.join(root, "setup-preview-aios");
  const setupPreview = run(process.execPath, [
    cli, "setup", "--dry-run", "--yes", "--skip-reveal",
    "--path", setupPath, "--home", homePath
  ], { cwd: packageRoot });
  assert.match(setupPreview.stdout, new RegExp(escapeRegExp(setupPath)));
  assert.equal(
    fs.existsSync(setupPath),
    false,
    "the packed setup preview must not create the proposed AIOS folder"
  );

  run(process.execPath, [cli, "init", "--yes", "--path", aiosPath], { cwd: packageRoot });

  const ignorePath = path.join(aiosPath, ".gitignore");
  const ignoreBeforeRestore = fs.readFileSync(ignorePath, "utf8");
  const lines = ignoreBeforeRestore.split(/\r?\n/);
  assert.equal(lines.filter((line) => line === "/workspaces/").length, 1);
  assert.equal(lines.includes("workspaces/"), false);

  run("git", ["init", "-q"], { cwd: aiosPath });
  fs.mkdirSync(path.join(aiosPath, "workspaces", "private-project"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "workspaces", "private-project", "private.txt"), "private\n");
  fs.mkdirSync(path.join(aiosPath, "nested", "workspaces"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "nested", "workspaces", "portable.txt"), "portable\n");
  assert.equal(run("git", ["check-ignore", "--no-index", "-q", "workspaces/private-project/private.txt"], {
    cwd: aiosPath,
    allowFailure: true
  }).status, 0, "managed checkout content must be ignored by the outer repository");
  assert.equal(run("git", ["check-ignore", "--no-index", "-q", "nested/workspaces/portable.txt"], {
    cwd: aiosPath,
    allowFailure: true
  }).status, 1, "the anchored rule must not hide unrelated nested folders");

  const projectDir = path.join(aiosPath, "projects", "packed-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), [
    "---",
    "id: packed-project-id",
    "project: packed-project",
    "name: Packed Project",
    "status: active",
    "domain: [build]",
    "repo_url: https://github.com/acme/packed-project.git",
    "---",
    "# Packed Project",
    ""
  ].join("\n"));

  const restored = run(process.execPath, [
    cli, "project", "restore", "packed-project",
    "--dry-run", "--json", "--path", aiosPath, "--home", homePath
  ], { cwd: packageRoot });
  const receipt = JSON.parse(restored.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "would-clone");
  assert.equal(receipt.machine_local.results[0].destination, path.join(aiosPath, "workspaces", "packed-project"));
  assert.equal(fs.readFileSync(ignorePath, "utf8"), ignoreBeforeRestore, "restore must not rewrite the boundary");
});

function dependencyNodeModules(start) {
  const candidate = path.join(start, "node_modules");
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Could not locate the repository-local dependency tree at ${candidate}.`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_WORK_TREE: undefined
    }
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}
