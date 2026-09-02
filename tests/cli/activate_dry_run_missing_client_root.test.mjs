import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// A first-time machine has no ~/.claude yet. `activate` creates that directory
// itself before writing bridges, but `activate --dry-run` must not write, so the
// preview reached the managed-file boundary check with the root still absent.
// The check treated "missing" exactly like "symlink" or "not a directory" and
// reported the path as unsafe, so the preview exited 1 and told the user that
// `--merge` could not resolve it — while the real `activate` immediately after
// succeeded. A directory that does not exist yet is not hostile.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-activate-missing-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "skills", "test-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(aiosPath, "AGENTS.md"), "# My AIOS\n");
  fs.writeFileSync(
    path.join(aiosPath, "skills", "test-skill", "SKILL.md"),
    "---\nname: test-skill\ndescription: A test skill.\n---\n\n# Test Skill\n"
  );
  return { root, homePath, aiosPath };
}

function runActivate(sandbox, extraArgs = []) {
  const env = { ...process.env, HOME: path.join(sandbox.root, "process-home"), PATH: "/usr/bin:/bin" };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(
    process.execPath,
    [cli, "activate", "--path", sandbox.aiosPath, "--home", sandbox.homePath, "--all", ...extraArgs],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }
  );
}

test("activate --dry-run succeeds on a home that has no Claude config directory yet", (t) => {
  const sandbox = makeSandbox(t);
  assert.equal(fs.existsSync(path.join(sandbox.homePath, ".claude")), false);

  const result = runActivate(sandbox, ["--dry-run"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /unsafe managed root/i, output);
  assert.doesNotMatch(output, /unsafe-target/i, output);
  assert.match(output, /\[would create\][^\n]*\.claude[/\\]CLAUDE\.md/);
  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".claude")),
    false,
    "the preview must not create the client configuration directory"
  );
});

test("activate then writes the bridge the preview promised", (t) => {
  const sandbox = makeSandbox(t);

  const preview = runActivate(sandbox, ["--dry-run"]);
  const applied = runActivate(sandbox);

  assert.equal(preview.status, 0, `${preview.stdout}${preview.stderr}`);
  assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
  assert.match(applied.stdout, /\[created\][^\n]*\.claude[/\\]CLAUDE\.md/);
  assert.equal(fs.existsSync(path.join(sandbox.homePath, ".claude", "CLAUDE.md")), true);
});
