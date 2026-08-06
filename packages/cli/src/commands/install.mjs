import fs from "node:fs/promises";
import path from "node:path";
import { summarizePermissions, validateManifest } from "../../../core/src/manifest.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { pathExists, readJson } from "../../../core/src/files.mjs";
import { writeSkillsIndex } from "../../../core/src/skills.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { activateCommand } from "./activate.mjs";

export async function installCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(`Usage:
  dotaios install <local-plugin-path> [options]

Accepts:
  - A local folder containing manifest.json (plugin) or SKILL.md (raw skill).

Remote URLs are refused. Download or clone a source yourself, inspect it, then
pass the reviewed local folder to this command.

Options:
  --path <dir>     Install into an AIOS folder other than ~/aios
  --home <dir>     Write native agent bridges and skills under this home directory
  --dry-run        Validate and display permissions without copying files
  --subdir <path>  Install from this subdirectory of the local source
`);
    return;
  }

  const options = parseOptions(args);
  const [pluginPath] = options.positionals;

  if (!pluginPath) {
    throw new Error("Usage: dotaios install <local-plugin-path> [--path <aios-dir>] [--home <home-dir>] [--dry-run]");
  }

  assertLocalInstallSource(pluginPath);

  // Keep a local subdirectory selection inside the reviewed source directory.
  assertSafeSubdir(options.subdir);

  const sourcePath = options.subdir
    ? path.join(path.resolve(pluginPath), options.subdir)
    : path.resolve(pluginPath);
  await runInstall(sourcePath, options);
}

async function runInstall(sourcePath, options) {
  await ensureDirectory(sourcePath, "Plugin path");
  const manifestPath = path.join(sourcePath, "manifest.json");
  
  let manifest;
  let isRawSkill = false;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    if (error.message.includes("No manifest.json found")) {
      const skillFile = path.join(sourcePath, "SKILL.md");
      if (await pathExists(skillFile)) {
        isRawSkill = true;
      } else {
        throw new Error(`Directory ${sourcePath} is neither a Plugin (missing manifest.json) nor a Raw Skill (missing SKILL.md).`);
      }
    } else {
      throw error;
    }
  }

  if (isRawSkill) {
    const skillName = path.basename(sourcePath);
    console.log(`Valid Raw Skill detected: ${skillName}`);
    const target = path.resolve(expandHome(options.path || defaultAiosPath()));
    // A skill is a set of instructions the agent will follow. Letting an
    // install quietly replace an existing one — say, a repo whose folder is
    // named `ingest` — hands a stranger the behaviour of a trusted skill. The
    // plugin path already refuses this; the raw path used to rm -rf the target.
    const collision = await pathEntryExists(path.join(target, "skills", skillName));
    if (options.dryRun) {
      console.log(collision
        ? `\nDry run only. WOULD REPLACE the existing skill "${skillName}" at ${path.join(target, "skills", skillName)}.`
        : "\nDry run only. Would copy raw skill directory. No permissions required.");
      return;
    }
    if (collision) {
      throw new Error(
        `Skill "${skillName}" already exists at ${path.join(target, "skills", skillName)}.\n` +
        "Remove or rename the existing skill first. Installing over it would replace instructions your agents already follow."
      );
    }
    await ensureAiosFolder(target);
    await installRawSkill(sourcePath, target, skillName);
    await writeSkillsIndex(target);
    console.log(`\nInstalled skill '${skillName}' into ${path.join(target, "skills", skillName)}`);
    console.log("Refreshed skills/INDEX.md for supported local clients.");
    const activationArgs = ["--path", target];
    if (options.home) activationArgs.push("--home", options.home);
    await activateCommand(activationArgs);
    return;
  }

  const result = validateManifest(manifest);

  if (!result.valid) {
    throw new Error(`Invalid manifest:\n- ${result.errors.join("\n- ")}`);
  }

  printManifestSummary(manifest);

  if (options.dryRun) {
    console.log("\nDry run only. Nothing copied.");
    return;
  }

  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);
  await installPlugin(sourcePath, target, manifest);
  const activationArgs = ["--path", target];
  if (options.home) activationArgs.push("--home", options.home);
  await activateCommand(activationArgs);
  console.log(`\nInstalled ${manifest.name}@${manifest.version} into ${path.join(target, "plugins", manifest.name)}`);
}

export function assertLocalInstallSource(input) {
  if (typeof input !== "string") return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith("git@")) {
    throw new Error(
      "Remote plugin sources are not executed directly. Download or clone it yourself, " +
      "inspect the source and revision, then pass the reviewed local folder to `dotaios install`."
    );
  }
}

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No manifest.json found at ${manifestPath}`);
    }
    throw new Error(`Could not read plugin manifest: ${error.message}`);
  }
}

// Reject a --subdir that is absolute or contains ".." segments so the install
// cannot escape the reviewed local source directory.
export function assertSafeSubdir(subdir) {
  if (subdir == null) return;
  if (path.isAbsolute(subdir)) {
    throw new Error(`--subdir must be a relative path inside the source, got: ${subdir}`);
  }
  if (subdir.split(/[\\/]+/).includes("..")) {
    throw new Error(`--subdir may not contain ".." path segments: ${subdir}`);
  }
}

function parseOptions(args = []) {
  const options = { dryRun: false, home: null, path: null, subdir: null, positionals: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--subdir") {
      options.subdir = readOptionValue(args, index, "--subdir");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printManifestSummary(manifest) {
  const permissions = summarizePermissions(manifest);

  console.log(`Plugin manifest is valid: ${manifest.name}@${manifest.version}`);
  console.log(manifest.description);
  console.log("\nDeclared permissions:");
  console.log(`- read: ${formatList(permissions.read)}`);
  console.log(`- write: ${formatList(permissions.write)}`);
  console.log(`- write with approval: ${formatList(permissions.write_with_approval)}`);
  console.log(`- connections: ${formatList(permissions.connections)}`);
}

function formatList(items) {
  return items.length > 0 ? items.join(", ") : "none";
}

async function installPlugin(sourcePath, target, manifest) {
  const pluginsDir = path.join(target, "plugins");
  const pluginTarget = path.join(pluginsDir, manifest.name);
  const tempTarget = path.join(pluginsDir, `.${manifest.name}.tmp-${process.pid}-${Date.now()}`);
  const backupTarget = path.join(pluginsDir, `.${manifest.name}.backup-${process.pid}-${Date.now()}`);

  await fs.mkdir(pluginsDir, { recursive: true });
  await copyDirectory(sourcePath, tempTarget);

  let hasBackup = false;
  let exposedSkills = [];
  try {
    try {
      await fs.rename(pluginTarget, backupTarget);
      hasBackup = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await fs.rename(tempTarget, pluginTarget);
    exposedSkills = await exposePluginSkills(pluginTarget, target, manifest);
    await updateSkillRegistry(target, manifest);
    await writeSkillsIndex(target);

    if (hasBackup) {
      await fs.rm(backupTarget, { recursive: true, force: true });
    }
  } catch (error) {
    for (const skillPath of exposedSkills) {
      await fs.rm(skillPath, { recursive: true, force: true });
    }
    await fs.rm(tempTarget, { recursive: true, force: true });
    if (hasBackup) {
      await fs.rm(pluginTarget, { recursive: true, force: true });
      await fs.rename(backupTarget, pluginTarget);
    }
    throw error;
  }
}

async function copyDirectory(source, destination) {
  return copyDirectoryWithOptions(source, destination);
}

async function copyDirectoryWithOptions(source, destination, { excludeNames = new Set() } = {}) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });

  for (const entry of entries) {
    if (excludeNames.has(entry.name)) continue;
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryWithOptions(sourceEntry, destinationEntry, { excludeNames });
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Plugin contains unsupported symlink: ${sourceEntry}`);
    } else {
      await fs.copyFile(sourceEntry, destinationEntry);
    }
  }
}

async function exposePluginSkills(pluginTarget, target, manifest) {
  const providedSkills = manifest.provides?.skills || [];
  const exposedSkills = [];
  try {
    for (const skillName of providedSkills) {
      assertSafeSkillName(skillName);
      const skillSource = await findPluginSkillSource(pluginTarget, skillName, providedSkills.length);
      const skillTarget = path.join(target, "skills", skillName);
      if (await pathEntryExists(skillTarget)) {
        throw new Error(`Plugin skill "${skillName}" already exists at ${skillTarget}; remove the existing skill before installing this plugin.`);
      }
      await copyDirectoryWithOptions(skillSource, skillTarget, { excludeNames: new Set(["manifest.json"]) });
      exposedSkills.push(skillTarget);
    }
  } catch (error) {
    for (const skillPath of exposedSkills) {
      await fs.rm(skillPath, { recursive: true, force: true });
    }
    throw error;
  }
  return exposedSkills;
}

async function findPluginSkillSource(pluginTarget, skillName, providedCount) {
  const candidates = [
    path.join(pluginTarget, "skills", skillName),
    path.join(pluginTarget, skillName)
  ];
  if (providedCount === 1) candidates.push(pluginTarget);

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new Error(`Plugin declares skill "${skillName}" but no SKILL.md was found in ${candidates.join(" or ")}.`);
}

function assertSafeSkillName(skillName) {
  if (typeof skillName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skillName)) {
    throw new Error(`Plugin skill name is unsafe: ${String(skillName)}`);
  }
}

async function pathEntryExists(value) {
  try {
    await fs.lstat(value);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(directoryPath, label) {
  try {
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      throw new Error(`${label} is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${directoryPath}`);
    }
    throw error;
  }
}

async function updateSkillRegistry(target, manifest) {
  const registryPath = path.join(target, "skills", "_registry.json");
  const registry = await readJson(registryPath, { skills: [], plugins: [] });
  const providedSkills = manifest.provides?.skills || [];

  registry.skills = Array.from(new Set([...(registry.skills || []), ...providedSkills])).sort();
  registry.plugins = [
    ...(registry.plugins || []).filter((plugin) => plugin.name !== manifest.name),
    {
      name: manifest.name,
      version: manifest.version,
      path: `plugins/${manifest.name}`,
      skills: providedSkills
    }
  ].sort((a, b) => a.name.localeCompare(b.name));

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function installRawSkill(sourcePath, target, skillName) {
  const skillsDir = path.join(target, "skills");
  const skillTarget = path.join(skillsDir, skillName);
  
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.rm(skillTarget, { recursive: true, force: true });
  await copyDirectory(sourcePath, skillTarget);
  
  const registryPath = path.join(target, "skills", "_registry.json");
  const registry = await readJson(registryPath, { skills: [], plugins: [] });
  registry.skills = Array.from(new Set([...(registry.skills || []), skillName])).sort();
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}
