import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { applyApprovedProjectRegistration } from "../helpers/project-registration.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("materialized agent instructions share one activation-captured CLI authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-candidate-authority-"));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(homePath, "aios");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });

  try {
    run(["init", "--yes", "--path", aiosPath, "--home", homePath]);
    applyApprovedProjectRegistration(
      (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }),
      ["project", "add", projectPath, "--path", aiosPath, "--home", homePath]
    );
    run([
      "activate", "--all", "--project", projectPath,
      "--path", aiosPath, "--home", homePath
    ]);

    const globalBridge = read(path.join(homePath, ".codex", "AGENTS.md"));
    assert.match(globalBridge, /"candidate_invocation":\{"executable":"[^"]+","argv_prefix":\["[^"]+"\]\}/);
    assert.match(globalBridge, /candidate_invocation\.executable/);
    assert.match(globalBridge, /candidate_invocation\.argv_prefix/);

    const instructionSurfaces = [
      path.join(aiosPath, "AGENTS.md"),
      path.join(aiosPath, "skills", "INDEX.md"),
      path.join(aiosPath, "skills", "RESOLVER.md"),
      path.join(projectPath, "AGENTS.md")
    ];
    for (const skillDir of fs.readdirSync(path.join(aiosPath, "skills"), { withFileTypes: true })) {
      if (!skillDir.isDirectory()) continue;
      const skillPath = path.join(aiosPath, "skills", skillDir.name, "SKILL.md");
      if (fs.existsSync(skillPath)) instructionSurfaces.push(skillPath);
    }

    const requiredReferences = new Set([
      path.join(aiosPath, "AGENTS.md"),
      path.join(projectPath, "AGENTS.md"),
      path.join(aiosPath, "skills", "save-session", "SKILL.md")
    ]);
    for (const surface of instructionSurfaces) {
      const content = read(surface);
      assert.doesNotMatch(
        content,
        /\bnpx(?:\.cmd)?\s+dotaios(?:@[^\s`]+)?/,
        `competing package-runner authority in ${surface}`
      );
      if (requiredReferences.has(surface)) assert.match(content, /candidate_invocation/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}
