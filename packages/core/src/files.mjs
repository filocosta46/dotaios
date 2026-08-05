import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

async function ensureDestinationParent(destination, boundaryRoot) {
  const parent = path.dirname(destination);
  if (!boundaryRoot) {
    await fs.mkdir(parent, { recursive: true });
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
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await lstatIfPresent(current);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Cannot write through unsafe managed directory: ${current}`);
    }
  }
}

export async function writeFileSafe(
  destination,
  content,
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
      fs.writeFile(temporary, content, { flag: "wx", mode: 0o666 })
    );
    return { action: created ? "created" : "kept", path: destination };
  }
  await replaceWithTemporaryFile(destination, async (temporary) => {
    const mode = existing ? existing.mode & 0o777 : 0o666;
    await fs.writeFile(temporary, content, { flag: "wx", mode });
    if (existing) await fs.chmod(temporary, mode);
  });
  return { action: existing ? "updated" : "created", path: destination };
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
  await replaceWithTemporaryFile(destination, (temporary) =>
    fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
  );
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
