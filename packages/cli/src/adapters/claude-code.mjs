import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ADAPTER_LEVELS } from "../../../core/src/adapter-contract.mjs";
import { inferTitle } from "../../../core/src/session-codec.mjs";
import { createSessionStore } from "../../../core/src/session-store.mjs";
import { resolveProjectContext } from "../../../core/src/projects.mjs";

export const name = "claude-code";
export const level = ADAPTER_LEVELS.FULL_AUTO;

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
// The documented install path is npx-only — INSTALL.md never installs dotaios
// globally — so a bare `dotaios` in the hook would not resolve and every
// session would fail to capture, silently. Match on the subcommand alone so a
// hook written by an earlier release is still recognised and never duplicated.
//
// Pinned to this exact version, never @latest. @latest would resolve to
// whatever is newest on npm at the moment the hook fires, so every session end
// would execute a build the user never installed or reviewed. The pin also
// makes the npx cache hit deterministic, which is what lets the hook work
// offline after its first run.
const HOOK_VERSION = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
).version;
const HOOK_COMMAND = `npx -y dotaios@${HOOK_VERSION} capture hook claude-code`;
const HOOK_MARKER = "capture hook claude-code";
const HOOK_TIMEOUT_SECONDS = 15;
const HOOK_NOT_SAVED_DIAGNOSTIC = "dotaios capture hook: session not saved\n";
const ACTIVATION_REFUSAL_MESSAGE = "Session capture activation refused: session memory requires reconciliation. "
  + "Run `dotaios capture reconcile` for the selected AIOS folder.";

// The command is written into another program's config and run through a
// shell, so a home directory with a space in it would otherwise word-split and
// silently break every save.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hookCommandFor(aiosPath) {
  return `${HOOK_COMMAND} --path ${shellQuote(aiosPath)}`;
}

// ---------- backfill ----------

export async function importClaudeCode(aiosPath, { all = false, project = null, projectId = null } = {}) {
  const projectDirs = await listProjectDirs();
  if (projectDirs.length === 0) {
    console.log("No Claude Code sessions found in ~/.claude/projects/");
    return;
  }

  const cutoff = all ? null : new Date(Date.now() - 30 * 86400000).toISOString();
  const store = createSessionStore({ aiosPath, claudeRoot: PROJECTS_DIR });

  let imported = 0;
  let alreadySaved = 0;
  let beforeCutoff = 0;
  let emptySources = 0;
  let errors = 0;

  for (const dirEntry of projectDirs) {
    // Claude's encoded transcript directory is not a project catalog entry;
    // leave it unscoped unless the caller supplied a resolved project.
    const inferredProject = project || null;
    const jsonlFiles = await listJsonlFiles(dirEntry.fullPath);

    for (const filePath of jsonlFiles) {
      try {
        const result = await store.capture({
          source: {
            path: filePath,
            policy: "claude-code-root",
            parser: (text) => parseTranscript(parseJsonlText(text), {
              project: inferredProject,
              projectId,
              sourcePath: filePath,
            }),
          },
          project: inferredProject,
          projectId,
          ...(cutoff ? { capturedAfter: cutoff } : {}),
        });
        if (result.outcome === "idempotent") {
          alreadySaved++;
        } else if (result.outcome === "refused" && result.reason === "before_cutoff") {
          beforeCutoff++;
        } else if (result.outcome === "refused" && result.reason === "empty_source") {
          emptySources++;
        } else if (["created", "grown"].includes(result.outcome)) {
          imported++;
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  }

  const skipped = alreadySaved + beforeCutoff + emptySources;
  if (imported === 0 && skipped === 0) {
    console.log("No Claude Code sessions found.");
  } else if (imported === 0) {
    console.log("0 new sessions.");
  } else {
    console.log(`Imported ${imported} session${imported !== 1 ? "s" : ""} from Claude Code.`);
  }
  if (alreadySaved > 0) console.log(`${alreadySaved} already saved.`);
  if (beforeCutoff > 0) console.log(`${beforeCutoff} before the 30-day cutoff.`);
  if (emptySources > 0) console.log(`${emptySources} empty source${emptySources !== 1 ? "s" : ""}.`);

  if (errors > 0) {
    console.log(`${errors} file${errors !== 1 ? "s" : ""} could not be read.`);
    throw new Error("Claude Code backfill incomplete; one or more sessions were not saved.");
  }
  return Object.freeze({ imported, alreadySaved, beforeCutoff, emptySources, errors });
}

// ---------- live hook ----------

export async function handleHookPayload(aiosPath, { cwd = process.cwd() } = {}) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.stderr.write("dotaios capture hook: invalid JSON from Claude Code\n");
    process.exitCode = 0;
    return;
  }

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) {
    // Silently exit — hook fired but no transcript_path. This session won't be saved.
    process.exitCode = 0;
    return;
  }

  try {
    const project = await resolveProjectContext({
      aiosPath,
      cwd: payload.cwd || cwd
    });
    const result = await createSessionStore({ aiosPath, claudeRoot: PROJECTS_DIR }).capture({
      source: {
        path: transcriptPath,
        policy: "claude-code-root",
        parser: (text) => parseTranscript(parseJsonlText(text), {
          project: project?.slug || null,
          projectId: project?.id || null,
          sourcePath: transcriptPath,
        }),
      },
      project: project?.slug || null,
      projectId: project?.id || null,
    });
    if (!["created", "grown", "idempotent"].includes(result.outcome)) {
      process.stderr.write(HOOK_NOT_SAVED_DIAGNOSTIC);
      process.exitCode = 0;
      return;
    }
  } catch {
    process.stderr.write(HOOK_NOT_SAVED_DIAGNOSTIC);
    process.exitCode = 0;
    return;
  }

  process.exitCode = 0;
}

// ---------- enable / disable ----------

export async function enable(aiosPath, {
  filesystem = fs,
  settingsPath = SETTINGS_PATH,
} = {}) {
  await assertWriterActivationCompatible(aiosPath);

  let snapshot;
  let settings;
  try {
    snapshot = await readSettingsSnapshot(settingsPath, filesystem);
    settings = snapshot.exists ? JSON.parse(snapshot.bytes.toString("utf8")) : {};
  } catch (error) {
    // Starting from {} after a read or parse failure would replace the user's
    // entire Claude Code configuration. Refuse before staging any replacement.
    throw new Error(
      `Cannot read ${settingsPath}: ${error.message}\n` +
      "Fix or move that file, then run this again. Refusing to overwrite it."
    );
  }
  assertSupportedSettings(settings);

  if (settings.hooks === undefined) settings.hooks = {};
  if (settings.hooks.Stop === undefined) settings.hooks.Stop = [];

  const wanted = hookCommandFor(aiosPath);
  const managed = settings.hooks.Stop.flatMap((group) => (
    group.hooks.filter((entry) => isManagedHook(entry))
  ));
  if (
    managed.length === 1
    && managed[0].command === wanted
    && managed[0].type === "command"
    && Number.isFinite(managed[0].timeout)
    && managed[0].timeout >= HOOK_TIMEOUT_SECONDS
  ) {
    console.log("Claude Code auto-save already configured.");
    return Object.freeze({ outcome: "already_configured" });
  }

  const hadManagedHook = managed.length > 0;
  settings.hooks.Stop = settings.hooks.Stop.flatMap((group) => {
    const hooks = group.hooks.filter((entry) => !isManagedHook(entry));
    if (hooks.length === 0 && group.hooks.length > 0) return [];
    return [{ ...group, hooks }];
  });
  settings.hooks.Stop.push({
    hooks: [
      {
        type: "command",
        command: wanted,
        timeout: HOOK_TIMEOUT_SECONDS,
        statusMessage: "Saving conversation to AIOS..."
      }
    ]
  });

  // A machine that has never run Claude Code has no ~/.claude yet.
  const publication = await replaceSettingsAtomically(settingsPath, snapshot, settings, filesystem);
  if (hadManagedHook) {
    console.log("Claude Code auto-save repaired.");
  } else {
    console.log("Claude Code auto-save enabled.");
    console.log("Future conversations will be saved incrementally after each completed Claude Code response.");
  }
  return publication;
}

function assertSupportedSettings(settings) {
  if (!isSettingsObject(settings)) throw unsupportedSettingsError();
  if (settings.hooks === undefined) return;
  if (!isSettingsObject(settings.hooks)) throw unsupportedSettingsError();
  if (settings.hooks.Stop === undefined) return;
  if (!Array.isArray(settings.hooks.Stop)) throw unsupportedSettingsError();
  for (const group of settings.hooks.Stop) {
    if (!isSettingsObject(group) || !Array.isArray(group.hooks)) throw unsupportedSettingsError();
    if (group.hooks.some((entry) => !isSettingsObject(entry))) throw unsupportedSettingsError();
  }
}

function isSettingsObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManagedHook(entry) {
  return typeof entry.command === "string" && entry.command.includes(HOOK_MARKER);
}

function unsupportedSettingsError() {
  const error = new Error("Claude Code settings structure is unsupported; refusing to overwrite it.");
  error.code = "DOTAIOS_CLAUDE_SETTINGS_UNSUPPORTED";
  return error;
}

async function readSettingsSnapshot(settingsPath, filesystem) {
  try {
    const observation = await observeSettingsFile(settingsPath, filesystem);
    return Object.freeze({ exists: true, ...observation });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ exists: false, bytes: null, stats: null });
    }
    throw error;
  }
}

async function observeSettingsFile(settingsPath, filesystem) {
  const before = await filesystem.lstat(settingsPath);
  assertSafeSettingsFile(before);
  let handle;
  try {
    handle = await filesystem.open(settingsPath, "r");
    const opened = await handle.stat();
    assertSafeSettingsFile(opened);
    if (!sameSettingsFile(before, opened)) throw settingsChangedError();
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const after = await filesystem.lstat(settingsPath);
    assertSafeSettingsFile(openedAfter);
    assertSafeSettingsFile(after);
    if (!sameSettingsFile(opened, openedAfter) || !sameSettingsFile(openedAfter, after)) {
      throw settingsChangedError();
    }
    return Object.freeze({ bytes, stats: after });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function replaceSettingsAtomically(settingsPath, snapshot, settings, filesystem) {
  const directory = path.dirname(settingsPath);
  await filesystem.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const mode = snapshot.exists ? snapshot.stats.mode & 0o777 : 0o600;
  let handle;
  try {
    handle = await filesystem.open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await filesystem.chmod(temporary, mode);
    const staged = await filesystem.lstat(temporary);
    assertSafeSettingsFile(staged);
    await assertSettingsSnapshotCurrent(settingsPath, snapshot, filesystem);
    await filesystem.rename(temporary, settingsPath);
    let published;
    try {
      published = await observeSettingsFile(settingsPath, filesystem);
    } catch (error) {
      if (isDefinitiveSettingsProofFailure(error)) throw error;
      return publicationIndeterminate();
    }
    if (!sameSettingsIdentity(staged, published.stats) || !published.bytes.equals(bytes)) {
      throw settingsChangedError();
    }
    try {
      await syncDirectory(directory, filesystem);
    } catch {
      return publicationIndeterminate();
    }
    return Object.freeze({ outcome: "installed" });
  } finally {
    await handle?.close().catch(() => {});
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertSettingsSnapshotCurrent(settingsPath, snapshot, filesystem) {
  if (!snapshot.exists) {
    try {
      await filesystem.lstat(settingsPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    throw settingsChangedError();
  }
  const current = await observeSettingsFile(settingsPath, filesystem);
  if (!sameSettingsFile(snapshot.stats, current.stats) || !snapshot.bytes.equals(current.bytes)) {
    throw settingsChangedError();
  }
}

function assertSafeSettingsFile(stats) {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (process.platform !== "win32" && stats.nlink !== 1)
    || (
      process.platform !== "win32"
      && typeof process.getuid === "function"
      && Number(stats.uid) !== process.getuid()
    )
  ) {
    const error = new Error("Claude Code settings are not a safe owned regular file.");
    error.code = "DOTAIOS_CLAUDE_SETTINGS_UNSAFE";
    throw error;
  }
}

function isDefinitiveSettingsProofFailure(error) {
  return [
    "DOTAIOS_CLAUDE_SETTINGS_CHANGED",
    "DOTAIOS_CLAUDE_SETTINGS_UNSAFE",
    "ENOENT",
    "ELOOP",
    "ENOTDIR",
  ].includes(error?.code);
}

function publicationIndeterminate() {
  console.warn("Claude Code auto-save settings were installed, but directory durability could not be confirmed.");
  return Object.freeze({ outcome: "installed_durability_indeterminate" });
}

function sameSettingsIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSettingsFile(left, right) {
  return sameSettingsIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function settingsChangedError() {
  const error = new Error("Claude Code settings changed during managed-hook cutover.");
  error.code = "DOTAIOS_CLAUDE_SETTINGS_CHANGED";
  return error;
}

async function syncDirectory(directory, filesystem) {
  let handle;
  try {
    handle = await filesystem.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertWriterActivationCompatible(aiosPath) {
  try {
    const store = createSessionStore({ aiosPath });
    const report = await store.reconcile({ apply: false });
    if (activationReportHasDrift(report)) throw new Error(ACTIVATION_REFUSAL_MESSAGE);

    // Reconciliation reports syntax and projection drift. A bounded metadata
    // read additionally proves that canonical ancestors and artifacts are safe.
    await store.search({ purpose: "metadata", query: "", limit: 1 });
  } catch {
    throw new Error(ACTIVATION_REFUSAL_MESSAGE);
  }
}

function activationReportHasDrift(report) {
  return report.operational_state !== "clean"
    || report.malformed_rows !== 0
    || report.unsafe_rows !== 0
    || [
      "orphan_markdown",
      "stale_rows",
      "invalid_markdown",
      "duplicate_ids",
      "duplicate_paths",
      "duplicate_sources",
      "conflicting_sources",
    ].some((key) => report[key].length !== 0);
}

export async function disable(aiosPath) {
  let settings;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    settings = JSON.parse(raw);
  } catch {
    console.log("No Claude Code settings found.");
    return;
  }

  if (!settings.hooks?.Stop) {
    console.log("Claude Code auto-save was not enabled.");
    return;
  }

  settings.hooks.Stop = settings.hooks.Stop.filter(
    (h) => !h.hooks?.some?.((e) => e.command?.includes(HOOK_MARKER))
  );

  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log("Claude Code auto-save disabled.");
}

export async function isEnabled() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    return settings.hooks?.Stop?.some?.(
      (h) => h.hooks?.some?.((e) => e.command?.includes(HOOK_MARKER))
    ) ?? false;
  } catch {
    return false;
  }
}

// ---------- transcript parser ----------

export function parseTranscript(lines, { project = null, projectId = null, sourcePath = null } = {}) {
  const messages = lines.filter((e) => e.type === "user" || e.type === "assistant");
  if (messages.length === 0) return null;

  const first = messages[0];
  const sessionId = extractSessionId(sourcePath) || first.uuid?.replace(/-/g, "").slice(0, 8) || "unknown";
  const capturedAt = first.timestamp || new Date().toISOString();

  const turns = [];
  for (const msg of messages) {
    const role = msg.message?.role;
    if (!role) continue;

    const text = extractTextContent(msg.message?.content || []);
    if (!text) continue;

    turns.push({
      role,
      content: text,
      ts: msg.timestamp,
    });
  }

  if (turns.length === 0) return null;

  const title = inferTitle(turns);

  return {
    agent: "claude-code",
    session_id: sessionId,
    captured_at: capturedAt,
    source_type: "import",
    source_path: sourcePath,
    ...(project && { project }),
    ...(projectId && { project_id: projectId }),
    title,
    turns,
  };
}

// ---------- helpers ----------

async function listProjectDirs() {
  let entries;
  try {
    entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, fullPath: path.join(PROJECTS_DIR, e.name) }));
}

async function listJsonlFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

function parseJsonlText(content) {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function extractSessionId(sourcePath) {
  if (!sourcePath) return null;
  const base = path.basename(sourcePath, ".jsonl");
  if (/^[0-9a-f-]{36}$/.test(base)) {
    return base.replace(/-/g, "").slice(0, 8);
  }
  return null;
}

function extractTextContent(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return typeof contentBlocks === "string" ? contentBlocks.trim() : null;
  }

  const parts = [];
  for (const block of contentBlocks) {
    if (block.type === "text" && block.text) {
      parts.push(block.text.trim());
    }
    // Skip: thinking, tool_use, tool_result, document
  }

  const text = parts.join("\n\n").trim();
  return text || null;
}
