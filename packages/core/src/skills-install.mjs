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

export async function installSymlinkSkills({
  aiosPath,
  sourceDir = null,
  targetDir,
  projectRoot = null,
  dryRun = false,
  overwrite = false
}) {
  if (projectRoot) {
    const safety = await validateProjectPath({ projectRoot, targetPath: targetDir });
    if (!safety.safe) {
      return [{ action: "skipped-unsafe-target", path: targetDir, note: safety.reason }];
    }
  }
  const skillsRoot = resolveSkillsRoot(aiosPath, sourceDir);
  const skills = await collectSkills(path.dirname(skillsRoot)); // [{ dir, name, ... }]
  if (skills.length === 0) return [];
  if (!dryRun) await fs.mkdir(targetDir, { recursive: true });

  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  const results = [];

  for (const skill of skills) {
    const source = path.join(skillsRoot, skill.dir);
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

export async function cleanupStaleLinks({ aiosPath, sourceDir = null, targetDir, projectRoot = null, dryRun = false }) {
  if (projectRoot) {
    const safety = await validateProjectPath({ projectRoot, targetPath: targetDir });
    if (!safety.safe) {
      return [{ action: "skipped-unsafe-target", path: targetDir, note: safety.reason }];
    }
  }
  const skillsRoot = resolveSkillsRoot(aiosPath, sourceDir);
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
    if (path.basename(target) !== entry.name) continue;      // alias ownership is unprovable
    const root = path.resolve(skillsRoot);
    const ownsIt = isWithin(root, target) || await isStaleDotaiosTempPath(target);
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

// Remove only links that point into this AIOS skill tree. This is used for
// migrations when a client has multiple discovery paths and the duplicate
// target would make the client report conflicting skill names. Real entries
// and foreign symlinks are never touched.
export async function removeManagedSkillLinks({ aiosPath, sourceDir = null, targetDir, dryRun = false }) {
  const skillsRoot = resolveSkillsRoot(aiosPath, sourceDir);
  const skills = await collectSkills(path.dirname(skillsRoot));
  const canonicalSources = new Map(
    skills.map((skill) => [skill.dir, path.join(skillsRoot, skill.dir)])
  );
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const root = path.resolve(skillsRoot);
  const removed = [];
  for (const entry of entries) {
    const dest = path.join(targetDir, entry.name);
    const info = await inspectEntry(dest);
    if (info.kind !== "symlink") continue;
    const canonicalSource = canonicalSources.get(entry.name);
    if (!canonicalSource) continue;
    const target = resolveSymlinkTarget(dest, info.target);
    if (!isWithin(root, target) || !(await samePath(target, canonicalSource))) continue;
    if (!dryRun) await fs.rm(dest, { recursive: true, force: true });
    removed.push({ action: dryRun ? "would-remove" : "removed", path: dest });
  }
  return removed;
}

// A managed alias is different from a canonical link: its basename is the
// skill's frontmatter name, while its target is the skill directory. The
// frontmatter name is the only durable ownership signal for this shape. Keep
// ambiguous names out of the result so a foreign link can never be removed by
// accident.
export async function findManagedSkillAliases({ aiosPath, sourceDir = null, targetDir, skills = null }) {
  const skillsRoot = resolveSkillsRoot(aiosPath, sourceDir);
  const sourceSkills = skills || await collectSkills(path.dirname(skillsRoot));
  const aliasesByName = new Map();
  for (const skill of sourceSkills) {
    if (!skill.name || skill.name === skill.dir) continue;
    if (aliasesByName.has(skill.name)) {
      aliasesByName.set(skill.name, null);
      continue;
    }
    aliasesByName.set(skill.name, skill);
  }

  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const aliases = [];
  for (const entry of entries) {
    const skill = aliasesByName.get(entry.name);
    if (!skill || !entry.isSymbolicLink()) continue;

    const destination = path.join(targetDir, entry.name);
    const rawTarget = await fs.readlink(destination);
    const resolvedTarget = resolveSymlinkTarget(destination, rawTarget);
    const source = path.join(skillsRoot, skill.dir);
    if (!(await samePath(resolvedTarget, source))) continue;

    aliases.push({
      alias: entry.name,
      canonical: skill.dir,
      path: destination,
      target: rawTarget
    });
  }
  return aliases.sort((left, right) => left.alias.localeCompare(right.alias));
}

// Remove only aliases whose ownership is proven by the canonical skill's
// frontmatter name and exact target. This is deliberately opt-in at the CLI
// layer because an alias may be intentional for a foreign client.
export async function removeManagedSkillAliases({ aiosPath, sourceDir = null, targetDir, dryRun = false }) {
  const aliases = await findManagedSkillAliases({ aiosPath, sourceDir, targetDir });
  const removed = [];
  for (const alias of aliases) {
    if (!dryRun) await fs.rm(alias.path, { recursive: true, force: true });
    removed.push({
      action: dryRun ? "would-remove" : "removed",
      ...alias
    });
  }
  return removed;
}

function resolveSymlinkTarget(entryPath, rawTarget) {
  return path.resolve(path.dirname(entryPath), rawTarget);
}

function resolveSkillsRoot(aiosPath, sourceDir) {
  return path.resolve(sourceDir || path.join(aiosPath, "skills"));
}

export async function validateProjectPath({ projectRoot, targetPath }) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  if (!isWithin(root, target)) {
    return { safe: false, reason: "target escapes project root" };
  }

  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        return { safe: false, reason: "target path contains an unmanaged symlink" };
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { safe: true };
      throw error;
    }
  }
  return { safe: true };
}

// A project-owned source must live inside the project itself. Unlike a target
// path, the source root is allowed to be absent, but an existing symlink would
// let attach propagate skills from outside the checkout and mislabel them as
// project-owned.
export async function validateProjectSourcePath({ projectRoot, sourcePath }) {
  const root = path.resolve(projectRoot);
  const source = path.resolve(sourcePath);
  if (!isWithin(root, source)) {
    return { safe: false, reason: "source path escapes project root" };
  }
  try {
    if ((await fs.lstat(source)).isSymbolicLink()) {
      return { safe: false, reason: "project skills source is an unmanaged symlink" };
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  return { safe: true };
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
