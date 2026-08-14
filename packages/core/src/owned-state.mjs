import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureOwnedDirectory(directory, {
  filesystem = fs,
  mode = 0o700
} = {}) {
  const { directoryPath, sharedParent } = ownedDirectoryPolicy(directory);
  try {
    await filesystem.mkdir(directoryPath, { mode, recursive: true });
  } catch (error) {
    if (error?.code !== "EEXIST") throw ownedStateError();
  }
  const stats = await filesystem.lstat(directoryPath).catch(() => null);
  assertOwnedDirectoryStats(stats, mode, sharedParent);
  return directoryPath;
}

export async function validateOwnedDirectoryIfPresent(directory, {
  filesystem = fs,
  mode = 0o700
} = {}) {
  const { directoryPath, sharedParent } = ownedDirectoryPolicy(directory);
  let stats;
  try {
    stats = await filesystem.lstat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw ownedStateError();
  }
  assertOwnedDirectoryStats(stats, mode, sharedParent);
  return true;
}

export function assertOwnedFileStats(stats, mode = 0o600, {
  platform = process.platform
} = {}) {
  assertOwnedPublicationFile(stats, mode, 1, platform);
}

export function sameFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
  );
}

export async function publishOwnedFileExclusive(filePath, bytes, {
  filesystem = fs,
  onPublishedFailure = null
} = {}) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle = null;
  let linked = false;
  let publishedStats = null;
  let failure = null;
  try {
    handle = await filesystem.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryStats = await filesystem.lstat(temporary);
    assertOwnedFileStats(temporaryStats);
    await filesystem.link(temporary, filePath);
    linked = true;
    await filesystem.unlink(temporary);
    publishedStats = await filesystem.lstat(filePath);
    assertOwnedFileStats(publishedStats);
    if (!sameFileIdentity(temporaryStats, publishedStats)) throw ownedStateError();
    await syncOwnedDirectory(directory, { filesystem });
  } catch (error) {
    failure = error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
  if (failure) {
    if (linked && onPublishedFailure) await onPublishedFailure(failure);
    throw failure;
  }
  return publishedStats;
}

// link(temporary, target) is the exclusive publication point. A process death
// before unlink(temporary) leaves exactly two names for the same owned inode;
// remove only that narrowly proven temporary, then restore strict nlink=1.
export async function recoverOwnedFileExclusivePublication(filePath, {
  filesystem = fs,
  mode = 0o600,
  platform = process.platform
} = {}) {
  let targetStats;
  try {
    targetStats = await filesystem.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!isOwnedPublicationFile(targetStats, mode, 2, platform)) return false;

  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const prefix = `.${basename}.`;
  const candidates = [];
  for (const entry of await filesystem.readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
    const token = entry.name.slice(prefix.length, -4);
    if (!isUuid(token)) continue;
    const candidatePath = path.join(directory, entry.name);
    let candidateStats;
    try {
      candidateStats = await filesystem.lstat(candidatePath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      isOwnedPublicationFile(candidateStats, mode, 2, platform)
      && sameOwnedPublicationSnapshot(targetStats, candidateStats)
    ) candidates.push({ path: candidatePath, stats: candidateStats });
  }
  if (candidates.length !== 1) return false;

  const [currentTarget, currentCandidate] = await Promise.all([
    filesystem.lstat(filePath, { bigint: true }),
    filesystem.lstat(candidates[0].path, { bigint: true })
  ]);
  if (
    !sameOwnedPublicationSnapshot(targetStats, currentTarget)
    || !sameOwnedPublicationSnapshot(candidates[0].stats, currentCandidate)
    || !sameOwnedPublicationSnapshot(currentTarget, currentCandidate)
  ) return false;

  await filesystem.unlink(candidates[0].path);
  await syncOwnedDirectory(directory, { filesystem });
  const recovered = await filesystem.lstat(filePath, { bigint: true });
  assertOwnedPublicationFile(recovered, mode, 1, platform);
  if (!sameOwnedPublicationObject(targetStats, recovered)) throw ownedStateError();
  return true;
}

export async function syncOwnedDirectory(directoryPath, { filesystem = fs } = {}) {
  const handle = await filesystem.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function ownedStateError() {
  const error = new Error("Owned local state is invalid or unavailable.");
  error.code = "DOTAIOS_OWNED_STATE_INVALID";
  return error;
}

function isOwnedPublicationFile(stats, mode, links, platform = process.platform) {
  try {
    assertOwnedPublicationFile(stats, mode, links, platform);
    return true;
  } catch {
    return false;
  }
}

function assertOwnedPublicationFile(stats, mode, links, platform = process.platform) {
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) throw ownedStateError();
  const nlink = typeof stats.nlink === "bigint" ? Number(stats.nlink) : stats.nlink;
  if (nlink !== links) throw ownedStateError();
  if (platform === "win32") return;
  const permissions = typeof stats.mode === "bigint"
    ? Number(stats.mode & 0o777n)
    : stats.mode & 0o777;
  const uid = typeof stats.uid === "bigint" ? Number(stats.uid) : stats.uid;
  if (uid !== currentUid() || permissions !== mode) throw ownedStateError();
}

function sameOwnedPublicationObject(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.size === right.size);
}

function sameOwnedPublicationSnapshot(left, right) {
  return Boolean(sameOwnedPublicationObject(left, right)
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertOwnedDirectoryStats(stats, mode, sharedParent = false) {
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) throw ownedStateError();
  if (process.platform === "win32") return;
  const permissions = stats.mode & 0o777;
  if (stats.uid !== currentUid()) throw ownedStateError();
  if (sharedParent) {
    if ((permissions & 0o700) !== 0o700 || (permissions & 0o022) !== 0) throw ownedStateError();
    return;
  }
  if (permissions !== mode) throw ownedStateError();
}

function ownedDirectoryPolicy(directory) {
  if (typeof directory === "string") return { directoryPath: directory, sharedParent: false };
  if (
    !directory
    || typeof directory.path !== "string"
    || directory.sharedParent !== true
    || Object.keys(directory).some((key) => !["path", "sharedParent"].includes(key))
  ) throw ownedStateError();
  return { directoryPath: directory.path, sharedParent: true };
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}
