import fs from "node:fs/promises";
import path from "node:path";

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
  } catch {
    return [];
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
  const results = [];
  const q = query.toLowerCase();

  // Search events
  const eventsPath = path.join(memoryDir, "events.jsonl");
  const events = await readJsonl(eventsPath);
  for (const event of events) {
    if (JSON.stringify(event).toLowerCase().includes(q)) {
      results.push({ source: "memory/events.jsonl", ...event });
    }
  }

  // Search archived events
  const archivePath = path.join(memoryDir, "events-archive.jsonl");
  const archived = await readJsonl(archivePath);
  for (const event of archived) {
    if (JSON.stringify(event).toLowerCase().includes(q)) {
      results.push({ source: "memory/events-archive.jsonl", ...event });
    }
  }

  // Search signals
  const signalsDir = path.join(memoryDir, "signals");
  let signalFiles;
  try {
    signalFiles = (await fs.readdir(signalsDir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    signalFiles = [];
  }
  for (const file of signalFiles) {
    const signals = await readJsonl(path.join(signalsDir, file));
    for (const signal of signals) {
      if (JSON.stringify(signal).toLowerCase().includes(q)) {
        results.push({ source: `memory/signals/${file}`, ...signal });
      }
    }
  }

  // Return most recent first, capped at limit
  return results.reverse().slice(0, limit);
}

/**
 * Search across vault markdown files for a keyword.
 * Returns matched files with line-level context.
 */
export async function searchVault(vaultDir, query, { limit = 20 } = {}) {
  const results = [];
  const q = query.toLowerCase();

  let allFiles;
  try {
    allFiles = await listMarkdownFiles(vaultDir);
  } catch {
    return [];
  }

  for (const filePath of allFiles) {
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    if (!content.toLowerCase().includes(q)) continue;

    const relative = path.relative(vaultDir, filePath);
    const lines = content.split("\n");
    const matchingLines = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        matchingLines.push({ line: i + 1, content: lines[i].trim() });
      }
    }

    results.push({
      source: `vault/${relative}`,
      file: relative,
      matches: matchingLines.slice(0, 5),
      title: lines.find((l) => l.startsWith("# "))?.replace(/^#\s+/, "") || relative
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Search across context files for a keyword.
 */
export async function searchContext(contextDir, query, { limit = 10 } = {}) {
  return searchVault(contextDir, query, { limit });
}

// --- Helpers ---

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function listMarkdownFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listMarkdownFiles(full));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}
