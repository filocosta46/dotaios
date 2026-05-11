import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathExists, readJson, writeFileSafe } from "../../../core/src/files.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { planTemplateTree } from "../../../core/src/render.mjs";
import { confirmWrites } from "../../../core/src/review.mjs";
import { readBullet, readSection } from "../../../core/src/sections.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const primaryContextFiles = ["identity.md", "work.md", "priorities.md", "north-star.md"];

export async function contextCommand(args) {
  if (hasHelpFlag(args)) {
    printContextHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  if (options.refresh) {
    const results = await refreshAgentEntrypoints(target, options);
    if (results === null) {
      console.log("Cancelled. No files written.");
      return;
    }
    printRefreshResults(results);
    return;
  }

  const [name] = options.positionals;
  if (!name) {
    await printContextSummary(target);
    return;
  }

  const filePath = resolveContextFile(target, name);
  if (!await pathExists(filePath)) {
    throw new Error(`No context file found at ${filePath}`);
  }

  if (options.edit) {
    openEditor(filePath);
    return;
  }

  console.log(await fs.readFile(filePath, "utf8"));
}

function parseOptions(args = []) {
  const options = { edit: false, path: null, positionals: [], refresh: false, review: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--edit") {
      options.edit = true;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--review") {
      options.review = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printContextHelp() {
  console.log(`Usage:
  dotaios context [name] [options]

Examples:
  dotaios context
  dotaios context identity
  dotaios context work --edit
  dotaios context --refresh

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --edit        Open the selected context file in $EDITOR
  --refresh     Regenerate CLAUDE.md, AGENTS.md, and .cursorrules
  --review      Show a diff and confirm before writing (use with --refresh).
                Honors DOTAIOS_AUTO_APPROVE=1 for non-interactive runs.
`);
}

async function printContextSummary(target) {
  const files = await listContextFiles(target);
  console.log(`DotAIOS context for ${target}`);
  console.log("\nFile              Status     Modified     Preview");

  for (const relative of files) {
    const filePath = path.join(target, "context", relative);
    const exists = await pathExists(filePath);
    if (!exists) {
      console.log(`${pad(relative, 17)} missing    -            -`);
      continue;
    }

    const stat = await fs.stat(filePath);
    const preview = await readPreview(filePath);
    console.log(`${pad(relative, 17)} ok         ${stat.mtime.toISOString().slice(0, 10)}   ${preview}`);
  }
}

async function listContextFiles(target) {
  const domainsPath = path.join(target, "context", "domains");
  const domains = await listDomainFiles(domainsPath);
  return [...primaryContextFiles, ...domains.map((file) => path.join("domains", file))];
}

async function listDomainFiles(domainsPath) {
  try {
    const entries = await fs.readdir(domainsPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function readPreview(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const line = content
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#"));
  return truncate(line || "-", 72);
}

async function refreshAgentEntrypoints(target, options) {
  const data = await readTemplateData(target);
  const templateRoot = path.join(repoRoot, "templates");
  const plan = await planTemplateTree(templateRoot, target, data, {
    include: (outputRelative) => ["CLAUDE.md", "AGENTS.md", ".cursorrules"].includes(outputRelative)
  });

  if (options.review) {
    const ok = await confirmWrites(plan, { autoApprove: process.env.DOTAIOS_AUTO_APPROVE === "1" });
    if (!ok) return null;
  }

  return Promise.all(plan.map((item) => writeFileSafe(item.path, item.content, "overwrite")));
}

async function readTemplateData(target) {
  const [config, identity, work, priorities] = await Promise.all([
    readJson(path.join(target, "aios.json"), {}),
    readText(path.join(target, "context", "identity.md")),
    readText(path.join(target, "context", "work.md")),
    readText(path.join(target, "context", "priorities.md"))
  ]);

  return {
    created_at: config.created_at || new Date().toISOString(),
    ai_tools: config.ai_tools || [],
    vault_path: config.vault_path || null,
    user_name: readBullet(identity, "Name") || "Your Name",
    user_role: readBullet(identity, "Role") || "student / operator / builder",
    current_work: readSection(work, "Current Work") || "Add the active work threads agents should keep in mind.",
    priorities: readSection(priorities, "Current Bets") || "Add the current bets and near-term priorities."
  };
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function resolveContextFile(target, name) {
  const alias = {
    identity: "identity.md",
    work: "work.md",
    priorities: "priorities.md",
    "north-star": "north-star.md"
  }[name] || name;
  const relative = alias.endsWith(".md") ? alias : `${alias}.md`;

  if (path.isAbsolute(relative) || relative.includes("..") || !/^[a-z0-9-]+(\/[a-z0-9-]+)*\.md$/.test(relative)) {
    throw new Error(`Invalid context name: ${name}`);
  }

  return path.join(target, "context", relative);
}

function openEditor(filePath) {
  const editor = process.env.EDITOR || "vi";
  const result = spawnSync(editor, [filePath], { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Could not open editor ${editor}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${editor} exited with status ${result.status}`);
  }
}

function printRefreshResults(results) {
  console.log("Regenerated agent entrypoints");
  for (const result of results) {
    console.log(`[${result.action}] ${result.path}`);
  }
}

function pad(value, size) {
  return value.padEnd(size, " ");
}

function truncate(value, size) {
  return value.length > size ? `${value.slice(0, size - 3)}...` : value;
}
