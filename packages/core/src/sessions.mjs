import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./memory.mjs";

export const SESSIONS_SUBDIR = "memory/sessions";
const INDEX_FILENAME = "index.jsonl";

export function generateSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

export function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function sessionFilename(session) {
  const ts = (session.captured_at || new Date().toISOString())
    .slice(0, 19)
    .replace(/:/g, "-");
  const agent = (session.agent || "manual").replace(/[^a-z0-9]/g, "-").toLowerCase();
  const shortId = (session.session_id || "").slice(0, 6);
  return `${ts}_${agent}_${shortId}.md`;
}

export function sessionDateDir(session) {
  return (session.captured_at || new Date().toISOString()).slice(0, 10);
}

export function inferTitle(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const first = turns.find((t) => t.role === "user");
  if (!first?.content) return null;
  const text = String(first.content).trim().replace(/\s+/g, " ");
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

export function renderSessionBody(session) {
  const lines = [];
  for (const turn of session.turns || []) {
    const timeStr = turn.ts ? ` · ${String(turn.ts).slice(11, 16)}` : "";
    lines.push(`**${turn.role}${timeStr}**`);
    lines.push("");
    if (turn.content) lines.push(String(turn.content));
    lines.push("");
  }
  return lines.join("\n");
}

export function renderSessionMarkdown(session) {
  const turnCount = Array.isArray(session.turns) ? session.turns.length : 0;
  const lines = [
    "---",
    `agent: ${session.agent || "manual"}`,
    `session_id: ${session.session_id}`,
    `captured_at: ${session.captured_at}`,
    `source_type: ${session.source_type || "manual"}`,
  ];
  if (session.source_path) lines.push(`source_path: ${session.source_path}`);
  if (session.project) lines.push(`project: ${session.project}`);
  lines.push(`turns: ${turnCount}`);
  if (session.title) lines.push(`title: "${escapeYaml(session.title)}"`);
  lines.push("schema: 1");
  lines.push("---");
  lines.push("");
  lines.push(renderSessionBody(session));

  return lines.join("\n");
}

export async function writeSession(aiosPath, session) {
  const sessionsBase = path.join(aiosPath, SESSIONS_SUBDIR);
  const bodyHash = contentHash(renderSessionBody(session));

  if (session.source_path) {
    const existing = await readSessionIndex(aiosPath);
    const priorEntry = existing.find((e) => e.source_path === session.source_path);

    if (priorEntry) {
      // Same source, same content → nothing to do
      if (priorEntry.content_hash === bodyHash) {
        return { filePath: null, relativePath: priorEntry.path, hash: bodyHash, skipped: true };
      }

      // Same source, content changed (transcript grew) → update in place
      // Preserve original session identity so the session_id and date stay stable
      const stable = {
        ...session,
        session_id: priorEntry.session_id,
        captured_at: priorEntry.captured_at,
      };
      const updatedDir = sessionDateDir(stable);
      const updatedFilename = sessionFilename(stable);
      const updatedDirPath = path.join(sessionsBase, updatedDir);
      const updatedFilePath = path.join(updatedDirPath, updatedFilename);
      const updatedRelative = path.join(SESSIONS_SUBDIR, updatedDir, updatedFilename);

      // Remove old file if path changed (shouldn't happen often, but be safe)
      if (priorEntry.path !== updatedRelative) {
        try { await fs.unlink(path.join(aiosPath, priorEntry.path)); } catch {}
      }

      await fs.mkdir(updatedDirPath, { recursive: true });
      await fs.writeFile(updatedFilePath, renderSessionMarkdown(stable), "utf8");

      const updatedEntry = {
        ...priorEntry,
        turns: Array.isArray(session.turns) ? session.turns.length : priorEntry.turns,
        title: session.title || priorEntry.title,
        path: updatedRelative,
        content_hash: bodyHash,
      };
      const rest = existing.filter((e) => e.source_path !== session.source_path);
      await writeSessionIndex(aiosPath, [...rest, updatedEntry]);
      return { filePath: updatedFilePath, relativePath: updatedRelative, hash: bodyHash, skipped: false, updated: true };
    }
  }

  // New session — write file and append to index
  const dateDir = sessionDateDir(session);
  const filename = sessionFilename(session);
  const dirPath = path.join(sessionsBase, dateDir);
  const filePath = path.join(dirPath, filename);
  const relativePath = path.join(SESSIONS_SUBDIR, dateDir, filename);

  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(filePath, renderSessionMarkdown(session), "utf8");

  const indexEntry = {
    session_id: session.session_id,
    agent: session.agent || "manual",
    captured_at: session.captured_at,
    source_type: session.source_type || "manual",
    ...(session.source_path && { source_path: session.source_path }),
    ...(session.project && { project: session.project }),
    turns: Array.isArray(session.turns) ? session.turns.length : 0,
    title: session.title || null,
    path: relativePath,
    content_hash: bodyHash,
  };

  await appendIndexEntry(aiosPath, indexEntry);
  return { filePath, relativePath, hash: bodyHash, skipped: false };
}

export async function readSessionIndex(aiosPath) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  return readJsonl(indexPath);
}

export async function filterSessions(aiosPath, { agent, project, since } = {}) {
  const entries = await readSessionIndex(aiosPath);
  const sinceTs = since ? parseSinceFlag(since) : null;

  return entries.filter((entry) => {
    if (agent && entry.agent !== agent) return false;
    if (project && entry.project !== project) return false;
    if (sinceTs && entry.captured_at < sinceTs) return false;
    return true;
  });
}

export async function deleteSession(aiosPath, sessionId) {
  const entries = await readSessionIndex(aiosPath);
  const entry = entries.find((e) => e.session_id === sessionId);
  if (!entry) throw new Error(`Session not found: ${sessionId}`);

  const filePath = path.join(aiosPath, entry.path);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const remaining = entries.filter((e) => e.session_id !== sessionId);
  await writeSessionIndex(aiosPath, remaining);
  return entry;
}

export async function searchSessions(aiosPath, query, { agent, project, since, limit = 20 } = {}) {
  const entries = await filterSessions(aiosPath, { agent, project, since });
  const lower = query.toLowerCase();
  const results = [];

  for (const entry of entries.slice().reverse()) {
    const titleMatch = (entry.title || "").toLowerCase().includes(lower);
    const agentMatch = (entry.agent || "").toLowerCase().includes(lower);
    const projectMatch = (entry.project || "").toLowerCase().includes(lower);

    if (titleMatch || agentMatch || projectMatch) {
      results.push({ entry, bodyMatch: false });
      if (results.length >= limit) break;
      continue;
    }

    const filePath = path.join(aiosPath, entry.path);
    let body;
    try {
      body = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const bodyContent = stripFrontmatter(body);
    if (bodyContent.toLowerCase().includes(lower)) {
      const snippet = extractSnippet(bodyContent, lower);
      results.push({ entry, bodyMatch: true, snippet });
    }

    if (results.length >= limit) break;
  }

  return results;
}

async function appendIndexEntry(aiosPath, entry) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function writeSessionIndex(aiosPath, entries) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  await fs.writeFile(indexPath, content.length > 0 ? content + "\n" : "", "utf8");
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseSinceFlag(since) {
  const match = since.match(/^(\d+)([dhwm])$/);
  if (!match) return since;
  const n = Number(match[1]);
  const ms = { d: 86400000, h: 3600000, w: 604800000, m: 2592000000 }[match[2]];
  return new Date(Date.now() - n * ms).toISOString();
}

function stripFrontmatter(content) {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  return content.slice(end + 4);
}

function extractSnippet(text, query) {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return "";
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
}
