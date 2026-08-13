import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatJsonlEntry, parseJsonlLine, readJsonl } from "./jsonl.mjs";
import { ContainedReadError, readContainedDirectory, readContainedFile } from "./contained-read.mjs";
import { refreshLiveOkf, writeProjectLog } from "./okf-live.mjs";
import {
  assertOwnedFileStats,
  publishOwnedFileExclusive,
  sameFileIdentity,
  syncOwnedDirectory
} from "./owned-state.mjs";
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
    entries = options.boundaryRoot
      ? await readContainedDirectory(options.boundaryRoot, signalsDir, {
          budget: options.budget,
          filesystem: fileSystem,
          maxEntries: options.maxDirectoryEntries,
          tooManyCode: "DOTAIOS_SIGNAL_DIRECTORY_LIMIT_EXCEEDED"
        })
      : await fileSystem.readdir(signalsDir);
  } catch (error) {
    if (options.boundaryRoot && error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
      throw error;
    }
    return [];
  }
  if (entries === null) return [];

  const selectedFiles = entries
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .filter((file) => {
      const date = signalFileDate(file);
      return date >= fromDate && date <= toDate;
    });
  if (Number.isFinite(options.maxFiles) && selectedFiles.length > options.maxFiles) {
    throw new ContainedReadError("DOTAIOS_SIGNAL_FILE_LIMIT_EXCEEDED");
  }

  const signals = [];
  for (const file of selectedFiles) {
    const date = signalFileDate(file);
    const filePath = path.join(signalsDir, file);
    const readFilesystem = options.boundaryRoot
      ? {
          readFile: async (candidate, encoding) => {
            const content = await readContainedFile(options.boundaryRoot, candidate, {
              budget: options.budget,
              filesystem: fileSystem,
              encoding: typeof encoding === "string" ? encoding : encoding?.encoding,
              maxBytes: options.maxFileBytes
            });
            if (content === null) {
              throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
            }
            return content;
          }
        }
      : fileSystem;
    const lines = await readJsonl(filePath, {
      filesystem: readFilesystem,
      quarantine: options.quarantine !== false
    });
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
 * Run one event-store mutation while holding the same advisory lock used by
 * appenders and compaction.
 */
export async function withEventStoreLock(eventsPath, callback, options = {}) {
  const fileSystem = options.filesystem || fs;
  await fileSystem.mkdir(path.dirname(eventsPath), { recursive: true });
  const lock = await acquireFileLock(eventsPath, fileSystem, {
    retryDelaysMs: options.lockRetryDelaysMs,
    staleMs: options.lockStaleMs,
    now: options.now
  });
  if (!lock) {
    throw new EventStoreLockError(eventsPath);
  }
  try {
    return await callback(fileSystem);
  } finally {
    await lock.release();
  }
}

export class EventStoreLockError extends Error {
  constructor(eventsPath) {
    super(`Timed out waiting for memory writer lock: ${eventsPath}.lock`);
    this.name = "EventStoreLockError";
    this.code = "DOTAIOS_EVENT_STORE_LOCKED";
  }
}

/**
 * Append one already-formed event record under the same lock used by event
 * compaction. Callers that preserve an existing event schema use this seam;
 * appendEvent remains the structured convenience API.
 */
export async function appendEventRecord(eventsPath, entry, options = {}) {
  const fileSystem = options.filesystem || fs;
  await withEventStoreLock(eventsPath, async () => {
    await fileSystem.appendFile(eventsPath, formatJsonlEntry(entry));
  }, options);
  return entry;
}

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
  await appendEventRecord(eventsPath, entry);
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
const ARCHIVE_ROTATE_BYTES = 2 * 1024 * 1024;
const ARCHIVE_LINE_MAX_BYTES = 4 * 1024 * 1024;

function archivePathFor(eventsPath) {
  return eventsPath.replace(/\.jsonl$/, "-archive.jsonl");
}

/**
 * Where trimmed signals go. A SIBLING of memory/signals/, next to
 * memory/events-archive.jsonl — never inside signals/, because every scanner
 * in this codebase treats `signals/*.jsonl` as a live daily file and would
 * re-read, re-audit, and eventually re-trim the archive itself.
 */
export function signalsArchivePathFor(signalsDir) {
  return path.join(path.dirname(path.resolve(signalsDir)), "signals-archive.jsonl");
}

function pendingPathFor(archivePath) {
  return `${archivePath}.pending`;
}

// Is this pid still running? EPERM means it exists but belongs to another user.
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Take over a lock we judged abandoned. rename() is atomic, so when two
// processes race to steal the same lock exactly one wins and the loser gets
// ENOENT — where unlink-then-write would let both delete and both acquire,
// and this lock now guards the deletion of the user's signals.
async function stealFileLock(lockPath, fileSystem) {
  const moved = `${lockPath}.steal.${process.pid}.${Date.now()}`;
  try {
    await fileSystem.rename(lockPath, moved);
  } catch {
    return; // someone else already stole or released it
  }
  try {
    await fileSystem.unlink(moved);
  } catch {
    // Best effort; a leftover .steal file is inert.
  }
}

// Advisory lock next to the file (same pattern as the session index lock).
// A live holder makes the caller skip no matter how long it has been working;
// only a dead holder — or a lock we cannot read — is taken over.
async function acquireFileLock(targetPath, fileSystem, options = {}) {
  const lockPath = `${targetPath}.lock`;
  const retryDelaysMs = options.retryDelaysMs ?? LOCK_RETRY_DELAYS_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const now = options.now || (() => Date.now());
  let waits = 0;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    const token = crypto.randomUUID();
    try {
      await fileSystem.writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        ts: now(),
        token
      }), { flag: "wx" });
      return {
        release: async () => {
          let held;
          try {
            held = JSON.parse(await fileSystem.readFile(lockPath, "utf8"));
          } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
          }
          if (held.token !== token) {
            throw new Error(`Memory writer lock ownership changed before release: ${lockPath}`);
          }
          try {
            await fileSystem.unlink(lockPath);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const held = JSON.parse(await fileSystem.readFile(lockPath, "utf8"));
        stale = Number.isInteger(held.pid) && held.pid > 0
          // Liveness beats the stopwatch: a run that legitimately takes longer
          // than the stale window must not have its lock pulled, and a crashed
          // holder must not wedge maintenance until the window expires.
          ? !pidIsAlive(held.pid)
          : await malformedLockIsStale(lockPath, fileSystem, staleMs, now);
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        stale = await malformedLockIsStale(lockPath, fileSystem, staleMs, now);
      }
      if (stale) {
        await stealFileLock(lockPath, fileSystem);
        continue;
      }
      if (waits >= retryDelaysMs.length) return null;
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[waits]));
      waits += 1;
    }
  }
  return null;
}

async function malformedLockIsStale(lockPath, fileSystem, staleMs, now) {
  try {
    const lockStat = await fileSystem.stat(lockPath);
    return now() - lockStat.mtimeMs > staleMs;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

async function fsyncFile(fileSystem, filePath) {
  if (typeof fileSystem.open !== "function") return;
  const handle = await fileSystem.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileDurable(fileSystem, filePath, content) {
  await fileSystem.writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  await fsyncFile(fileSystem, filePath);
}

async function stagePendingArchive(fileSystem, filePath, content) {
  assertArchiveLineBounds(content);
  await fileSystem.writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  await fsyncFile(fileSystem, filePath);
}

async function fileExists(fileSystem, filePath) {
  try {
    await fileSystem.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// A crash can leave a staged archive batch behind. Decide whether the batch
// committed (rename happened → events no longer holds it → finish the flush)
// or not (events still holds it → the staging file is stale, drop it).
async function recoverPendingArchive(eventsPath, fileSystem) {
  const archivePath = archivePathFor(eventsPath);
  const pendingPath = pendingPathFor(archivePath);
  let pendingContent;
  let pendingStats;
  try {
    ({ content: pendingContent, stats: pendingStats } = await readOwnedArchiveFile(pendingPath, fileSystem, {
      allowLegacyMode: true
    }));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const pendingLines = pendingContent.split("\n").filter((line) => line.trim());
  if (pendingLines.length === 0) {
    await removeObservedArchiveFile(pendingPath, pendingStats, fileSystem);
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
    await removeObservedArchiveFile(pendingPath, pendingStats, fileSystem);
    return;
  }
  await flushPendingArchive(archivePath, fileSystem);
}

// Publish the staged batch line-idempotently into the active archive and, when
// needed, immutable numbered shards. Returns only after every accepted line is
// fsynced, so callers may treat it as the point after which source removal is
// safe.
async function flushPendingArchive(archivePath, fileSystem) {
  const pendingPath = pendingPathFor(archivePath);
  let pendingContent;
  let pendingStats;
  try {
    ({ content: pendingContent, stats: pendingStats } = await readOwnedArchiveFile(pendingPath, fileSystem, {
      allowLegacyMode: true
    }));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const pendingLines = pendingContent.split("\n").filter((line) => line.trim());
  assertArchiveLineBounds(pendingContent);

  const shards = await inspectArchiveShards(archivePath, fileSystem);
  const active = await readArchiveActive(archivePath, fileSystem);
  assertArchiveLineBounds(active.content);
  const tailLines = await collectArchiveTailLines(
    archivePath,
    active,
    shards,
    Math.max(ARCHIVE_TAIL_BYTES, Buffer.byteLength(pendingContent) + 1024),
    fileSystem
  );
  const missing = pendingLines.filter((line) => !tailLines.has(line));
  await appendArchiveLines(archivePath, active, shards, missing, fileSystem);

  await removeObservedArchiveFile(pendingPath, pendingStats, fileSystem);
}

async function removeObservedArchiveFile(filePath, expectedStats, fileSystem) {
  const current = await fileSystem.lstat(filePath);
  assertOwnedFileStats(current);
  if (!sameFileIdentity(expectedStats, current)) throw archiveStateError();
  await fileSystem.unlink(filePath);
  await syncOwnedDirectory(path.dirname(filePath), { filesystem: fileSystem });
}

async function appendArchiveLines(archivePath, active, existingShards, lines, fileSystem) {
  let activeContent = active.content;
  let activeStats = active.stats;
  let nextShard = existingShards.length === 0
    ? 1
    : existingShards.at(-1).number + 1;

  // A crash after immutable shard publication but before resetting the active
  // file leaves an exact prefix in both places. Repair that state before doing
  // new work; the shard is already the durable authority for those bytes.
  const newest = existingShards.at(-1);
  if (newest && activeContent) {
    const newestContent = (await readOwnedArchiveFile(newest.path, fileSystem)).content;
    if (activeContent.startsWith(newestContent)) {
      activeContent = activeContent.slice(newestContent.length);
      activeStats = await replaceArchiveActive(archivePath, activeContent, activeStats, fileSystem);
    }
  }

  // Normalize a legacy over-target active file one complete JSONL record at a
  // time. Each published prefix is removed immediately, so every interruption
  // is recoverable by the prefix rule above.
  while (Buffer.byteLength(activeContent) > ARCHIVE_ROTATE_BYTES) {
    const { chunk, remainder } = takeArchiveChunk(activeContent);
    await publishArchiveShard(archivePath, nextShard, chunk, fileSystem);
    nextShard += 1;
    activeStats = await replaceArchiveActive(archivePath, remainder, activeStats, fileSystem);
    activeContent = remainder;
  }

  let activeParts = activeContent ? [activeContent] : [];
  let activeBytes = Buffer.byteLength(activeContent);
  let activeEndsWithNewline = activeContent.endsWith("\n");
  const materializeActive = () => {
    activeContent = activeParts.join("");
    activeParts = activeContent ? [activeContent] : [];
    return activeContent;
  };
  let changed = false;
  for (const line of lines) {
    const record = `${line}\n`;
    const recordBytes = Buffer.byteLength(record);
    if (recordBytes > ARCHIVE_LINE_MAX_BYTES) throw archiveLineTooLargeError();
    const separator = activeBytes > 0 && !activeEndsWithNewline ? "\n" : "";
    const separatorBytes = separator ? 1 : 0;
    if (activeBytes > 0 && activeBytes + separatorBytes + recordBytes > ARCHIVE_ROTATE_BYTES) {
      const completedActive = materializeActive();
      activeStats = await replaceArchiveActive(archivePath, completedActive, activeStats, fileSystem);
      await publishArchiveShard(archivePath, nextShard, completedActive, fileSystem);
      nextShard += 1;
      activeStats = await replaceArchiveActive(archivePath, "", activeStats, fileSystem);
      activeContent = "";
      activeParts = [];
      activeBytes = 0;
      activeEndsWithNewline = false;
      changed = false;
    }
    if (recordBytes > ARCHIVE_ROTATE_BYTES) {
      await publishArchiveShard(archivePath, nextShard, record, fileSystem);
      nextShard += 1;
      continue;
    }
    if (separator) activeParts.push(separator);
    activeParts.push(record);
    activeBytes += separatorBytes + recordBytes;
    activeEndsWithNewline = true;
    changed = true;
  }

  if (changed || !activeStats) {
    await replaceArchiveActive(archivePath, materializeActive(), activeStats, fileSystem);
  }
}

function takeArchiveChunk(content) {
  let chunkEnd = 0;
  let chunkBytes = 0;
  let recordStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content[index] !== "\n") continue;
    if (index === content.length && recordStart === content.length) break;
    const recordEnd = index < content.length ? index + 1 : index;
    const recordBytes = Buffer.byteLength(content.slice(recordStart, recordEnd));
    if (chunkEnd > 0 && chunkBytes + recordBytes > ARCHIVE_ROTATE_BYTES) break;
    chunkBytes += recordBytes;
    chunkEnd = recordEnd;
    recordStart = recordEnd;
    if (chunkBytes > ARCHIVE_ROTATE_BYTES) break;
  }
  if (chunkEnd === 0) throw archiveStateError();
  return { chunk: content.slice(0, chunkEnd), remainder: content.slice(chunkEnd) };
}

function splitArchiveRecords(content) {
  if (!content) return [];
  const records = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    records.push(content.slice(start, index + 1));
    start = index + 1;
  }
  if (start < content.length) records.push(content.slice(start));
  return records;
}

function assertArchiveLineBounds(content) {
  for (const record of splitArchiveRecords(content)) {
    if (Buffer.byteLength(record) > ARCHIVE_LINE_MAX_BYTES) throw archiveLineTooLargeError();
  }
}

async function inspectArchiveShards(archivePath, fileSystem) {
  const directory = path.dirname(archivePath);
  const stem = path.basename(archivePath, ".jsonl");
  const matcher = new RegExp(`^${escapeRegExp(stem)}\\.(\\d{6})\\.jsonl$`);
  let entries;
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const shards = [];
  for (const entry of entries) {
    const match = entry.name.match(matcher);
    if (!match) continue;
    const filePath = path.join(directory, entry.name);
    const stats = await inspectOwnedArchiveFile(filePath, fileSystem);
    shards.push({ number: Number(match[1]), path: filePath, stats });
  }
  shards.sort((left, right) => left.number - right.number);
  for (let index = 1; index < shards.length; index += 1) {
    if (shards[index - 1].number === shards[index].number) throw archiveStateError();
  }
  return shards;
}

async function inspectOwnedArchiveFile(filePath, fileSystem) {
  const stats = await fileSystem.lstat(filePath);
  assertOwnedFileStats(stats);
  return stats;
}

async function collectArchiveTailLines(archivePath, active, shards, minimumBytes, fileSystem) {
  const lines = new Set();
  let observedBytes = 0;
  const sources = [
    { path: archivePath, content: active.content },
    ...[...shards].reverse().map(({ path: filePath }) => ({ path: filePath, content: null }))
  ];
  for (const source of sources) {
    const content = source.content === null
      ? (await readOwnedArchiveFile(source.path, fileSystem)).content
      : source.content;
    observedBytes += Buffer.byteLength(content);
    for (const line of content.split("\n")) if (line.trim()) lines.add(line);
    if (observedBytes >= minimumBytes) break;
  }
  return lines;
}

async function readArchiveActive(archivePath, fileSystem) {
  try {
    return await readOwnedArchiveFile(archivePath, fileSystem, { allowLegacyMode: true });
  } catch (error) {
    if (error.code === "ENOENT") return { content: "", stats: null };
    throw error;
  }
}

async function readOwnedArchiveFile(filePath, fileSystem, { allowLegacyMode = false } = {}) {
  let pathStats = await fileSystem.lstat(filePath);
  pathStats = await validateArchiveFileMode(filePath, pathStats, fileSystem, allowLegacyMode);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fileSystem.open(filePath, flags);
  try {
    const before = await handle.stat();
    assertOwnedFileStats(before);
    if (!sameFileIdentity(pathStats, before)) throw archiveStateError();
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) throw archiveStateError();
    const current = await fileSystem.lstat(filePath);
    if (!sameFileIdentity(after, current)) throw archiveStateError();
    return { content, stats: current };
  } finally {
    await handle.close();
  }
}

async function validateArchiveFileMode(filePath, stats, fileSystem, allowLegacyMode) {
  try {
    assertOwnedFileStats(stats);
    return stats;
  } catch (error) {
    if (!allowLegacyMode || process.platform === "win32") throw error;
    assertOwnedFileStats(stats, 0o644);
    await fileSystem.chmod(filePath, 0o600);
    const secured = await fileSystem.lstat(filePath);
    assertOwnedFileStats(secured);
    if (!sameArchiveObject(stats, secured)) throw archiveStateError();
    return secured;
  }
}

function sameArchiveObject(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.uid === right.uid);
}

async function publishArchiveShard(archivePath, number, content, fileSystem) {
  assertArchiveLineBounds(content);
  const shardPath = archiveShardPath(archivePath, number);
  await publishOwnedFileExclusive(shardPath, content, { filesystem: fileSystem });
  return shardPath;
}

async function replaceArchiveActive(archivePath, content, expectedStats, fileSystem) {
  assertArchiveLineBounds(content);
  if (!expectedStats) {
    return publishOwnedFileExclusive(archivePath, content, { filesystem: fileSystem });
  }
  const current = await fileSystem.lstat(archivePath);
  if (!sameFileIdentity(expectedStats, current)) throw archiveStateError();
  const temporary = path.join(
    path.dirname(archivePath),
    `.${path.basename(archivePath)}.${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fileSystem.open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryStats = await fileSystem.lstat(temporary);
    assertOwnedFileStats(temporaryStats);
    const stillCurrent = await fileSystem.lstat(archivePath);
    if (!sameFileIdentity(expectedStats, stillCurrent)) throw archiveStateError();
    await fileSystem.rename(temporary, archivePath);
    const published = await fileSystem.lstat(archivePath);
    assertOwnedFileStats(published);
    if (!sameFileIdentity(temporaryStats, published)) throw archiveStateError();
    await syncOwnedDirectory(path.dirname(archivePath), { filesystem: fileSystem });
    return published;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
  }
}

function archiveShardPath(archivePath, number) {
  return archivePath.replace(/\.jsonl$/, `.${String(number).padStart(6, "0")}.jsonl`);
}

function archiveLineTooLargeError() {
  const error = new Error("One archive record exceeds the safe 4 MiB read ceiling.");
  error.code = "DOTAIOS_ARCHIVE_LINE_TOO_LARGE";
  return error;
}

function archiveStateError() {
  const error = new Error("Memory archive state changed or is not safely owned.");
  error.code = "DOTAIOS_ARCHIVE_STATE_INVALID";
  return error;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compact events.jsonl: keep only the most recent N entries in the main file,
 * archive older entries to the bounded events-archive generation.
 *
 * Crash-safe transaction: kept-tail and archive batch are staged and fsynced,
 * the rename over events.jsonl is the single commit point, and the archive
 * archive publication happens only after it (idempotently, so an interrupted
 * run can be re-run without losing or duplicating an event). Guarded by an
 * advisory lockfile next to events.jsonl.
 *
 * Returns { archived, kept } — or { archived: 0, kept: 0, skipped: "locked" }
 * when another live process holds the lock.
 */
export async function compactEvents(eventsPath, limit = RECENT_EVENT_LIMIT, options = {}) {
  const fileSystem = options.filesystem || fs;
  try {
    return await withEventStoreLock(eventsPath, async () => {
      await recoverPendingArchive(eventsPath, fileSystem);

      const all = await readJsonl(eventsPath, { filesystem: fileSystem });
      if (all.length <= limit) {
        return { archived: 0, kept: all.length };
      }

      const toArchive = all.slice(0, -limit);
      const toKeep = all.slice(-limit);
      const tmpPath = path.join(
        path.dirname(eventsPath),
        `.${path.basename(eventsPath)}.${crypto.randomUUID()}.tmp`
      );
      const archiveBatch = toArchive.map((entry) => formatJsonlEntry(entry)).join("");
      assertArchiveLineBounds(archiveBatch);

      try {
        await writeFileDurable(fileSystem, tmpPath, toKeep.map((entry) => formatJsonlEntry(entry)).join(""));
        await stagePendingArchive(fileSystem, pendingPathFor(archivePathFor(eventsPath)), archiveBatch);
        await fileSystem.rename(tmpPath, eventsPath);
        await flushPendingArchive(archivePathFor(eventsPath), fileSystem);
      } finally {
        await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
      }

      return { archived: toArchive.length, kept: toKeep.length };
    }, options);
  } catch (error) {
    if (error instanceof EventStoreLockError) {
      return { archived: 0, kept: 0, skipped: "locked" };
    }
    throw error;
  }
}

/**
 * Move signal files older than retentionDays out of memory/signals/ and into
 * the bounded memory/signals-archive generation. Retention controls what stays
 * in the routed daily window — it is not a licence to destroy what the user
 * wrote.
 *
 * Crash-safe transaction: the batch is staged and fsynced, appended to the
 * archive generation line-idempotently, and only then are the source files unlinked.
 * The unlink is the commit point, so every crash point leaves a line in both
 * places (transient duplication the next run collapses) and never in neither.
 * Staging order is unlink order, so a crash mid-delete leaves a suffix of the
 * batch, which the sized dedupe window is guaranteed to cover.
 *
 * Returns { removed, archived, archivedFiles, freedBytes, archivePath } — or
 * the same shape with skipped: "locked" when another live process holds the
 * archive lock. `archived` counts non-empty LINES the archive is now
 * responsible for; `archivedFiles` counts source files (an empty stale file
 * archives zero lines but is still fully accounted for).
 */
export async function trimSignals(signalsDir, retentionDays = SIGNAL_RETENTION_DAYS, options = {}) {
  const fileSystem = options.filesystem || fs;
  const archivePath = options.archivePath || signalsArchivePathFor(signalsDir);
  const pendingPath = pendingPathFor(archivePath);
  const nothingToDo = { removed: 0, archived: 0, archivedFiles: 0, freedBytes: 0, archivePath };

  let entries;
  try {
    entries = await fileSystem.readdir(signalsDir);
  } catch {
    return nothingToDo;
  }

  const cutoff = isoDate(new Date(Date.now() - retentionDays * 86400000));
  const stale = entries
    .filter((file) => file.endsWith(".jsonl"))
    .filter((file) => {
      const date = signalFileDate(file);
      return Boolean(date) && date < cutoff;
    })
    .sort();

  // Nothing stale and no crashed batch to finish: stay out of the folder
  // entirely, so the common maintenance run writes no lock file at all.
  if (stale.length === 0 && !await fileExists(fileSystem, pendingPath)) return nothingToDo;

  const lock = await acquireFileLock(archivePath, fileSystem);
  if (!lock) return { ...nothingToDo, skipped: "locked" };
  try {
    // Finish any batch a crashed earlier run staged but never appended. The
    // append is line-idempotent, so replaying it can only duplicate work the
    // dedupe collapses — it can never lose a line.
    await flushPendingArchive(archivePath, fileSystem);

    const sources = [];
    const staged = [];
    for (const file of stale) {
      const filePath = path.join(signalsDir, file);
      let content;
      try {
        content = await fileSystem.readFile(filePath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      // A synced folder (iCloud, Dropbox) can remove the file between the read
      // and here. Its lines are already staged, so losing only the byte count
      // is harmless — aborting the whole run would not be.
      let size = 0;
      try {
        ({ size } = await fileSystem.stat(filePath));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      sources.push({ filePath, size });
      for (const line of content.split("\n")) {
        if (line.trim()) staged.push(line);
      }
    }

    if (sources.length === 0) return nothingToDo;

    if (staged.length > 0) {
      const archiveBatch = staged.map((line) => `${line}\n`).join("");
      assertArchiveLineBounds(archiveBatch);
      await stagePendingArchive(fileSystem, pendingPath, archiveBatch);
      await flushPendingArchive(archivePath, fileSystem);
    }

    let removed = 0;
    let freedBytes = 0;
    for (const { filePath, size } of sources) {
      try {
        await fileSystem.unlink(filePath);
      } catch (error) {
        // Already gone is the outcome we wanted; anything else is real.
        if (error.code !== "ENOENT") throw error;
      }
      removed += 1;
      freedBytes += size;
    }

    return { removed, archived: staged.length, archivedFiles: removed, freedBytes, archivePath };
  } finally {
    await lock.release();
  }
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
        summary: `auto-maintenance: archived ${compacted.archived} event(s), archived and removed ${trimmed.removed} stale signal file(s)`,
        archived: compacted.archived,
        kept: compacted.kept,
        signal_files_removed: trimmed.removed,
        // Per-file proof that the removal was a move, not a delete. `dotaios
        // doctor` reads these back and warns when removed outruns archived.
        signal_files_archived: trimmed.archivedFiles,
        signal_lines_archived: trimmed.archived
      });
    }
    return { ran: true, archived: compacted.archived, removed: trimmed.removed, signalLinesArchived: trimmed.archived };
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
