import fs from "node:fs/promises";
import path from "node:path";
import { readJson } from "./files.mjs";

export function aiosConfigPath(aiosPath) {
  return path.join(aiosPath, "aios.json");
}

export async function readAiosConfig(aiosPath) {
  return (await readJson(aiosConfigPath(aiosPath), {})) || {};
}

// Merge a patch into aios.json, preserving every existing key. Used for
// persisted preferences such as `skills_first`. Never overwrites the whole file.
export async function updateAiosConfig(aiosPath, patch) {
  const filePath = aiosConfigPath(aiosPath);
  const current = await readAiosConfig(aiosPath);
  const next = { ...current, ...patch };
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
