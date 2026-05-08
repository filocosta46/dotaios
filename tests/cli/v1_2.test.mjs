import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("search finds keyword across context and vault", () => {
  const { aiosPath } = setupAios();

  // Write searchable content
  fs.writeFileSync(
    path.join(aiosPath, "context", "work.md"),
    "# Work\n\n## Current Work\n\nBuilding the DotAIOS memory system for thesis research.\n"
  );
  fs.mkdirSync(path.join(aiosPath, "vault", "wiki", "ai-agents"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "vault", "wiki", "ai-agents", "_index.md"),
    "# AI Agents\n\nAgents use local context to make better decisions.\n"
  );

  // Ingest a file so there's a memory event
  run(["ingest", path.join(repoRoot, "README.md"), "--path", aiosPath]);

  // Search for "agent" — should find context + vault + memory
  const result = run(["search", "agent", "--path", aiosPath]);
  assert.match(result.stdout, /context\//);
  assert.match(result.stdout, /vault\//);
  assert.match(result.stdout, /result\(s\) found/);

  // Search with scope filter
  const vaultOnly = run(["search", "agent", "--scope", "vault", "--path", aiosPath]);
  assert.match(vaultOnly.stdout, /vault\//);
  assert.doesNotMatch(vaultOnly.stdout, /── context\//);

  // Search for something that doesn't exist
  const noResults = run(["search", "xyznonexistent123", "--path", aiosPath]);
  assert.match(noResults.stdout, /No results found/);
});

test("search validates scope and limit", () => {
  const { aiosPath } = setupAios();

  const badScope = runFail(["search", "agent", "--scope", "projects", "--path", aiosPath]);
  assert.match(badScope.stderr, /Invalid --scope/);

  const badLimit = runFail(["search", "agent", "--limit", "0", "--path", aiosPath]);
  assert.match(badLimit.stderr, /Invalid --limit/);

  const badNumericLimit = runFail(["search", "agent", "--limit", "2.5", "--path", aiosPath]);
  assert.match(badNumericLimit.stderr, /Invalid --limit/);
});

test("ingest writes a structured memory event", () => {
  const { aiosPath, tempRoot } = setupAios();
  const sourcePath = path.join(tempRoot, "notes.md");
  fs.writeFileSync(sourcePath, "# Notes\n\nBeta memory hardening.\n");

  run(["ingest", sourcePath, "--path", aiosPath]);

  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  const [event] = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(event.type, "ingest");
  assert.equal(event.source, sourcePath);
  assert.equal(event.destination, path.join(aiosPath, "vault", "raw", "notes.md"));
  assert.equal(event.summary, "Ingested notes.md");
  assert.ok(event.ts);
});

test("cleanup compacts events and trims old signals", () => {
  const { aiosPath } = setupAios();

  // Create 60 events (more than the limit of 50)
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  const events = [];
  for (let i = 0; i < 60; i++) {
    events.push(JSON.stringify({ ts: `2026-05-0${Math.floor(i / 10) + 1}T12:00:00Z`, type: "test", summary: `event ${i}` }));
  }
  fs.writeFileSync(eventsPath, events.join("\n") + "\n");

  // Create an old signal file (40 days ago) and a recent one
  const signalsDir = path.join(aiosPath, "memory", "signals");
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(signalsDir, `${oldDate}.jsonl`),
    JSON.stringify({ ts: `${oldDate}T12:00:00Z`, type: "old-signal" }) + "\n"
  );
  fs.writeFileSync(
    path.join(signalsDir, `${todayDate}.jsonl`),
    JSON.stringify({ ts: `${todayDate}T12:00:00Z`, type: "fresh-signal" }) + "\n"
  );

  // Dry run first — nothing should change
  const dryResult = run(["cleanup", "--dry-run", "--path", aiosPath]);
  assert.match(dryResult.stdout, /dry run/i);
  assert.match(dryResult.stdout, /Would archive 10 events/);
  assert.match(dryResult.stdout, /Would remove 1 signal/);
  // Verify files untouched
  const eventsBefore = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  assert.equal(eventsBefore.length, 60);

  // Real cleanup
  const realResult = run(["cleanup", "--path", aiosPath]);
  assert.match(realResult.stdout, /Archived 10 entries, kept 50/);
  assert.match(realResult.stdout, /Removed 1 file/);

  // Verify events compacted
  const eventsAfter = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  assert.equal(eventsAfter.length, 50);

  // Verify archive created
  const archivePath = path.join(aiosPath, "memory", "events-archive.jsonl");
  const archived = fs.readFileSync(archivePath, "utf8").split("\n").filter(Boolean);
  assert.equal(archived.length, 10);

  // Verify old signal deleted, fresh signal kept
  assert.equal(fs.existsSync(path.join(signalsDir, `${oldDate}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(signalsDir, `${todayDate}.jsonl`)), true);
});

test("cleanup handles empty memory gracefully", () => {
  const { aiosPath } = setupAios();
  const result = run(["cleanup", "--path", aiosPath]);
  assert.match(result.stdout, /nothing to compact/i);
  assert.match(result.stdout, /nothing to trim/i);
});

test("connect google dry-run checks gws without writing files", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);

  const result = run(["connect", "google", "--dry-run", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(result.stdout, /Google Workspace dry run/);
  assert.match(result.stdout, /Would verify auth/);
  assert.match(result.stdout, /Read-first beta scope/);
  assert.equal(fs.existsSync(path.join(aiosPath, "connections", "apis", "google-workspace.md")), false);
});

test("connect google status verifies auth without writing files", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);

  const result = run(["connect", "google", "--status", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(result.stdout, /Google Workspace status/);
  assert.match(result.stdout, /looks ready/);
  assert.equal(fs.existsSync(path.join(aiosPath, "connections", "apis", "google-workspace.md")), false);
});

test("connect google writes connection files and a structured memory event", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);

  const result = run(["connect", "google", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(result.stdout, /Connected Google Workspace/);

  const connectionDoc = fs.readFileSync(path.join(aiosPath, "connections", "apis", "google-workspace.md"), "utf8");
  assert.match(connectionDoc, /Auth: managed by `gws`/);
  assert.match(connectionDoc, /Send\/write actions require explicit approval|explicit approval first/);

  const registry = fs.readFileSync(path.join(aiosPath, "connections", "registry.md"), "utf8");
  assert.match(registry, /Google Workspace \| Active/);

  const skill = fs.readFileSync(path.join(aiosPath, "skills", "google-workspace", "SKILL.md"), "utf8");
  assert.match(skill, /name: google-workspace/);
  assert.match(skill, /Ask before sending/);

  const skillRegistry = JSON.parse(fs.readFileSync(path.join(aiosPath, "skills", "_registry.json"), "utf8"));
  assert.equal(skillRegistry.skills.includes("google-workspace"), true);

  const events = fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const event = events.at(-1);
  assert.equal(event.type, "connection");
  assert.equal(event.connection, "google-workspace");
  assert.equal(event.tool, "gws");
});

test("connect google refuses unsupported services and unauthenticated gws", () => {
  const { aiosPath, tempRoot } = setupAios();
  const badService = runFail(["connect", "slack", "--path", aiosPath]);
  assert.match(badService.stderr, /Unsupported connection/);

  const gwsBin = createFakeGws(tempRoot, { authOk: false });
  const notReady = runFail(["connect", "google", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(notReady.stderr, /auth is not ready/);
  assert.equal(fs.existsSync(path.join(aiosPath, "connections", "apis", "google-workspace.md")), false);
});

test("connect google detects unusable gws auth even when status exits zero", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot, { authJsonInvalid: true });

  const notReady = runFail(["connect", "google", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(notReady.stdout, /Could not decrypt/);
  assert.match(notReady.stderr, /auth is not ready/);

  const status = run(["google", "status", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(status.stdout, /\[missing\] gws auth status/);
  assert.match(status.stdout, /Could not decrypt/);
});

test("google status reports connection and auth state", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);

  const before = run(["google", "status", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(before.stdout, /DotAIOS Google status/);
  assert.match(before.stdout, /\[missing\] DotAIOS Google connection note/);
  assert.match(before.stdout, /\[ok\] gws auth status/);

  run(["connect", "google", "--path", aiosPath, "--gws-bin", gwsBin]);
  const after = run(["google", "status", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(after.stdout, /\[ok\] DotAIOS Google connection note/);
});

test("google setup explains the nontechnical OAuth path", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot, { authOk: false });

  const result = run(["google", "setup", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(result.stdout, /What this setup really means/);
  assert.match(result.stdout, /Google requires an OAuth client/);
  assert.match(result.stdout, /read-only scopes for: gmail,calendar,drive/);
  assert.match(result.stdout, /gws auth login --readonly --services gmail,calendar,drive/);
});

test("google setup helps when gws is missing", () => {
  const { aiosPath, tempRoot } = setupAios();
  const missingGws = path.join(tempRoot, "missing-gws");

  const setup = run(["google", "setup", "--path", aiosPath, "--gws-bin", missingGws]);
  assert.match(setup.stdout, /\[missing\] gws CLI/);
  assert.match(setup.stdout, /npm install -g @googleworkspace\/cli/);

  const workflow = runFail(["google", "inbox", "--path", aiosPath, "--gws-bin", missingGws]);
  assert.match(workflow.stderr, /Google Workspace CLI is required/);
});

test("google read-first workflows run through gws after connect", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);
  run(["connect", "google", "--path", aiosPath, "--gws-bin", gwsBin]);

  const inbox = run(["google", "inbox", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(inbox.stdout, /Running: gws gmail \+triage/);
  assert.match(inbox.stdout, /Inbox triage: 2 unread messages/);

  const agenda = run(["google", "agenda", "--today", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(agenda.stdout, /Running: gws calendar \+agenda --today/);
  assert.match(agenda.stdout, /Calendar agenda: today/);

  const drive = run(["google", "drive", "--page-size", "5", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(drive.stdout, /Running: gws drive files list --params/);
  assert.match(drive.stdout, /Drive files: 5 requested/);
});

test("google workflows validate setup and safe options", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);

  const notConnected = runFail(["google", "inbox", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(notConnected.stderr, /not connected/);

  run(["connect", "google", "--path", aiosPath, "--gws-bin", gwsBin]);

  const badRange = runFail(["google", "agenda", "--today", "--week", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(badRange.stderr, /Use only one agenda range/);

  const badPageSize = runFail(["google", "drive", "--page-size", "0", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(badPageSize.stderr, /--page-size must be a positive integer/);

  const badWorkflow = runFail(["google", "send", "--path", aiosPath, "--gws-bin", gwsBin]);
  assert.match(badWorkflow.stderr, /Unsupported Google workflow/);
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-v12-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  fs.mkdirSync(path.join(tempRoot, "project"), { recursive: true });
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

function createFakeGws(tempRoot, { authJsonInvalid = false, authOk = true } = {}) {
  const gwsBin = path.join(tempRoot, "gws");
  fs.writeFileSync(
    gwsBin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("gws 0.22.5");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (${authJsonInvalid ? "true" : "false"}) {
    console.log(JSON.stringify({
      auth_method: "oauth2",
      client_config_exists: true,
      encrypted_credentials_exists: true,
      encryption_error: "Could not decrypt",
      encryption_valid: false,
      token_cache_exists: true
    }, null, 2));
    process.exit(0);
  }
  if (${authOk ? "true" : "false"}) {
    console.log("Authenticated as beta@example.com");
    process.exit(0);
  }
  console.error("Not authenticated");
  process.exit(1);
}
if (args[0] === "gmail" && args[1] === "+triage") {
  console.log("Inbox triage: 2 unread messages");
  process.exit(0);
}
if (args[0] === "calendar" && args[1] === "+agenda") {
  console.log("Calendar agenda: " + (args.includes("--today") ? "today" : "upcoming"));
  process.exit(0);
}
if (args[0] === "drive" && args[1] === "files" && args[2] === "list") {
  const paramsIndex = args.indexOf("--params");
  const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
  console.log("Drive files: " + (params.pageSize || 10) + " requested");
  process.exit(0);
}
console.error("Unexpected gws command: " + args.join(" "));
process.exit(2);
`
  );
  fs.chmodSync(gwsBin, 0o755);
  return gwsBin;
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }

  return result;
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status === 0) {
    throw new Error(`Command unexpectedly passed: dotaios ${args.join(" ")}\n${result.stdout}`);
  }

  return result;
}
