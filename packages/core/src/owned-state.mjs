import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureOwnedDirectory(directoryPath, {
  filesystem = fs,
  mode = 0o700
} = {}) {
  try {
    await filesystem.mkdir(directoryPath, { mode });
  } catch (error) {
    if (error?.code !== "EEXIST") throw ownedStateError();
  }
  const stats = await filesystem.lstat(directoryPath).catch(() => null);
  assertOwnedDirectoryStats(stats, mode);
  return directoryPath;
}

export async function validateOwnedDirectoryIfPresent(directoryPath, {
  filesystem = fs,
  mode = 0o700
} = {}) {
  let stats;
  try {
    stats = await filesystem.lstat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw ownedStateError();
  }
  assertOwnedDirectoryStats(stats, mode);
  return true;
}

export function assertOwnedFileStats(stats, mode = 0o600) {
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) throw ownedStateError();
  if (process.platform === "win32") return;
  if (stats.nlink !== 1 || stats.uid !== currentUid() || (stats.mode & 0o777) !== mode) {
    throw ownedStateError();
  }
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

function assertOwnedDirectoryStats(stats, mode) {
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) throw ownedStateError();
  if (process.platform === "win32") return;
  if (stats.uid !== currentUid() || (stats.mode & 0o777) !== mode) throw ownedStateError();
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}
