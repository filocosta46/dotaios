import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  dotaiosBinDir,
  isPathWithin,
  lightpandaBinPath,
  syncConfigPath
} from "../../packages/core/src/paths.mjs";

async function containmentFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-paths-"));
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root, outside };
}

test("dotaiosBinDir returns ~/.dotaios/bin", () => {
  assert.equal(dotaiosBinDir(), path.join(os.homedir(), ".dotaios", "bin"));
});

test("lightpandaBinPath returns ~/.dotaios/bin/lightpanda on unix", { skip: process.platform === "win32" }, () => {
  assert.equal(lightpandaBinPath(), path.join(os.homedir(), ".dotaios", "bin", "lightpanda"));
});

test("lightpandaBinPath returns ~/.dotaios/bin/lightpanda.exe on windows", { skip: process.platform !== "win32" }, () => {
  assert.equal(lightpandaBinPath(), path.join(os.homedir(), ".dotaios", "bin", "lightpanda.exe"));
});

test("syncConfigPath returns ~/.dotaios/sync.json", () => {
  assert.equal(syncConfigPath(), path.join(os.homedir(), ".dotaios", "sync.json"));
});

test("isPathWithin accepts a missing descendant of the allowed root", async (t) => {
  const { root } = await containmentFixture(t);

  assert.equal(await isPathWithin(root, path.join(root, "missing", "note.md")), true);
});

test("isPathWithin rejects lexical traversal outside the allowed root", async (t) => {
  const { root, outside } = await containmentFixture(t);

  assert.equal(await isPathWithin(root, path.join(root, "..", path.basename(outside), "note.md")), false);
});

test("isPathWithin rejects a descendant reached through an escaping symlink", async (t) => {
  const { root, outside } = await containmentFixture(t);
  await fs.symlink(outside, path.join(root, "escape"), "dir");

  assert.equal(await isPathWithin(root, path.join(root, "escape", "note.md")), false);
});

test("isPathWithin accepts a descendant reached through an internal symlink", async (t) => {
  const { root } = await containmentFixture(t);
  const target = path.join(root, "target");
  await fs.mkdir(target);
  await fs.symlink(target, path.join(root, "alias"), "dir");

  assert.equal(await isPathWithin(root, path.join(root, "alias", "note.md")), true);
});

test("isPathWithin rejects a descendant reached through a dangling symlink", async (t) => {
  const { directory, root } = await containmentFixture(t);
  await fs.symlink(path.join(directory, "missing-target"), path.join(root, "escape"), "dir");

  assert.equal(await isPathWithin(root, path.join(root, "escape", "note.md")), false);
});
