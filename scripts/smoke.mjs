import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-smoke-"));
const aiosPath = path.join(tempRoot, "aios");
const vaultPath = path.join(tempRoot, "vault");

run(["--help"]);
run(["init", "--path", aiosPath, "--vault-path", vaultPath, "--yes"]);
run(["status", "--path", aiosPath]);
run(["ingest", path.join(repoRoot, "README.md"), "--path", aiosPath]);
run(["install", path.join(repoRoot, "examples", "plugins", "hello-memory"), "--path", aiosPath]);
run(["install", path.join(repoRoot, "examples", "plugins", "hello-memory"), "--dry-run"]);

console.log(`Smoke test passed: ${tempRoot}`);

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}
