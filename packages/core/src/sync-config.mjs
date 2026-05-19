import fs from "node:fs/promises";
import path from "node:path";
import { syncConfigPath } from "./paths.mjs";

export async function readSyncConfig(filePath = syncConfigPath()) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`sync.json is malformed at ${filePath}: ${err.message}`);
  }
}

export async function writeSyncConfig(filePathOrPatch, maybePatch) {
  // overload: writeSyncConfig(patch) or writeSyncConfig(path, patch)
  let filePath, patch;
  if (typeof filePathOrPatch === "string") {
    filePath = filePathOrPatch;
    patch = maybePatch;
  } else {
    filePath = syncConfigPath();
    patch = filePathOrPatch;
  }

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Re-chmod the dir in case it pre-existed at looser mode (mkdir won't tighten existing dirs)
  if (process.platform !== "win32") {
    try { await fs.chmod(dir, 0o700); } catch {}
  }

  // TODO(Task 7): wrap with file lock to prevent concurrent CLI hook + heartbeat
  // from clobbering each other's read-modify-write basis. Atomic rename below
  // covers half-written file visibility, but not the read-merge-write race.
  const existing = (await readSyncConfig(filePath)) ?? {};
  const merged = { ...existing, ...patch };

  // Write to .tmp first (mode honored on creation), then atomic rename.
  // This guarantees the new content lands at 0600 from the moment it exists,
  // and concurrent readers never see a half-written file.
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(tmp, 0o600); // belt-and-suspenders
  }
  await fs.rename(tmp, filePath);
  return merged;
}

export async function isSyncEnabled(filePath = syncConfigPath()) {
  const cfg = await readSyncConfig(filePath);
  return Boolean(cfg?.access_token);
}
