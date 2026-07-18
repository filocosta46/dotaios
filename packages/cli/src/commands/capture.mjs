import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { writeSession, filterSessions, deleteSession } from "../../../core/src/sessions.mjs";
import { parseRawText } from "../adapters/manual.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { emitPilotMetric } from "../lib/pilot-metrics.mjs";
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
    await emitPilotMetric(aiosPath, { type: "capture_saved", source: "file", outcome: "skipped" });
    return;
  }

  console.log(`Saved: ${result.relativePath}`);
  if (session.title) console.log(`Title: ${session.title}`);
  console.log(`Turns: ${session.turns.length}  ID: ${session.session_id}`);
  await emitPilotMetric(aiosPath, { type: "capture_saved", source: "file", outcome: "ok" });
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
    await emitPilotMetric(aiosPath, { type: "capture_saved", source: "paste", outcome: "empty" });
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
    await emitPilotMetric(aiosPath, { type: "capture_saved", source: "paste", outcome: "skipped" });
    return;
  }

  console.log(`Saved: ${result.relativePath}`);
  if (session.title) console.log(`Title: ${session.title}`);
  console.log(`Turns: ${session.turns.length}  ID: ${session.session_id}`);
  await emitPilotMetric(aiosPath, { type: "capture_saved", source: "paste", outcome: "ok" });
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
    await emitPilotMetric(aiosPath, { type: "capture_saved", source: "claude-code", outcome: "ok" });
  } catch (error) {
    await emitPilotMetric(aiosPath, { type: "capture_saved", source: "claude-code", outcome: "fail" });
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
  await emitPilotMetric(aiosPath, { type: "capture_deleted", outcome: "ok" });
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
