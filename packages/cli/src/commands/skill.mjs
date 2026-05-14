import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { readJson } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { installCommand } from "./install.mjs";

const HELP_TEXT = `Usage:
  dotaios skill <subcommand> [options]

Subcommands:
  add <url-or-path>   Install a skill or plugin into your AIOS folder.
                      Accepts a local folder path or a git/https URL.
  list                Show every skill currently installed.
  remove <name>       Remove a previously installed plugin from your AIOS.

This is the friendly alias for plugin install/uninstall. Skills are reusable
agent workflows. Plugins are skills that ship with code.

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
`;

export async function skillCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const { subcommand, positionals, options } = parseOptions(args);
  if (!subcommand) {
    console.log(HELP_TEXT);
    return;
  }

  if (subcommand === "add") {
    if (positionals.length === 0) {
      throw new Error("Usage: dotaios skill add <url-or-path>");
    }
    const installArgs = [...positionals];
    if (options.path) installArgs.push("--path", options.path);
    await installCommand(installArgs);
    return;
  }

  if (subcommand === "list") {
    await listSkills(options);
    return;
  }

  if (subcommand === "remove" || subcommand === "rm") {
    if (positionals.length === 0) {
      throw new Error("Usage: dotaios skill remove <name>");
    }
    await removeSkill(positionals[0], options);
    return;
  }

  throw new Error(`Unknown skill subcommand: ${subcommand}. Try \`dotaios skill --help\`.`);
}

function parseOptions(args = []) {
  const options = { path: null };
  const positionals = [];
  let subcommand = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (!arg.startsWith("--") && !subcommand) {
      subcommand = arg;
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { subcommand, positionals, options };
}

async function listSkills(options) {
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const registryPath = path.join(target, "skills", "_registry.json");
  const registry = await readJson(registryPath, { skills: [], plugins: [] });

  console.log(`Skills in ${target}/skills/`);
  console.log("");

  const skills = registry.skills || [];
  if (skills.length === 0) {
    console.log("  (no skills yet)");
  } else {
    for (const name of skills) {
      console.log(`  - ${name}`);
    }
  }

  const plugins = registry.plugins || [];
  if (plugins.length > 0) {
    console.log("");
    console.log("Installed plugins:");
    for (const plugin of plugins) {
      console.log(`  - ${plugin.name}@${plugin.version}  (${plugin.path})`);
    }
  }

  console.log("");
  console.log("Add a new skill: `dotaios skill add <url-or-path>`");
}

async function removeSkill(name, options) {
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const registryPath = path.join(target, "skills", "_registry.json");
  const registry = await readJson(registryPath, { skills: [], plugins: [] });
  const plugins = registry.plugins || [];
  const plugin = plugins.find((entry) => entry.name === name);

  if (!plugin) {
    throw new Error(`No installed plugin named "${name}". Run \`dotaios skill list\` to see what is installed.`);
  }

  const pluginDir = path.join(target, plugin.path);
  await fs.rm(pluginDir, { recursive: true, force: true });

  const removedSkillSet = new Set(plugin.skills || []);
  registry.plugins = plugins.filter((entry) => entry.name !== name);
  registry.skills = (registry.skills || []).filter((skill) => !removedSkillSet.has(skill));

  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Removed ${name} from ${pluginDir}.`);
}
