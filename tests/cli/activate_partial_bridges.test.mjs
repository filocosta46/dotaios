import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// One unwritable client directory used to decide the fate of every other
// client. `createGlobalBridges` wrote one bridge per registry entry with no
// guard, so the first throw abandoned the loop: Claude Code was connected,
// Codex and Gemini were left untouched, and nothing said which was which. The
// user saw a raw POSIX errno naming a DotAIOS-internal .tmp file.
//
// A directory at mode 500 is not exotic: it is what a tool installed under
// sudo, or a locked-down corporate Mac, actually looks like.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// mode 500 does not stop root, so the failure being pinned cannot be staged.
const rootless = typeof process.getuid !== "function" || process.getuid() !== 0;

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-partial-bridge-"));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  for (const dir of [".claude", ".codex", ".gemini"]) {
    fs.mkdirSync(path.join(homePath, dir), { recursive: true });
  }
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

function runActivate(sandbox) {
  return spawnSync(
    process.execPath,
    [cli, "activate", "--path", sandbox.aiosPath, "--home", sandbox.homePath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: path.join(sandbox.root, "process-home"), PATH: "/usr/bin:/bin" }
    }
  );
}

test("one unwritable client directory does not strand the other clients", { skip: !rootless }, () => {
  const sandbox = makeSandbox();
  const blocked = path.join(sandbox.homePath, ".codex");
  fs.chmodSync(blocked, 0o500);

  let result;
  try {
    result = runActivate(sandbox);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }

  const output = `${result.stdout}${result.stderr}`;

  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".claude", "CLAUDE.md")),
    true,
    "the client written before the unwritable one keeps its bridge"
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".gemini", "GEMINI.md")),
    true,
    "the client written after the unwritable one must still be connected"
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".codex", "AGENTS.md")),
    false,
    "the unwritable client is the only one that stays unconnected"
  );

  assert.notEqual(result.status, 0, "an unconnected client is still a failed activation");
  assert.match(output, /Codex/, "the report must name the client that failed");
  assert.match(output, /permission/i, "an errno is not an explanation");
  assert.doesNotMatch(
    output,
    /\.dotaios-\d+-[0-9a-f]{8}-.*\.tmp/,
    "a DotAIOS-internal staging filename is not something to show a person"
  );
  assert.doesNotMatch(output, /EACCES/, "the raw POSIX code is not the user-facing message");
});

test("a bridge write failure is reported per client, not as one aborted run", { skip: !rootless }, () => {
  const sandbox = makeSandbox();
  const blocked = path.join(sandbox.homePath, ".codex");
  fs.chmodSync(blocked, 0o500);

  let result;
  try {
    result = runActivate(sandbox);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }

  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /\[failed\]/, "the failing client appears in the per-client report");
  assert.doesNotMatch(
    output,
    /Step 2 failed/,
    "a single client problem is not a whole-activation crash"
  );
  // `--merge` keeps what a file already says. It cannot help a directory that
  // refuses to be written, so offering it here would just waste a retry.
  assert.doesNotMatch(output, /activate --merge/, "the collision remedy is wrong for a permission failure");

  // The remaining client landing is what makes the retry finish the job.
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

// The counter this defect corrupts was asserted nowhere in the suite. A throw
// produced no result object, so it never incremented and the run reported
// neither the failure nor the successes.
test("a bridge that could not be written is counted as blocked", { skip: !rootless }, async () => {
  const sandbox = makeSandbox();
  const blocked = path.join(sandbox.homePath, ".codex");
  fs.chmodSync(blocked, 0o500);
  const previousExitCode = process.exitCode;

  const { activateCommand } = await import(
    path.join(repoRoot, "packages", "cli", "src", "commands", "activate.mjs")
  );
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  console.log = () => {};
  console.error = () => {};

  let activation;
  try {
    activation = await activateCommand(["--path", sandbox.aiosPath, "--home", sandbox.homePath]);
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exitCode = previousExitCode;
    fs.chmodSync(blocked, 0o755);
  }

  assert.equal(activation.blockedContextCount, 1, "the unwritable client is counted, not lost to a throw");
  assert.ok(activation.configuredContextCount >= 2, "the writable clients are still counted as configured");
  const failed = activation.results.filter((entry) => entry.action === "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].path, /\.codex[/\\]AGENTS\.md$/, "the result names the bridge, not a staged sibling");

  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

// `--merge` resolves exactly one kind of blocked bridge: an unmanaged file
// DotAIOS declined to replace. Offering it for a path that is not a regular
// file just spends the user's next run on a command that cannot work.
test("a bridge path that is not a regular file is not answered with --merge", () => {
  const sandbox = makeSandbox();
  // A directory where the bridge file belongs — writeManagedFile refuses it.
  fs.mkdirSync(path.join(sandbox.homePath, ".codex", "AGENTS.md"), { recursive: true });

  const result = runActivate(sandbox);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /left untouched/, "the run says the bridge was not changed");
  assert.match(output, /--merge` cannot resolve these/, "and says why the collision remedy does not apply");
  assert.doesNotMatch(
    output,
    /run `dotaios activate --merge`/,
    "the merge remedy is only for an unmanaged file that can actually be merged"
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".gemini", "GEMINI.md")),
    true,
    "the other clients are still connected"
  );

  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

// The skill store runs before the bridge loop, so this failure stranded every
// client at once — including the ones whose own directories were fine.
test("an unwritable skills projection target does not strand every client", { skip: !rootless }, () => {
  const sandbox = makeSandbox();
  const blocked = path.join(sandbox.homePath, ".claude");
  fs.chmodSync(blocked, 0o500);

  let result;
  try {
    result = runActivate(sandbox);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }

  const output = `${result.stdout}${result.stderr}`;
  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".codex", "AGENTS.md")),
    true,
    "a client with a writable directory is connected even when projection fails"
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.homePath, ".gemini", "GEMINI.md")),
    true,
    "every remaining client is connected"
  );
  assert.notEqual(result.status, 0, "a failed projection is still a failed activation");
  assert.match(output, /skill links could not be published/i, "the run says what failed");
  assert.doesNotMatch(output, /EACCES/, "the raw POSIX code is not the user-facing message");

  fs.rmSync(sandbox.root, { recursive: true, force: true });
});
