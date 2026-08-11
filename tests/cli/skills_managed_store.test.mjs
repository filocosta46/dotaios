import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { createManagedSkillFixture, OPAQUE_ASSET_BYTES, snapshotTree, writeSkill } from "../helpers/managed-skills.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("spawned CLI inventory and exact adoption preserve preview/apply separation", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "cli-adopted"), {
    files: { "assets/data.bin": OPAQUE_ASSET_BYTES }
  });
  const before = snapshotTree(fixture.root);
  const preview = run([
    "skills", "adopt", sourcePath,
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    "--json"
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  const proof = JSON.parse(preview.stdout);
  assert.equal(proof.format, "dotaios-managed-skill-adoption-proof/v1");
  assert.deepEqual(snapshotTree(fixture.root), before);

  const applied = run([
    "skills", "adopt", sourcePath,
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    "--apply", proof.operation_id,
    "--fingerprint", proof.plan_fingerprint,
    "--json"
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, "adopted");

  const inventory = run([
    "skills", "inventory",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    "--json"
  ]);
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.deepEqual(JSON.parse(inventory.stdout).owned.map(({ name }) => name), ["cli-adopted"]);

  const resolved = run([
    "skills", "resolve", "reviewed cli-adopted skill",
    "--path", fixture.aiosPath,
    "--json"
  ]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).matches[0].name, "cli-adopted");
  assert.deepEqual(fs.readFileSync(
    path.join(fixture.aiosPath, "skills", "cli-adopted", "assets", "data.bin")
  ), OPAQUE_ASSET_BYTES);

  const removalPreview = run([
    "skills", "remove", "cli-adopted",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    "--json"
  ]);
  assert.equal(removalPreview.status, 0, removalPreview.stderr);
  const removalProof = JSON.parse(removalPreview.stdout);
  const removal = run([
    "skill", "remove", "cli-adopted",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    "--apply", removalProof.operation_id,
    "--fingerprint", removalProof.plan_fingerprint
  ]);
  assert.equal(removal.status, 0, removal.stderr);
  assert.match(removal.stdout, /recovery retained locally/i);
  const retainedInventory = run([
    "skill", "list",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ]);
  assert.equal(retainedInventory.status, 0, retainedInventory.stderr);
  assert.match(retainedInventory.stdout, /Retained recovery: 1/i);
});

test("human inventory distinguishes adoptable directories from unmanaged native links", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const real = writeSkill(path.join(fixture.homePath, ".agents", "skills", "linked-extra"));
  const claude = path.join(fixture.homePath, ".claude", "skills", "linked-extra");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.symlinkSync(real, claude);

  const inventory = run([
    "skills", "inventory",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ]);

  assert.equal(inventory.status, 0, inventory.stderr);
  assert.match(inventory.stdout, /candidate linked-extra \(discovered-native-directory\)/i);
  assert.match(inventory.stdout, /unmanaged linked-extra \(discovered-native-link; not directly adoptable\)/i);
});

test("spawned CLI rejects apply without both exact proof tokens", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "missing-token"));
  const result = run([
    "skills", "adopt", sourcePath,
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    "--apply", "skill-adopt-not-enough"
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required together/i);
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, "skills", "missing-token")), false);
});
