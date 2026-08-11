import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processBirthToken, processRecordIsAlive } from "./process-identity.mjs";
import {
  assertOwnedFileStats,
  ensureOwnedDirectory,
  ownedStateError,
  sameFileIdentity,
  syncOwnedDirectory
} from "./owned-state.mjs";

const DEFAULT_LOCK_FORMAT = "dotaios-sync-operation-lock/v1";
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const STRICT_TRANSITION_READ_RETRIES = 16;
const STRICT_TRANSITION_FORMAT = "dotaios-operation-lock-transition/v1";
const MAX_STRICT_PUBLICATION_TEMPORARIES = 64;
const MAX_STRICT_PUBLICATION_DIRECTORY_ENTRIES = 1_024;
const STRICT_PUBLICATION_OBSERVATION_TIMEOUT_MS = 5_000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const STRICT_OPERATION_BUSY = Symbol("strict-operation-busy");

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
    await publishStrictRecordExclusive(lockPath, record, {
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

async function publishStrictRecordExclusive(filePath, record, {
  filesystem,
  onPublishedFailure = null,
} = {}) {
  const directory = path.dirname(filePath);
  const temporary = strictPublicationTemporary(filePath, record.owner);
  const raw = `${JSON.stringify(record)}\n`;
  let handle = null;
  let created = false;
  let createdStats = null;
  let cleanupProof = null;
  let temporaryDetached = false;
  let linked = false;
  let publishedStats = null;
  let failure = null;
  try {
    handle = await filesystem.open(temporary, "wx", 0o600);
    created = true;
    createdStats = await handle.stat();
    assertOwnedFileStats(createdStats);
    cleanupProof = { raw, stats: createdStats, requireRaw: false };
    await handle.writeFile(raw, "utf8");
    cleanupProof.requireRaw = true;
    await handle.sync();
    await handle.close();
    handle = null;
    const [temporaryRaw, temporaryStats] = await readObservedStrictRecord(
      temporary,
      filesystem,
      await filesystem.lstat(temporary),
    );
    if (
      temporaryRaw !== raw
      || temporaryStats.nlink !== 1
      || !sameFileIdentity(createdStats, temporaryStats)
    ) throw ownedStateError();
    cleanupProof = Object.freeze({ raw, stats: temporaryStats, requireRaw: true });
    await filesystem.link(temporary, filePath);
    linked = true;
    await assertExactPublicationTemporary(temporary, createdStats, 2, filesystem);
    await filesystem.unlink(temporary);
    temporaryDetached = true;
    publishedStats = await filesystem.lstat(filePath);
    assertOwnedFileStats(publishedStats);
    if (!sameFileIdentity(temporaryStats, publishedStats)) throw ownedStateError();
    await syncOwnedDirectory(directory, { filesystem });
  } catch (error) {
    failure = error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created && !temporaryDetached && cleanupProof) {
      try {
        await unlinkExactStrictPublicationTemporary(
          temporary,
          filePath,
          cleanupProof,
          filesystem,
        );
        temporaryDetached = true;
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT" && !failure) failure = cleanupError;
      }
    }
  }
  if (failure) {
    if (linked && onPublishedFailure) await onPublishedFailure(failure);
    throw failure;
  }
  return Object.freeze({ raw, stats: publishedStats });
}

async function assertExactPublicationTemporary(temporary, expected, nlink, filesystem) {
  const current = await filesystem.lstat(temporary);
  assertStrictReadableLockStats(current);
  if (!sameStrictNodeExceptLinkCount(expected, current) || current.nlink !== nlink) {
    throw ownedStateError();
  }
}

async function unlinkExactStrictPublicationTemporary(
  temporary,
  canonical,
  proof,
  filesystem,
) {
  const [raw, current] = await readObservedStrictRecord(
    temporary,
    filesystem,
    await filesystem.lstat(temporary),
  );
  if (
    (proof.requireRaw && raw !== proof.raw)
    || !sameStrictNodeExceptLinkCount(proof.stats, current)
    || (process.platform !== "win32" && current.nlink !== 1 && current.nlink !== 2)
  ) throw ownedStateError();
  if (process.platform !== "win32" && current.nlink === 2) {
    const [canonicalRaw, canonicalStats] = await readLockRecord(canonical, filesystem, true);
    if (canonicalRaw !== raw || !sameFileIdentity(current, canonicalStats)) throw ownedStateError();
  }
  await filesystem.unlink(temporary);
}

function strictPublicationTemporary(filePath, owner) {
  if (!isStrictPublicationOwner(owner)) {
    throw ownedStateError();
  }
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${owner}.tmp`);
}

function isStrictPublicationOwner(owner) {
  return typeof owner === "string" && new RegExp(`^${UUID_PATTERN}$`, "i").test(owner);
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
    if (strictOwnedState && observed.publicationSettled) return STRICT_OPERATION_BUSY;
    if (!ownerCanBeReclaimed(observed.held, observed.stats, settings)) return false;
    const held = observed.held;
    if (strictOwnedState && !ownerRecordIsValid(held, format, true)) throw ownedStateError();
    const reclaimable = strictOwnedState && observed.publicationTemporary
      ? await normalizeAbandonedStrictPublication(lockPath, observed, settings)
      : observed;
    return moveAbandonedLock(lockPath, settings, reclaimable);
  } finally {
    await releaseOperationLock(recovery, { filesystem, strictOwnedState });
  }
}

export async function acquireOperationLock(lockPath, options = {}) {
  const settings = operationLockSettings(options);
  const { filesystem, format, strictOwnedState } = settings;
  await prepareLockParent(lockPath, settings);
  if (strictOwnedState && await orphanStrictTransitionIsTerminal(lockPath, settings)) {
    return null;
  }
  if (strictOwnedState && await recoverStrictPublicationTemporaries(lockPath, settings)) {
    return null;
  }
  const record = createOwnerRecord(settings);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publishOwner(lockPath, record, filesystem, strictOwnedState)) {
      if (strictOwnedState) await assertPublishedOwner(lockPath, record, settings);
      return { lockPath, owner: record.owner, format };
    }
    const { missing, held, stats, publicationSettled } = await readHeldLock(lockPath, settings);
    if (missing) continue;
    if (strictOwnedState && !ownerRecordIsValid(held, format, true)) throw ownedStateError();
    if (strictOwnedState && publicationSettled) return null;
    if (!ownerCanBeReclaimed(held, stats, settings)) return null;
    if (await stealAbandoned(lockPath, settings) === STRICT_OPERATION_BUSY) return null;
  }
  return null;
}

async function orphanStrictTransitionIsTerminal(lockPath, settings) {
  try {
    await settings.filesystem.lstat(lockPath);
    return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const transitionPath = `${lockPath}.transition`;
  let terminal = false;
  try {
    const [raw] = await readLockRecord(transitionPath, settings.filesystem, true);
    terminal = orphanStrictTransitionIsPoisoned(raw, settings.format);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const matcher = new RegExp(
    `^\\.${escapeRegExp(path.basename(transitionPath))}\\.(${UUID_PATTERN})\\.tmp$`,
    "i",
  );
  const directory = await settings.filesystem.opendir(path.dirname(lockPath));
  let visited = 0;
  let matched = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > MAX_STRICT_PUBLICATION_DIRECTORY_ENTRIES) throw ownedStateError();
      const match = matcher.exec(entry.name);
      if (!match) continue;
      matched += 1;
      if (matched > MAX_STRICT_PUBLICATION_TEMPORARIES) throw ownedStateError();
      const candidate = path.join(path.dirname(lockPath), entry.name);
      const [raw, stats] = await readLockRecord(candidate, settings.filesystem, true);
      if (process.platform !== "win32" && stats.nlink !== 1) throw ownedStateError();
      const record = parseOrphanStrictTransition(raw, settings.format);
      if (record.owner.toLowerCase() !== match[1].toLowerCase()) throw ownedStateError();
      if (record.next.poisoned !== true) throw ownedStateError();
      terminal = true;
    }
  } finally {
    await directory.close().catch(() => {});
  }
  try {
    await settings.filesystem.lstat(lockPath);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return terminal;
}

function orphanStrictTransitionIsPoisoned(raw, format) {
  const transition = parseOrphanStrictTransition(raw, format);
  if (transition.next.poisoned !== true) throw ownedStateError();
  return true;
}

function parseOrphanStrictTransition(raw, format) {
  let transition;
  try { transition = JSON.parse(raw); } catch { throw ownedStateError(); }
  if (
    typeof transition?.lock_dev !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(transition.lock_dev)
    || transition.lock_dev.length > 64
    || typeof transition?.lock_ino !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(transition.lock_ino)
    || transition.lock_ino.length > 64
  ) throw ownedStateError();
  assertStrictTransitionRecord(transition, format, {
    dev: transition.lock_dev,
    ino: transition.lock_ino,
  });
  return transition;
}

async function recoverStrictPublicationTemporaries(lockPath, settings) {
  const first = await inspectStrictPublicationTemporaries(lockPath, settings);
  if (first.active || first.dead.length === 0) return first.active;
  if (settings.recoveryDepth >= settings.maxRecoveryDepth) throw ownedStateError();
  const recovery = await acquireOperationLock(`${lockPath}.recovery`, {
    ...settings,
    recoveryDepth: settings.recoveryDepth + 1,
  });
  if (!recovery) return true;
  try {
    const confirmed = await inspectStrictPublicationTemporaries(lockPath, settings);
    if (confirmed.active) return true;
    let changed = false;
    for (const residue of confirmed.dead) {
      let canonical;
      try { canonical = await settings.filesystem.lstat(lockPath); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (canonical) return true;
      const [raw, stats, nested] = await readLockRecord(residue.path, settings.filesystem, true);
      if (
        nested
        || raw !== residue.raw
        || !sameFileIdentity(stats, residue.stats)
        || stats.nlink !== 1
      ) throw ownedStateError();
      await settings.filesystem.unlink(residue.path);
      changed = true;
    }
    if (changed) {
      await syncOwnedDirectory(path.dirname(lockPath), { filesystem: settings.filesystem });
    }
    return false;
  } finally {
    await releaseOperationLock(recovery, {
      filesystem: settings.filesystem,
      strictOwnedState: true,
    });
  }
}

async function inspectStrictPublicationTemporaries(lockPath, settings) {
  let canonical;
  try { canonical = await settings.filesystem.lstat(lockPath); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (canonical) return Object.freeze({ active: false, dead: Object.freeze([]) });
  const matcher = new RegExp(
    `^\\.${escapeRegExp(path.basename(lockPath))}\\.(${UUID_PATTERN})\\.tmp$`,
    "i",
  );
  const directory = await settings.filesystem.opendir(path.dirname(lockPath));
  const dead = [];
  let active = false;
  let matched = 0;
  let visited = 0;
  const observationDeadline = Date.now() + STRICT_PUBLICATION_OBSERVATION_TIMEOUT_MS;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > MAX_STRICT_PUBLICATION_DIRECTORY_ENTRIES) throw ownedStateError();
      const match = matcher.exec(entry.name);
      if (!match) continue;
      matched += 1;
      if (matched > MAX_STRICT_PUBLICATION_TEMPORARIES) throw ownedStateError();
      const candidate = path.join(path.dirname(lockPath), entry.name);
      let before;
      try {
        before = await settings.filesystem.lstat(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      let observed = null;
      for (;;) {
        try {
          observed = await readObservedStrictRecord(candidate, settings.filesystem, before, true);
        } catch (error) {
          let current;
          try {
            current = await settings.filesystem.lstat(candidate);
          } catch (lstatError) {
            if (lstatError?.code === "ENOENT") {
              if (
                error?.code === "DOTAIOS_OPERATION_LOCK_REMOVED"
                && !removedStrictPublicationWasExact(error.raw, match[1], settings.format)
              ) throw ownedStateError();
              break;
            }
            throw lstatError;
          }
          if (await strictOwnerIsPublished(lockPath, settings)) {
            active = true;
            break;
          }
          if (
            error?.code !== "DOTAIOS_OPERATION_LOCK_UNPUBLISHED"
            && error?.code !== "DOTAIOS_OPERATION_LOCK_TRANSITION"
          ) throw error;
          if (Date.now() >= observationDeadline) throw ownedStateError();
          if (!sameStrictNodeExceptLinkCount(before, current)) throw ownedStateError();
          before = current;
          await delay(1);
          continue;
        }
        const [raw, stats] = observed;
        if (stats.nlink === 2) {
          if (!await strictOwnerIsPublished(lockPath, settings, match[1])) {
            throw ownedStateError();
          }
          active = true;
          observed = null;
          break;
        }
        if (stats.nlink !== 1) throw ownedStateError();
        let record;
        try { record = JSON.parse(raw); } catch { /* An exact publisher may not have completed its write. */ }
        if (
          ownerRecordIsValid(record, settings.format, true)
          && record.owner.toLowerCase() === match[1].toLowerCase()
        ) {
          if (settings.isOwnerAlive(record)) active = true;
          else dead.push(Object.freeze({ path: candidate, raw, stats }));
          break;
        }
        if (Date.now() >= observationDeadline) throw ownedStateError();
        let current;
        try {
          current = await settings.filesystem.lstat(candidate);
        } catch (error) {
          if (error?.code === "ENOENT") throw ownedStateError();
          throw error;
        }
        assertStrictReadableLockStats(current);
        if (current.nlink === 2) {
          if (!await strictOwnerIsPublished(lockPath, settings, match[1])) {
            throw ownedStateError();
          }
          active = true;
          observed = null;
          break;
        }
        if (current.nlink !== 1 || !sameStrictNodeExceptLinkCount(before, current)) {
          throw ownedStateError();
        }
        before = current;
        observed = null;
        await delay(1);
      }
      if (!observed) continue;
    }
  } finally {
    await directory.close().catch(() => {});
  }
  return Object.freeze({ active, dead: Object.freeze(dead) });
}

function removedStrictPublicationWasExact(raw, owner, format) {
  let record;
  try { record = JSON.parse(raw); } catch { return false; }
  return Boolean(
    ownerRecordIsValid(record, format, true)
    && record.owner.toLowerCase() === owner.toLowerCase()
  );
}

async function strictOwnerIsPublished(lockPath, settings, expectedOwner = null) {
  let raw;
  try {
    [raw] = await readLockRecord(lockPath, settings.filesystem, true);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "DOTAIOS_OPERATION_LOCK_PUBLICATION_SETTLED") raw = error.raw;
    else throw error;
  }
  let record;
  try { record = JSON.parse(raw); } catch { throw ownedStateError(); }
  if (!ownerRecordIsValid(record, settings.format, true)) throw ownedStateError();
  return expectedOwner === null || record.owner.toLowerCase() === expectedOwner.toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function assertPublishedOwner(lockPath, record, settings) {
  const [raw, stats] = await readLockRecord(lockPath, settings.filesystem, true);
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
  const terminal = await readStrictTransitionIfPresent(lockPath, stats, published, settings);
  if (terminal) throw ownedStateError();
}

async function readHeldLock(lockPath, settings, fallbackStats = false) {
  const { filesystem, format, strictOwnedState } = settings;
  for (let attempt = 0; attempt <= STRICT_TRANSITION_READ_RETRIES; attempt += 1) {
    try {
      const [raw, stats, publicationTemporary] = await readLockRecord(
        lockPath,
        filesystem,
        strictOwnedState,
      );
      let held = null;
      let transition = null;
      try { held = JSON.parse(raw); } catch { /* Invalid non-strict records age out by mtime. */ }
      if (strictOwnedState) {
        const terminal = await readStrictTransitionIfPresent(lockPath, stats, held, settings);
        if (terminal) {
          held = terminal.next;
          transition = terminal;
        }
      }
      return Object.freeze({ missing: false, held, raw, stats, publicationTemporary, transition });
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ missing: true, held: null, stats: null });
      if (strictOwnedState && error?.code === "DOTAIOS_OPERATION_LOCK_PUBLICATION_SETTLED") {
        let held;
        try { held = JSON.parse(error.raw); } catch { throw ownedStateError(); }
        if (!ownerRecordIsValid(held, format, true)) throw ownedStateError();
        const terminal = await readStrictTransitionIfPresent(lockPath, error.stats, held, settings);
        if (terminal) held = terminal.next;
        return Object.freeze({
          missing: false,
          held,
          raw: error.raw,
          stats: error.stats,
          publicationTemporary: null,
          publicationSettled: true,
          transition: terminal || null,
        });
      }
      if (strictOwnedState && error?.code === "DOTAIOS_OPERATION_LOCK_REMOVED") {
        let removed;
        try { removed = JSON.parse(error.raw); } catch { throw ownedStateError(); }
        if (!ownerRecordIsValid(removed, format, true)) throw ownedStateError();
        if (attempt >= STRICT_TRANSITION_READ_RETRIES) throw ownedStateError();
        await delay(1);
        continue;
      }
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

async function normalizeAbandonedStrictPublication(lockPath, observed, settings) {
  const { filesystem } = settings;
  const [raw, stats, temporary] = await readLockRecord(lockPath, filesystem, true);
  if (
    temporary !== observed.publicationTemporary
    || raw !== observed.raw
    || !sameFileIdentity(stats, observed.stats)
  ) throw ownedStateError();
  await filesystem.unlink(temporary);
  await syncOwnedDirectory(path.dirname(lockPath), { filesystem });
  const [confirmedRaw, confirmedStats, confirmedTemporary] = await readLockRecord(
    lockPath,
    filesystem,
    true,
  );
  if (
    confirmedTemporary
    || confirmedRaw !== raw
    || !sameStrictNodeExceptLinkCount(stats, confirmedStats)
    || confirmedStats.nlink !== 1
  ) throw ownedStateError();
  return Object.freeze({ ...observed, raw: confirmedRaw, stats: confirmedStats, publicationTemporary: null });
}

function sameStrictNodeExceptLinkCount(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
  );
}

async function moveAbandonedLock(lockPath, settings, observed) {
  const { filesystem, strictOwnedState } = settings;
  const moved = `${lockPath}.stale.${randomUUID()}`;
  try {
    await filesystem.rename(lockPath, moved);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (strictOwnedState) {
    try {
      const [movedRaw, movedStats] = await readLockRecord(moved, filesystem, true);
      if (movedRaw !== observed.raw || !sameFileIdentity(movedStats, observed.stats)) {
        throw ownedStateError();
      }
      await clearAbandonedStrictTransition(lockPath, movedStats, settings, observed.transition);
    } catch (error) {
      await restoreForeignLock(moved, lockPath, filesystem);
      throw error;
    }
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
  const settings = operationLockSettings({
    filesystem,
    format: lock.format,
    strictOwnedState: true,
    ownsParent: false,
  });
  const observed = await readHeldLock(lock.lockPath, settings, true);
  if (
    observed.missing
    || !ownerRecordIsValid(observed.held, lock.format, true)
    || observed.held.owner !== lock.owner
    || observed.held.releasing === true
  ) throw ownedStateError();
  if (observed.held.poisoned === true) return;
  const next = Object.freeze({ ...observed.held, poisoned: true });
  await publishStrictTransition(lock, observed.held, next, observed.stats, filesystem);
  const confirmed = await readHeldLock(lock.lockPath, settings, true);
  if (
    confirmed.missing
    || confirmed.held?.owner !== lock.owner
    || confirmed.held?.poisoned !== true
  ) throw ownedStateError();
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
  const published = await publishStrictRecordExclusive(transitionPath, record, { filesystem });
  return Object.freeze({ path: transitionPath, raw: published.raw });
}

async function clearStrictTransition(transition, filesystem) {
  let [raw, stats, temporary] = await readLockRecord(transition.path, filesystem, true);
  if (raw !== transition.raw) throw ownedStateError();
  if (temporary) {
    await assertExactPublicationTemporary(temporary, stats, 2, filesystem);
    await filesystem.unlink(temporary);
    await syncOwnedDirectory(path.dirname(transition.path), { filesystem });
    const confirmed = await readLockRecord(transition.path, filesystem, true);
    if (
      confirmed[0] !== raw
      || confirmed[2]
      || !sameStrictNodeExceptLinkCount(stats, confirmed[1])
      || confirmed[1].nlink !== 1
    ) throw ownedStateError();
    stats = confirmed[1];
  }
  await filesystem.unlink(transition.path);
  await syncOwnedDirectory(path.dirname(transition.path), { filesystem });
}

async function readStrictTransitionIfPresent(lockPath, lockStats, held, settings) {
  const transitionPath = `${lockPath}.transition`;
  for (let observation = 0; observation < 2; observation += 1) {
    let raw;
    let transitionStats;
    try {
      [raw, transitionStats] = await readLockRecord(transitionPath, settings.filesystem, true);
    } catch (error) {
      if (error?.code === "DOTAIOS_OPERATION_LOCK_PUBLICATION_SETTLED") {
        raw = error.raw;
        transitionStats = error.stats;
      } else {
      if (error?.code !== "ENOENT") throw error;
      const staged = await readUnpublishedStrictTransition(
        transitionPath,
        lockStats,
        held,
        settings,
      );
      if (staged) return staged;
      continue;
      }
    }
    let transition;
    try { transition = JSON.parse(raw); } catch { throw ownedStateError(); }
    assertStrictTransitionRecord(transition, settings.format, lockStats);
    return Object.freeze({ next: transition.next, raw, stats: transitionStats, transitionPath });
  }
  return false;
}

async function readUnpublishedStrictTransition(transitionPath, lockStats, held, settings) {
  if (!ownerRecordIsValid(held, settings.format, true)) return false;
  if (!isStrictPublicationOwner(held.owner)) return false;
  const temporary = strictPublicationTemporary(transitionPath, held.owner);
  let before;
  try {
    before = await settings.filesystem.lstat(temporary);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let observed;
  try {
    observed = await readObservedStrictRecord(temporary, settings.filesystem, before, true);
  } catch (error) {
    if (error?.code === "DOTAIOS_OPERATION_LOCK_UNPUBLISHED") throw ownedStateError();
    throw error;
  }
  const [raw, stats] = observed;
  if (process.platform !== "win32" && stats.nlink !== 1) throw ownedStateError();
  let transition;
  try { transition = JSON.parse(raw); } catch { throw ownedStateError(); }
  assertStrictTransitionRecord(transition, settings.format, lockStats);
  return Object.freeze({ next: transition.next, raw, stats, transitionPath: temporary });
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

async function clearAbandonedStrictTransition(lockPath, lockStats, settings, observed = null) {
  const transitionPath = `${lockPath}.transition`;
  if (observed && observed.transitionPath !== transitionPath) {
    const expected = strictPublicationTemporary(transitionPath, observed.next.owner);
    if (observed.transitionPath !== expected || observed.next.releasing !== true) {
      throw ownedStateError();
    }
    const [stagedRaw, stagedStats, nested] = await readLockRecord(
      observed.transitionPath,
      settings.filesystem,
      true,
    );
    if (
      nested
      || stagedStats.nlink !== 1
      || stagedRaw !== observed.raw
      || !sameFileIdentity(stagedStats, observed.stats)
    ) throw ownedStateError();
    let staged;
    try { staged = JSON.parse(stagedRaw); } catch { throw ownedStateError(); }
    assertStrictTransitionRecord(staged, settings.format, lockStats);
    if (settings.isOwnerAlive(staged)) throw ownedStateError();
    await settings.filesystem.unlink(observed.transitionPath);
    await syncOwnedDirectory(path.dirname(lockPath), { filesystem: settings.filesystem });
    return;
  }
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
    let raw;
    let stats;
    try {
      [raw, stats] = await readLockRecord(lockPath, filesystem, strictOwnedState);
    } catch (error) {
      if (!strictOwnedState || error?.code !== "DOTAIOS_OPERATION_LOCK_PUBLICATION_SETTLED") throw error;
      raw = error.raw;
      stats = error.stats;
    }
    let record = null;
    try {
      record = JSON.parse(raw);
    } catch { /* An exact strict transition may carry the effective terminal record. */ }
    if (strictOwnedState) {
      const terminal = await readStrictTransitionIfPresent(lockPath, stats, record, operationLockSettings({
        filesystem,
        format,
        isOwnerAlive,
        strictOwnedState: true,
        ownsParent: false,
      }));
      if (terminal) record = terminal.next;
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
  const [raw, canonicalAfter] = await readObservedStrictRecord(lockPath, filesystem, before);
  const publicationTemporary = canonicalAfter.nlink === 2
    ? await proveStrictPublicationSibling(lockPath, raw, canonicalAfter, filesystem)
    : null;
  return [raw, canonicalAfter, publicationTemporary];
}

async function readObservedStrictRecord(
  lockPath,
  filesystem,
  before,
  allowMissingBeforeRead = false,
) {
  assertStrictReadableLockStats(before);
  let handle;
  try {
    handle = await filesystem.open(lockPath, "r");
  } catch (error) {
    if (allowMissingBeforeRead && error?.code === "ENOENT") {
      throw unpublishedStrictRecordChangedError();
    }
    throw error?.code === "ENOENT" ? operationLockTransitionError() : error;
  }
  try {
    const opened = await handle.stat();
    if (allowMissingBeforeRead && process.platform !== "win32" && opened.nlink === 0) {
      throw unpublishedStrictRecordChangedError();
    }
    assertStrictReadableLockStats(opened);
    if (
      allowMissingBeforeRead
      && sameFileIdentity(before, opened)
      && before.nlink !== opened.nlink
      && before.size === opened.size
      && before.mtimeMs === opened.mtimeMs
    ) throw unpublishedStrictRecordChangedError();
    if (
      sameFileIdentity(before, opened)
      && !sameLockContentSnapshot(before, opened)
    ) {
      if (allowMissingBeforeRead) throw unpublishedStrictRecordChangedError();
      throw operationLockTransitionError();
    }
    const raw = await handle.readFile("utf8");
    const openedAfter = await handle.stat();
    let canonicalAfter;
    try {
      canonicalAfter = await filesystem.lstat(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw observedStrictOwnerRemovedError(raw);
      throw error;
    }
    if (process.platform !== "win32" && openedAfter.nlink === 0) {
      if (allowMissingBeforeRead) throw unpublishedStrictRecordChangedError();
      throw observedStrictOwnerRemovedError(raw);
    }
    assertStrictReadableLockStats(openedAfter);
    assertStrictReadableLockStats(canonicalAfter);
    const publicationLinkChanged = Boolean(
      sameStrictNodeExceptLinkCount(opened, openedAfter)
      && opened.size === openedAfter.size
      && opened.mtimeMs === openedAfter.mtimeMs
      && (
        (allowMissingBeforeRead && (
          (opened.nlink === 1 && openedAfter.nlink === 2)
          || (opened.nlink === 2 && openedAfter.nlink === 1)
        ))
        || (!allowMissingBeforeRead && opened.nlink === 2 && openedAfter.nlink === 1)
      )
    );
    if (!sameFileIdentity(opened, openedAfter) && !publicationLinkChanged) {
      throw ownedStateError();
    }
    if (!sameFileIdentity(openedAfter, canonicalAfter)) {
      throw observedStrictOwnerRemovedError(raw);
    }
    // Retry only when metadata proves this exact inode changed during the
    // handle-bound observation. Stable malformed or replaced state fails
    // closed; new poison and release paths never rewrite this live record.
    if (!sameLockContentSnapshot(opened, openedAfter) && !publicationLinkChanged) {
      throw operationLockTransitionError();
    }
    return [raw, canonicalAfter];
  } finally {
    await handle.close();
  }
}

function unpublishedStrictRecordChangedError() {
  const error = new Error("Unpublished strict owner disappeared before observation.");
  error.code = "DOTAIOS_OPERATION_LOCK_UNPUBLISHED";
  return error;
}

function observedStrictOwnerRemovedError(raw) {
  const error = new Error("Observed strict owner was removed after a handle-bound read.");
  error.code = "DOTAIOS_OPERATION_LOCK_REMOVED";
  error.raw = raw;
  return error;
}

function assertStrictReadableLockStats(stats) {
  if (process.platform === "win32") return assertOwnedFileStats(stats);
  if (
    !stats?.isFile()
    || stats.isSymbolicLink()
    || (stats.nlink !== 1 && stats.nlink !== 2)
    || stats.uid !== process.getuid()
    || (stats.mode & 0o777) !== 0o600
  ) throw ownedStateError();
}

async function proveStrictPublicationSibling(lockPath, raw, lockStats, filesystem) {
  let record;
  try { record = JSON.parse(raw); } catch { throw ownedStateError(); }
  const temporary = strictPublicationTemporary(lockPath, record?.owner);
  let before;
  try {
    before = await filesystem.lstat(temporary);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return throwIfStrictPublicationSettled(lockPath, raw, lockStats, filesystem);
    }
    throw error;
  }
  if (
    process.platform !== "win32"
    && before.nlink === 1
    && sameStrictNodeExceptLinkCount(lockStats, before)
    && lockStats.size === before.size
    && lockStats.mtimeMs === before.mtimeMs
  ) return throwIfStrictPublicationSettled(lockPath, raw, lockStats, filesystem);
  assertStrictPublicationSiblingStats(before);
  if (!sameFileIdentity(lockStats, before)) throw ownedStateError();
  let handle;
  try {
    handle = await filesystem.open(temporary, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return throwIfStrictPublicationSettled(lockPath, raw, lockStats, filesystem);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (
      process.platform !== "win32"
      && opened.nlink === 1
      && sameStrictNodeExceptLinkCount(before, opened)
    ) return throwIfStrictPublicationSettled(lockPath, raw, lockStats, filesystem);
    assertStrictPublicationSiblingStats(opened);
    if (!sameFileIdentity(before, opened)) throw operationLockTransitionError();
    const siblingRaw = await handle.readFile("utf8");
    const openedAfter = await handle.stat();
    if (
      process.platform !== "win32"
      && openedAfter.nlink === 1
      && siblingRaw === raw
      && sameStrictNodeExceptLinkCount(opened, openedAfter)
      && opened.size === openedAfter.size
      && opened.mtimeMs === openedAfter.mtimeMs
    ) return throwIfStrictPublicationSettled(lockPath, raw, lockStats, filesystem);
    const canonicalAfter = await filesystem.lstat(lockPath);
    assertStrictPublicationSiblingStats(openedAfter);
    assertStrictReadableLockStats(canonicalAfter);
    if (
      siblingRaw !== raw
      || !sameLockContentSnapshot(opened, openedAfter)
      || !sameFileIdentity(openedAfter, canonicalAfter)
    ) throw ownedStateError();
  } finally {
    await handle.close();
  }
  return temporary;
}

async function throwIfStrictPublicationSettled(lockPath, raw, lockStats, filesystem) {
  let confirmedRaw;
  let confirmedStats;
  try {
    [confirmedRaw, confirmedStats] = await readObservedStrictRecord(
      lockPath,
      filesystem,
      await filesystem.lstat(lockPath),
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw strictPublicationSettledError(raw, lockStats);
    if (
      error?.code === "DOTAIOS_OPERATION_LOCK_TRANSITION"
      || error?.code === "DOTAIOS_OPERATION_LOCK_REMOVED"
    ) {
      try {
        await filesystem.lstat(lockPath);
      } catch (lstatError) {
        if (lstatError?.code === "ENOENT") throw strictPublicationSettledError(raw, lockStats);
        throw lstatError;
      }
      throw ownedStateError();
    }
    throw error;
  }
  if (
    lockStats.nlink !== 2
    || confirmedStats.nlink !== 1
    || confirmedRaw !== raw
    || !sameStrictNodeExceptLinkCount(lockStats, confirmedStats)
    || lockStats.size !== confirmedStats.size
    || lockStats.mtimeMs !== confirmedStats.mtimeMs
  ) throw ownedStateError();
  throw strictPublicationSettledError(confirmedRaw, confirmedStats);
}

function assertStrictPublicationSiblingStats(stats) {
  assertStrictReadableLockStats(stats);
  if (process.platform !== "win32" && stats.nlink !== 2) throw ownedStateError();
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

function strictPublicationSettledError(raw, stats) {
  const error = new Error("Strict owner publication settled during sibling proof.");
  error.code = "DOTAIOS_OPERATION_LOCK_PUBLICATION_SETTLED";
  error.raw = raw;
  error.stats = stats;
  return error;
}

async function releaseStrictOperationLock(lock, filesystem) {
  const releasePath = `${lock.lockPath}.release.${randomUUID()}`;
  const settings = operationLockSettings({
    filesystem,
    format: lock.format,
    strictOwnedState: true,
    ownsParent: false,
  });
  const observed = await readHeldLock(lock.lockPath, settings, true);
  if (
    observed.missing
    || !ownerRecordIsValid(observed.held, lock.format, true)
    || observed.held.owner !== lock.owner
    || observed.held.poisoned === true
    || observed.held.releasing === true
    || observed.publicationSettled
    || observed.publicationTemporary
  ) throw ownedStateError();
  try {
    await filesystem.rename(lock.lockPath, releasePath);
  } catch (error) {
    throw error?.code === "ENOENT" ? ownedStateError() : error;
  }
  try {
    const [raw, movedStats] = await readLockRecord(releasePath, filesystem, true);
    const held = JSON.parse(raw);
    if (
      !ownerRecordIsValid(held, lock.format, true)
      || held.owner !== lock.owner
      || held.poisoned === true
      || held.releasing === true
      || raw !== observed.raw
      || !sameFileIdentity(observed.stats, movedStats)
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
