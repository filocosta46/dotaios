import fs from "node:fs/promises";
import path from "node:path";
import { validateManifest, summarizePermissions } from "../../../core/src/manifest.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { readJson, pathExists } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

export async function installCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(`Usage:
  dotaios install <plugin-path> [options]

Options:
  --path <dir>  Install into an AIOS folder other than ~/aios
  --dry-run     Validate and display permissions without copying files
`);
    return;
  }

  const options = parseOptions(args);
  const [pluginPath] = options.positionals;

  if (!pluginPath) {
    throw new Error("Usage: dotaios install <plugin-path> [--path <aios-dir>] [--dry-run]");
  }

  if (/^[a-z]+:\/\//i.test(pluginPath)) {
    throw new Error("Remote plugin installs are not supported in v1.1. Download and review the plugin locally first.");
  }

  const sourcePath = path.resolve(pluginPath);
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
    if (options.dryRun) {
      console.log("\nDry run only. Would copy raw skill directory. No permissions required.");
      return;
    }
    const target = path.resolve(expandHome(options.path || defaultAiosPath()));
    await ensureAiosFolder(target);
    await installRawSkill(sourcePath, target, skillName);
    console.log(`\nInstalled skill '${skillName}' into ${path.join(target, "skills", skillName)}`);
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
  console.log(`\nInstalled ${manifest.name}@${manifest.version} into ${path.join(target, "plugins", manifest.name)}`);
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

function parseOptions(args = []) {
  const options = { dryRun: false, path: null, positionals: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
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
  try {
    try {
      await fs.rename(pluginTarget, backupTarget);
      hasBackup = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await fs.rename(tempTarget, pluginTarget);
    await updateSkillRegistry(target, manifest);

    if (hasBackup) {
      await fs.rm(backupTarget, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(tempTarget, { recursive: true, force: true });
    if (hasBackup) {
      await fs.rm(pluginTarget, { recursive: true, force: true });
      await fs.rename(backupTarget, pluginTarget);
    }
    throw error;
  }
}

async function copyDirectory(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });

  for (const entry of entries) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, destinationEntry);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Plugin contains unsupported symlink: ${sourceEntry}`);
    } else {
      await fs.copyFile(sourceEntry, destinationEntry);
    }
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

