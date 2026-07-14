import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `command failed: ${result.stdout}\n${result.stderr}`);
  return result;
}

test("marketplace install forwards --home and propagates plugin skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-market-install-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const registryPath = path.join(root, "registry.json");
  run(["init", "--path", aiosPath, "--yes"]);
  fs.writeFileSync(registryPath, JSON.stringify({
    skills: [{
      id: "hello-memory",
      name: "Hello Memory",
      paid: false,
      install_url: path.join(repoRoot, "examples", "plugins", "hello-memory")
    }]
  }));

  run([
    "market", "install", "hello-memory",
    "--registry", pathToFileURL(registryPath).href,
    "--path", aiosPath,
    "--home", homePath
  ]);

  const source = path.join(aiosPath, "skills", "hello-memory");
  assert.equal(fs.readlinkSync(path.join(homePath, ".agents", "skills", "hello-memory")), source);
  fs.rmSync(root, { recursive: true, force: true });
});
