import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("the packed CLI initializes a restorable, ignored workspace shelf", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-packed-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "run", "pack:admission", "--", "--silent", "--pack-destination", root
  ], { cwd: repoRoot });

  const tarball = fs.readdirSync(root).find((entry) => entry.endsWith(".tgz"));
  assert.ok(tarball, "npm pack must create a tarball");
  const unpacked = path.join(root, "unpacked");
  fs.mkdirSync(unpacked);
  run("tar", ["-xzf", path.join(root, tarball), "-C", unpacked]);

  const packageRoot = path.join(unpacked, "package");
  assert.equal(fs.existsSync(path.join(packageRoot, "templates", "gitignore.template")), true);
  assert.equal(fs.existsSync(path.join(packageRoot, "templates", ".gitignore")), false);
  const officialManifestPath = path.join(packageRoot, "packages", "core", "src", "official-skills.json");
  assert.equal(fs.existsSync(officialManifestPath), true, "the package must carry its official-skill manifest");
  const officialManifest = JSON.parse(fs.readFileSync(officialManifestPath, "utf8"));
  for (const skill of officialManifest.skills) {
    const skillRoot = path.join(packageRoot, "skills", skill.name);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(skillRoot).mode & 0o7777, skill.mode, `${skill.name} packed root mode`);
    }
    for (const file of skill.files) {
      const packedPath = path.join(skillRoot, file.path);
      const bytes = fs.readFileSync(packedPath);
      assert.equal(bytes.length, file.bytes, `${skill.name}/${file.path} packed size`);
      assert.equal(sha256(bytes), file.packed_sha256, `${skill.name}/${file.path} packed digest`);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(packedPath).mode & 0o7777, file.mode, `${skill.name}/${file.path} packed mode`);
      }
    }
  }

  // The release artifact must be runnable from its own admitted dependency
  // bytes. An ambient checkout symlink would bypass the npm 12 firewall this
  // packaged-workspace test is supposed to exercise.
  const bundledModules = path.join(packageRoot, "node_modules");
  assert.equal(fs.lstatSync(bundledModules).isDirectory(), true);
  assert.equal(fs.lstatSync(bundledModules).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(packageRoot, "npm-shrinkwrap.json")), true);

  const cli = path.join(packageRoot, "packages", "cli", "src", "index.mjs");
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(homePath);

  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  ).version;
  const version = run(process.execPath, [cli, "--version"], { cwd: packageRoot });
  assert.equal(version.stdout.trim(), expectedVersion, "the packed CLI must report the release version");

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

  for (const skill of officialManifest.skills) {
    const instructions = fs.readFileSync(path.join(aiosPath, "skills", skill.name, "SKILL.md"), "utf8");
    assert.doesNotMatch(instructions, /<exact-candidate-version>/, `${skill.name} placeholder must be materialized`);
    assert.doesNotMatch(instructions, /\bnpx\s+dotaios(?!@)/, `${skill.name} must not use PATH-resolved DotAIOS`);
    for (const match of instructions.matchAll(/\bnpx\s+dotaios@([^\s`"'\\]+)/g)) {
      assert.equal(match[1], expectedVersion, `${skill.name} must invoke the packed candidate version`);
    }
  }

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
