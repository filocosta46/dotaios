import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

function bindingError(message = "Local Git metadata could not be verified safely") {
  return new Error(`${message}; sync changed nothing.`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openRegularSingleLink(filePath, {
  filesystem,
  label,
  optional = false,
  maxBytes = 16 * 1024
}) {
  let expectedStats;
  try {
    expectedStats = await filesystem.lstat(filePath);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw bindingError(`${label} is not a private regular file`);
  }
  if (
    !expectedStats.isFile()
    || expectedStats.isSymbolicLink()
    || expectedStats.nlink !== 1
    || expectedStats.size > maxBytes
  ) {
    throw bindingError(`${label} is not a private regular file`);
  }
  let handle;
  try {
    handle = await filesystem.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
    );
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw bindingError(`${label} is not a private regular file`);
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.size > maxBytes
      || !sameFile(stats, expectedStats)
    ) {
      throw bindingError(`${label} is not a private regular file`);
    }
    return { content: await handle.readFile("utf8"), stats };
  } finally {
    await handle.close().catch(() => {});
  }
}

function parsePathRecord(content, { label, prefix = "" }) {
  const text = String(content);
  const body = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (!body || body.includes("\n") || body.includes("\r") || body.includes("\0")) {
    throw bindingError(`${label} is malformed`);
  }
  if (prefix && !body.startsWith(prefix)) {
    throw bindingError(`${label} is malformed`);
  }
  const value = prefix ? body.slice(prefix.length) : body;
  if (!value || value !== value.trim()) {
    throw bindingError(`${label} is malformed`);
  }
  return value;
}

async function canonicalDirectory(directoryPath, label, filesystem) {
  let stats;
  try {
    stats = await filesystem.lstat(directoryPath);
  } catch {
    throw bindingError(`${label} is unavailable`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw bindingError(`${label} is not a real directory`);
  }
  try {
    return await filesystem.realpath(directoryPath);
  } catch {
    throw bindingError(`${label} could not be resolved`);
  }
}

async function canonicalPath(candidate, label, filesystem) {
  try {
    return await filesystem.realpath(candidate);
  } catch {
    throw bindingError(`${label} could not be resolved`);
  }
}

async function rawPath(git, args, label, aiosPath, filesystem) {
  if (typeof git?.raw !== "function") {
    throw bindingError(`${label} inspection is unavailable`);
  }
  const result = await git.raw(args);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw bindingError(`${label} could not be inspected`);
  }
  return canonicalPath(path.resolve(aiosPath, result.stdout.trim()), label, filesystem);
}

async function assertSafeGitConfigs(git, { gitDir, commonDir }, filesystem) {
  await openRegularSingleLink(path.join(commonDir, "config"), {
    filesystem,
    label: "Local Git common config",
    optional: true,
    maxBytes: 1024 * 1024
  });

  const routed = await git.raw(["config", "--local", "--bool", "--get", "extensions.worktreeConfig"]);
  if (routed.code !== 0 && routed.code !== 1) {
    throw bindingError("Local Git config routing could not be inspected");
  }
  if (routed.code !== 0) return;
  const enabled = routed.stdout.trim();
  if (enabled !== "true" && enabled !== "false") {
    throw bindingError("Local Git worktree config routing is invalid");
  }
  if (enabled === "true") {
    await openRegularSingleLink(path.join(gitDir, "config.worktree"), {
      filesystem,
      label: "Local Git worktree config",
      optional: true,
      maxBytes: 1024 * 1024
    });
  }
}

/**
 * Bind a token-free Git client to exactly the requested AIOS worktree before
 * any credential, index, config, or network operation is allowed.
 */
export async function assertRepositoryBinding({
  aiosPath,
  git,
  filesystem = fs,
  allowMissing = false
}) {
  const markerPath = path.join(aiosPath, ".git");
  let markerStats;
  try {
    markerStats = await filesystem.lstat(markerPath);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null;
    throw bindingError("Root .git metadata is missing or unreadable");
  }
  if (markerStats.isSymbolicLink() || (!markerStats.isDirectory() && !markerStats.isFile())) {
    throw bindingError("Root .git metadata is a symbolic link or special file");
  }
  if (typeof git?.isRepositoryRoot !== "function" || !await git.isRepositoryRoot()) {
    throw bindingError("Local Git metadata does not belong to this AIOS folder");
  }

  const marker = await canonicalPath(markerPath, "Root .git metadata", filesystem);
  let binding;
  if (markerStats.isDirectory()) {
    const gitDir = await rawPath(
      git,
      ["rev-parse", "--absolute-git-dir"],
      "Local Git directory",
      aiosPath,
      filesystem
    );
    const commonDir = await rawPath(
      git,
      ["rev-parse", "--git-common-dir"],
      "Local Git common directory",
      aiosPath,
      filesystem
    );
    if (gitDir !== marker || commonDir !== marker) {
      throw bindingError("Local Git metadata does not belong exclusively to this AIOS folder");
    }
    binding = { kind: "primary", gitDir, commonDir };
  } else {
    const markerRecord = await openRegularSingleLink(markerPath, {
      filesystem,
      label: "Local Git worktree marker"
    });
    if (!sameFile(markerRecord.stats, markerStats)) {
      throw bindingError("Local Git worktree marker changed during verification");
    }
    const declaredGitDir = parsePathRecord(markerRecord.content, {
      label: "Local Git worktree marker",
      prefix: "gitdir: "
    });
    const declaredGitDirPath = path.resolve(path.dirname(markerPath), declaredGitDir);
    const gitDir = await canonicalDirectory(
      declaredGitDirPath,
      "Local Git worktree directory",
      filesystem
    );
    const backPointerRecord = await openRegularSingleLink(path.join(gitDir, "gitdir"), {
      filesystem,
      label: "Local Git worktree back-pointer"
    });
    const backPointer = parsePathRecord(backPointerRecord.content, {
      label: "Local Git worktree back-pointer"
    });
    if (await canonicalPath(path.resolve(gitDir, backPointer), "Local Git worktree back-pointer", filesystem) !== marker) {
      throw bindingError("Local Git metadata does not belong to this AIOS worktree");
    }

    const commonRecord = await openRegularSingleLink(path.join(gitDir, "commondir"), {
      filesystem,
      label: "Local Git common-directory pointer"
    });
    const commonPointer = parsePathRecord(commonRecord.content, {
      label: "Local Git common-directory pointer"
    });
    const commonDir = await canonicalDirectory(
      path.resolve(gitDir, commonPointer),
      "Local Git common directory",
      filesystem
    );
    const relativeGitDir = path.relative(path.join(commonDir, "worktrees"), gitDir);
    if (
      !relativeGitDir
      || path.isAbsolute(relativeGitDir)
      || relativeGitDir === ".."
      || relativeGitDir.startsWith(`..${path.sep}`)
      || relativeGitDir.includes(path.sep)
    ) {
      throw bindingError("Local Git metadata is not a registered worktree");
    }

    const [reportedGitDir, reportedCommonDir] = await Promise.all([
      rawPath(git, ["rev-parse", "--absolute-git-dir"], "Local Git directory", aiosPath, filesystem),
      rawPath(git, ["rev-parse", "--git-common-dir"], "Local Git common directory", aiosPath, filesystem)
    ]);
    if (reportedGitDir !== gitDir || reportedCommonDir !== commonDir) {
      throw bindingError("Local Git metadata changed during verification");
    }
    binding = { kind: "linked-worktree", gitDir, commonDir };
  }

  await assertSafeGitConfigs(git, binding, filesystem);
  return binding;
}
