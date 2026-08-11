import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { createSessionStore } from "../../../core/src/session-store.mjs";
import { SESSION_CODEC_LIMITS } from "../../../core/src/session-codec.mjs";
import { parseRawText } from "../adapters/manual.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { emitReliabilityMetric } from "../lib/reliability-metrics.mjs";
import { resolveProjectContext } from "../../../core/src/projects.mjs";

const HELP_TEXT = `Usage:
  dotaios capture <subcommand> [options]

Save and search your AI conversations locally so other agents can remember them.

Subcommands:
  import file <path>        Save a conversation file
  import paste              Paste a conversation (opens your editor)
  import claude-code [--all]  Backfill past Claude Code sessions
  list [--agent <a>] [--project <p>] [--since <n>d]
                            List saved conversations
  delete <id>               Delete a saved conversation
  reconcile [--apply]       Report or rebuild the derived session index
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

  if (sub === "import") return runImport(rest);
  if (sub === "list") return runList(rest);
  if (sub === "delete") return runDelete(rest);
  if (sub === "reconcile") return runReconcile(rest);
  if (sub === "status") return runStatus(rest);
  if (sub === "enable") return runEnable(rest);
  if (sub === "disable") return runDisable(rest);
  if (sub === "hook") return runHook(rest);

  console.error(`Unknown capture subcommand: ${sub}`);
  console.log(HELP_TEXT);
  process.exitCode = 1;
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
  if (source === "prepared") return runImportPrepared(rest);
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
  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });
  let result;
  try {
    result = await createSessionStore({ aiosPath }).capture({
      source: {
        path: resolved,
        policy: "manual-exact",
        parser: (text) => parseRawText(text, {
          project: project?.slug,
          projectId: project?.id,
          sourceType: "import",
        }),
      },
      project: project?.slug,
      projectId: project?.id,
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "DOTAIOS_SESSION_SOURCE_UNAVAILABLE") {
      throw new Error("Cannot read file.");
    }
    throw error;
  }
  await printCaptureOutcome(aiosPath, result, "file");
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
  const result = await createSessionStore({ aiosPath }).capture({ session });
  await printCaptureOutcome(aiosPath, result, "paste");
}

async function runImportPrepared(args) {
  const options = parseCommonOptions(args);
  const aiosPath = resolveAiosPath(options);
  await ensureAiosFolder(aiosPath);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > SESSION_CODEC_LIMITS.documentBytes) {
      const error = new Error("Prepared session input exceeds the bounded capture limit.");
      error.code = "DOTAIOS_SESSION_DOCUMENT_TOO_LARGE";
      throw error;
    }
    chunks.push(bytes);
  }
  const result = await createSessionStore({ aiosPath }).capture({
    preparedMarkdown: Buffer.concat(chunks),
  });
  await printCaptureOutcome(aiosPath, result, "prepared");
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
  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });

  const searched = await createSessionStore({ aiosPath }).search({
    purpose: "metadata",
    query: "",
    agent: options.agent,
    project: project?.slug,
    since: options.since,
  });
  const entries = searched.rows;

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

  let deleted;
  try {
    deleted = await createSessionStore({ aiosPath }).delete({ sessionId });
  } catch (error) {
    if (error?.code === "DOTAIOS_SESSION_NOT_FOUND") throw new Error(`Session not found: ${sessionId}`);
    throw error;
  }
  console.log(`Deleted session ${deleted.session.session_id}`);
  if (deleted.session.title) console.log(`  ${deleted.session.title}`);
  await emitReliabilityMetric(aiosPath, { type: "capture_deleted", outcome: "ok" });
}

async function runReconcile(args) {
  const options = parseCommonOptions(args);
  const aiosPath = resolveAiosPath(options);
  const apply = args.includes("--apply");
  const store = createSessionStore({ aiosPath });
  const result = await store.reconcile({ apply });
  if (apply) {
    console.log(`Session projection ${result.outcome}: ${result.rows} row${result.rows === 1 ? "" : "s"}.`);
    return;
  }
  console.log("Session reconciliation report:");
  console.log(`  orphan Markdown: ${result.orphan_markdown.length}`);
  console.log(`  stale rows: ${result.stale_rows.length}`);
  console.log(`  malformed rows: ${result.malformed_rows}`);
  console.log(`  unsafe rows: ${result.unsafe_rows}`);
  console.log(`  invalid Markdown: ${result.invalid_markdown.length}`);
  console.log(`  duplicate IDs: ${result.duplicate_ids.length}`);
  console.log(`  duplicate paths: ${result.duplicate_paths.length}`);
  console.log(`  duplicate sources: ${result.duplicate_sources.length}`);
  console.log(`  conflicting sources: ${result.conflicting_sources.length}`);
  console.log(`  projection missing: ${result.projection_missing ? "yes" : "no"}`);
  console.log(`  operational state: ${result.operational_state}`);
  if (["poisoned", "unsafe"].includes(result.operational_state)) {
    console.log("Preserve the private operational evidence and request support; automatic repair is refused.");
    return;
  }
  const projectionDrift = result.orphan_markdown.length
    || result.stale_rows.length
    || result.malformed_rows
    || result.unsafe_rows
    || result.duplicate_ids.length
    || result.duplicate_paths.length
    || result.projection_missing
    || result.operational_state === "pending";
  if (projectionDrift) {
    console.log("Run `dotaios capture reconcile --apply` to recover pending work and rebuild only the derived projection.");
  }
  if (result.duplicate_sources.length || result.conflicting_sources.length) {
    console.log("Use `dotaios capture list` to identify an exact unwanted session, then `dotaios capture delete <session-id>`; reconciliation never chooses or deletes evidence.");
  }
  if (result.invalid_markdown.length) {
    console.log("Invalid canonical Markdown requires manual evidence-preserving inspection; automatic repair is refused.");
  }
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

async function printCaptureOutcome(aiosPath, result, source) {
  if (result.outcome === "idempotent") {
    console.log("Already saved (no changes).");
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source, outcome: "skipped" });
    return;
  }
  if (result.outcome === "created" || result.outcome === "grown") {
    const session = result.session;
    console.log(`Saved: ${result.relativePath || result.row.path}`);
    if (session.title) console.log(`Title: ${session.title}`);
    console.log(`Turns: ${session.turns.length}  ID: ${session.session_id}`);
    await emitReliabilityMetric(aiosPath, { type: "capture_saved", source, outcome: result.outcome });
    return;
  }
  if (result.outcome === "conflict_preserved") {
    console.error("A divergent version was preserved; reconciliation is required.");
  } else if (result.outcome === "reconciliation_required") {
    console.error("Session capture is blocked until the conflicting source is reconciled.");
  } else {
    console.error(`Session capture refused (${result.reason || "unsafe_state"}).`);
  }
  const error = new Error("Session capture did not report success.");
  error.dotaiosCliReported = true;
  throw error;
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
