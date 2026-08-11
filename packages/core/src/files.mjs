import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireOperationLock, releaseOperationLock } from "./operation-lock.mjs";

const FILE_REPLACEMENT_LOCK_FORMAT = "dotaios-file-replacement-lock/v1";

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertSafeOverwriteTarget(destination, stats) {
  if (!stats || (stats.isFile() && !stats.isSymbolicLink())) return;
  throw new Error(`Cannot overwrite unsafe file destination: ${destination}`);
}

function temporarySiblingPath(destination) {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.dotaios-${process.pid}-${randomUUID()}.tmp`
  );
}

async function replaceWithTemporaryFile(destination, createTemporary) {
  const temporary = temporarySiblingPath(destination);
  try {
    await createTemporary(temporary);
    // rename(2) replaces a leaf symlink rather than following it. The caller's
    // lstat check rejects pre-existing unsafe leaves; this atomic replacement
    // also keeps a last-moment leaf swap from redirecting bytes elsewhere.
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function publishTemporaryWithoutReplacing(temporary, destination) {
  // A staged sibling plus an exclusive hard link is the portable no-replace
  // publication primitive Node exposes. Both names are on the same filesystem,
  // and the temporary name is removed by the caller after publication.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.link(temporary, destination);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const winner = await lstatIfPresent(destination);
      if (!winner) continue;
      assertSafeOverwriteTarget(destination, winner);
      return false;
    }
  }
  throw new Error(`Cannot safely publish preserved file after repeated destination races: ${destination}`);
}

async function createOrKeepWithTemporaryFile(destination, createTemporary) {
  const temporary = temporarySiblingPath(destination);
  try {
    await createTemporary(temporary);
    return await publishTemporaryWithoutReplacing(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function validateDestinationParent(destination, boundaryRoot, { createMissing = false } = {}) {
  const parent = path.dirname(destination);
  if (!boundaryRoot) {
    if (createMissing) await fs.mkdir(parent, { recursive: true });
    return;
  }

  const root = path.resolve(boundaryRoot);
  const resolvedDestination = path.resolve(destination);
  const relativeDestination = path.relative(root, resolvedDestination);
  if (
    !relativeDestination
    || relativeDestination === ".."
    || relativeDestination.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeDestination)
  ) {
    throw new Error(`Cannot write outside the managed file boundary: ${destination}`);
  }

  const rootStats = await lstatIfPresent(root);
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Cannot write through unsafe managed root: ${root}`);
  }

  const relativeParent = path.relative(root, parent);
  let current = root;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (createMissing) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    const stats = await lstatIfPresent(current);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Cannot write through unsafe managed directory: ${current}`);
    }
  }
}

async function ensureDestinationParent(destination, boundaryRoot) {
  await validateDestinationParent(destination, boundaryRoot, { createMissing: true });
}

export async function validateManagedFilePath(destination, boundaryRoot) {
  await validateDestinationParent(destination, boundaryRoot);
  const stats = await lstatIfPresent(destination);
  if (!stats) return null;
  assertSafeOverwriteTarget(destination, stats);
  return stats;
}

export async function writeFileSafe(
  destination,
  content,
  writeMode = "preserve",
  { boundaryRoot = null, mode = 0o666 } = {}
) {
  const existing = await lstatIfPresent(destination);
  assertSafeOverwriteTarget(destination, existing);
  await ensureDestinationParent(destination, boundaryRoot);
  if (existing && writeMode === "preserve") {
    return { action: "kept", path: destination };
  }

  if (!existing && writeMode === "preserve") {
    const created = await createOrKeepWithTemporaryFile(destination, (temporary) =>
      fs.writeFile(temporary, content, { flag: "wx", mode })
    );
    return { action: created ? "created" : "kept", path: destination };
  }
  await replaceWithTemporaryFile(destination, async (temporary) => {
    const fileMode = existing ? existing.mode & 0o777 : mode;
    await fs.writeFile(temporary, content, { flag: "wx", mode: fileMode });
    if (existing) await fs.chmod(temporary, fileMode);
  });
  return { action: existing ? "updated" : "created", path: destination };
}

export async function replaceFileIfUnchanged(
  destination,
  expected,
  content,
  {
    boundaryRoot = null,
    mode = 0o666,
    backupMode = mode,
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null,
    beforeRename = null,
    expectedStats = null,
    expectedBytes = null
  } = {}
) {
  const comparisonBytes = expectedBytes == null
    ? Buffer.from(expected)
    : Buffer.from(expectedBytes);
  const token = `${process.pid}-${randomUUID()}`;
  const basename = path.basename(destination);
  const staged = path.join(path.dirname(destination), `.${basename}.dotaios-${token}.next`);
  const preservedPath = `${destination}.dotaios-backup-${token}`;
  const lockPath = `${destination}.dotaios-write.lock`;
  await ensureDestinationParent(lockPath, boundaryRoot);
  assertSafeOverwriteTarget(lockPath, await lstatIfPresent(lockPath));
  const lock = await acquireOperationLock(lockPath, {
    format: FILE_REPLACEMENT_LOCK_FORMAT,
    ownsParent: false
  });
  if (!lock) return { replaced: false, preservedPath: null };

  try {
    const stagedWrite = await writeFileSafe(staged, content, "preserve", { boundaryRoot, mode });
    if (stagedWrite.action !== "created") {
      throw new Error(`Cannot stage a unique replacement for ${destination}`);
    }
    await fs.chmod(staged, mode);

    try {
      await beforeReplace?.({ destination, current: expected, next: content, staged });
      if (!await fileStillMatches(destination, comparisonBytes, expectedStats)) {
        return { replaced: false, preservedPath: null };
      }

      await beforePublish?.({ destination, current: expected, next: content, staged });
      if (!await fileStillMatches(destination, comparisonBytes, expectedStats)) {
        return { replaced: false, preservedPath: null };
      }

      // Publish an exact byte-for-byte backup while the live destination stays
      // in place. The later rename is atomic, so readers observe either the old
      // file or the complete replacement—even if the process stops mid-update.
      const backup = await writeFileSafe(preservedPath, comparisonBytes, "preserve", {
        boundaryRoot,
        mode: backupMode
      });
      if (backup.action !== "created") {
        throw new Error(`Cannot preserve a unique backup for ${destination}`);
      }
      await fs.chmod(preservedPath, backupMode);

      if (!await fileStillMatches(destination, comparisonBytes, expectedStats)) {
        return { replaced: false, preservedPath };
      }

      await beforeCommit?.({ destination, current: expected, next: content, staged, preservedPath });
      if (!await fileStillMatches(destination, comparisonBytes, expectedStats)) {
        return { replaced: false, preservedPath };
      }

      await beforeRename?.({ destination, current: expected, next: content, staged, preservedPath });
      await validateManagedFilePath(destination, boundaryRoot);
      if (!await fileStillMatches(destination, comparisonBytes, expectedStats)) {
        return { replaced: false, preservedPath };
      }

      // DotAIOS writers are serialized by the recoverable per-file lock. The
      // final rename keeps readers on a complete old-or-new file. Editors that
      // do not honor that lock still have a narrow final check-to-rename race,
      // so callers must describe this as guarded replacement, not filesystem
      // compare-and-swap.
      await fs.rename(staged, destination);
      return { replaced: true, preservedPath };
    } finally {
      await fs.rm(staged, { force: true });
    }
  } finally {
    await releaseOperationLock(lock);
  }
}

async function fileStillMatches(destination, expectedBytes, expectedStats) {
  const before = await lstatIfPresent(destination);
  if (!sameRegularFile(before, expectedStats)) return false;

  let current;
  try {
    current = await fs.readFile(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const after = await lstatIfPresent(destination);
  return current.equals(expectedBytes) && sameRegularFile(after, before);
}

function sameRegularFile(actual, expected) {
  if (!actual?.isFile() || actual.isSymbolicLink() || !expected) return false;
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && (actual.mode & 0o777) === (expected.mode & 0o777);
}

export async function copyFileSafe(
  source,
  destination,
  writeMode = "preserve",
  { boundaryRoot = null } = {}
) {
  const existing = await lstatIfPresent(destination);
  assertSafeOverwriteTarget(destination, existing);
  await ensureDestinationParent(destination, boundaryRoot);
  if (existing && writeMode === "preserve") {
    return { action: "kept", path: destination };
  }

  if (!existing && writeMode === "preserve") {
    const created = await createOrKeepWithTemporaryFile(destination, (temporary) =>
      fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
    );
    return { action: created ? "created" : "kept", path: destination };
  }
  await replaceWithTemporaryFile(destination, async (temporary) => {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    if (existing) await fs.chmod(temporary, existing.mode & 0o777);
  });
  return { action: existing ? "updated" : "created", path: destination };
}

export async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(resolved) : resolved;
  }));

  return files.flat();
}
