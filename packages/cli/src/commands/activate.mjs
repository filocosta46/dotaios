import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../../../core/src/files.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { MANAGED_END, MANAGED_START } from "../../../core/src/bridges.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const managedStart = MANAGED_START;
const managedEnd = MANAGED_END;

export async function activateCommand(args) {
  if (hasHelpFlag(args)) {
    printActivateHelp();
    return;
  }

  const options = parseOptions(args);
  const aiosPath = resolvePath(options.path || defaultAiosPath());
  const homePath = resolvePath(options.home || os.homedir());
  await ensureAiosFolder(aiosPath);

  const results = [];
  results.push(...await createGlobalBridges(aiosPath, homePath, options));

  if (options.project) {
    results.push(...await createProjectBridges(aiosPath, resolvePath(options.project), options));
  }

  printResults("DotAIOS activated", results);
  if (!options.project) {
    console.log("\nFor Cursor project rules, run `dotaios attach <project-dir>` inside a project.");
  }
}

export async function attachCommand(args) {
  if (hasHelpFlag(args)) {
    printAttachHelp();
    return;
  }

  const options = parseOptions(args);
  const [projectArg] = options.positionals;
  const aiosPath = resolvePath(options.path || defaultAiosPath());
  const projectPath = resolvePath(options.project || projectArg || process.cwd());
  await ensureAiosFolder(aiosPath);

  const results = await createProjectBridges(aiosPath, projectPath, options);
  printResults("DotAIOS attached", results);
}

function parseOptions(args = []) {
  const options = {
    dryRun: false,
    home: null,
    overwrite: false,
    path: null,
    positionals: [],
    project: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printActivateHelp() {
  console.log(`Usage:
  dotaios activate [options]

Options:
  --path <dir>     Use an AIOS folder other than ~/aios
  --home <dir>     Write global agent bridges somewhere other than your home
  --project <dir>  Also attach DotAIOS to a project folder
  --dry-run        Show what would be written without changing files
  --overwrite      Replace existing unmanaged bridge files
`);
}

function printAttachHelp() {
  console.log(`Usage:
  dotaios attach [project-dir] [options]

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --dry-run     Show what would be written without changing files
  --overwrite   Replace existing unmanaged bridge files
`);
}

async function createGlobalBridges(aiosPath, homePath, options) {
  const bridges = await Promise.all([
    writeManagedFile(path.join(homePath, ".claude", "CLAUDE.md"), claudeBridge(aiosPath), options),
    writeManagedFile(path.join(homePath, ".codex", "AGENTS.md"), codexBridge(aiosPath), options),
    writeManagedFile(path.join(homePath, ".gemini", "GEMINI.md"), geminiBridge(aiosPath), options)
  ]);
  const skills = await bridgeSkillsToClaude(aiosPath, homePath, options);
  return [...bridges, ...skills];
}

async function bridgeSkillsToClaude(aiosPath, homePath, options) {
  const aiosSkillsDir = path.join(aiosPath, "skills");
  if (!await pathExists(aiosSkillsDir)) return [];

  const claudeSkillsDir = path.join(homePath, ".claude", "skills");
  if (!options.dryRun) {
    await fs.mkdir(claudeSkillsDir, { recursive: true });
  }

  let entries;
  try {
    entries = await fs.readdir(aiosSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith(".") || name.startsWith("_")) continue;

    const source = path.join(aiosSkillsDir, name);
    const dest = path.join(claudeSkillsDir, name);

    const skillFile = path.join(source, "SKILL.md");
    if (!await pathExists(skillFile)) {
      results.push({ action: "skipped", path: dest, note: "no SKILL.md in source" });
      continue;
    }

    const existsResult = await readSymlinkOrPath(dest);
    if (existsResult.kind === "symlink" && existsResult.target === source) {
      results.push({ action: "skipped", path: dest, note: "already linked to AIOS" });
      continue;
    }
    if (existsResult.kind === "missing") {
      if (!options.dryRun) {
        await fs.symlink(source, dest, "dir");
      }
      results.push({ action: options.dryRun ? "would link" : "linked", path: dest });
      continue;
    }
    if (!options.overwrite) {
      results.push({ action: "kept", path: dest, note: "existing unmanaged file or directory" });
      continue;
    }
    if (!options.dryRun) {
      await fs.rm(dest, { recursive: true, force: true });
      await fs.symlink(source, dest, "dir");
    }
    results.push({ action: options.dryRun ? "would relink" : "relinked", path: dest });
  }
  return results;
}

async function readSymlinkOrPath(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(filePath);
      return { kind: "symlink", target };
    }
    return { kind: "exists" };
  } catch {
    return { kind: "missing" };
  }
}

async function createProjectBridges(aiosPath, projectPath, options) {
  return Promise.all([
    writeManagedFile(path.join(projectPath, "AGENTS.md"), projectAgentsBridge(aiosPath), options),
    writeManagedFile(path.join(projectPath, ".cursor", "rules", "dotaios.mdc"), cursorRule(aiosPath), options)
  ]);
}

async function writeManagedFile(destination, content, { dryRun = false, overwrite = false } = {}) {
  const exists = await pathExists(destination);

  if (!exists) {
    if (!dryRun) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content);
    }
    return { action: dryRun ? "would create" : "created", path: destination };
  }

  const current = await fs.readFile(destination, "utf8");
  const managed = current.includes(managedStart) && current.includes(managedEnd);
  if (!managed && !overwrite) {
    return { action: "kept", path: destination, note: "existing unmanaged file" };
  }

  if (!dryRun) {
    await fs.writeFile(destination, content);
  }

  return { action: dryRun ? "would update" : "updated", path: destination };
}

function claudeBridge(aiosPath) {
  return bridgeFile("DotAIOS Claude Bridge", [
    "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
    "",
    `@${path.join(aiosPath, "CLAUDE.md")}`
  ]);
}

function codexBridge(aiosPath) {
  return bridgeFile("DotAIOS Codex Bridge", [
    "When a task depends on the user's identity, priorities, active work, memory, or writing style, read the DotAIOS entrypoint first.",
    "",
    `DotAIOS entrypoint: ${path.join(aiosPath, "AGENTS.md")}`,
    "",
    "Follow DotAIOS approval rules before durable writes to identity, wiki, CRM, or long-term knowledge."
  ]);
}

function geminiBridge(aiosPath) {
  return bridgeFile("DotAIOS Gemini Bridge", [
    "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
    "",
    `@${path.join(aiosPath, "AGENTS.md")}`
  ]);
}

function projectAgentsBridge(aiosPath) {
  return bridgeFile("DotAIOS Project Bridge", [
    "This project is attached to the user's DotAIOS memory.",
    "",
    `Before personal recommendations or cross-project planning, read: ${path.join(aiosPath, "AGENTS.md")}`,
    "",
    "Keep project-specific instructions in this file short. Durable personal context belongs in DotAIOS."
  ]);
}

function cursorRule(aiosPath) {
  return [
    "---",
    "description: DotAIOS personal context",
    "globs:",
    "alwaysApply: true",
    "---",
    "",
    managedStart,
    "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
    "",
    `@${path.join(aiosPath, "AGENTS.md")}`,
    managedEnd,
    ""
  ].join("\n");
}

function bridgeFile(title, lines) {
  return [
    `# ${title}`,
    "",
    managedStart,
    ...lines,
    managedEnd,
    ""
  ].join("\n");
}

function resolvePath(value) {
  return path.resolve(expandHome(value));
}

function printResults(title, results) {
  console.log(`\n${title}`);
  for (const result of results) {
    const note = result.note ? ` (${result.note})` : "";
    console.log(`[${result.action}] ${result.path}${note}`);
  }
}
