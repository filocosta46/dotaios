import { constants as fsConstants } from "node:fs";
import localFilesystem from "node:fs/promises";
import path from "node:path";

import { isPathWithin, isPathWithinLexically } from "./paths.mjs";

export class ContainedReadError extends Error {
  constructor(code = "DOTAIOS_UNSAFE_READ_PATH") {
    super("A working-context source is not a contained regular file.");
    this.name = "ContainedReadError";
    this.code = code;
  }
}

/**
 * Preserve an existing filesystem interface while guarding the two operations
 * that can return projected content or directory names.
 */
export function createContainedReadFilesystem(root, filesystem = localFilesystem, limits = {}) {
  return new Proxy(filesystem, {
    get(target, property) {
      if (property === "readFile") {
        return async (filePath, options) => {
          const encoding = typeof options === "string" ? options : options?.encoding;
          const content = await readContainedFile(root, filePath, {
            filesystem,
            encoding,
            budget: limits.budget,
            maxBytes: limits.maxFileBytes,
            tooLargeCode: limits.fileTooLargeCode
          });
          if (content === null) throw missingPathError();
          return content;
        };
      }
      if (property === "readdir") {
        return async (directoryPath, readdirOptions) => {
          const entries = await readContainedDirectory(root, directoryPath, {
            filesystem,
            budget: limits.budget,
            maxEntries: limits.maxEntries,
            tooManyCode: limits.tooManyCode,
            readdirOptions
          });
          if (entries === null) throw missingPathError();
          return entries;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/** Create one synchronous reservation ledger shared by a contained projection. */
export function createContainedReadBudget({ maxBytes, maxFiles, maxEntries, dimensionCodes = false }) {
  const limits = {
    maxBytes: normalizeFiniteLimit(maxBytes),
    maxFiles: normalizeFiniteLimit(maxFiles),
    maxEntries: normalizeFiniteLimit(maxEntries)
  };
  const used = { bytes: 0, files: 0, entries: 0 };
  return Object.freeze({
    reserveFile(size) {
      const bytes = normalizeFiniteLimit(size);
      if (used.files + 1 > limits.maxFiles) {
        throw new ContainedReadError(dimensionCodes
          ? "DOTAIOS_PROJECTION_FILE_COUNT_EXCEEDED"
          : "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
      }
      if (used.bytes + bytes > limits.maxBytes) {
        throw new ContainedReadError(dimensionCodes
          ? "DOTAIOS_PROJECTION_BYTE_BUDGET_EXCEEDED"
          : "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
      }
      used.files += 1;
      used.bytes += bytes;
    },
    reserveEntries(count = 1) {
      const entries = normalizeFiniteLimit(count);
      if (used.entries + entries > limits.maxEntries) {
        throw new ContainedReadError(dimensionCodes
          ? "DOTAIOS_PROJECTION_ENTRY_COUNT_EXCEEDED"
          : "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
      }
      used.entries += entries;
    },
    reserveDemand(demand = {}) {
      const bytes = normalizeFiniteLimit(demand.bytes);
      const files = normalizeFiniteLimit(demand.files);
      const entries = normalizeFiniteLimit(demand.entries);
      if (used.files + files > limits.maxFiles) {
        throw new ContainedReadError(dimensionCodes
          ? "DOTAIOS_PROJECTION_FILE_COUNT_EXCEEDED"
          : "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
      }
      if (used.bytes + bytes > limits.maxBytes) {
        throw new ContainedReadError(dimensionCodes
          ? "DOTAIOS_PROJECTION_BYTE_BUDGET_EXCEEDED"
          : "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
      }
      if (used.entries + entries > limits.maxEntries) {
        throw new ContainedReadError(dimensionCodes
          ? "DOTAIOS_PROJECTION_ENTRY_COUNT_EXCEEDED"
          : "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
      }
      used.bytes += bytes;
      used.files += files;
      used.entries += entries;
    },
    remaining() {
      return Object.freeze({
        bytes: limits.maxBytes - used.bytes,
        files: limits.maxFiles - used.files,
        entries: limits.maxEntries - used.entries
      });
    },
    snapshot() {
      return Object.freeze({ ...used });
    }
  });
}

/** Snapshot one required regular file without reading or decoding its bytes. */
export async function inspectContainedFile(root, filePath, options = {}) {
  return readContainedFile(root, filePath, { ...options, snapshotOnly: true });
}

/** Observe one final path component without following links or reading bytes. */
export async function inspectContainedPathEntry(root, filePath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const hasExpectedSnapshot = Object.hasOwn(options, "expectedSnapshot");
  if (!isPathWithinLexically(root, filePath)) throw new ContainedReadError();
  let before;
  try {
    before = await filesystem.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      await assertMissingTailContained(root, filePath, filesystem);
      await assertContainedDirectoriesUnchanged(root, filesystem, options.expectedDirectories);
      if (hasExpectedSnapshot && options.expectedSnapshot !== null) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      return null;
    }
    throw error;
  }
  const ancestors = await inspectContainedAncestors(root, filePath, filesystem);
  const confirmed = await lstatAfterObservation(filesystem, filePath);
  if (!sameFile(before, confirmed)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  await assertContainedAncestorsUnchanged(root, filePath, filesystem, ancestors);
  await assertContainedDirectoriesUnchanged(root, filesystem, options.expectedDirectories);
  const snapshot = { stats: confirmed, ancestors };
  if (
    hasExpectedSnapshot
    && (
      options.expectedSnapshot === null
      || !sameContainedFileSnapshot(options.expectedSnapshot, snapshot)
    )
  ) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  const type = confirmed.isSymbolicLink()
    ? "symbolic-link"
    : confirmed.isFile()
      ? "regular-file"
      : "other";
  return Object.freeze({ type, ...snapshot });
}

/**
 * Observe one final component relative to a corpus transaction's already
 * canonicalized root and exact parent snapshot.
 *
 * The transaction, not this inspector, owns root/ancestor/directory
 * validation. Keeping that proof request-owned means accepted sibling files
 * do not each repeat the same ancestor walk.
 */
export async function inspectContainedSnapshotPathEntry(root, filePath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const resolvedParent = path.resolve(options.parentPath || path.dirname(resolvedFile));
  if (
    !isPathWithinLexically(resolvedRoot, resolvedFile)
    || resolvedParent !== path.dirname(resolvedFile)
    || !options.parentSnapshot?.stats
  ) {
    throw new ContainedReadError();
  }

  let current;
  try {
    current = await filesystem.lstat(resolvedFile);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      if (Object.hasOwn(options, "expectedSnapshot") && options.expectedSnapshot === null) {
        return null;
      }
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    throw error;
  }
  const type = current.isSymbolicLink()
    ? "symbolic-link"
    : current.isFile()
      ? "regular-file"
      : "other";
  const snapshot = Object.freeze({ type, stats: current, ancestors: [] });
  if (
    Object.hasOwn(options, "expectedSnapshot")
    && (
      options.expectedSnapshot === null
      || options.expectedSnapshot.type !== snapshot.type
      || !sameFile(options.expectedSnapshot.stats, snapshot.stats)
    )
  ) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  return snapshot;
}

/** Final-check each observed file once; shared directories are checked elsewhere. */
export async function assertContainedPathEntrySnapshotsUnchanged(root, observations, options = {}) {
  const concurrency = Math.max(1, Math.min(128, Number(options.concurrency) || 64));
  const unique = new Map();
  for (const observation of observations || []) {
    const filePath = path.resolve(observation.filePath || observation.path);
    if (!isPathWithinLexically(root, filePath) || !Object.hasOwn(observation, "snapshot")) {
      throw new ContainedReadError();
    }
    const retained = unique.get(filePath);
    if (retained) {
      const unchanged = retained.snapshot === null && observation.snapshot === null
        || (
          retained.snapshot?.type === observation.snapshot?.type
          && sameFile(retained.snapshot.stats, observation.snapshot.stats)
        );
      if (!unchanged) throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      continue;
    }
    unique.set(filePath, { filePath, snapshot: observation.snapshot });
  }
  const values = [...unique.values()];
  for (let index = 0; index < values.length; index += concurrency) {
    await Promise.all(values.slice(index, index + concurrency).map(async ({ filePath, snapshot }) => {
      let current;
      try {
        current = await (options.filesystem || localFilesystem).lstat(filePath);
      } catch (error) {
        if ((error?.code === "ENOENT" || error?.code === "ENOTDIR") && snapshot === null) return;
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
        }
        throw error;
      }
      if (
        snapshot === null
        || snapshot.type !== (current.isSymbolicLink() ? "symbolic-link" : current.isFile() ? "regular-file" : "other")
        || !sameFile(snapshot.stats, current)
      ) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
    }));
  }
}

/** Snapshot regular-file metadata without opening or reading source bytes. */
export async function inspectContainedFileMetadata(root, filePath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  if (!isPathWithinLexically(root, filePath)) throw new ContainedReadError();
  const before = await filesystem.lstat(filePath, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || !await isPathWithin(root, filePath, { fileSystem: filesystem })
  ) {
    throw new ContainedReadError("DOTAIOS_EVIDENCE_NOT_REGULAR_FILE");
  }
  const ancestors = await inspectContainedAncestors(root, filePath, filesystem);
  const after = await filesystem.lstat(filePath, { bigint: true });
  if (!sameBigIntFile(before, after)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  await assertContainedAncestorsUnchanged(root, filePath, filesystem, ancestors);
  return Object.freeze({ stats: after, ancestors });
}

/** Compare two metadata-only regular-file observations. */
export function sameContainedFileMetadataSnapshot(left, right) {
  return Boolean(
    left
    && right
    && sameBigIntFile(left.stats, right.stats)
    && sameAncestorSnapshots(left.ancestors, right.ancestors)
  );
}

/** Compare two handle-bound file/ancestor snapshots from the same path. */
export function sameContainedFileSnapshot(left, right) {
  return Boolean(
    left
    && right
    && sameFile(left.stats, right.stats)
    && sameAncestorSnapshots(left.ancestors, right.ancestors)
  );
}

/** Read one regular file without allowing a projected source to escape root. */
export async function readContainedFile(root, filePath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  if (!isPathWithinLexically(root, filePath)) throw new ContainedReadError();

  let before;
  try {
    before = await filesystem.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      if (options.expectedSnapshot) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      await assertMissingTailContained(root, filePath, filesystem);
      return null;
    }
    throw error;
  }
  if (options.expectedSnapshot && !sameFile(options.expectedSnapshot.stats, before)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  if (!await isPathWithin(root, filePath, { fileSystem: filesystem })) {
    throw new ContainedReadError();
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new ContainedReadError();
  const ancestorsBefore = await inspectContainedAncestors(root, filePath, filesystem);
  const confirmedBefore = await lstatAfterObservation(filesystem, filePath);
  if (!sameFile(before, confirmedBefore)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  if (
    options.expectedSnapshot
    && !sameContainedFileSnapshot(
      options.expectedSnapshot,
      { stats: confirmedBefore, ancestors: ancestorsBefore }
    )
  ) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  if (
    Number.isFinite(options.maxBytes)
    && !Number.isFinite(options.prefixBytes)
    && before.size > options.maxBytes
  ) {
    throw new ContainedReadError(options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE");
  }
  if (Number.isFinite(options.maxSourceBytes) && before.size > options.maxSourceBytes) {
    throw new ContainedReadError(options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE");
  }

  // O_NOFOLLOW binds the final component. A second containment check after
  // opening refuses an ancestor swapped outside the authorized root before any
  // bytes are read from the handle.
  if (typeof filesystem.open === "function") {
    let handle;
    try {
      handle = await filesystem.open(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
      );
      if (!await isPathWithin(root, filePath, { fileSystem: filesystem })) {
        throw new ContainedReadError();
      }
      await assertContainedAncestorsUnchanged(root, filePath, filesystem, ancestorsBefore);
      await assertContainedDirectoriesUnchanged(root, filesystem, options.expectedDirectories);
      const opened = await handle.stat();
      const current = await lstatAfterObservation(filesystem, filePath);
      if (
        !opened.isFile()
        || current.isSymbolicLink()
        || !sameFile(confirmedBefore, opened)
        || !sameFile(opened, current)
      ) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      if (options.snapshotOnly) {
        const completed = await handle.stat();
        if (!sameFile(opened, completed)) {
          throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
        }
        await assertContainedAncestorsUnchanged(root, filePath, filesystem, ancestorsBefore);
        return { stats: completed, ancestors: ancestorsBefore };
      }
      if (
        Number.isFinite(options.maxBytes)
        && !Number.isFinite(options.prefixBytes)
        && opened.size > options.maxBytes
      ) {
        throw new ContainedReadError(options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE");
      }
      if (Number.isFinite(options.maxSourceBytes) && opened.size > options.maxSourceBytes) {
        throw new ContainedReadError(options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE");
      }
      const prefixBytes = Number.isFinite(options.prefixBytes)
        ? normalizeFiniteLimit(options.prefixBytes)
        : null;
      const reservedBytes = options.reserveSourceBytes === true
        ? opened.size
        : prefixBytes === null
          ? opened.size
          : Math.min(opened.size, prefixBytes);
      options.budget?.reserveFile(reservedBytes);
      const bytes = options.frontmatterOnly === true
        ? await readHandleFrontmatter(
          handle,
          prefixBytes ?? opened.size,
          options.stopOnMissingFrontmatter === true
        )
        : prefixBytes !== null
          ? await readHandlePrefix(handle, prefixBytes, opened.size)
        : Number.isFinite(options.maxBytes)
          ? await readBoundedHandle(
            handle,
            options.maxBytes,
            options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE",
            opened.size
          )
          : await handle.readFile();
      const completed = await handle.stat();
      if (!sameFile(opened, completed)) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      await assertContainedAncestorsUnchanged(root, filePath, filesystem, ancestorsBefore);
      await assertContainedDirectoriesUnchanged(root, filesystem, options.expectedDirectories);
      const content = decodeContainedBytes(bytes, options.encoding);
      return options.returnSnapshot ? { content, stats: completed } : content;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  throw new ContainedReadError(
    Number.isFinite(options.maxBytes)
      ? "DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE"
      : "DOTAIOS_FILE_HANDLE_READ_UNAVAILABLE"
  );
}

/** List one real directory while keeping the result inside root. */
export async function readContainedDirectory(root, directoryPath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const before = await inspectContainedDirectorySnapshot(root, directoryPath, { filesystem });
  if (before === null) return null;
  let entries;
  if (Number.isFinite(options.maxEntries) && typeof filesystem.opendir !== "function") {
    throw new ContainedReadError("DOTAIOS_BOUNDED_DIRECTORY_READ_UNAVAILABLE");
  }
  if (Number.isFinite(options.maxEntries)) {
    let directory;
    try {
      directory = await filesystem.opendir(directoryPath, {
        encoding: options.nameEncoding || "utf8"
      });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      throw error;
    }
    const opened = await inspectContainedDirectorySnapshot(root, directoryPath, { filesystem });
    if (!sameDirectorySnapshot(before, opened)) {
      await directory.close().catch(() => {});
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    entries = [];
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        options.budget?.reserveEntries(1);
        entries.push(options.readdirOptions?.withFileTypes ? entry : entry.name);
        if (entries.length > options.maxEntries) {
          throw new ContainedReadError(options.tooManyCode || "DOTAIOS_DIRECTORY_LIMIT_EXCEEDED");
        }
      }
    } finally {
      await directory.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
  } else {
    entries = await filesystem.readdir(directoryPath, options.readdirOptions);
    options.budget?.reserveEntries(entries.length);
    if (Number.isFinite(options.maxEntries) && entries.length > options.maxEntries) {
      throw new ContainedReadError(options.tooManyCode || "DOTAIOS_DIRECTORY_LIMIT_EXCEEDED");
    }
  }
  const after = await inspectContainedDirectorySnapshot(root, directoryPath, { filesystem });
  if (!sameDirectorySnapshot(before, after)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  return options.returnSnapshot ? { entries, snapshot: after } : entries;
}

/** Validate one directory without listing its potentially large contents. */
export async function inspectContainedDirectory(root, directoryPath, options = {}) {
  const snapshot = await inspectContainedDirectorySnapshot(root, directoryPath, options);
  if (options.returnSnapshot) return snapshot;
  return snapshot?.stats || null;
}

/** Snapshot the closest existing directory that bounds a missing contained tail. */
export async function inspectNearestContainedDirectory(root, candidate, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(candidate);
  if (!isPathWithinLexically(resolvedRoot, current)) throw new ContainedReadError();
  await assertMissingTailContained(resolvedRoot, current, filesystem);

  while (isPathWithinLexically(resolvedRoot, current)) {
    try {
      const snapshot = await inspectContainedDirectorySnapshot(resolvedRoot, current, { filesystem });
      if (snapshot) return Object.freeze({ path: current, snapshot });
    } catch (error) {
      if (error instanceof ContainedReadError) throw error;
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
  throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
}

/** Compare two contained directory observations from the same path. */
export function sameContainedDirectorySnapshot(left, right) {
  return sameDirectorySnapshot(left, right);
}

/**
 * Read one file that was accepted by a separately validated directory walk.
 *
 * This is intentionally narrower than readContainedFile: callers must supply
 * the canonical authorized root and the exact parent-directory observation
 * that admitted the path. It lets a request-scoped corpus transaction reuse
 * traversal invariants while retaining a no-follow handle, expected-entry /
 * handle identity, exact-parent identity, bounded bytes, UTF-8, and mutation
 * checks for every file. Canonical containment is owned by the transaction's
 * directory walk and final generation validation rather than repeated here.
 */
export async function readContainedSnapshotFile(root, filePath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const resolvedParent = path.resolve(options.parentPath || path.dirname(resolvedFile));
  if (
    !isPathWithinLexically(resolvedRoot, resolvedFile)
    || resolvedParent !== path.dirname(resolvedFile)
    || !options.parentSnapshot?.stats
  ) {
    throw new ContainedReadError();
  }
  if (typeof filesystem.open !== "function") {
    throw new ContainedReadError("DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE");
  }
  const noFollowFlag = Object.hasOwn(options, "noFollowFlag")
    ? options.noFollowFlag
    : fsConstants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollowFlag) || noFollowFlag <= 0) {
    throw new ContainedReadError("DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE");
  }

  let handle;
  try {
    handle = await filesystem.open(
      resolvedFile,
      fsConstants.O_RDONLY
        | noFollowFlag
        | (fsConstants.O_NONBLOCK || 0)
    );
    const opened = await handle.stat();
    const currentParent = await lstatAfterObservation(filesystem, resolvedParent, { bigint: true });
    const allowedRootParentLink = resolvedParent === resolvedRoot && currentParent.isSymbolicLink();
    if (
      !opened.isFile()
      || (options.expectedSnapshot && (
        options.expectedSnapshot.type !== "regular-file"
        || !sameFile(options.expectedSnapshot.stats, opened)
      ))
      || !sameBigIntFile(options.parentSnapshot.stats, currentParent)
      || (!allowedRootParentLink && (!currentParent.isDirectory() || currentParent.isSymbolicLink()))
    ) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    if (Number.isFinite(options.maxBytes) && opened.size > options.maxBytes) {
      throw new ContainedReadError(options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE");
    }

    options.budget?.reserveFile(opened.size);
    const bytes = Number.isFinite(options.maxBytes)
      ? await readBoundedHandle(
        handle,
        options.maxBytes,
        options.tooLargeCode || "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE",
        opened.size
      )
      : await handle.readFile();
    const completed = await handle.stat();
    if (!sameFile(opened, completed)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    return Object.freeze({
      content: decodeContainedBytes(bytes, options.encoding),
      stats: completed
    });
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Enumerate one directory already admitted by a corpus transaction. Parent
 * identity and canonical-root binding replace repeated full ancestor walks;
 * before/open/after path observations still surround the portable opendir
 * handle, whose identity Node does not expose directly.
 */
export async function readContainedSnapshotDirectory(root, directoryPath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directoryPath);
  const canonicalRoot = path.resolve(options.canonicalRoot || root);
  if (!isPathWithinLexically(resolvedRoot, resolvedDirectory)) {
    throw new ContainedReadError();
  }
  if (typeof filesystem.opendir !== "function") {
    throw new ContainedReadError("DOTAIOS_BOUNDED_DIRECTORY_READ_UNAVAILABLE");
  }

  let directory;
  try {
    const before = await lstatAfterObservation(filesystem, resolvedDirectory, { bigint: true });
    const allowedRootLink = resolvedDirectory === resolvedRoot && before.isSymbolicLink();
    if (
      (!allowedRootLink && (!before.isDirectory() || before.isSymbolicLink()))
      || (options.expectedSnapshot && !sameBigIntFile(options.expectedSnapshot.stats, before))
    ) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    directory = await filesystem.opendir(resolvedDirectory, {
      encoding: options.nameEncoding || "utf8"
    });
    const opened = await lstatAfterObservation(filesystem, resolvedDirectory, { bigint: true });
    if (!sameBigIntFile(before, opened)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }

    if (resolvedDirectory !== resolvedRoot) {
      const resolvedParent = path.resolve(options.parentPath || path.dirname(resolvedDirectory));
      if (resolvedParent !== path.dirname(resolvedDirectory) || !options.parentSnapshot?.stats) {
        throw new ContainedReadError();
      }
      const currentParent = await lstatAfterObservation(filesystem, resolvedParent, { bigint: true });
      const allowedRootParentLink = resolvedParent === resolvedRoot && currentParent.isSymbolicLink();
      if (
        (!allowedRootParentLink && (!currentParent.isDirectory() || currentParent.isSymbolicLink()))
        || !sameBigIntFile(options.parentSnapshot.stats, currentParent)
      ) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
    }

    let canonicalDirectory;
    try {
      canonicalDirectory = await filesystem.realpath(resolvedDirectory);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      throw error;
    }
    if (!isPathWithinLexically(canonicalRoot, canonicalDirectory)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }

    const entries = [];
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      options.budget?.reserveEntries(1);
      entries.push(options.readdirOptions?.withFileTypes ? entry : entry.name);
      if (Number.isFinite(options.maxEntries) && entries.length > options.maxEntries) {
        throw new ContainedReadError(options.tooManyCode || "DOTAIOS_DIRECTORY_LIMIT_EXCEEDED");
      }
    }
    const after = await lstatAfterObservation(filesystem, resolvedDirectory, { bigint: true });
    if (!sameBigIntFile(opened, after)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    return {
      entries,
      snapshot: {
        stats: after,
        ancestors: options.expectedSnapshot?.ancestors || []
      }
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    throw error;
  } finally {
    if (directory) {
      await directory.close().catch((error) => {
        if (error?.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
  }
}

/**
 * Revalidate one request's complete observed directory/ancestor generation.
 * Paths shared by many files or directories are checked once, so this work is
 * proportional to the observed directory set rather than to files multiplied
 * by their ancestor depth.
 */
export async function assertContainedDirectorySnapshotsUnchanged(root, observations, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  const resolvedRoot = path.resolve(root);
  const expectedPaths = new Map();

  for (const observation of observations || []) {
    const observedPath = path.resolve(observation.path);
    if (!isPathWithinLexically(resolvedRoot, observedPath) || !observation.snapshot) {
      throw new ContainedReadError();
    }
    const observedRootAncestor = observedPath === resolvedRoot
      ? observation.snapshot.ancestors?.find(
        (ancestor) => path.resolve(ancestor.path) === resolvedRoot
      )
      : null;
    rememberExpectedDirectory(expectedPaths, observedPath, {
      stats: observation.snapshot.stats,
      resolvedPath: observedRootAncestor?.resolvedPath || observedPath,
      resolvedStats: observedRootAncestor?.resolvedStats || observation.snapshot.stats
    });
    for (const ancestor of observation.snapshot.ancestors || []) {
      rememberExpectedDirectory(expectedPaths, ancestor.path, ancestor);
    }
  }

  for (const [expectedPath, expected] of expectedPaths) {
    const actual = await lstatAfterObservation(filesystem, expectedPath, { bigint: true });
    if (!sameBigIntFile(expected.stats, actual)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    if (expectedPath === resolvedRoot && actual.isSymbolicLink()) {
      let actualResolvedPath;
      try {
        actualResolvedPath = await filesystem.realpath(expectedPath);
      } catch (error) {
        if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
          throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
        }
        throw error;
      }
      const actualResolvedStats = await lstatAfterObservation(
        filesystem,
        actualResolvedPath,
        { bigint: true }
      );
      if (
        path.resolve(actualResolvedPath) !== path.resolve(expected.resolvedPath)
        || !sameBigIntFile(expected.resolvedStats, actualResolvedStats)
        || !actualResolvedStats.isDirectory()
        || actualResolvedStats.isSymbolicLink()
      ) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      continue;
    }
    if (!actual.isDirectory() || actual.isSymbolicLink()) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
  }
}

function rememberExpectedDirectory(expectedPaths, expectedPath, expected) {
  const resolvedPath = path.resolve(expectedPath);
  const current = expectedPaths.get(resolvedPath);
  if (current && (
    path.resolve(current.resolvedPath) !== path.resolve(expected.resolvedPath)
    || !sameBigIntFile(current.stats, expected.stats)
    || !sameBigIntFile(current.resolvedStats, expected.resolvedStats)
  )) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  if (!current) expectedPaths.set(resolvedPath, expected);
}

async function inspectContainedDirectorySnapshot(root, directoryPath, options = {}) {
  const filesystem = options.filesystem || localFilesystem;
  if (!isPathWithinLexically(root, directoryPath)) throw new ContainedReadError();
  let before;
  try {
    before = await filesystem.lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      await assertMissingTailContained(root, directoryPath, filesystem);
      return null;
    }
    throw error;
  }
  if (!await isPathWithin(root, directoryPath, { fileSystem: filesystem })) {
    throw new ContainedReadError();
  }
  const allowedRootLink = path.resolve(directoryPath) === path.resolve(root) && before.isSymbolicLink();
  if (!allowedRootLink && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new ContainedReadError();
  }
  const ancestors = await inspectContainedAncestors(root, directoryPath, filesystem);
  const confirmed = await lstatAfterObservation(filesystem, directoryPath, { bigint: true });
  if (!sameBigIntFile(before, confirmed)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
  await assertContainedAncestorsUnchanged(root, directoryPath, filesystem, ancestors);
  return { stats: confirmed, ancestors };
}

async function inspectContainedAncestors(root, candidate, filesystem) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = resolvedCandidate === resolvedRoot
    ? resolvedRoot
    : path.resolve(path.dirname(candidate));
  if (!isPathWithinLexically(resolvedRoot, resolvedParent)) throw new ContainedReadError();

  const relative = path.relative(resolvedRoot, resolvedParent);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  const paths = [resolvedRoot];
  for (const segment of segments) paths.push(path.join(paths.at(-1), segment));

  const snapshots = [];
  for (const [index, ancestorPath] of paths.entries()) {
    let stats;
    try {
      stats = await filesystem.lstat(ancestorPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      throw error;
    }
    if (index === 0 && stats.isSymbolicLink()) {
      let resolvedPath;
      let resolvedStats;
      try {
        resolvedPath = await filesystem.realpath(ancestorPath);
        resolvedStats = await filesystem.lstat(resolvedPath, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
        }
        throw error;
      }
      if (!resolvedStats.isDirectory() || resolvedStats.isSymbolicLink()) {
        throw new ContainedReadError();
      }
      snapshots.push({ path: ancestorPath, stats, resolvedPath, resolvedStats });
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ContainedReadError();
    snapshots.push({ path: ancestorPath, stats, resolvedPath: ancestorPath, resolvedStats: stats });
  }
  return snapshots;
}

async function assertMissingTailContained(root, candidate, filesystem) {
  const resolvedRoot = path.resolve(root);
  let ancestor = path.resolve(path.dirname(candidate));
  while (isPathWithinLexically(resolvedRoot, ancestor)) {
    try {
      const stats = await filesystem.lstat(ancestor);
      const allowedRootLink = ancestor === resolvedRoot && stats.isSymbolicLink();
      if (!allowedRootLink && (!stats.isDirectory() || stats.isSymbolicLink())) {
        throw new ContainedReadError();
      }
      await inspectContainedAncestors(
        root,
        path.join(ancestor, ".dotaios-missing-tail-check"),
        filesystem
      );
      return;
    } catch (error) {
      if (error instanceof ContainedReadError) throw error;
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    if (ancestor === resolvedRoot) break;
    ancestor = path.dirname(ancestor);
  }
  throw new ContainedReadError();
}

async function assertContainedAncestorsUnchanged(root, candidate, filesystem, expected) {
  const actual = await inspectContainedAncestors(root, candidate, filesystem);
  if (!sameAncestorSnapshots(expected, actual)) {
    throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
  }
}

async function assertContainedDirectoriesUnchanged(root, filesystem, expectedDirectories = []) {
  for (const expected of expectedDirectories) {
    const actual = await inspectContainedDirectorySnapshot(root, expected.path, { filesystem });
    if (!sameDirectorySnapshot(expected.snapshot, actual)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
  }
}

function sameAncestorSnapshots(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path
    && entry.resolvedPath === right[index].resolvedPath
    && sameBigIntFile(entry.stats, right[index].stats)
    && sameBigIntFile(entry.resolvedStats, right[index].resolvedStats)
  ));
}

function sameDirectorySnapshot(left, right) {
  return Boolean(
    left
    && right
    && sameBigIntFile(left.stats, right.stats)
    && sameAncestorSnapshots(left.ancestors, right.ancestors)
  );
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameBigIntFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function normalizeFiniteLimit(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError("Contained read limits must be non-negative safe integers.");
  }
  return normalized;
}

async function lstatAfterObservation(filesystem, targetPath, options) {
  try {
    return await filesystem.lstat(targetPath, options);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    throw error;
  }
}

async function readBoundedHandle(handle, maximumBytes, tooLargeCode, expectedBytes = null) {
  if (typeof handle.read !== "function") {
    throw new ContainedReadError("DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE");
  }
  const limit = Math.max(0, Math.floor(maximumBytes));
  const expected = Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
    ? Math.min(expectedBytes, limit)
    : limit;
  const chunks = [];
  let total = 0;
  while (total < expected) {
    const length = Math.min(64 * 1024, expected - total);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  const sentinel = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await handle.read(sentinel, 0, 1, null);
  if (extraBytes > 0) throw new ContainedReadError(tooLargeCode);
  return Buffer.concat(chunks, total);
}

async function readHandlePrefix(handle, maximumBytes, expectedBytes = null) {
  if (typeof handle.read !== "function") {
    throw new ContainedReadError("DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE");
  }
  const limit = Math.max(0, Math.floor(maximumBytes));
  const expected = Number.isSafeInteger(expectedBytes) && expectedBytes >= 0
    ? Math.min(expectedBytes, limit)
    : limit;
  const chunks = [];
  let total = 0;
  while (total < expected) {
    const length = Math.min(64 * 1024, expected - total);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

async function readHandleFrontmatter(handle, maximumBytes, stopOnMissingFrontmatter = false) {
  if (typeof handle.read !== "function") {
    throw new ContainedReadError("DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE");
  }
  const limit = Math.max(0, Math.floor(maximumBytes));
  let bytes = "";
  const singleByte = Buffer.allocUnsafe(1);
  while (bytes.length < limit) {
    const { bytesRead } = await handle.read(singleByte, 0, 1, null);
    if (bytesRead === 0) break;
    bytes += String.fromCharCode(singleByte[0]);
    if (stopOnMissingFrontmatter && !frontmatterOpeningPossible(bytes)) break;
    if (bytes.length >= 5) {
      const opening = bytes.charCodeAt(3) === 0x0a
        || (bytes.charCodeAt(3) === 0x0d && bytes.charCodeAt(4) === 0x0a);
      if (opening && (
        endsWithBytes(bytes, [0x0a, 0x2d, 0x2d, 0x2d, 0x0a])
        || endsWithBytes(bytes, [0x0a, 0x2d, 0x2d, 0x2d, 0x0d, 0x0a])
      )) {
        break;
      }
    }
  }
  return Buffer.from(bytes, "latin1");
}

function frontmatterOpeningPossible(value) {
  if (value.startsWith("---\n") || value.startsWith("---\r\n")) return true;
  if (value.length > 5) return true;
  return "---\n".startsWith(value) || "---\r\n".startsWith(value);
}

function endsWithBytes(value, suffix) {
  if (value.length < suffix.length) return false;
  const offset = value.length - suffix.length;
  return suffix.every((byte, index) => value.charCodeAt(offset + index) === byte);
}

function missingPathError() {
  const error = new Error("Working-context source not found.");
  error.code = "ENOENT";
  return error;
}

function decodeContainedBytes(value, encoding) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!encoding) return bytes;
  const text = bytes.toString(encoding);
  if (["utf8", "utf-8"].includes(String(encoding).toLowerCase())) {
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new ContainedReadError("DOTAIOS_INVALID_UTF8");
    }
  }
  return text;
}
