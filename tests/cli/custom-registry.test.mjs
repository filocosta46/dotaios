import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `dotaios ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

test("activation resolves native skill targets from a project-owned registry", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-custom-registry-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");

  runCli(["init", "--path", aiosPath, "--yes"]);
  fs.writeFileSync(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [{
        name: "Custom Runner",
        detect: ".custom-runner",
        bridge: null,
        skills: { mode: "symlink", dir: ".custom/skills" }
      }]
    })
  );

  runCli(["activate", "--path", aiosPath, "--home", homePath, "--all"]);

  const link = path.join(homePath, ".custom", "skills", "audit");
  assert.equal(fs.readlinkSync(link), path.join(aiosPath, "skills", "audit"));
});
