import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectSkills } from "./skills.mjs";

async function isStaleDotaiosTempPath(value) {
  const resolved = path.resolve(value);
  const tempRoot = path.resolve(os.tmpdir());
  const isDotaiosPath = isWithin(tempRoot, resolved)
    && /(?:^|[\\/])dotaios-[^\\/]+[\\/]aios[\\/]skills(?:[\\/]|$)/.test(resolved);
  if (!isDotaiosPath) return false;

  // A temp-looking path is not stale merely because its name looks old. Do
  // not repair a live external skill directory that happens to live in /tmp.
  try {
    await fs.access(resolved);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return true;
  }
}

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

    const resolvedEntryTarget = entry.kind === "symlink"
      ? resolveSymlinkTarget(dest, entry.target)
      : null;
    if (entry.kind === "symlink" && await samePath(resolvedEntryTarget, source)) {
      results.push({ action: "already-linked", path: dest });
      continue;
    }
    if (entry.kind === "missing") {
      if (!dryRun) await fs.symlink(source, dest, symlinkType);
      results.push({ action: dryRun ? "would link" : "linked", path: dest });
      continue;
    }
    if (entry.kind === "symlink" && await isStaleDotaiosTempPath(resolvedEntryTarget)) {
      if (!dryRun) {
        await fs.rm(dest, { recursive: true, force: true });
        await fs.symlink(source, dest, symlinkType);
      }
      results.push({ action: dryRun ? "would repair" : "repaired", path: dest });
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
    const target = resolveSymlinkTarget(dest, info.target);
    const root = path.resolve(skillsRoot);
    const ownsIt = isWithin(root, target);
    if (!ownsIt) continue;                                  // foreign symlink — leave it
    try {
      await fs.access(target);                               // source still exists?
    } catch {
      if (!dryRun) await fs.rm(dest, { force: true });
      removed.push({ action: dryRun ? "would remove" : "removed", path: dest });
    }
  }
  return removed;
}

function resolveSymlinkTarget(entryPath, rawTarget) {
  return path.resolve(path.dirname(entryPath), rawTarget);
}

async function samePath(left, right) {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    const [leftReal, rightReal] = await Promise.all([
      fs.realpath(left),
      fs.realpath(right)
    ]);
    return leftReal === rightReal;
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
