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
    const allowedFields = new Set(["format", "pid", "owner", "at", "process_started_at", "poisoned"]);
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
    return moveAbandonedLock(lockPath, filesystem);
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
  const { filesystem, strictOwnedState } = settings;
  try {
    const [raw, stats] = await readLockRecord(lockPath, filesystem, strictOwnedState);
    let held = null;
    try { held = JSON.parse(raw); } catch { /* Invalid non-strict records age out by mtime. */ }
    return Object.freeze({ missing: false, held, stats });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ missing: true, held: null, stats: null });
    if (strictOwnedState) throw error;
    const stats = fallbackStats ? await filesystem.stat(lockPath).catch(() => null) : null;
    return Object.freeze({ missing: false, held: null, stats });
  }
}

async function moveAbandonedLock(lockPath, filesystem) {
  const moved = `${lockPath}.stale.${randomUUID()}`;
  try {
    await filesystem.rename(lockPath, moved);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
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
  const before = await filesystem.lstat(lock.lockPath);
  assertOwnedFileStats(before);
  const handle = await filesystem.open(lock.lockPath, "r+");
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    if (!sameFileIdentity(before, opened)) throw ownedStateError();
    const raw = await handle.readFile("utf8");
    let held;
    try {
      held = JSON.parse(raw);
    } catch {
      throw ownedStateError();
    }
    if (!ownerRecordIsValid(held, lock.format, true) || held.owner !== lock.owner) throw ownedStateError();
    if (held.poisoned !== true) {
      const bytes = Buffer.from(`${JSON.stringify({ ...held, poisoned: true })}\n`);
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
  } finally {
    await handle.close();
  }
  await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
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
  assertOwnedFileStats(before);
  const handle = await filesystem.open(lockPath, "r");
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    if (!sameFileIdentity(before, opened)) throw ownedStateError();
    const raw = await handle.readFile("utf8");
    const openedAfter = await handle.stat();
    const canonicalAfter = await filesystem.lstat(lockPath);
    assertOwnedFileStats(openedAfter);
    assertOwnedFileStats(canonicalAfter);
    if (
      !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(openedAfter, canonicalAfter)
    ) throw ownedStateError();
    return [raw, canonicalAfter];
  } finally {
    await handle.close();
  }
}

async function releaseStrictOperationLock(lock, filesystem) {
  const releasePath = `${lock.lockPath}.release.${randomUUID()}`;
  try {
    await filesystem.rename(lock.lockPath, releasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    const [raw] = await readLockRecord(releasePath, filesystem, true);
    const held = JSON.parse(raw);
    if (!ownerRecordIsValid(held, lock.format, true) || held.owner !== lock.owner) throw ownedStateError();
    await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
    const poison = await publishReleasePoison(lock, held, filesystem);
    await filesystem.unlink(releasePath);
    await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
    await removePublishedPoison(lock, poison, filesystem);
  } catch (error) {
    await restoreForeignLock(releasePath, lock.lockPath, filesystem);
    throw error;
  }
}

async function publishReleasePoison(lock, held, filesystem) {
  const poison = Object.freeze({ ...held, poisoned: true });
  await publishOwnedFileExclusive(lock.lockPath, `${JSON.stringify(poison)}\n`, { filesystem });
  return poison;
}

async function removePublishedPoison(lock, poison, filesystem) {
  const tombstone = `${lock.lockPath}.poison-release.${randomUUID()}`;
  try {
    await filesystem.rename(lock.lockPath, tombstone);
    const [raw] = await readLockRecord(tombstone, filesystem, true);
    if (raw !== `${JSON.stringify(poison)}\n`) throw ownedStateError();
    await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem });
  } catch (error) {
    await restoreForeignLock(tombstone, lock.lockPath, filesystem);
    throw error;
  }
  await filesystem.rm(tombstone, { force: true }).catch(() => {});
  await syncOwnedDirectory(path.dirname(lock.lockPath), { filesystem }).catch(() => {});
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
