import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processBirthToken, processRecordIsAlive } from "./process-identity.mjs";
import {
  assertOwnedFileStats,
  ensureOwnedDirectory,
  ownedStateError,
  publishOwnedFileExclusive,
  sameFileIdentity,
  syncOwnedDirectory
} from "./owned-state.mjs";

const DEFAULT_LOCK_FORMAT = "dotaios-sync-operation-lock/v1";
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const STRICT_TRANSITION_READ_RETRIES = 16;
const STRICT_TRANSITION_FORMAT = "dotaios-operation-lock-transition/v1";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ownerRecordIsValid(record, format, strictOwnedState = false) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.format !== format) return false;
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  if (
    typeof record.owner !== "string"
    || !record.owner
    || record.owner.length > 256
    || record.owner.trim() !== record.owner
  ) return false;
  if (!Number.isSafeInteger(record.at) || record.at < 0) return false;
  if (
    record.process_started_at !== undefined
    && (
      typeof record.process_started_at !== "string"
      || !record.process_started_at
      || record.process_started_at.length > 256
      || record.process_started_at.trim() !== record.process_started_at
    )
  ) return false;
  if (strictOwnedState) {
    if (record.poisoned !== undefined && record.poisoned !== true) return false;
    if (record.releasing !== undefined && record.releasing !== true) return false;
    if (record.poisoned === true && record.releasing === true) return false;
    const allowedFields = new Set([
      "format", "pid", "owner", "at", "process_started_at", "poisoned", "releasing",
    ]);
    if (Object.keys(record).some((field) => !allowedFields.has(field))) return false;
  }
  return true;
}

function ownerCanBeReclaimed(record, stats, { format, now, staleMs, isOwnerAlive, strictOwnedState }) {
  if (ownerRecordIsValid(record, format, strictOwnedState)) {
    return (!strictOwnedState || record.poisoned !== true) && !isOwnerAlive(record);
  }
  return Number.isFinite(stats?.mtimeMs) && now() - stats.mtimeMs > staleMs;
}

async function publishOwner(lockPath, record, filesystem, strictOwnedState) {
  if (strictOwnedState) return publishStrictOwner(lockPath, record, filesystem);
  const temporary = `${lockPath}.${record.owner}.tmp`;
  await filesystem.writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await filesystem.link(temporary, lockPath);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

async function publishStrictOwner(lockPath, record, filesystem) {
  try {
    await publishOwnedFileExclusive(lockPath, `${JSON.stringify(record)}\n`, {
      filesystem,
      onPublishedFailure: () => poisonOperationLock(
        { lockPath, owner: record.owner, format: record.format },
        { filesystem, strictOwnedState: true }
      )
    });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function stealAbandoned(lockPath, settings) {
  const { filesystem, format, strictOwnedState, recoveryDepth, maxRecoveryDepth } = settings;
  const recoveryPath = `${lockPath}.recovery`;
  if (recoveryDepth >= maxRecoveryDepth) return false;
  const recovery = await acquireOperationLock(recoveryPath, {
    ...settings,
    recoveryDepth: recoveryDepth + 1
  });
  if (!recovery) return false;
  try {
    const observed = await readHeldLock(lockPath, settings, true);
    if (observed.missing) return false;
    if (!ownerCanBeReclaimed(observed.held, observed.stats, settings)) return false;
    const held = observed.held;
    if (strictOwnedState && !ownerRecordIsValid(held, format, true)) throw ownedStateError();
    return moveAbandonedLock(lockPath, settings);
  } finally {
    await releaseOperationLock(recovery, { filesystem, strictOwnedState });
  }
}

export async function acquireOperationLock(lockPath, options = {}) {
  const settings = operationLockSettings(options);
  const { filesystem, format, strictOwnedState } = settings;
  await prepareLockParent(lockPath, settings);
  const record = createOwnerRecord(settings);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publishOwner(lockPath, record, filesystem, strictOwnedState)) {
      if (strictOwnedState) await assertPublishedOwner(lockPath, record, filesystem);
      return { lockPath, owner: record.owner, format };
    }
    const { missing, held, stats } = await readHeldLock(lockPath, settings);
    if (missing) continue;
    if (strictOwnedState && !ownerRecordIsValid(held, format, true)) throw ownedStateError();
    if (!ownerCanBeReclaimed(held, stats, settings)) return null;
    await stealAbandoned(lockPath, settings);
  }
  return null;
}

function operationLockSettings(options) {
  return Object.freeze({
    filesystem: options.filesystem || fs,
    format: options.format || DEFAULT_LOCK_FORMAT,
    now: options.now || (() => Date.now()),
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    isOwnerAlive: options.isOwnerAlive || processRecordIsAlive,
    ownsParent: options.ownsParent ?? true,
    strictOwnedState: options.strictOwnedState ?? false,
    ownedDirectories: options.ownedDirectories || [],
    recoveryDepth: options.recoveryDepth ?? 0,
    maxRecoveryDepth: options.maxRecoveryDepth ?? 32
  });
}

async function prepareLockParent(lockPath, settings) {
  const { filesystem, ownsParent, strictOwnedState, ownedDirectories } = settings;
  if (strictOwnedState) {
    for (const directory of ownedDirectories) await ensureOwnedDirectory(directory, { filesystem });
    if (ownedDirectories.length === 0 && ownsParent) {
      await ensureOwnedDirectory(path.dirname(lockPath), { filesystem });
    }
  } else if (ownsParent) {
    await filesystem.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await filesystem.chmod(path.dirname(lockPath), 0o700).catch(() => {});
    }
  }
}

function createOwnerRecord({ format, now }) {
  const processStartedAt = processBirthToken(process.pid);
  return Object.freeze({
    format,
    pid: process.pid,
    owner: randomUUID(),
    at: now(),
    ...(processStartedAt && { process_started_at: processStartedAt })
  });
}

async function assertPublishedOwner(lockPath, record, filesystem) {
  const [raw] = await readLockRecord(lockPath, filesystem, true);
  let published;
  try {
    published = JSON.parse(raw);
  } catch {
    throw ownedStateError();
  }
  if (
    !ownerRecordIsValid(published, record.format, true)
    || published.owner !== record.owner
    || raw !== `${JSON.stringify(record)}\n`
  ) throw ownedStateError();
}

async function readHeldLock(lockPath, settings, fallbackStats = false) {
  const { filesystem, format, strictOwnedState } = settings;
  for (let attempt = 0; attempt <= STRICT_TRANSITION_READ_RETRIES; attempt += 1) {
    try {
      const [raw, stats] = await readLockRecord(lockPath, filesystem, strictOwnedState);
      let held = null;
      try { held = JSON.parse(raw); } catch { /* Invalid non-strict records age out by mtime. */ }
      if (
        strictOwnedState
        && !ownerRecordIsValid(held, format, true)
        && await recoverOrObserveStrictTransition(lockPath, stats, settings)
      ) {
        throw operationLockTransitionError();
      }
      return Object.freeze({ missing: false, held, stats });
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ missing: true, held: null, stats: null });
      if (
        strictOwnedState
        && error?.code === "DOTAIOS_OPERATION_LOCK_TRANSITION"
        && attempt < STRICT_TRANSITION_READ_RETRIES
      ) {
        await delay(1);
        continue;
      }
      if (strictOwnedState && error?.code === "DOTAIOS_OPERATION_LOCK_TRANSITION") {
        throw ownedStateError();
      }
      if (strictOwnedState) throw error;
      const stats = fallbackStats ? await filesystem.stat(lockPath).catch(() => null) : null;
      return Object.freeze({ missing: false, held: null, stats });
    }
  }
  throw ownedStateError();
}

async function moveAbandonedLock(lockPath, settings) {
  const { filesystem, strictOwnedState } = settings;
  const moved = `${lockPath}.stale.${randomUUID()}`;
  try {
    await filesystem.rename(lockPath, moved);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (strictOwnedState) {
    const movedStats = await filesystem.lstat(moved);
    await clearAbandonedStrictTransition(lockPath, movedStats, settings);
  }
  await filesystem.rm(moved, { force: true });
  return true;
}

export async function releaseOperationLock(lock, { filesystem = fs, strictOwnedState = false } = {}) {
  if (strictOwnedState) return releaseStrictOperationLock(lock, filesystem);
  let held;
  try {
    held = JSON.parse(await filesystem.readFile(lock.lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (held?.format !== lock.format || held.owner !== lock.owner) {
    throw new Error(`Operation lock ownership changed before release: ${lock.lockPath}`);
  }
  await filesystem.unlink(lock.lockPath);
}

export async function withOperationLock(lockPath, callback, options = {}) {
  const lock = await acquireOperationLock(lockPath, options);
  if (!lock) return { acquired: false, value: null };
  let retainLock = false;
  try {
    return { acquired: true, value: await callback() };
  } catch (error) {
    retainLock = options.retainOnError?.(error) === true;
    if (retainLock && options.strictOwnedState) {
      await poisonOperationLock(lock, options).catch(() => {});
    }
    throw error;
  } finally {
    if (!retainLock) await releaseOperationLock(lock, options);
  }
}

export async function poisonOperationLock(lock, {
  filesystem = fs,
  strictOwnedState = false
} = {}) {
  if (!strictOwnedState) throw new Error("Poisoned locks require strict owned state.");
  return rewriteExactOperationLock(lock, filesystem, (held) => (
    held.poisoned === true ? held : { ...held, poisoned: true }
  ));
}

async function markOperationLockReleasing(lock, filesystem) {
  return rewriteExactOperationLock(lock, filesystem, (held) => {
    if (held.poisoned === true) throw ownedStateError();
    return held.releasing === true ? held : { ...held, releasing: true };
  });
}

async function rewriteExactOperationLock(lock, filesystem, update) {
  const before = await filesystem.lstat(lock.lockPath);
  assertOwnedFileStats(before);
  const handle = await filesystem.open(lock.lockPath, "r+");
  let transition = null;
  let completed = false;
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    if (!sameFileIdentity(before, opened)) throw operationLockTransitionError();
    const raw = await handle.readFile("utf8");
    let held;
    try {
      held = JSON.parse(raw);
    } catch {
      throw ownedStateError();
    }
    if (!ownerRecordIsValid(held, lock.format, true) || held.owner !== lock.owner) throw ownedStateError();
    const updated = update(held);
    if (updated !== held) {
      transition = await publishStrictTransition(lock, held, updated, opened, filesystem);
      const canonicalBeforeWrite = await filesystem.lstat(lock.lockPath);
      assertOwnedFileStats(canonicalBeforeWrite);
      if (!sameFileIdentity(opened, canonicalBeforeWrite)) throw ownedStateError();
      const bytes = Buffer.from(`${JSON.stringify(updated)}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (bytesWritten < 1) throw ownedStateError();
        offset += bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
    }
    const after = await filesystem.lstat(lock.lockPath);
    assertOwnedFileStats(after);
    if (!sameFileIdentity(opened, after)) throw ownedStateError();
    completed = true;
  } finally {
    await handle.close();
  }
  if (transition && completed) await clearStrictTransition(transition, filesystem);
  await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
}

async function publishStrictTransition(lock, held, updated, stats, filesystem) {
  const transitionPath = `${lock.lockPath}.transition`;
  const record = Object.freeze({
    format: STRICT_TRANSITION_FORMAT,
    lock_format: lock.format,
    pid: held.pid,
    owner: held.owner,
    at: held.at,
    ...(held.process_started_at && { process_started_at: held.process_started_at }),
    lock_dev: String(stats.dev),
    lock_ino: String(stats.ino),
    next: updated,
  });
  await publishOwnedFileExclusive(transitionPath, `${JSON.stringify(record)}\n`, { filesystem });
  return Object.freeze({ path: transitionPath, raw: `${JSON.stringify(record)}\n` });
}

async function clearStrictTransition(transition, filesystem) {
  const [raw] = await readLockRecord(transition.path, filesystem, true);
  if (raw !== transition.raw) throw ownedStateError();
  await filesystem.unlink(transition.path);
  await syncOwnedDirectory(path.dirname(transition.path), { filesystem });
}

async function recoverOrObserveStrictTransition(lockPath, lockStats, settings) {
  const transitionPath = `${lockPath}.transition`;
  let raw;
  try {
    [raw] = await readLockRecord(transitionPath, settings.filesystem, true);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let transition;
  try { transition = JSON.parse(raw); } catch { throw ownedStateError(); }
  assertStrictTransitionRecord(transition, settings.format, lockStats);
  if (settings.isOwnerAlive(transition)) return true;
  await completeInterruptedStrictTransition(lockPath, lockStats, transition, settings.filesystem);
  return true;
}

async function completeInterruptedStrictTransition(lockPath, expectedStats, transition, filesystem) {
  const before = await filesystem.lstat(lockPath);
  assertOwnedFileStats(before);
  if (!sameFileIdentity(before, expectedStats)) throw ownedStateError();
  const handle = await filesystem.open(lockPath, "r+");
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    if (!sameFileIdentity(before, opened)) throw ownedStateError();
    const bytes = Buffer.from(`${JSON.stringify(transition.next)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten < 1) throw ownedStateError();
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
    await handle.sync();
    const openedAfter = await handle.stat();
    const canonicalAfter = await filesystem.lstat(lockPath);
    assertOwnedFileStats(openedAfter);
    assertOwnedFileStats(canonicalAfter);
    if (
      !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(openedAfter, canonicalAfter)
    ) throw ownedStateError();
  } finally {
    await handle.close();
  }
  await syncOwnedDirectory(path.dirname(lockPath), { filesystem });
}

function assertStrictTransitionRecord(transition, format, lockStats) {
  const allowedFields = new Set([
    "format", "lock_format", "pid", "owner", "at", "process_started_at", "lock_dev", "lock_ino", "next",
  ]);
  if (
    !transition || typeof transition !== "object" || Array.isArray(transition)
    || Object.keys(transition).some((field) => !allowedFields.has(field))
    || transition.format !== STRICT_TRANSITION_FORMAT
    || transition.lock_format !== format
    || !Number.isSafeInteger(transition.pid) || transition.pid <= 0
    || typeof transition.owner !== "string" || !transition.owner || transition.owner.length > 256
    || !Number.isSafeInteger(transition.at) || transition.at < 0
    || (transition.process_started_at !== undefined && (
      typeof transition.process_started_at !== "string"
      || !transition.process_started_at
      || transition.process_started_at.length > 256
    ))
    || transition.lock_dev !== String(lockStats.dev)
    || transition.lock_ino !== String(lockStats.ino)
    || !ownerRecordIsValid(transition.next, format, true)
    || transition.next.owner !== transition.owner
    || transition.next.pid !== transition.pid
    || transition.next.at !== transition.at
    || transition.next.process_started_at !== transition.process_started_at
    || (transition.next.poisoned !== true && transition.next.releasing !== true)
  ) throw ownedStateError();
}

async function clearAbandonedStrictTransition(lockPath, lockStats, settings) {
  const transitionPath = `${lockPath}.transition`;
  let raw;
  try {
    [raw] = await readLockRecord(transitionPath, settings.filesystem, true);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  let transition;
  try { transition = JSON.parse(raw); } catch { throw ownedStateError(); }
  assertStrictTransitionRecord(transition, settings.format, lockStats);
  if (settings.isOwnerAlive(transition)) throw ownedStateError();
  await clearStrictTransition({ path: transitionPath, raw }, settings.filesystem);
}

export async function inspectOperationLock(lockPath, {
  filesystem = fs,
  format = DEFAULT_LOCK_FORMAT,
  isOwnerAlive = processRecordIsAlive,
  strictOwnedState = false
} = {}) {
  try {
    const [raw] = await readLockRecord(lockPath, filesystem, strictOwnedState);
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw strictOwnedState ? ownedStateError() : new Error("Operation lock record is invalid.");
    }
    if (!ownerRecordIsValid(record, format, strictOwnedState)) {
      throw strictOwnedState ? ownedStateError() : new Error("Operation lock record is invalid.");
    }
    return Object.freeze({ exists: true, ownerAlive: isOwnerAlive(record), record: Object.freeze(record) });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ exists: false, ownerAlive: false, record: null });
    throw error;
  }
}

async function readLockRecord(lockPath, filesystem, strictOwnedState) {
  if (!strictOwnedState) {
    return Promise.all([filesystem.readFile(lockPath, "utf8"), filesystem.stat(lockPath)]);
  }
  const before = await filesystem.lstat(lockPath);
  assertStrictLockStatsOrTransition(before);
  const handle = await filesystem.open(lockPath, "r");
  try {
    const opened = await handle.stat();
    assertStrictLockStatsOrTransition(opened);
    if (!sameFileIdentity(before, opened)) throw operationLockTransitionError();
    const raw = await handle.readFile("utf8");
    const openedAfter = await handle.stat();
    const canonicalAfter = await filesystem.lstat(lockPath);
    assertStrictLockStatsOrTransition(openedAfter);
    assertStrictLockStatsOrTransition(canonicalAfter);
    if (
      !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(openedAfter, canonicalAfter)
    ) throw operationLockTransitionError();
    // Strict release/poison transitions deliberately rewrite the same owned
    // inode in place. A contender can otherwise read a mixed JSON record while
    // that bounded rewrite is active. Retry only when metadata proves this
    // exact inode changed during our handle observation; stable malformed or
    // replaced state still fails closed as owned-state invalid.
    if (!sameLockContentSnapshot(opened, openedAfter)) {
      throw operationLockTransitionError();
    }
    return [raw, canonicalAfter];
  } finally {
    await handle.close();
  }
}

function assertStrictLockStatsOrTransition(stats) {
  try {
    assertOwnedFileStats(stats);
  } catch (error) {
    if (isExclusivePublicationWindow(stats)) {
      throw operationLockTransitionError();
    }
    throw error;
  }
}

function isExclusivePublicationWindow(stats) {
  if (
    process.platform === "win32"
    || !stats?.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 2
    || stats.uid !== process.getuid()
    || (stats.mode & 0o777) !== 0o600
  ) return false;
  // nlink=2 is the exact intermediate state produced by
  // publishOwnedFileExclusive(). Retry it only for a bounded number of reads;
  // a pre-planted or persistent hardlink therefore still fails closed.
  return true;
}

function sameLockContentSnapshot(left, right) {
  return Boolean(
    sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
  );
}

function operationLockTransitionError() {
  const error = new Error("Operation lock owner state changed during observation.");
  error.code = "DOTAIOS_OPERATION_LOCK_TRANSITION";
  return error;
}

async function releaseStrictOperationLock(lock, filesystem) {
  const releasePath = `${lock.lockPath}.release.${randomUUID()}`;
  await markOperationLockReleasing(lock, filesystem);
  try {
    await filesystem.rename(lock.lockPath, releasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    const [raw] = await readLockRecord(releasePath, filesystem, true);
    const held = JSON.parse(raw);
    if (
      !ownerRecordIsValid(held, lock.format, true)
      || held.owner !== lock.owner
      || held.releasing !== true
      || held.poisoned === true
    ) throw ownedStateError();
    await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
    await filesystem.unlink(releasePath);
    await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
  } catch (error) {
    await restoreForeignLock(releasePath, lock.lockPath, filesystem);
    await poisonOperationLock(lock, { filesystem, strictOwnedState: true }).catch(() => {});
    throw error;
  }
}

async function restoreForeignLock(releasePath, lockPath, filesystem) {
  try {
    await filesystem.link(releasePath, lockPath);
    await syncOwnedDirectory(path.dirname(lockPath), { filesystem });
    await filesystem.unlink(releasePath);
    await syncOwnedDirectory(path.dirname(lockPath), { filesystem });
  } catch {
    // Preserve the moved bytes when another lock already occupies the canonical path.
  }
}
