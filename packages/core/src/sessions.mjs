import path from "node:path";

import {
  contentHash,
  generateSessionId,
  inferTitle,
  renderSessionBody,
  renderSessionMarkdown,
  sessionFilename,
} from "./session-codec.mjs";
import { createSessionStore } from "./session-store.mjs";

export const SESSIONS_SUBDIR = "memory/sessions";

export { contentHash, generateSessionId, inferTitle, renderSessionBody, renderSessionMarkdown, sessionFilename };

export function sessionDateDir(session) {
  return (session.captured_at || new Date().toISOString()).slice(0, 10);
}

/**
 * Compatibility facade for local callers while they migrate to SessionStore.
 * Storage authority remains inside the four-operation store; this wrapper only
 * translates its explicit outcomes to the historical return shape.
 */
export async function writeSession(aiosPath, session, options = {}) {
  const store = compatibilityStore(aiosPath, options);
  const result = await store.capture({ session });
  if (result.outcome === "refused" || result.outcome === "reconciliation_required") {
    const error = new Error("Session capture did not commit.");
    error.code = result.reason === "contention"
      ? "DOTAIOS_SESSION_STORE_CONTENTION"
      : "DOTAIOS_SESSION_RECONCILIATION_REQUIRED";
    throw error;
  }
  const relativePath = result.row.path;
  return {
    filePath: result.outcome === "idempotent" ? null : path.join(aiosPath, relativePath),
    relativePath,
    hash: result.row.content_hash,
    skipped: result.outcome === "idempotent",
    ...(result.outcome === "grown" ? { updated: true } : {}),
    outcome: result.outcome,
  };
}

export async function readSessionIndex(aiosPath, options = {}) {
  const result = await compatibilityStore(aiosPath, options).search({
    purpose: "catalog",
    query: "",
    ...(options.reader ? { reader: options.reader } : {}),
  });
  return [...result.rows].reverse();
}

export async function filterSessions(aiosPath, {
  agent,
  project,
  since,
  filesystem,
  reader,
} = {}) {
  const result = await compatibilityStore(aiosPath, { filesystem }).search({
    purpose: "metadata",
    query: "",
    agent,
    project,
    since: normalizeSince(since),
    reader,
  });
  return [...result.rows].reverse();
}

export async function deleteSession(aiosPath, sessionId, options = {}) {
  try {
    const result = await compatibilityStore(aiosPath, options).delete({ sessionId });
    return result.row;
  } catch (error) {
    if (error?.code === "DOTAIOS_SESSION_NOT_FOUND") {
      throw new Error(`Session not found: ${sessionId}`);
    }
    throw error;
  }
}

export async function searchSessions(aiosPath, query, {
  agent,
  project,
  since,
  limit = 20,
  filesystem,
  reader,
} = {}) {
  const result = await compatibilityStore(aiosPath, { filesystem }).search({
    purpose: "body",
    query,
    agent,
    project,
    since: normalizeSince(since),
    limit,
    reader,
  });
  const lower = String(query || "").toLowerCase();
  return result.rows.map(({ body, canonical_hash: _canonicalHash, ...entry }) => {
    const metadata = [entry.title, entry.agent, entry.project].filter(Boolean).join("\n").toLowerCase();
    const matchIndex = metadata.includes(lower) ? -1 : body.toLowerCase().indexOf(lower);
    const bodyMatch = matchIndex !== -1;
    return {
      entry,
      bodyMatch,
      ...(bodyMatch ? { snippet: extractSnippet(body, lower, matchIndex) } : {}),
    };
  });
}

function compatibilityStore(aiosPath, options = {}) {
  return createSessionStore({
    aiosPath,
    ...(options.filesystem ? { filesystem: options.filesystem } : {}),
  });
}

function normalizeSince(since) {
  if (!since) return undefined;
  const match = String(since).match(/^(\d+)([dhwm])$/);
  if (!match) return since;
  const days = {
    d: Number(match[1]),
    h: Number(match[1]) / 24,
    w: Number(match[1]) * 7,
    m: Number(match[1]) * 30,
  }[match[2]];
  return `${Math.ceil(days)}d`;
}

function extractSnippet(text, query, index) {
  if (index === -1) return "";
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + query.length + 60);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
}
