import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  processBirthToken,
  processRecordIsAlive
} from "../../../core/src/process-identity.mjs";

const LOCK_FORMAT = "dotaios-sync-operation-lock/v1";
const DEFAULT_STALE_MS = 5 * 60 * 1000;

function ownerRecordIsValid(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.format !== LOCK_FORMAT) return false;
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
  return true;
}

function ownerCanBeReclaimed(record, stats, { now, staleMs, isOwnerAlive }) {
  if (ownerRecordIsValid(record)) return !isOwnerAlive(record);
  return Number.isFinite(stats?.mtimeMs) && now() - stats.mtimeMs > staleMs;
}

async function publishOwner(lockPath, record, filesystem) {
  const temporary = `${lockPath}.${record.owner}.tmp`;
  await filesystem.writeFile(temporary, `${JSON.stringify(record)}\n`, {
    flag: "wx",
    mode: 0o600
  });
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

async function stealAbandoned(lockPath, {
  filesystem,
  now,
  staleMs,
  isOwnerAlive,
  recoveryDepth,
  maxRecoveryDepth
}) {
  // Serialize stale-owner recovery separately. Without this gate, two
  // stealers can both classify the old inode, then the loser can rename the
  // fresh lock the winner just published.
  const recoveryPath = `${lockPath}.recovery`;
  if (recoveryDepth >= maxRecoveryDepth) return false;
  const recovery = await acquireOperationLock(recoveryPath, {
    filesystem,
    now,
    staleMs,
    isOwnerAlive,
    recoveryDepth: recoveryDepth + 1,
    maxRecoveryDepth
  });
  if (!recovery) return false;
  try {
    let held;
    let stats;
    try {
      const [raw, currentStats] = await Promise.all([
        filesystem.readFile(lockPath, "utf8"),
        filesystem.stat(lockPath)
      ]);
      stats = currentStats;
      try {
        held = JSON.parse(raw);
      } catch {
        held = null;
      }
    } catch (error) {
      if (error.code === "ENOENT") return false;
      held = null;
      stats = await filesystem.stat(lockPath).catch(() => null);
    }
    if (!ownerCanBeReclaimed(held, stats, { now, staleMs, isOwnerAlive })) return false;

    const moved = `${lockPath}.stale.${randomUUID()}`;
    try {
      await filesystem.rename(lockPath, moved);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    await filesystem.rm(moved, { force: true });
    return true;
  } finally {
    await releaseOperationLock(recovery, { filesystem });
  }
}

export async function acquireOperationLock(lockPath, {
  filesystem = fs,
  now = () => Date.now(),
  staleMs = DEFAULT_STALE_MS,
  isOwnerAlive = processRecordIsAlive,
  recoveryDepth = 0,
  maxRecoveryDepth = 32
} = {}) {
  await filesystem.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await filesystem.chmod(path.dirname(lockPath), 0o700).catch(() => {});
  }

  const processStartedAt = processBirthToken(process.pid);
  const record = {
    format: LOCK_FORMAT,
    pid: process.pid,
    owner: randomUUID(),
    at: now(),
    ...(processStartedAt && { process_started_at: processStartedAt })
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publishOwner(lockPath, record, filesystem)) {
      return { lockPath, owner: record.owner };
    }

    let held = null;
    let stats = null;
    try {
      const [raw, currentStats] = await Promise.all([
        filesystem.readFile(lockPath, "utf8"),
        filesystem.stat(lockPath)
      ]);
      stats = currentStats;
      try {
        held = JSON.parse(raw);
      } catch {
        held = null;
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
    }

    if (!ownerCanBeReclaimed(held, stats, { now, staleMs, isOwnerAlive })) return null;
    await stealAbandoned(lockPath, {
      filesystem,
      now,
      staleMs,
      isOwnerAlive,
      recoveryDepth,
      maxRecoveryDepth
    });
  }
  return null;
}

export async function releaseOperationLock(lock, { filesystem = fs } = {}) {
  let held;
  try {
    held = JSON.parse(await filesystem.readFile(lock.lockPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (held?.format !== LOCK_FORMAT || held.owner !== lock.owner) {
    throw new Error(`Sync operation lock ownership changed before release: ${lock.lockPath}`);
  }
  await filesystem.unlink(lock.lockPath);
}

export async function withOperationLock(lockPath, callback, options = {}) {
  const lock = await acquireOperationLock(lockPath, options);
  if (!lock) return { acquired: false, value: null };
  try {
    return { acquired: true, value: await callback() };
  } finally {
    await releaseOperationLock(lock, options);
  }
}
