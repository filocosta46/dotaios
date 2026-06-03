import os from "node:os";
import path from "node:path";
import { pathExists } from "./files.mjs";

export const requiredAiosFiles = [
  "aios.json",
  "README.md",
  "FIRST_SESSION.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  "skills/INDEX.md",
  "skills/RESOLVER.md",
  "context/identity.md",
  "context/work.md",
  "context/priorities.md",
  "context/north-star.md"
];

export function defaultAiosPath() {
  return path.join(os.homedir(), "aios");
}

export function expandHome(value) {
  if (!value || !value.startsWith("~")) return value;
  return path.join(os.homedir(), value.slice(1));
}

export function resolveVaultPath(config, aiosPath = defaultAiosPath()) {
  return config?.vault_path || path.join(aiosPath, "vault");
}

export async function ensureAiosFolder(target) {
  if (!(await pathExists(path.join(target, "aios.json")))) {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
}

export function dotaiosDir() {
  return path.join(os.homedir(), ".dotaios");
}

export function dotaiosBinDir() {
  return path.join(dotaiosDir(), "bin");
}

export function lightpandaBinPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(dotaiosBinDir(), `lightpanda${ext}`);
}

export function lightpandaHintFlagPath() {
  return path.join(dotaiosDir(), ".lightpanda_hint_shown");
}

export function syncConfigPath() {
  return path.join(dotaiosDir(), "sync.json");
}
