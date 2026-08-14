import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// ---------- helpers ----------

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-capture-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: dotaios ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  }
  return result;
}

function runFail(args, opts = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...opts,
  });
  assert.notEqual(result.status, 0, `Expected non-zero exit but got 0`);
  return result;
}

function writeConvFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function registerProject(aiosPath, tempRoot, slug) {
  const projectPath = path.join(tempRoot, `${slug}-checkout`);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "source.txt"), `${slug}\n`);
  run([
    "project", "add", projectPath,
    "--path", aiosPath,
    "--state-path", path.join(tempRoot, "home", ".dotaios", "projects.json"),
    "--slug", slug,
    "--apply"
  ]);
  return projectPath;
}

const SAMPLE_CONV = [
  "**user · 14:30**",
  "",
  "What is session memory in DotAIOS?",
  "",
  "**assistant · 14:31**",
  "",
  "Session memory saves your AI conversations locally.",
  "",
].join("\n");

const DIALOGUE_CONV = [
  "Human: Why is the sky blue?",
  "Assistant: Rayleigh scattering.",
  "Human: Cool, thanks.",
].join("\n");

// ---------- capture --help ----------

test("capture --help prints usage", () => {
  const result = run(["capture", "--help"]);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /import/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /delete/);
  assert.match(result.stdout, /status/);
});

test("capture with no subcommand prints usage", () => {
  const result = run(["capture"]);
  assert.match(result.stdout, /Usage:/);
});

// ---------- capture import file ----------

test("capture import file saves conversation and prints path", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "conv.md", SAMPLE_CONV);

  const result = run(["capture", "import", "file", file, "--path", aiosPath]);

  assert.match(result.stdout, /Saved:/);
  assert.match(result.stdout, /memory\/sessions\//);
  assert.match(result.stdout, /What is session memory/);
});

test("capture import file creates session file on disk", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "conv2.md", SAMPLE_CONV);

  run(["capture", "import", "file", file, "--path", aiosPath]);

  const sessionsDir = path.join(aiosPath, "memory", "sessions");
  const dates = fs.readdirSync(sessionsDir);
  assert.ok(dates.length > 0, "session date folder must exist");
  const files = fs.readdirSync(path.join(sessionsDir, dates[0]));
  assert.ok(files.length > 0, "session .md file must exist");
  const content = fs.readFileSync(path.join(sessionsDir, dates[0], files[0]), "utf8");
  assert.match(content, /What is session memory/);
});

test("capture import file deduplicates same file", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "dup.md", SAMPLE_CONV);

  run(["capture", "import", "file", file, "--path", aiosPath]);
  const result2 = run(["capture", "import", "file", file, "--path", aiosPath]);

  assert.match(result2.stdout, /Already saved/);
});

test("capture import file with --project tags the session", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "tagged.md", DIALOGUE_CONV);
  registerProject(aiosPath, tempRoot, "my-project");

  run(["capture", "import", "file", file, "--path", aiosPath, "--project", "my-project"]);

  const result = run(["capture", "list", "--path", aiosPath]);
  assert.match(result.stdout, /\[my-project\]/);
});

test("capture import file errors for missing path", () => {
  const { aiosPath } = setupAios();
  const result = runFail(["capture", "import", "file", "/nonexistent/file.md", "--path", aiosPath]);
  assert.match(result.stderr, /Cannot read file/);
});

// ---------- capture import <path> shorthand ----------

test("capture import <path> (shorthand) saves conversation", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "short.md", DIALOGUE_CONV);

  const result = run(["capture", "import", file, "--path", aiosPath]);
  assert.match(result.stdout, /Saved:/);
});

// ---------- capture list ----------

test("capture list shows empty message when no sessions", () => {
  const { aiosPath } = setupAios();
  const result = run(["capture", "list", "--path", aiosPath]);
  assert.match(result.stdout, /No saved conversations/);
});

test("capture list shows saved session", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "listed.md", SAMPLE_CONV);
  run(["capture", "import", "file", file, "--path", aiosPath]);

  const result = run(["capture", "list", "--path", aiosPath]);
  assert.match(result.stdout, /1 saved conversation/);
  assert.match(result.stdout, /What is session memory/);
  assert.match(result.stdout, /manual/);
});

test("capture list --agent filters by agent", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "filt.md", SAMPLE_CONV);
  run(["capture", "import", "file", file, "--path", aiosPath]);

  const result = run(["capture", "list", "--path", aiosPath, "--agent", "manual"]);
  assert.match(result.stdout, /1 saved conversation/);

  const empty = run(["capture", "list", "--path", aiosPath, "--agent", "claude-code"]);
  assert.match(empty.stdout, /No saved conversations/);
});

test("capture list --project filters by project", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "projf.md", SAMPLE_CONV);
  registerProject(aiosPath, tempRoot, "brain");
  registerProject(aiosPath, tempRoot, "other");
  run(["capture", "import", "file", file, "--path", aiosPath, "--project", "brain"]);

  const result = run(["capture", "list", "--path", aiosPath, "--project", "brain"]);
  assert.match(result.stdout, /\[brain\]/);

  const empty = run(["capture", "list", "--path", aiosPath, "--project", "other"]);
  assert.match(empty.stdout, /No saved conversations/);
});

test("capture rejects an explicit project that is not in the catalog", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "unknown-project.md", DIALOGUE_CONV);
  const result = runFail([
    "capture", "import", "file", file,
    "--path", aiosPath,
    "--project", "not-registered"
  ]);
  assert.match(result.stderr, /is not registered/);
});

test("capture infers the registered project from the checkout path in both directions", () => {
  const { aiosPath, tempRoot } = setupAios();
  const alphaPath = registerProject(aiosPath, tempRoot, "alpha");
  const betaPath = registerProject(aiosPath, tempRoot, "beta");
  const alphaFile = writeConvFile(tempRoot, "alpha.md", "Human: Alpha fact\nAssistant: Alpha response\n");
  const betaFile = writeConvFile(tempRoot, "beta.md", "Human: Beta fact\nAssistant: Beta response\n");

  const env = { ...process.env, HOME: path.join(tempRoot, "home") };
  run(["capture", "import", "file", alphaFile, "--path", aiosPath], { cwd: alphaPath, env });
  run(["capture", "import", "file", betaFile, "--path", aiosPath], { cwd: betaPath, env });

  const index = fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(index.map((entry) => entry.project).sort(), ["alpha", "beta"]);
  assert.ok(index.every((entry) => typeof entry.project_id === "string" && entry.project_id.length > 0));
});

test("Claude live hook attributes a session through the checkout path", () => {
  const { aiosPath, tempRoot } = setupAios();
  const alphaPath = registerProject(aiosPath, tempRoot, "alpha");
  const transcriptPath = path.join(tempRoot, "claude-transcript.jsonl");
  fs.writeFileSync(transcriptPath, [
    { type: "user", sessionId: "hook-session", timestamp: "2026-07-16T10:00:00.000Z", message: { role: "user", content: "Hook fact" } },
    { type: "assistant", sessionId: "hook-session", timestamp: "2026-07-16T10:01:00.000Z", message: { role: "assistant", content: "Hook response" } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  run(["capture", "hook", "claude-code", "--path", aiosPath], {
    cwd: alphaPath,
    env: { ...process.env, HOME: path.join(tempRoot, "home") },
    input: `${JSON.stringify({ transcript_path: transcriptPath, cwd: alphaPath })}\n`
  });

  const entries = fs.readFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].project, "alpha");
  assert.equal(typeof entries[0].project_id, "string");
});

test("Claude live hook keeps Private chat outside DotAIOS", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-private-hook-test-"));
  const missingAiosPath = path.join(tempRoot, "must-not-be-opened");
  const transcriptPath = path.join(tempRoot, "claude-private-transcript.jsonl");
  fs.writeFileSync(transcriptPath, [
    { type: "user", timestamp: "2026-08-14T10:00:00.000Z", message: { role: "user", content: "Private chat\nPlease help me think." } },
    { type: "assistant", timestamp: "2026-08-14T10:01:00.000Z", message: { role: "assistant", content: "I can help." } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  const result = run(["capture", "hook", "claude-code", "--path", missingAiosPath], {
    cwd: tempRoot,
    env: { ...process.env, HOME: path.join(tempRoot, "home") },
    input: `${JSON.stringify({ transcript_path: transcriptPath, cwd: tempRoot })}\n`
  });

  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(missingAiosPath), false, "Off must not create or inspect an AIOS folder");
});

// ---------- capture delete ----------

test("capture delete removes session by id", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "del.md", SAMPLE_CONV);
  run(["capture", "import", "file", file, "--path", aiosPath]);

  const listResult = run(["capture", "list", "--path", aiosPath]);
  // Extract session id (first 8-char hex in the list output)
  const idMatch = listResult.stdout.match(/([0-9a-f]{8})\s+\d{4}-\d{2}-\d{2}/);
  assert.ok(idMatch, "session id not found in list output");
  const sessionId = idMatch[1];

  const delResult = run(["capture", "delete", sessionId, "--path", aiosPath]);
  assert.match(delResult.stdout, /Deleted session/);

  const afterList = run(["capture", "list", "--path", aiosPath]);
  assert.match(afterList.stdout, /No saved conversations/);
});

test("capture delete with unknown id fails", () => {
  const { aiosPath } = setupAios();
  const result = runFail(["capture", "delete", "deadbeef", "--path", aiosPath]);
  assert.match(result.stderr, /Session not found: deadbeef/);
});

// ---------- no collision with dotaios import and dotaios ingest ----------

test("dotaios import still works independently of capture", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(
    tempRoot,
    "import-test.json",
    JSON.stringify({
      signals: [{ type: "chat-import", project: "test", summary: "Collision test signal." }],
    })
  );

  // dotaios import writes to memory/signals/, not memory/sessions/
  run(["import", file, "--path", aiosPath, "--apply"]);

  // sessions/ should be empty
  const sessionsDir = path.join(aiosPath, "memory", "sessions");
  const entries = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.equal(entries.length, 0, "import command must not write to memory/sessions/");
});

test("dotaios ingest still works independently of capture", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "note.txt", "A raw knowledge note for the vault.");

  const result = run(["ingest", file, "--path", aiosPath]);
  assert.match(result.stdout, /vault\/raw/);

  // sessions/ must still be empty
  const sessionsDir = path.join(aiosPath, "memory", "sessions");
  const entries = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.equal(entries.length, 0, "ingest must not write to memory/sessions/");
});

test("capture import does not write to memory/events.jsonl", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "noevents.md", SAMPLE_CONV);

  run(["capture", "import", "file", file, "--path", aiosPath]);

  const eventsFile = path.join(aiosPath, "memory", "events.jsonl");
  // events.jsonl either doesn't exist or doesn't contain session content
  if (fs.existsSync(eventsFile)) {
    const content = fs.readFileSync(eventsFile, "utf8");
    assert.ok(!content.includes("What is session memory"), "capture must not write to events.jsonl");
  }
});

// ---------- capture status ----------

test("capture status --all prints adapter summary including unsupported", () => {
  const result = run(["capture", "status", "--all"]);
  assert.match(result.stdout, /capture status/i);
  assert.match(result.stdout, /claude-code/);
});

test("capture enable with --path and no adapter does not parse path as adapter", () => {
  const { aiosPath, tempRoot } = setupAios();
  const result = run(["capture", "enable", "--path", aiosPath], {
    env: { ...process.env, HOME: tempRoot },
  });
  assert.match(result.stdout, /Found on this machine|No supported AI tools detected/i);
});

// --- 1.27: the capture hook is promoted into the default install path, so it
// has to resolve on the npx-only flow INSTALL.md actually prescribes. ---

// A real scaffolded folder, on a machine that has never run Claude Code. The
// AIOS must be genuine or `capture enable` bails before it ever touches the
// client settings, and these tests would pass for the wrong reason.
function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-home-"));
  const aios = path.join(home, "aios");
  const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  assert.equal(init.status, 0, init.stderr);
  fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
  return { home, aios };
}

function runWithHome(home, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });
}

test("the installed hook command resolves without a global install", () => {
  const { home, aios } = isolatedHome();

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);
  assert.equal(result.status, 0, result.stderr);

  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const command = settings.hooks.Stop[0].hooks[0].command;

  assert.match(command, /npx/, "INSTALL.md never installs dotaios globally, so a bare `dotaios` cannot resolve");
  assert.match(command, /capture hook claude-code/);
  // The path is shell-quoted now, so assert it is PRESENT rather than pinning
  // an unquoted form — quoting is what stops a home dir with a space breaking.
  assert.ok(command.includes(aios), `hook must carry the AIOS path: ${command}`);
});

test("enabling capture creates the client directory instead of crashing", () => {
  const { home, aios } = isolatedHome();
  assert.equal(fs.existsSync(path.join(home, ".claude")), false, "precondition: a fresh machine has no ~/.claude");

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("an existing hook is recognised even if it predates the npx form", () => {
  const { home, aios } = isolatedHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `dotaios capture hook claude-code --path ${aios}` }] }] }
  }));

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop.length, 1, "a 1.26-era hook must not be duplicated by the 1.27 form");
});

test("an unreadable settings file is never overwritten", () => {
  const { home, aios } = isolatedHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const settingsPath = path.join(home, ".claude", "settings.json");
  const corrupt = '{"hooks": {"Stop": [ THIS IS NOT JSON';
  fs.writeFileSync(settingsPath, corrupt);

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.notEqual(result.status, 0, "clobbering a user's client settings is worse than failing");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), corrupt, "the user's file must survive untouched");
});

// The user must be able to STOP recording. enable/disable/status have to agree
// on what a DotAIOS hook looks like, or consent becomes one-way.

test("what enable turns on, disable turns off", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");

  assert.equal(runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]).status, 0);
  const enabled = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(enabled.hooks.Stop.length, 1, "precondition: the hook is installed");

  const off = runWithHome(home, ["capture", "disable", "claude-code", "--path", aios]);
  assert.equal(off.status, 0, off.stderr);

  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const remaining = (after.hooks?.Stop || []).filter(
    (h) => h.hooks?.some?.((e) => e.command?.includes("capture hook claude-code"))
  );
  assert.deepEqual(remaining, [], "printing 'disabled' while still recording is a consent failure");
});

test("status reports capture as on once it is on", () => {
  const { home, aios } = isolatedHome();
  // detect.mjs only claims full-auto once it can prove it can read a transcript,
  // so a machine that has actually used Claude Code is the case under test.
  const projectDir = path.join(home, ".claude", "projects", "some-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "session.jsonl"), '{"type":"user","message":{"role":"user"}}\n');

  runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  const status = runWithHome(home, ["capture", "status", "--path", aios]);

  assert.equal(status.status, 0, status.stderr);
  // "import only" is what status prints when it cannot see a live hook. A user
  // who just enabled auto-save must not be told their conversations are not
  // being recorded when they are.
  const claudeLine = status.stdout.split("\n").find((line) => line.includes("claude-code")) || "";
  assert.doesNotMatch(claudeLine, /import only/, `status denied a hook it just wrote: ${claudeLine.trim()}`);
  assert.match(claudeLine, /auto-save/, `status must show auto-save is live: ${claudeLine.trim()}`);
});

test("a hook written by an earlier release can still be turned off", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `dotaios capture hook claude-code --path ${aios}` }] }] }
  }));

  assert.equal(runWithHome(home, ["capture", "disable", "claude-code", "--path", aios]).status, 0);

  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(after.hooks?.Stop || [], [], "upgrading must not strand a 1.26 hook the user cannot remove");
});

// --- The hook string is written into another program's config and executed by
// a shell. It has to survive a real home directory and a real upgrade. ---

function hookCommandFor(home) {
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  return settings.hooks.Stop[0].hooks[0].command;
}

test("a path containing a space does not word-split the hook", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios home "));
  const aios = path.join(home, "my aios");
  const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], {
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  assert.equal(init.status, 0, init.stderr);
  fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });

  assert.equal(runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]).status, 0);

  const command = hookCommandFor(home);
  // Claude Code runs this through a shell. Unquoted, `--path /a/my aios`
  // becomes `--path /a/my` and every session silently fails to save.
  assert.match(command, /--path '.*my aios'|--path ".*my aios"/, `path must be quoted: ${command}`);
});

test("the hook is pinned to a version, never to whatever is newest on npm", () => {
  const { home, aios } = isolatedHome();
  runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  const command = hookCommandFor(home);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.doesNotMatch(command, /@latest/, "a hook that auto-upgrades runs unreviewed code on every session end");
  assert.match(command, new RegExp(`dotaios@${pkg.version.replace(/\./g, "\\.")}`), command);
});

test("enabling over a hook written by an older release repairs it", () => {
  const { home, aios } = isolatedHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const settingsPath = path.join(home, ".claude", "settings.json");
  // Exactly what 1.26 wrote: a bare `dotaios` that never resolves on the npx path.
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `dotaios capture hook claude-code --path ${aios}` }] }] }
  }));

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);
  assert.equal(result.status, 0, result.stderr);

  const command = hookCommandFor(home);
  assert.match(command, /npx/, `a broken hook must be repaired, not reported as fine: ${command}`);
  assert.doesNotMatch(result.stdout, /already configured/, "silently leaving a broken hook is the bug");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings.hooks.Stop.length, 1, "repair must not duplicate the hook");
});
