import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ADAPTER_LEVELS } from "../../../core/src/adapter-contract.mjs";
import { writeSession, readSessionIndex } from "../../../core/src/sessions.mjs";
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
const HOOK_COMMAND = `npx -y dotaios@latest capture hook claude-code`;
const HOOK_MARKER = "capture hook claude-code";

// ---------- backfill ----------

export async function importClaudeCode(aiosPath, { all = false, project = null, projectId = null } = {}) {
  const projectDirs = await listProjectDirs();
  if (projectDirs.length === 0) {
    console.log("No Claude Code sessions found in ~/.claude/projects/");
    return;
  }

  const cutoff = all ? null : new Date(Date.now() - 30 * 86400000).toISOString();
  const existing = await readSessionIndex(aiosPath);
  const existingPaths = new Set(existing.map((e) => e.source_path).filter(Boolean));

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const dirEntry of projectDirs) {
    // Claude's encoded transcript directory is not a project catalog entry;
    // leave it unscoped unless the caller supplied a resolved project.
    const inferredProject = project || null;
    const jsonlFiles = await listJsonlFiles(dirEntry.fullPath);

    for (const filePath of jsonlFiles) {
      if (existingPaths.has(filePath)) {
        skipped++;
        continue;
      }

      let lines;
      try {
        lines = await readJsonlLines(filePath);
      } catch {
        errors++;
        continue;
      }

      if (lines.length === 0) {
        skipped++;
        continue;
      }

      // Apply date cutoff based on first message timestamp
      const firstTs = firstTimestamp(lines);
      if (cutoff && firstTs && firstTs < cutoff) {
        skipped++;
        continue;
      }

      const session = parseTranscript(lines, {
        project: inferredProject,
        projectId,
        sourcePath: filePath,
      });

      if (!session || session.turns.length === 0) {
        skipped++;
        continue;
      }

      try {
        const result = await writeSession(aiosPath, session);
        if (result.skipped) {
          skipped++;
        } else {
          imported++;
        }
      } catch {
        errors++;
      }
    }
  }

  if (imported === 0 && skipped === 0) {
    console.log("No Claude Code sessions found.");
  } else if (imported === 0) {
    console.log(`0 new sessions (${skipped} already saved).`);
  } else {
    console.log(`Imported ${imported} session${imported !== 1 ? "s" : ""} from Claude Code.`);
    if (skipped > 0) console.log(`${skipped} already saved.`);
  }

  if (errors > 0) {
    console.log(`${errors} file${errors !== 1 ? "s" : ""} could not be read.`);
  }
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

  let lines;
  try {
    lines = await readJsonlLines(transcriptPath);
  } catch {
    process.exitCode = 0;
    return;
  }

  if (lines.length === 0) {
    process.exitCode = 0;
    return;
  }

  const project = await resolveProjectContext({
    aiosPath,
    cwd: payload.cwd || cwd
  });

  const session = parseTranscript(lines, {
    project: project?.slug || null,
    projectId: project?.id || null,
    sourcePath: transcriptPath,
  });

  if (!session || session.turns.length === 0) {
    process.exitCode = 0;
    return;
  }

  try {
    await writeSession(aiosPath, session);
  } catch (err) {
    process.stderr.write(`dotaios capture hook: failed to save session: ${err.message}\n`);
  }

  process.exitCode = 0;
}

// ---------- enable / disable ----------

export async function enable(aiosPath) {
  let settings;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    settings = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      // The file exists but we cannot read or parse it. Starting from {} would
      // write our hook over the user's entire Claude Code configuration.
      // Refusing is the only safe move; they can fix or move the file.
      throw new Error(
        `Cannot read ${SETTINGS_PATH}: ${error.message}\n` +
        "Fix or move that file, then run this again. Refusing to overwrite it."
      );
    }
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];

  const existing = settings.hooks.Stop.find(
    (h) => h.hooks?.some?.((e) => e.command?.includes(HOOK_MARKER))
  );

  if (existing) {
    console.log("Claude Code auto-save already configured.");
    return;
  }

  settings.hooks.Stop.push({
    hooks: [
      {
        type: "command",
        command: `${HOOK_COMMAND} --path ${aiosPath}`,
        timeout: 10,
        statusMessage: "Saving conversation to AIOS..."
      }
    ]
  });

  // A machine that has never run Claude Code has no ~/.claude yet.
  await fs.mkdir(CLAUDE_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log("Claude Code auto-save enabled.");
  console.log("Future conversations will be saved incrementally after each completed Claude Code response.");
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
    (h) => !h.hooks?.some?.((e) => e.command?.includes("dotaios capture hook claude-code"))
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
      (h) => h.hooks?.some?.((e) => e.command?.includes("dotaios capture hook claude-code"))
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

  const title = inferTitleFromTurns(turns);

  return {
    agent: "claude-code",
    session_id: sessionId,
    captured_at: capturedAt,
    source_type: "import",
    source_path: sourcePath,
    project,
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

async function readJsonlLines(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function firstTimestamp(lines) {
  for (const line of lines) {
    if (line.timestamp) return line.timestamp;
  }
  return null;
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

function inferTitleFromTurns(turns) {
  const first = turns.find((t) => t.role === "user");
  if (!first?.content) return null;
  const text = String(first.content).replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}
