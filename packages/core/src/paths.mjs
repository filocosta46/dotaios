import fs from "node:fs/promises";
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

// Present only while setup owns a scaffold it has not finished building. Once
// init completes and its tree is verified, setup releases it. Anything that
// reads an AIOS folder needs the same name for it, so it lives here once.
export const SETUP_TRANSACTION_FILE = ".dotaios-setup-transaction.json";

export function defaultAiosPath() {
  return path.join(os.homedir(), "aios");
}

export function expandHome(value) {
  if (!value || !value.startsWith("~")) return value;
  return path.join(os.homedir(), value.slice(1));
}

// aios.json is a portable record, so vault_path is allowed to be `~/…` or a
// path relative to the folder that declares it. This returned it verbatim, and
// every caller then treated it as if it were already resolved. Two consequences,
// both found by attacking `dotaios import`:
//
//   "../vault"  resolved against the process CWD, so the same folder and the
//               same import file wrote to two different places depending on
//               where the command was run — and a containment check comparing
//               that value against an equally unresolved root is a tautology.
//   "~/vault"   was never expanded, so a literal `~` directory appeared under
//               the CWD and the vault the user asked for was never touched.
//
// Relative means relative to the AIOS folder, which is the only root that
// travels with the record. An absolute path is returned unchanged, because
// path.resolve stops at the first absolute segment.
export function resolveVaultPath(config, aiosPath = defaultAiosPath()) {
  const configured = config?.vault_path;
  if (!configured) return path.join(aiosPath, "vault");
  return path.resolve(expandHome(aiosPath), expandHome(configured));
}

/** Return whether a lexical candidate path is contained by a lexical root. */
export function isPathWithinLexically(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Return whether candidate resolves inside root, including through symlinks.
 * Missing tail components are allowed, but dangling or looping symlinks are
 * rejected because their eventual destination cannot be proven safe.
 */
export async function isPathWithin(root, candidate, options = {}) {
  const fileSystem = options.fileSystem || fs;
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      canonicalPath(fileSystem, root),
      canonicalPath(fileSystem, candidate)
    ]);
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    return relative === "" || (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ELOOP") return false;
    throw error;
  }
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

async function canonicalPath(fileSystem, value) {
  const missing = [];
  let existing = path.resolve(value);
  while (true) {
    try {
      await fileSystem.lstat(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return path.join(await fileSystem.realpath(existing), ...missing);
}
