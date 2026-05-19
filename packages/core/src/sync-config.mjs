import fs from "node:fs/promises";
import path from "node:path";
import { syncConfigPath } from "./paths.mjs";

export async function readSyncConfig(filePath = syncConfigPath()) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
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

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = (await readSyncConfig(filePath)) ?? {};
  const merged = { ...existing, ...patch };
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), { mode: 0o600 });

  // re-chmod in case file existed before with looser mode
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  return merged;
}

export async function isSyncEnabled(filePath = syncConfigPath()) {
  const cfg = await readSyncConfig(filePath);
  return Boolean(cfg?.access_token);
}
