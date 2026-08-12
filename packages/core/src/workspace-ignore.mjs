import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const MANAGED_WORKSPACE_IGNORE_RULE = "/workspaces/";

export function hasExactManagedWorkspaceIgnoreRule(content) {
  return String(content).split(/\r?\n/).some((line) => line === MANAGED_WORKSPACE_IGNORE_RULE);
}

// Init recovery cannot depend on Git being installed. Require the exact
// anchored rule and conservatively refuse any later negation that could undo
// it; ordinary later rules (such as build/) remain safe to preserve.
export function hasStableManagedWorkspaceIgnoreRule(content) {
  const lines = String(content).split(/\r?\n/);
  const exactIndex = lines.lastIndexOf(MANAGED_WORKSPACE_IGNORE_RULE);
  if (exactIndex === -1) return false;
  return lines.slice(exactIndex + 1).every((line) => {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith("#") || !trimmed.startsWith("!");
  });
}

// A final meaningful rule is a conservative, deterministic migration proof:
// no later pattern can re-include the managed workspace root.
export function endsWithManagedWorkspaceIgnoreRule(content) {
  const lines = String(content).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    return line === MANAGED_WORKSPACE_IGNORE_RULE;
  }
  return false;
}

export async function isManagedWorkspaceEffectivelyIgnored(
  content,
  { filesystem = fs, env = process.env } = {}
) {
  const probeRoot = await filesystem.mkdtemp(
    path.join(os.tmpdir(), "dotaios-workspace-ignore-")
  );
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))
  );
  try {
    await filesystem.writeFile(path.join(probeRoot, ".gitignore"), String(content), {
      flag: "wx",
      mode: 0o600
    });
    await filesystem.mkdir(path.join(probeRoot, "workspaces"));
    await execFileAsync(
      "git",
      ["-c", "init.templateDir=", "init", "--quiet"],
      { cwd: probeRoot, encoding: "utf8", env: cleanEnv }
    );
    try {
      await execFileAsync(
        "git",
        ["check-ignore", "--no-index", "-q", "--", "workspaces/"],
        { cwd: probeRoot, encoding: "utf8", env: cleanEnv }
      );
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  } finally {
    await filesystem.rm(probeRoot, { recursive: true, force: true });
  }
}
