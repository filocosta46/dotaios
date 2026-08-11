import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { enable as enableClaudeCapture } from "../../packages/cli/src/adapters/claude-code.mjs";
import { createSessionStore } from "../../packages/core/src/session-store.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const ACTIVATION_REFUSAL_DIAGNOSTIC = "Session capture activation refused: session memory requires reconciliation. "
  + "Run `dotaios capture reconcile` for the selected AIOS folder.\n";

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

test("capture import prepared submits canonical Markdown through SessionStore", () => {
  const { aiosPath } = setupAios();
  const prepared = [
    "---",
    "agent: codex",
    "captured_at: 2026-08-11T12:00:00.000Z",
    "source_type: prepared",
    "turns: 0",
    'title: "Prepared handoff"',
    "schema: 1",
    "---",
    "",
    "Bounded canonical body.",
  ].join("\n");

  const result = run(["capture", "import", "prepared", "--path", aiosPath], { input: prepared });
  assert.match(result.stdout, /Saved:/);
  assert.match(result.stdout, /Prepared handoff/);
  const storedId = result.stdout.match(/ID: ([0-9a-f]{8})/)?.[1];
  assert.ok(storedId);

  const listed = run(["capture", "list", "--path", aiosPath]);
  assert.match(listed.stdout, new RegExp(storedId));
  assert.match(listed.stdout, /Prepared handoff/);
});

test("capture import prepared refuses over-bound stdin before publication", () => {
  const { aiosPath } = setupAios();
  const result = runFail(["capture", "import", "prepared", "--path", aiosPath], {
    input: "x".repeat(1024 * 1024 + 1),
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.match(result.stderr, /bounded capture limit/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "sessions", "index.jsonl")), false);
});

test("capture report-only reconciliation is read-only and apply rebuilds only the projection", () => {
  const { aiosPath, tempRoot } = setupAios();
  const file = writeConvFile(tempRoot, "reconcile.md", SAMPLE_CONV);
  run(["capture", "import", "file", file, "--path", aiosPath]);
  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  fs.rmSync(storeRoot, { recursive: true, force: true });
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  fs.writeFileSync(indexPath, "{malformed}\n", { mode: 0o600 });

  const report = run(["capture", "reconcile", "--path", aiosPath]);
  assert.match(report.stdout, /malformed rows: 1/);
  assert.match(report.stdout, /unsafe rows: 0/);
  assert.match(report.stdout, /invalid Markdown: 0/);
  assert.match(report.stdout, /duplicate IDs: 0/);
  assert.match(report.stdout, /duplicate paths: 0/);
  assert.match(report.stdout, /projection missing: no/);
  assert.match(report.stdout, /operational state: clean/);
  assert.match(report.stdout, /capture reconcile --apply.*derived projection/);
  assert.equal(fs.existsSync(storeRoot), false, "report-only reconciliation must not create operational state");

  const applied = run(["capture", "reconcile", "--apply", "--path", aiosPath]);
  assert.match(applied.stdout, /1 row/);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(indexPath, "utf8").trim()));
});

test("capture reconciliation gives evidence-safe conflict remediation without suggesting projection rebuild", async () => {
  const { aiosPath, tempRoot } = setupAios();
  const sourcePath = writeConvFile(tempRoot, "conflict-source.json", "{}\n");
  const store = createSessionStore({ aiosPath });
  const candidate = (content) => ({
    agent: "manual",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "import",
    title: content,
    turns: [{ role: "user", content }],
  });
  await store.capture({
    source: { path: sourcePath, policy: "manual-exact", parser: () => candidate("first") },
  });
  await store.capture({
    source: { path: sourcePath, policy: "manual-exact", parser: () => candidate("divergent") },
  });

  const report = run(["capture", "reconcile", "--path", aiosPath]);
  assert.match(report.stdout, /conflicting sources: 1/);
  assert.match(report.stdout, /capture delete <session-id>/);
  assert.doesNotMatch(report.stdout, /capture reconcile --apply/);
});

test("capture reconciliation never suggests projection rebuild for poisoned operational evidence", () => {
  const { aiosPath } = setupAios();
  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(storeRoot, "unexpected"), "preserve me\n", { mode: 0o600 });

  const report = run(["capture", "reconcile", "--path", aiosPath]);
  assert.match(report.stdout, /operational state: poisoned/);
  assert.match(report.stdout, /preserve.*operational evidence.*support/i);
  assert.doesNotMatch(report.stdout, /capture reconcile --apply/);
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
  const homePath = path.join(tempRoot, "home");
  const transcriptPath = path.join(homePath, ".claude", "projects", "alpha", "claude-transcript.jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, [
    { type: "user", sessionId: "hook-session", timestamp: "2026-07-16T10:00:00.000Z", message: { role: "user", content: "Hook fact" } },
    { type: "assistant", sessionId: "hook-session", timestamp: "2026-07-16T10:01:00.000Z", message: { role: "assistant", content: "Hook response" } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  run(["capture", "hook", "claude-code", "--path", aiosPath], {
    cwd: alphaPath,
    env: { ...process.env, HOME: homePath },
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

test("Claude live hook stays zero-exit and reports no false success when a supplied transcript is not saved", () => {
  const { aiosPath, tempRoot } = setupAios();
  const homePath = path.join(tempRoot, "home");
  const transcriptPath = path.join(homePath, ".claude", "projects", "private-project", "secret-source.jsonl");

  const result = run(["capture", "hook", "claude-code", "--path", aiosPath], {
    env: { ...process.env, HOME: homePath },
    input: `${JSON.stringify({ transcript_path: transcriptPath })}\n`,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "dotaios capture hook: session not saved\n");
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 96);
  assert.equal(result.stderr.includes(transcriptPath), false);
  assert.doesNotMatch(result.stderr, /private-project|secret-source/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /(?:^|\n)Saved:|Already saved/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "sessions", "index.jsonl")), false);
});

test("Claude live hook contains project resolution failures without leaking catalog details", () => {
  const { aiosPath, tempRoot } = setupAios();
  const homePath = path.join(tempRoot, "home");
  const transcriptPath = path.join(homePath, ".claude", "projects", "private-project", "source.jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-11T10:00:00.000Z",
    message: { role: "user", content: "private transcript content" },
  })}\n`);
  fs.mkdirSync(path.join(aiosPath, "projects", "INVALID PRIVATE CATALOG"));

  const result = run(["capture", "hook", "claude-code", "--path", aiosPath], {
    env: { ...process.env, HOME: homePath },
    input: `${JSON.stringify({ transcript_path: transcriptPath })}\n`,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "dotaios capture hook: session not saved\n");
  assert.doesNotMatch(result.stderr, /INVALID|PRIVATE|transcript|source\.jsonl/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "sessions", "index.jsonl")), false);
});

test("Claude backfill exits nonzero when any discovered source is malformed", () => {
  const { aiosPath, tempRoot } = setupAios();
  const homePath = path.join(tempRoot, "home");
  const projectPath = path.join(homePath, ".claude", "projects", "fixture");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "good.jsonl"), [
    { type: "user", timestamp: "2026-08-11T10:00:00.000Z", message: { role: "user", content: "Good source" } },
    { type: "assistant", timestamp: "2026-08-11T10:01:00.000Z", message: { role: "assistant", content: "Saved exactly once" } },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(projectPath, "bad.jsonl"), "{malformed}\n");

  const result = runFail(["capture", "import", "claude-code", "--all", "--path", aiosPath], {
    env: { ...process.env, HOME: homePath },
  });

  assert.match(result.stdout, /Imported 1 session/);
  assert.match(result.stdout, /1 file could not be read/);
  assert.match(result.stderr, /backfill incomplete/i);
  const listed = run(["capture", "list", "--path", aiosPath]);
  assert.match(listed.stdout, /Good source/);
});

test("Claude backfill reports already-saved, cutoff, empty, and error outcomes separately", () => {
  const { aiosPath, tempRoot } = setupAios();
  const homePath = path.join(tempRoot, "home");
  const projectPath = path.join(homePath, ".claude", "projects", "outcomes");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "good.jsonl"), [
    { type: "user", timestamp: "2026-08-11T10:00:00.000Z", message: { role: "user", content: "Outcome source" } },
    { type: "assistant", timestamp: "2026-08-11T10:01:00.000Z", message: { role: "assistant", content: "Saved once" } },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(projectPath, "before-cutoff.jsonl"), `${JSON.stringify({
    type: "user",
    timestamp: "2020-01-01T00:00:00.000Z",
    message: { role: "user", content: "Old source" },
  })}\n`);
  fs.writeFileSync(path.join(projectPath, "empty.jsonl"), `${JSON.stringify({ type: "summary" })}\n`);
  fs.writeFileSync(path.join(projectPath, "malformed.jsonl"), "{malformed}\n");

  const first = runFail(["capture", "import", "claude-code", "--path", aiosPath], {
    env: { ...process.env, HOME: homePath },
  });
  assert.match(first.stdout, /Imported 1 session/);
  assert.match(first.stdout, /1 before the 30-day cutoff/);
  assert.match(first.stdout, /1 empty source/);
  assert.match(first.stdout, /1 file could not be read/);

  const second = runFail(["capture", "import", "claude-code", "--path", aiosPath], {
    env: { ...process.env, HOME: homePath },
  });
  assert.match(second.stdout, /0 new sessions/);
  assert.match(second.stdout, /1 already saved/);
  assert.match(second.stdout, /1 before the 30-day cutoff/);
  assert.match(second.stdout, /1 empty source/);
  assert.match(second.stdout, /1 file could not be read/);
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
  const hook = settings.hooks.Stop[0].hooks[0];
  const command = hook.command;

  assert.match(command, /npx/, "INSTALL.md never installs dotaios globally, so a bare `dotaios` cannot resolve");
  assert.match(command, /capture hook claude-code/);
  // The path is shell-quoted now, so assert it is PRESENT rather than pinning
  // an unquoted form — quoting is what stops a home dir with a space breaking.
  assert.ok(command.includes(aios), `hook must carry the AIOS path: ${command}`);
  assert.ok(hook.timeout > 10, "host timeout must exceed SessionStore's bounded lock wait");
  assert.equal(
    fs.existsSync(path.join(aios, ".dotaios", "session-store")),
    false,
    "fresh activation preflight must remain report-only",
  );
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

for (const [name, invalidSettings] of [
  ["array root", "[]\n"],
  ["array hooks container", '{"hooks":[]}\n'],
  ["object Stop container", '{"hooks":{"Stop":{}}}\n'],
]) {
  test(`capture activation rejects an invalid ${name} byte-identically`, async () => {
    const { home, aios } = isolatedHome();
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, invalidSettings);

    await assert.rejects(
      () => enableClaudeCapture(aios, { settingsPath }),
      /settings structure is unsupported/i,
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), invalidSettings);
    assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ["settings.json"]);
  });
}

test("a failed managed-hook cutover preserves the exact prior settings bytes", async () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = [
    "{",
    '  "theme": "dark",',
    '  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "dotaios capture hook claude-code --path legacy"}]}]}',
    "}",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);

  const failingFilesystem = new Proxy(fsp, {
    get(target, property) {
      if (property === "rename") {
        return async (source, destination) => {
          if (path.resolve(destination) === path.resolve(settingsPath)) {
            const error = new Error("simulated settings install failure");
            error.code = "EIO";
            throw error;
          }
          return target.rename(source, destination);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await assert.rejects(
    () => enableClaudeCapture(aios, { filesystem: failingFilesystem, settingsPath }),
    /simulated settings install failure/,
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ["settings.json"]);
});

test("a partial staged settings write cannot truncate the live legacy hook", async () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dotaios capture hook claude-code --path legacy"}]}]},"theme":"dark"}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);

  const failingFilesystem = new Proxy(fsp, {
    get(target, property) {
      if (property === "open") {
        return async (targetPath, flags, mode) => {
          const handle = await target.open(targetPath, flags, mode);
          if (flags !== "wx") return handle;
          return new Proxy(handle, {
            get(openHandle, handleProperty) {
              if (handleProperty === "writeFile") {
                return async () => {
                  await openHandle.writeFile("partial replacement");
                  const error = new Error("simulated partial staged write");
                  error.code = "EIO";
                  throw error;
                };
              }
              const value = Reflect.get(openHandle, handleProperty);
              return typeof value === "function" ? value.bind(openHandle) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await assert.rejects(
    () => enableClaudeCapture(aios, { filesystem: failingFilesystem, settingsPath }),
    /simulated partial staged write/,
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ["settings.json"]);
});

for (const failurePoint of ["published validation", "parent directory sync"]) {
  test(`a ${failurePoint} fault reports indeterminate success with the exact new hook live`, async () => {
    const { home, aios } = isolatedHome();
    const settingsPath = path.join(home, ".claude", "settings.json");
    const settingsDirectory = path.dirname(settingsPath);
    const previousBytes = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dotaios capture hook claude-code --path legacy"}]}]},"theme":"dark"}\n';
    fs.mkdirSync(settingsDirectory, { recursive: true });
    fs.writeFileSync(settingsPath, previousBytes);
    await enableClaudeCapture(aios, { settingsPath });
    const expectedBytes = fs.readFileSync(settingsPath);
    fs.writeFileSync(settingsPath, previousBytes);

    let published = false;
    const failingFilesystem = new Proxy(fsp, {
      get(target, property) {
        if (property === "rename") {
          return async (source, destination) => {
            await target.rename(source, destination);
            if (path.resolve(destination) === path.resolve(settingsPath)) published = true;
          };
        }
        if (failurePoint === "published validation" && property === "lstat") {
          return async (targetPath) => {
            if (published && path.resolve(targetPath) === path.resolve(settingsPath)) {
              const error = new Error("simulated published validation failure");
              error.code = "EIO";
              throw error;
            }
            return target.lstat(targetPath);
          };
        }
        if (failurePoint === "parent directory sync" && property === "open") {
          return async (targetPath, flags, mode) => {
            const handle = await target.open(targetPath, flags, mode);
            if (!published || path.resolve(targetPath) !== path.resolve(settingsDirectory)) return handle;
            return new Proxy(handle, {
              get(openHandle, handleProperty) {
                if (handleProperty === "sync") {
                  return async () => {
                    const error = new Error("simulated parent directory sync failure");
                    error.code = "EIO";
                    throw error;
                  };
                }
                const value = Reflect.get(openHandle, handleProperty);
                return typeof value === "function" ? value.bind(openHandle) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await enableClaudeCapture(aios, { filesystem: failingFilesystem, settingsPath });
    assert.equal(result.outcome, "installed_durability_indeterminate");
    assert.deepEqual(fs.readFileSync(settingsPath), expectedBytes);
    assert.notDeepEqual(fs.readFileSync(settingsPath), Buffer.from(previousBytes));
    assert.deepEqual(fs.readdirSync(settingsDirectory), ["settings.json"]);
  });
}

test("capture activation refuses projection drift without changing an existing managed hook", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = [
    "{",
    '  "permissions": { "allow": ["Read"] },',
    '  "hooks": {',
    '    "Stop": [',
    '      { "hooks": [{ "type": "command", "command": "dotaios capture hook claude-code --path legacy", "timeout": 10 }] }',
    "    ]",
    "  }",
    "}",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);
  fs.writeFileSync(path.join(aios, "memory", "sessions", "index.jsonl"), "{malformed}\n");

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, ACTIVATION_REFUSAL_DIAGNOSTIC);
  assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
  assert.equal(
    fs.existsSync(path.join(aios, ".dotaios", "session-store")),
    false,
    "report-only activation preflight must not create writer state",
  );
  assert.doesNotMatch(result.stderr, /legacy|settings\.json|memory\/sessions/);
});

test("capture activation refuses an unsafe canonical ancestor without exposing its path", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dotaios capture hook claude-code --path legacy"}]}]}}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);
  const outside = path.join(home, "outside-private-session-canary");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "canary.txt"), "PRIVATE CANARY\n");
  fs.symlinkSync(outside, path.join(aios, "memory", "sessions", "2026-08-11"));

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, ACTIVATION_REFUSAL_DIAGNOSTIC);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
  assert.equal(fs.readFileSync(path.join(outside, "canary.txt"), "utf8"), "PRIVATE CANARY\n");
  assert.doesNotMatch(result.stderr, /outside-private|canary|2026-08-11|settings\.json/);
});

test("capture activation refuses an over-bound projection without changing managed settings", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dotaios capture hook claude-code --path legacy"}]}]}}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);
  fs.writeFileSync(
    path.join(aios, "memory", "sessions", "index.jsonl"),
    "x".repeat(8 * 1024 * 1024 + 1),
  );

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, ACTIVATION_REFUSAL_DIAGNOSTIC);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
  assert.equal(fs.existsSync(path.join(aios, ".dotaios", "session-store")), false);
});

test("capture activation refuses a recoverable pending writer transaction without changing managed settings", async () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dotaios capture hook claude-code --path legacy"}]}]}}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);
  const store = createSessionStore({
    aiosPath: aios,
    faultInjector(phase) {
      if (phase === "after_pending") {
        const error = new Error("simulated pending writer transaction");
        error.code = "INJECTED_PENDING_WRITER";
        throw error;
      }
    },
  });
  await assert.rejects(() => store.capture({
    session: {
      agent: "paste",
      session_id: "ignored01",
      captured_at: "2026-08-11T12:00:00.000Z",
      source_type: "paste",
      title: "Pending activation fixture",
      turns: [{ role: "user", content: "pending activation fixture" }],
    },
  }));

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, ACTIVATION_REFUSAL_DIAGNOSTIC);
  assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
});

test("capture activation refuses poisoned writer state without changing managed settings", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  const existingSettings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"dotaios capture hook claude-code --path legacy"}]}]}}\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, existingSettings);
  const operationalRoot = path.join(aios, ".dotaios", "session-store");
  fs.mkdirSync(operationalRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(operationalRoot, 0o700);
  fs.writeFileSync(path.join(operationalRoot, "unexpected-private-state"), "do not discard\n", { mode: 0o600 });

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, ACTIVATION_REFUSAL_DIAGNOSTIC);
  assert.equal(result.stdout, "");
  assert.equal(fs.readFileSync(settingsPath, "utf8"), existingSettings);
  assert.equal(fs.readFileSync(path.join(operationalRoot, "unexpected-private-state"), "utf8"), "do not discard\n");
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
  const managedCommands = settings.hooks.Stop.flatMap((group) => group.hooks || [])
    .map((hook) => hook.command)
    .filter((command) => command?.includes("capture hook claude-code"));
  assert.equal(managedCommands.length, 1, "cutover must publish exactly one managed writer");
  assert.equal(
    managedCommands.some((managed) => managed.startsWith("dotaios capture hook")),
    false,
    "a successful cutover must not leave the legacy writer active alongside the replacement",
  );
});

test("managed-hook cutover drains every legacy and current duplicate before publishing one writer", () => {
  const { home, aios } = isolatedHome();
  const settingsPath = path.join(home, ".claude", "settings.json");
  assert.equal(runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]).status, 0);
  const currentCommand = hookCommandFor(home);
  const foreignCommands = ["foreign mixed hook", "foreign standalone hook"];
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    theme: "dark",
    hooks: {
      Stop: [
        {
          matcher: "mixed",
          hooks: [
            { type: "command", command: foreignCommands[0] },
            { type: "command", command: currentCommand, timeout: 15 },
          ],
        },
        {
          matcher: "legacy-only",
          hooks: [{ type: "command", command: `dotaios capture hook claude-code --path ${aios}` }],
        },
        {
          matcher: "current-duplicate",
          hooks: [{ type: "command", command: currentCommand, timeout: 15 }],
        },
        {
          matcher: "foreign-only",
          hooks: [{ type: "command", command: foreignCommands[1] }],
        },
      ],
    },
  }, null, 2)}\n`);

  const result = runWithHome(home, ["capture", "enable", "claude-code", "--path", aios]);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const commands = settings.hooks.Stop.flatMap((group) => group.hooks || []).map((hook) => hook.command);
  const managedCommands = commands.filter((command) => command?.includes("capture hook claude-code"));

  assert.deepEqual(commands.filter((command) => foreignCommands.includes(command)), foreignCommands);
  assert.deepEqual(managedCommands, [currentCommand], "cutover must leave exactly one current managed writer");
  assert.equal(settings.theme, "dark");
  assert.equal(
    settings.hooks.Stop.some((group) => ["legacy-only", "current-duplicate"].includes(group.matcher)),
    false,
    "empty managed-only groups must not survive cutover",
  );
});
