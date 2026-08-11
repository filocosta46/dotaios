import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EvidenceReadError } from "./evidence-reader.mjs";
import { readJsonl } from "./memory.mjs";
import { isPathWithinLexically } from "./paths.mjs";

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
  if (session.project_id) lines.push(`project_id: ${session.project_id}`);
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
        ...(session.project && { project: session.project }),
        ...(session.project_id && { project_id: session.project_id }),
        path: updatedRelative,
        content_hash: bodyHash,
      };
      await withIndexLock(aiosPath, async () => {
        const current = await readSessionIndex(aiosPath);
        const rest = current.filter((e) => e.source_path !== session.source_path);
        await writeSessionIndex(aiosPath, [...rest, updatedEntry]);
      });
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
    ...(session.project_id && { project_id: session.project_id }),
    turns: Array.isArray(session.turns) ? session.turns.length : 0,
    title: session.title || null,
    path: relativePath,
    content_hash: bodyHash,
  };

  await appendIndexEntry(aiosPath, indexEntry);
  return { filePath, relativePath, hash: bodyHash, skipped: false };
}

export async function readSessionIndex(aiosPath, options = {}) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  return readJsonl(indexPath, options);
}

export async function filterSessions(aiosPath, {
  agent,
  project,
  since,
  readOnly = false,
  filesystem,
  reader,
  root = aiosPath
} = {}) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  const entries = reader
    ? await reader.readJsonl(root, indexPath)
    : await readSessionIndex(aiosPath, {
        ...(filesystem ? { filesystem } : {}),
        quarantine: !readOnly
      });
  const sinceTs = since ? parseSinceFlag(since) : null;

  return entries.filter((entry) => {
    if (agent && entry.agent !== agent) return false;
    if (project && entry.project !== project) return false;
    if (sinceTs && entry.captured_at < sinceTs) return false;
    return true;
  });
}

export async function deleteSession(aiosPath, sessionId) {
  const entry = await withIndexLock(aiosPath, async () => {
    const entries = await readSessionIndex(aiosPath);
    const found = entries.find((e) => e.session_id === sessionId);
    if (!found) throw new Error(`Session not found: ${sessionId}`);
    await writeSessionIndex(aiosPath, entries.filter((e) => e.session_id !== sessionId));
    return found;
  });

  const filePath = path.join(aiosPath, entry.path);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return entry;
}

export async function searchSessions(aiosPath, query, {
  agent,
  project,
  since,
  limit = 20,
  readOnly = false,
  filesystem,
  reader,
  root = aiosPath
} = {}) {
  const entries = await filterSessions(aiosPath, {
    agent,
    project,
    since,
    readOnly,
    filesystem,
    reader,
    root
  });
  const lower = query.toLowerCase();
  const results = [];
  const sessionsRoot = path.resolve(aiosPath, SESSIONS_SUBDIR);

  for (const entry of entries.slice().reverse()) {
    let filePath = null;
    if (reader) {
      if (typeof entry.path !== "string" || entry.path.length === 0 || path.isAbsolute(entry.path)) {
        throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
      }
      filePath = path.resolve(aiosPath, entry.path);
      if (
        !isPathWithinLexically(path.resolve(root), filePath)
        || !isPathWithinLexically(sessionsRoot, filePath)
      ) {
        throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
      }
    }
    const titleMatch = (entry.title || "").toLowerCase().includes(lower);
    const agentMatch = (entry.agent || "").toLowerCase().includes(lower);
    const projectMatch = (entry.project || "").toLowerCase().includes(lower);

    if (titleMatch || agentMatch || projectMatch) {
      results.push({ entry, bodyMatch: false });
      if (results.length >= limit) break;
      continue;
    }

    filePath ||= path.join(aiosPath, entry.path);
    let body;
    try {
      body = reader
        ? await reader.readText(root, filePath)
        : await fs.readFile(filePath, "utf8");
      if (body === null) continue;
    } catch (error) {
      if (reader) throw error;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long a held lock can sit (by mtime) before we assume the holder is wedged
// and reclaim it. Index mutations are sub-second, so this is a generous backstop
// for a holder whose liveness we cannot otherwise determine.
const LOCK_STALE_MS = 15000;
// Hard ceiling on how long we wait for a live holder before giving up. Reaching
// it means a real process held the lock continuously — we error rather than run
// fn() unlocked, which would defeat the lock and corrupt the index.
const LOCK_WAIT_MS = 30000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but owned by another user
  }
}

// A lock is stealable if the PID written in it is no longer alive, or — as a
// backstop for an unreadable/legacy lock — if it is older than LOCK_STALE_MS.
async function lockIsStealable(lockPath) {
  let st;
  let raw;
  try {
    [st, raw] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
  } catch {
    return false; // lock vanished; let the open() retry win the race
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
  return Date.now() - st.mtimeMs > LOCK_STALE_MS;
}

// Atomically remove a stale lock. rename() is atomic: if two processes race to
// steal the same lock, exactly one wins the rename and the other gets ENOENT —
// so two stealers can't both delete a fresh lock and double-acquire. Best-effort;
// any error means another process already moved it, so we just retry the loop.
async function stealLock(lockPath) {
  const moved = `${lockPath}.steal.${process.pid}.${Date.now()}`;
  try {
    await fs.rename(lockPath, moved);
  } catch {
    return; // someone else stole or replaced it first
  }
  await fs.rm(moved, { force: true });
}

// Serialize index mutations across processes so a concurrent append and a full
// rewrite can't drop each other's changes. The lock records the
// holder's PID so a crashed holder is reclaimed immediately; a still-live holder
// is waited on (never overrun). Bounded by LOCK_WAIT_MS so the CLI never hangs.
async function withIndexLock(aiosPath, fn) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const lockPath = `${indexPath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle = null;
  while (!handle) {
    // Checked every iteration (including after a steal) so the loop is bounded.
    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring the session index lock (${lockPath}); a live process is holding it.`);
    }
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (await lockIsStealable(lockPath)) {
        await stealLock(lockPath);
      } else {
        await delay(50);
      }
    }
  }
  try {
    await handle.write(String(process.pid));
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    try {
      // Remove the lock only if it is still ours, or empty: open("wx") is
      // exclusive, so an empty lock can only be one we created but failed to
      // stamp. Either way it is safe — and necessary — to clean up.
      const current = (await fs.readFile(lockPath, "utf8")).trim();
      if (current === "" || Number.parseInt(current, 10) === process.pid) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {}
  }
}

async function appendIndexEntry(aiosPath, entry) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  // Append a single JSONL line with O_APPEND under the lock. Unlike a
  // read-modify-write rewrite, an atomic append can't drop a concurrent append's
  // entry even if the advisory lock is briefly double-held during a steal — the
  // realistic concurrency here is many captures appending at once.
  await withIndexLock(aiosPath, async () => {
    await fs.appendFile(indexPath, `${JSON.stringify(entry)}\n`);
  });
}

// Atomic replace. Callers must hold withIndexLock for the read-modify-write.
async function writeSessionIndex(aiosPath, entries) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  const tmpPath = `${indexPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, content.length > 0 ? content + "\n" : "", "utf8");
  await fs.rename(tmpPath, indexPath);
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
