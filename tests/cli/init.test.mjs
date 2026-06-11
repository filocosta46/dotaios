import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

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
