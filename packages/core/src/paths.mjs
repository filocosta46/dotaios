import os from "node:os";
import path from "node:path";

export const requiredAiosFiles = [
  "aios.json",
  "README.md",
  "FIRST_SESSION.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
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
