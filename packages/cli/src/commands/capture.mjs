import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { resolveMemoryPolicy } from "../../../core/src/memory-policy.mjs";
import { createEvidenceReader } from "../../../core/src/evidence-reader.mjs";
import { repeatedJsonObjectKey } from "../../../core/src/json.mjs";
import { writeSession, saveSessionSummary, filterSessions, deleteSession } from "../../../core/src/sessions.mjs";
import { parseRawText } from "../adapters/manual.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { emitReliabilityMetric } from "../lib/reliability-metrics.mjs";
import {
  resolvePortableProjectIdentity,
  resolveProjectContext,
  validateProjectSelector,
} from "../../../core/src/projects.mjs";

const SAVE_SUMMARY_MAX_BYTES = 64 * 1024;

const HELP_TEXT = `Usage:
  dotaios capture <subcommand> [options]

Save and search your AI conversations locally so other agents can remember them.

Subcommands:
  save-summary              Save one bounded session summary from v1 JSON on stdin
  import file <path>        Save a conversation file
  import paste              Paste a conversation (opens your editor)
  import claude-code [--all]  Backfill past Claude Code sessions
  list [--agent <a>] [--project <p>] [--since <n>d]
                            List saved conversations
  delete <id>               Delete a saved conversation
  status                    Show per-agent save capability
  enable [agent]            Enable auto-save for an agent
  disable [agent]           Disable auto-save for an agent

Options:
  --path <dir>  Use a non-default AIOS folder
  --project <p> Tag the session with a project name
`;

export async function captureCommand(args) {
  if (!args || args.length === 0 || hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const [sub, ...rest] = args;

  if (sub === "save-summary") return runSaveSummary(rest);
  if (sub === "import") return runImport(rest);
  if (sub === "list") return runList(rest);
  if (sub === "delete") return runDelete(rest);
  if (sub === "status") return runStatus(rest);
  if (sub === "enable") return runEnable(rest);
  if (sub === "disable") return runDisable(rest);
  if (sub === "hook") return runHook(rest);

  console.error(`Unknown capture subcommand: ${sub}`);
  console.log(HELP_TEXT);
  process.exitCode = 1;
}

// ---------- intentional summary save ----------

async function runSaveSummary(args) {
  const options = parseSaveSummaryOptions(args);
  const { input, requestHash } = await readSaveSummaryInput();
  const envelope = validateSaveSummaryEnvelope(input);
  const projectIdentity = envelope.memory.mode === "project"
    ? envelope.memory.project
    : null;
  const memoryPolicy = resolveMemoryPolicy({
    mode: envelope.memory.mode,
    project: projectIdentity?.id,
  });

  // Resolve policy before the AIOS path so Off is provably zero-access even when
  // the caller supplies a path that does not exist.
  if (memoryPolicy.mode === "off") {
    throw new Error("capture save-summary refuses Memory Off without reading or writing the AIOS folder.");
  }

  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  let project = null;
  if (projectIdentity) {
    project = await resolvePortableProjectIdentity({
      aiosPath,
      projectSelector: projectIdentity.id,
      evidenceReader: createEvidenceReader({ roots: [aiosPath] }),
    });
    if (project.id !== projectIdentity.id || project.slug !== projectIdentity.slug) {
      throw new Error("Project identity does not exactly match the registered project.");
    }
  }

  const receipt = await saveSessionSummary(aiosPath, {
    operation_id: envelope.operation_id,
    request_hash: requestHash,
    agent: envelope.session.agent,
    title: envelope.session.title,
    summary: envelope.session.summary,
    ...(project && { project: project.slug, project_id: project.id }),
  });
  console.log(JSON.stringify(receipt));
}

async function readSaveSummaryInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes >= SAVE_SUMMARY_MAX_BYTES) {
      throw new Error(`capture save-summary input must be smaller than the ${SAVE_SUMMARY_MAX_BYTES}-byte limit.`);
    }
    chunks.push(value);
  }

  const raw = Buffer.concat(chunks);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    throw new Error("capture save-summary input is not valid UTF-8.");
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("capture save-summary input is not valid JSON.");
  }
  const repeatedKey = repeatedJsonObjectKey(text);
  if (repeatedKey !== null) {
    throw new Error(`capture save-summary input sets "${repeatedKey}" twice; keep one decoded JSON key per object.`);
  }
  return {
    input,
    requestHash: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

function validateSaveSummaryEnvelope(input) {
  assertPlainObject(input, "capture save-summary input");
  assertExactKeys(input, ["version", "operation_id", "memory", "session"], "capture save-summary input");
  if (input.version !== 1) {
    throw new Error("capture save-summary supports only envelope version 1.");
  }
  if (
    typeof input.operation_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.operation_id)
  ) {
    throw new Error("capture save-summary operation_id must be 1-128 safe characters and start with a letter or number.");
  }

  assertPlainObject(input.memory, "capture save-summary memory");
  if (input.memory.mode === "project") {
    assertExactKeys(input.memory, ["mode", "project"], "capture save-summary memory");
    assertPlainObject(input.memory.project, "capture save-summary project");
    assertExactKeys(input.memory.project, ["id", "slug"], "capture save-summary project");
    validateProjectSelector(input.memory.project.id);
    validateProjectSelector(input.memory.project.slug);
  } else {
    assertExactKeys(input.memory, ["mode"], "capture save-summary memory");
    if (input.memory.mode !== "shared" && input.memory.mode !== "off") {
      throw new Error("capture save-summary memory mode must be shared, project, or off.");
    }
  }

  assertPlainObject(input.session, "capture save-summary session");
  assertExactKeys(input.session, ["agent", "title", "summary"], "capture save-summary session");
  if (
    typeof input.session.agent !== "string"
    || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.session.agent)
  ) {
    throw new Error("capture save-summary agent must be a lowercase slug of at most 64 characters.");
  }
  if (
    typeof input.session.title !== "string"
    || input.session.title.trim().length === 0
    || Array.from(input.session.title).length > 200
    || /[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.session.title)
  ) {
    throw new Error("capture save-summary title must be 1-200 characters without control or formatting characters.");
  }
  if (
    typeof input.session.summary !== "string"
    || input.session.summary.trim().length === 0
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input.session.summary)
    || /\p{Bidi_Control}|\p{Cs}/u.test(input.session.summary)
    || /\r(?!\n)/u.test(input.session.summary)
  ) {
    throw new Error("capture save-summary summary must be non-empty Markdown without unsafe control characters.");
  }

  return input;
}

function parseSaveSummaryOptions(args = []) {
  const options = { path: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--path" || options.path !== null) {
      throw new Error("capture save-summary accepts only one optional --path value; all save data belongs in the stdin envelope.");
    }
    options.path = readOptionValue(args, index, "--path");
    index += 1;
  }
  return options;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    const details = [
      unknown.length > 0 ? `unknown: ${unknown.join(", ")}` : null,
      missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    throw new Error(`${label} has invalid fields (${details}).`);
  }
}

// ---------- import ----------

async function runImport(args) {
  if (hasHelpFlag(args)) {
    console.log(`Usage:
  dotaios capture import file <path>  Save a conversation file
  dotaios capture import paste        Paste a conversation in your editor
  dotaios capture import claude-code [--all]  Backfill Claude Code sessions
`);
    return;
  }

  const [source, ...rest] = args;

  if (source === "file") return runImportFile(rest);
  if (source === "paste") return runImportPaste(rest);
  if (source === "claude-code") return runImportClaudeCode(rest);
  if (source === "cursor") return runImportCursor(rest);

  if (!source) {
    console.error("Usage: dotaios capture import <file|paste|claude-code|cursor>");
    process.exitCode = 1;
    return;
  }

  // Treat unknown source name as a file path (convenience)
  return runImportFile([source, ...rest]);
}

async function runImportFile(args) {
  const options = parseCommonOptions(args);
  const filePath = options.positionals[0];

  if (!filePath) {
    console.error("Usage: dotaios capture import file <path> [--project <name>]");
    process.exitCode = 1;
    return;
  }

  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  const resolved = path.resolve(expandHome(filePath));
  let text;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch (err) {
    throw new Error(`Cannot read file: ${resolved} (${err.message})`);
  }

  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });
  const session = parseRawText(text, {
    project: project?.slug,
    projectId: project?.id,
    sourceType: "import"
  });
  session.source_path = resolved;
  const result = await writeSession(aiosPath, session);

  if (result.skipped) {
    console.log("Already saved (no changes).");
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "file", outcome: "skipped" });
    return;
  }

  console.log(`Saved: ${result.relativePath}`);
  if (session.title) console.log(`Title: ${session.title}`);
  console.log(`Turns: ${session.turns.length}  ID: ${session.session_id}`);
  await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "file", outcome: "ok" });
}

async function runImportPaste(args) {
  const options = parseCommonOptions(args);
  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  const text = await openEditorForInput([
    "# Paste your AI conversation below this line, then save and close.",
    "# Lines starting with # are ignored.",
    "# Supported formats: Claude Code, ChatGPT, plain Human:/Assistant: dialogue.",
    "#",
  ].join("\n") + "\n");

  if (!text.trim()) {
    console.log("Nothing saved (empty input).");
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "paste", outcome: "empty" });
    return;
  }

  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });
  const session = parseRawText(text, {
    project: project?.slug,
    projectId: project?.id,
    sourceType: "manual"
  });
  const result = await writeSession(aiosPath, session);

  if (result.skipped) {
    console.log("Already saved (no changes).");
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "paste", outcome: "skipped" });
    return;
  }

  console.log(`Saved: ${result.relativePath}`);
  if (session.title) console.log(`Title: ${session.title}`);
  console.log(`Turns: ${session.turns.length}  ID: ${session.session_id}`);
  await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "paste", outcome: "ok" });
}

async function runImportClaudeCode(args) {
  // Loaded lazily so the command file stays importable even without the adapter
  const { importClaudeCode } = await import("../adapters/claude-code.mjs");
  const options = parseCommonOptions(args);
  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);
  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });

  try {
    await importClaudeCode(aiosPath, {
      all: options.all,
      project: project?.slug,
      projectId: project?.id,
    });
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "claude-code", outcome: "ok" });
  } catch (error) {
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source: "claude-code", outcome: "fail" });
    throw error;
  }
}

async function runImportCursor(args) {
  console.log(`Cursor: paste/import only for now.

Auto-save from Cursor is planned for a future release.

To save a Cursor conversation:
  1. Copy the conversation from Cursor.
  2. Run: dotaios capture import paste
  3. Paste into the editor that opens, save, and close.
`);
}

// ---------- list ----------

async function runList(args) {
  const options = parseCommonOptions(args);
  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });

  const entries = await filterSessions(aiosPath, {
    agent: options.agent,
    project: project?.slug,
    since: options.since,
  });

  if (entries.length === 0) {
    console.log("No saved conversations yet.");
    console.log("Save one with: dotaios capture import paste");
    return;
  }

  const sorted = entries.slice().sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const show = sorted.slice(0, options.limit || 20);

  console.log(`${show.length} saved conversation${show.length !== 1 ? "s" : ""}:\n`);
  for (const entry of show) {
    const date = entry.captured_at.slice(0, 10);
    const agent = entry.agent || "manual";
    const title = entry.title || "(untitled)";
    const turns = entry.turns || 0;
    const project = entry.project ? `  [${entry.project}]` : "";
    console.log(`  ${entry.session_id}  ${date}  ${agent}${project}`);
    console.log(`    ${title}  (${turns} turn${turns !== 1 ? "s" : ""})`);
  }

  if (sorted.length > show.length) {
    console.log(`\n  … and ${sorted.length - show.length} more. Use --limit to see more.`);
  }
}

// ---------- delete ----------

async function runDelete(args) {
  const options = parseCommonOptions(args);
  const sessionId = options.positionals[0];

  if (!sessionId) {
    console.error("Usage: dotaios capture delete <id>");
    process.exitCode = 1;
    return;
  }

  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  const deleted = await deleteSession(aiosPath, sessionId);
  console.log(`Deleted session ${deleted.session_id}`);
  if (deleted.title) console.log(`  ${deleted.title}`);
  await emitReliabilityMetric(aiosPath, { type: "capture_deleted", outcome: "ok" });
}

// ---------- status ----------

async function runStatus(args) {
  const { detectAdapters } = await import("../adapters/detect.mjs");
  const { getLevelLabel } = await import("../../../core/src/adapter-contract.mjs");
  const options = parseCommonOptions(args);
  const showAll = args.includes("--all");

  const detected = await detectAdapters();

  console.log("AI conversation capture status:\n");
  for (const [adapterName, info] of Object.entries(detected)) {
    if (!showAll && info.level === "unsupported") continue;
    const label = getLevelLabel(info.level);
    const active = info.enabled ? "  ✓ on" : "";
    console.log(`  ${adapterName.padEnd(16)} ${label}${active}`);
  }

  console.log("\nRun 'dotaios capture enable' to set up auto-save.");
  console.log("Run 'dotaios capture import paste' to save any conversation manually.");
}

// ---------- enable / disable ----------

async function runEnable(args) {
  const { enableAdapter } = await import("../adapters/detect.mjs");
  const options = parseCommonOptions(args);
  const adapterName = options.positionals[0];
  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  await enableAdapter(adapterName, aiosPath);
}

async function runDisable(args) {
  const { disableAdapter } = await import("../adapters/detect.mjs");
  const options = parseCommonOptions(args);
  const adapterName = options.positionals[0];
  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);

  await disableAdapter(adapterName, aiosPath);
}

// ---------- hook (internal) ----------

async function runHook(args) {
  const [adapterName, ...rest] = args;
  if (!adapterName) {
    console.error("Usage: dotaios capture hook <adapter>");
    process.exitCode = 1;
    return;
  }

  if (adapterName === "claude-code") {
    const { handleHookPayload } = await import("../adapters/claude-code.mjs");
    const options = parseCommonOptions(rest);
    const aiosPath = resolveAiosPath(options);
    await handleHookPayload(aiosPath);
    return;
  }

  console.error(`No hook handler for adapter: ${adapterName}`);
  process.exitCode = 1;
}

// ---------- helpers ----------

function parseCommonOptions(args = []) {
  const options = { positionals: [], path: null, project: null, agent: null, since: null, limit: 20, all: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--path") { options.path = readOptionValue(args, i, "--path"); i++; }
    else if (arg === "--project") { options.project = readOptionValue(args, i, "--project"); i++; }
    else if (arg === "--agent") { options.agent = readOptionValue(args, i, "--agent"); i++; }
    else if (arg === "--since") { options.since = readOptionValue(args, i, "--since"); i++; }
    else if (arg === "--limit") { options.limit = Number(readOptionValue(args, i, "--limit")); i++; }
    else if (arg === "--all") { options.all = true; }
    else if (!arg.startsWith("--")) { options.positionals.push(arg); }
  }

  return options;
}

function resolveAiosPath(options) {
  return path.resolve(expandHome(options.path || defaultAiosPath()));
}

async function openEditorForInput(header) {
  const tmpFile = path.join(os.tmpdir(), `dotaios-capture-${Date.now()}.md`);
  await fs.writeFile(tmpFile, header, "utf8");

  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const result = spawnSync(editor, [tmpFile], { stdio: "inherit" });

  if (result.error) {
    throw new Error(`Could not open editor "${editor}": ${result.error.message}. Set $EDITOR to your preferred editor.`);
  }

  const content = await fs.readFile(tmpFile, "utf8");
  await fs.unlink(tmpFile).catch(() => {});

  return content
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}
