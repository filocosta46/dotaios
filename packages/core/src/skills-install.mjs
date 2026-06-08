import fs from "node:fs/promises";
import path from "node:path";
import { collectSkills } from "./skills.mjs";

// A target entry is "owned" by DotAIOS iff it is a symlink whose target is the
// matching skill dir under <aiosPath>/skills. We never touch anything else
// unless overwrite is set.
async function inspectEntry(entryPath) {
  try {
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) {
      return { kind: "symlink", target: await fs.readlink(entryPath) };
    }
    return { kind: "exists" };
  } catch {
    return { kind: "missing" };
  }
}

export async function installSymlinkSkills({ aiosPath, targetDir, dryRun = false, overwrite = false }) {
  const skills = await collectSkills(aiosPath); // [{ dir, name, ... }]
  if (!dryRun) await fs.mkdir(targetDir, { recursive: true });

  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  const results = [];

  for (const skill of skills) {
    const source = path.join(aiosPath, "skills", skill.dir);
    const dest = path.join(targetDir, skill.dir);
    const entry = await inspectEntry(dest);

    if (entry.kind === "symlink" && path.resolve(entry.target) === path.resolve(source)) {
      results.push({ action: "already-linked", path: dest });
      continue;
    }
    if (entry.kind === "missing") {
      if (!dryRun) await fs.symlink(source, dest, symlinkType);
      results.push({ action: dryRun ? "would link" : "linked", path: dest });
      continue;
    }
    // exists OR foreign symlink
    if (!overwrite) {
      results.push({ action: "kept", path: dest, note: "existing unmanaged entry" });
      continue;
    }
    if (!dryRun) {
      await fs.rm(dest, { recursive: true, force: true });
      await fs.symlink(source, dest, symlinkType);
    }
    results.push({ action: dryRun ? "would relink" : "relinked", path: dest });
  }
  return results;
}

export async function cleanupStaleLinks({ aiosPath, targetDir, dryRun = false }) {
  const skillsRoot = path.join(aiosPath, "skills");
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of entries) {
    const dest = path.join(targetDir, entry.name);
    const info = await inspectEntry(dest);
    if (info.kind !== "symlink") continue;                 // never touch real files/dirs
    const target = path.resolve(info.target);
    const root = path.resolve(skillsRoot);
    const ownsIt = target.startsWith(root + path.sep) || target === root;
    if (!ownsIt) continue;                                  // foreign symlink — leave it
    try {
      await fs.access(info.target);                         // source still exists?
    } catch {
      if (!dryRun) await fs.rm(dest, { force: true });
      removed.push({ action: dryRun ? "would remove" : "removed", path: dest });
    }
  }
  return removed;
}
