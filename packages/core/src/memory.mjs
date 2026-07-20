import fs from "node:fs/promises";
import path from "node:path";
import { formatJsonlEntry, parseJsonlLine, readJsonl } from "./jsonl.mjs";
import { refreshLiveOkf, writeProjectLog } from "./okf-live.mjs";
import { searchMarkdownDir, searchMemoryDir } from "./search.mjs";

export { formatJsonlEntry, parseJsonlLine, readJsonl };

export const RECENT_EVENT_LIMIT = 50;
export const SIGNAL_RETENTION_DAYS = 30;

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
export async function readSignals(signalsDir, fromDate, toDate, options = {}) {
  const fileSystem = options.filesystem || fs;
  const transform = typeof options.transform === "function" ? options.transform : null;
  let entries;
  try {
    entries = await fileSystem.readdir(signalsDir);
  } catch {
    return [];
  }

  const signals = [];
  for (const file of entries.filter((f) => f.endsWith(".jsonl")).sort()) {
    const date = signalFileDate(file);
    if (date < fromDate || date > toDate) continue;
    const filePath = path.join(signalsDir, file);
    const lines = await readJsonl(filePath, { filesystem: fileSystem });
    for (const [index, entry] of lines.entries()) {
      signals.push(transform
        ? transform(entry, {
          file,
          date,
          sourceLine: index + 1,
        })
        : entry);
    }
  }
  return signals;
}

/**
 * The one place a signal filename becomes a date. Prefix-aware: both
 * `2026-06-12.jsonl` and machine-namespaced `laptop-2026-06-12.jsonl` resolve;
 * undated files return "" and must be skipped by retention logic.
 */
export function signalFileDate(filename) {
  return String(filename).match(/(?:^|-)(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1] || "";
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
  const aiosPath = aiosPathFromEvents(eventsPath);
  await maybeMaintain(aiosPath);
  if (aiosPath && entry.project) {
    try {
      await writeProjectLog(aiosPath, entry.project);
    } catch {
      // Live log projection is best-effort — never break an append.
    }
  }
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
  await maybeMaintain(aiosPathFromSignals(signalsDir));
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

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_DELAYS_MS = [50, 150, 300];
const LOCK_MAX_ATTEMPTS = 8;
const ARCHIVE_TAIL_BYTES = 262_144;

function archivePathFor(eventsPath) {
  return eventsPath.replace(/\.jsonl$/, "-archive.jsonl");
}

function pendingPathFor(eventsPath) {
  return `${archivePathFor(eventsPath)}.pending`;
}

// Advisory lock next to the file (same pattern as the sync tick lock). Another
// live holder makes the caller skip; a stale or unreadable lock is taken over.
async function acquireFileLock(targetPath, fileSystem) {
  const lockPath = `${targetPath}.lock`;
  let waits = 0;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      await fileSystem.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: "wx" });
      return {
        release: async () => {
          try {
            await fileSystem.unlink(lockPath);
          } catch {
            // Already gone — releasing twice must stay harmless.
          }
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const held = JSON.parse(await fileSystem.readFile(lockPath, "utf8"));
        stale = !held.ts || Date.now() - held.ts > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          await fileSystem.unlink(lockPath);
        } catch {
          // Raced with the holder's own release.
        }
        continue;
      }
      if (waits >= LOCK_RETRY_DELAYS_MS.length) return null;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[waits]));
      waits += 1;
    }
  }
  return null;
}

async function writeFileDurable(fileSystem, filePath, content) {
  await fileSystem.writeFile(filePath, content);
  if (typeof fileSystem.open === "function") {
    try {
      const handle = await fileSystem.open(filePath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // fsync is best-effort; the rename below is the atomicity boundary.
    }
  }
}

// A crash can leave a staged archive batch behind. Decide whether the batch
// committed (rename happened → events no longer holds it → finish the flush)
// or not (events still holds it → the staging file is stale, drop it).
async function recoverPendingArchive(eventsPath, fileSystem) {
  const pendingPath = pendingPathFor(eventsPath);
  let pendingContent;
  try {
    pendingContent = await fileSystem.readFile(pendingPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const pendingLines = pendingContent.split("\n").filter((line) => line.trim());
  if (pendingLines.length === 0) {
    await fileSystem.unlink(pendingPath);
    return;
  }
  let eventsContent = "";
  try {
    eventsContent = await fileSystem.readFile(eventsPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const eventLines = new Set(eventsContent.split("\n").filter((line) => line.trim()));
  const first = pendingLines[0];
  const last = pendingLines[pendingLines.length - 1];
  if (eventLines.has(first) && eventLines.has(last)) {
    await fileSystem.unlink(pendingPath);
    return;
  }
  await flushPendingArchive(eventsPath, fileSystem);
}

// Append the staged batch to the archive, line-idempotently: a crashed earlier
// flush may already have written part or all of it.
async function flushPendingArchive(eventsPath, fileSystem) {
  const pendingPath = pendingPathFor(eventsPath);
  const archivePath = archivePathFor(eventsPath);
  let pendingContent;
  try {
    pendingContent = await fileSystem.readFile(pendingPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const pendingLines = pendingContent.split("\n").filter((line) => line.trim());
  let archiveContent = "";
  try {
    archiveContent = await fileSystem.readFile(archivePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tailLines = new Set(archiveContent.slice(-ARCHIVE_TAIL_BYTES).split("\n").filter((line) => line.trim()));
  const missing = pendingLines.filter((line) => !tailLines.has(line));
  if (missing.length > 0) {
    // A torn earlier append can leave the archive without a final newline;
    // start on a fresh line so the fragment stays its own (visible) bad line.
    const prefix = archiveContent.length > 0 && !archiveContent.endsWith("\n") ? "\n" : "";
    await fileSystem.appendFile(archivePath, prefix + missing.map((line) => `${line}\n`).join(""));
  }
  await fileSystem.unlink(pendingPath);
}

/**
 * Compact events.jsonl: keep only the most recent N entries in the main file,
 * archive older entries to events-archive.jsonl.
 *
 * Crash-safe transaction: kept-tail and archive batch are staged and fsynced,
 * the rename over events.jsonl is the single commit point, and the archive
 * append happens only after it (idempotently, so an interrupted run can be
 * re-run without losing or duplicating an event). Guarded by an advisory
 * lockfile next to events.jsonl.
 *
 * Returns { archived, kept } — or { archived: 0, kept: 0, skipped: "locked" }
 * when another live process holds the lock.
 */
export async function compactEvents(eventsPath, limit = RECENT_EVENT_LIMIT, options = {}) {
  const fileSystem = options.filesystem || fs;
  const lock = await acquireFileLock(eventsPath, fileSystem);
  if (!lock) return { archived: 0, kept: 0, skipped: "locked" };
  try {
    await recoverPendingArchive(eventsPath, fileSystem);

    const all = await readJsonl(eventsPath, { filesystem: fileSystem });
    if (all.length <= limit) {
      return { archived: 0, kept: all.length };
    }

    const toArchive = all.slice(0, -limit);
    const toKeep = all.slice(-limit);
    const tmpPath = `${eventsPath}.tmp`;

    await writeFileDurable(fileSystem, tmpPath, toKeep.map((entry) => formatJsonlEntry(entry)).join(""));
    await writeFileDurable(fileSystem, pendingPathFor(eventsPath), toArchive.map((entry) => formatJsonlEntry(entry)).join(""));
    await fileSystem.rename(tmpPath, eventsPath);
    await flushPendingArchive(eventsPath, fileSystem);

    return { archived: toArchive.length, kept: toKeep.length };
  } finally {
    await lock.release();
  }
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
    const date = signalFileDate(file);
    if (!date || date >= cutoff) continue;

    const filePath = path.join(signalsDir, file);
    const stat = await fs.stat(filePath);
    freedBytes += stat.size;
    await fs.unlink(filePath);
    removed += 1;
  }

  return { removed, freedBytes };
}

// --- Opportunistic maintenance ---

const MAINTENANCE_INTERVAL_MS = 86_400_000;
const MAINTENANCE_STATE_FILE = ".maintenance.json";
const activeMaintenance = new Set();

function aiosPathFromEvents(eventsPath) {
  const dir = path.dirname(eventsPath);
  if (path.basename(eventsPath) === "events.jsonl" && path.basename(dir) === "memory") {
    return path.dirname(dir);
  }
  return null;
}

function aiosPathFromSignals(signalsDir) {
  const dir = path.resolve(signalsDir);
  if (path.basename(dir) === "signals" && path.basename(path.dirname(dir)) === "memory") {
    return path.dirname(path.dirname(dir));
  }
  return null;
}

async function maybeMaintain(aiosPath) {
  if (!aiosPath || activeMaintenance.has(aiosPath)) return;
  try {
    await maintainMemory(aiosPath);
  } catch {
    // Maintenance must never break an append.
  }
}

async function eventsOverflowing(eventsPath) {
  let content;
  try {
    content = await fs.readFile(eventsPath, "utf8");
  } catch {
    return false;
  }
  let lines = 0;
  for (const line of content.split("\n")) {
    if (line.trim()) lines += 1;
    if (lines > 2 * RECENT_EVENT_LIMIT) return true;
  }
  return false;
}

/**
 * The one opportunistic bloat-control seam. Called from appendEvent and
 * appendSignal; runs compaction + signal trimming at most once per day, or
 * immediately when events.jsonl exceeds 2× RECENT_EVENT_LIMIT. Writes a
 * receipt event to events.jsonl. `dotaios cleanup` stays the manual override.
 * All rotation mechanics stay hidden behind this function.
 */
export async function maintainMemory(aiosPath, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const memoryDir = path.join(aiosPath, "memory");
  const eventsPath = path.join(memoryDir, "events.jsonl");
  const signalsDir = path.join(memoryDir, "signals");
  const statePath = path.join(memoryDir, MAINTENANCE_STATE_FILE);

  if (activeMaintenance.has(aiosPath)) return { ran: false, reason: "in-progress" };
  activeMaintenance.add(aiosPath);
  try {
    const nowMs = now();
    let state = null;
    try {
      state = JSON.parse(await fs.readFile(statePath, "utf8"));
    } catch {
      state = null;
    }
    const overflowing = await eventsOverflowing(eventsPath);
    if (!state?.lastRun) {
      // First contact with this folder: start the daily clock quietly. Only a
      // genuine overflow justifies churning a fresh folder immediately.
      if (!overflowing) {
        await fs.mkdir(memoryDir, { recursive: true });
        await fs.writeFile(statePath, JSON.stringify({ lastRun: nowMs }));
        return { ran: false, reason: "initialized" };
      }
    } else if (!overflowing && nowMs - state.lastRun < MAINTENANCE_INTERVAL_MS) {
      return { ran: false, reason: "interval" };
    }

    const compacted = await compactEvents(eventsPath);
    const trimmed = await trimSignals(signalsDir);
    try {
      await refreshLiveOkf(aiosPath);
    } catch {
      // Index/log refresh is best-effort; compaction results still stand.
    }
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ lastRun: nowMs }));
    if (compacted.skipped !== "locked") {
      await appendEvent(eventsPath, {
        type: "memory.maintenance",
        summary: `auto-maintenance: archived ${compacted.archived} event(s), removed ${trimmed.removed} stale signal file(s)`,
        archived: compacted.archived,
        kept: compacted.kept,
        signal_files_removed: trimmed.removed
      });
    }
    return { ran: true, archived: compacted.archived, removed: trimmed.removed };
  } finally {
    activeMaintenance.delete(aiosPath);
  }
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

// --- Helpers ---

export function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
