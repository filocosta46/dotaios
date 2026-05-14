import fs from "node:fs/promises";
import path from "node:path";
import { searchMarkdownDir, searchMemoryDir } from "./search.mjs";

export const RECENT_EVENT_LIMIT = 50;
export const SIGNAL_RETENTION_DAYS = 30;

// --- JSONL primitives ---

export function parseJsonlLine(line) {
  if (!line.trim()) return null;
  return JSON.parse(line);
}

export function formatJsonlEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}

// --- Read operations ---

/**
 * Read all entries from a JSONL file. Returns an empty array if file is missing.
 */
export async function readJsonl(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Read the most recent N entries from a JSONL file.
 */
export async function readRecentEvents(filePath, limit = RECENT_EVENT_LIMIT) {
  const all = await readJsonl(filePath);
  return all.slice(-limit);
}

/**
 * Read all signal files for a date range (inclusive).
 * @param {string} signalsDir - path to memory/signals/
 * @param {string} fromDate - ISO date string "YYYY-MM-DD"
 * @param {string} toDate - ISO date string "YYYY-MM-DD"
 */
export async function readSignals(signalsDir, fromDate, toDate) {
  let entries;
  try {
    entries = await fs.readdir(signalsDir);
  } catch {
    return [];
  }

  const signals = [];
  for (const file of entries.filter((f) => f.endsWith(".jsonl")).sort()) {
    const date = file.replace(".jsonl", "");
    if (date < fromDate || date > toDate) continue;
    const filePath = path.join(signalsDir, file);
    const lines = await readJsonl(filePath);
    signals.push(...lines);
  }
  return signals;
}

/**
 * Read today + yesterday signals (the default routing window).
 */
export function readRecentSignals(signalsDir) {
  const today = isoDate(new Date());
  const yesterday = isoDate(new Date(Date.now() - 86400000));
  return readSignals(signalsDir, yesterday, today);
}

// --- Write operations ---

/**
 * Append a structured event to events.jsonl.
 * Ensures required fields: ts, type.
 */
export async function appendEvent(eventsPath, { type, project, domain, summary, source, ...extra }) {
  if (!type) throw new Error("Event requires a type field");
  const entry = {
    ts: new Date().toISOString(),
    type,
    ...(project && { project }),
    ...(domain && { domain }),
    ...(summary && { summary }),
    ...(source && { source }),
    ...extra
  };
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.appendFile(eventsPath, formatJsonlEntry(entry));
  return entry;
}

/**
 * Append a signal to the appropriate date file in signals/.
 */
export async function appendSignal(signalsDir, { type, project, domain, summary, source, ...extra }) {
  const now = new Date();
  const entry = {
    ts: now.toISOString(),
    type: type || "signal",
    ...(project && { project }),
    ...(domain && { domain }),
    ...(summary && { summary }),
    ...(source && { source }),
    ...extra
  };
  const filePath = path.join(signalsDir, `${isoDate(now)}.jsonl`);
  await fs.mkdir(signalsDir, { recursive: true });
  await fs.appendFile(filePath, formatJsonlEntry(entry));
  return entry;
}

// --- Filter operations ---

/**
 * Filter events by any combination of fields.
 * @param {object[]} events - array of parsed JSONL entries
 * @param {object} filters - { type?, project?, domain?, from?, to?, query? }
 */
export function filterEvents(events, { type, project, domain, from, to, query } = {}) {
  return events.filter((event) => {
    if (type && event.type !== type) return false;
    if (project && event.project !== project) return false;
    if (domain && event.domain !== domain) return false;
    if (from && event.ts < from) return false;
    if (to && event.ts > to) return false;
    if (query) {
      const text = JSON.stringify(event).toLowerCase();
      if (!text.includes(query.toLowerCase())) return false;
    }
    return true;
  });
}

// --- Cleanup operations ---

/**
 * Compact events.jsonl: keep only the most recent N entries in the main file,
 * archive older entries to events-archive.jsonl.
 * Returns { archived: number, kept: number }.
 */
export async function compactEvents(eventsPath, limit = RECENT_EVENT_LIMIT) {
  const all = await readJsonl(eventsPath);
  if (all.length <= limit) {
    return { archived: 0, kept: all.length };
  }

  const toArchive = all.slice(0, -limit);
  const toKeep = all.slice(-limit);

  const archivePath = eventsPath.replace(/\.jsonl$/, "-archive.jsonl");
  const archiveContent = toArchive.map((entry) => formatJsonlEntry(entry)).join("");
  await fs.appendFile(archivePath, archiveContent);
  await fs.writeFile(eventsPath, toKeep.map((entry) => formatJsonlEntry(entry)).join(""));

  return { archived: toArchive.length, kept: toKeep.length };
}

/**
 * Remove signal files older than retentionDays.
 * Returns { removed: number, freedBytes: number }.
 */
export async function trimSignals(signalsDir, retentionDays = SIGNAL_RETENTION_DAYS) {
  let entries;
  try {
    entries = await fs.readdir(signalsDir);
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  const cutoff = isoDate(new Date(Date.now() - retentionDays * 86400000));
  let removed = 0;
  let freedBytes = 0;

  for (const file of entries.filter((f) => f.endsWith(".jsonl"))) {
    const date = file.replace(".jsonl", "");
    if (date >= cutoff) continue;

    const filePath = path.join(signalsDir, file);
    const stat = await fs.stat(filePath);
    freedBytes += stat.size;
    await fs.unlink(filePath);
    removed += 1;
  }

  return { removed, freedBytes };
}

// --- Search operations ---

/**
 * Search across all memory files (events + signals) for a keyword.
 * Returns matched entries with their source.
 */
export async function searchMemory(memoryDir, query, { limit = 20 } = {}) {
  return searchMemoryDir(memoryDir, query, { limit });
}

/**
 * Search across vault markdown files for a keyword.
 * Returns matched files with line-level context.
 */
export async function searchVault(vaultDir, query, { limit = 20 } = {}) {
  return searchMarkdownDir(vaultDir, query, { limit, sourcePrefix: "vault" });
}

/**
 * Search across context files for a keyword.
 */
export async function searchContext(contextDir, query, { limit = 10 } = {}) {
  return searchMarkdownDir(contextDir, query, { limit, sourcePrefix: "context" });
}

// --- Helpers ---

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
