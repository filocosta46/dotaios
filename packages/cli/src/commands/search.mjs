import path from "node:path";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { pathExists, readJson } from "../../../core/src/files.mjs";
import { searchMemory, searchVault, searchContext } from "../../../core/src/memory.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

export async function searchCommand(args) {
  if (hasHelpFlag(args)) {
    printSearchHelp();
    return;
  }

  const options = parseOptions(args);
  const query = options.positionals.join(" ");

  if (!query) {
    throw new Error("Usage: dotaios search <query> [--scope memory|vault|context|all]");
  }

  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const config = await readJson(path.join(target, "aios.json"), {});
  const vaultPath = resolveVaultPath(config, target);
  const scope = options.scope || "all";
  const limit = options.limit;

  console.log(`Searching for "${query}" in ${scope}...\n`);

  let totalResults = 0;

  // Search context
  if (scope === "all" || scope === "context") {
    const contextDir = path.join(target, "context");
    const results = await searchContext(contextDir, query, { limit });
    if (results.length > 0) {
      console.log(`── context/ (${results.length} match${results.length > 1 ? "es" : ""}) ──`);
      for (const result of results) {
        console.log(`  ${result.file}`);
        for (const match of result.matches) {
          console.log(`    L${match.line}: ${truncate(match.content, 100)}`);
        }
      }
      console.log();
      totalResults += results.length;
    }
  }

  // Search memory
  if (scope === "all" || scope === "memory") {
    const memoryDir = path.join(target, "memory");
    const results = await searchMemory(memoryDir, query, { limit });
    if (results.length > 0) {
      console.log(`── memory/ (${results.length} match${results.length > 1 ? "es" : ""}) ──`);
      for (const result of results) {
        const { source, ...entry } = result;
        const summary = entry.summary || entry.type || JSON.stringify(entry).slice(0, 100);
        console.log(`  [${entry.ts?.slice(0, 10) || "?"}] ${entry.type || "?"} — ${truncate(summary, 80)}`);
        console.log(`    source: ${source}`);
      }
      console.log();
      totalResults += results.length;
    }
  }

  // Search vault
  if (scope === "all" || scope === "vault") {
    const results = await searchVault(vaultPath, query, { limit });
    if (results.length > 0) {
      console.log(`── vault/ (${results.length} match${results.length > 1 ? "es" : ""}) ──`);
      for (const result of results) {
        console.log(`  ${result.title} (${result.file})`);
        for (const match of result.matches) {
          console.log(`    L${match.line}: ${truncate(match.content, 100)}`);
        }
      }
      console.log();
      totalResults += results.length;
    }
  }

  // Search projects
  if (scope === "all") {
    const projectsDir = path.join(target, "projects");
    const results = await searchVault(projectsDir, query, { limit });
    if (results.length > 0) {
      console.log(`── projects/ (${results.length} match${results.length > 1 ? "es" : ""}) ──`);
      for (const result of results) {
        console.log(`  ${result.title} (${result.file})`);
        for (const match of result.matches) {
          console.log(`    L${match.line}: ${truncate(match.content, 100)}`);
        }
      }
      console.log();
      totalResults += results.length;
    }
  }

  if (totalResults === 0) {
    console.log("No results found.");
  } else {
    console.log(`${totalResults} result(s) found.`);
  }
}

function parseOptions(args = []) {
  const options = { limit: 20, path: null, positionals: [], scope: null };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scope") {
      options.scope = readOptionValue(args, index, "--scope");
      index += 1;
    } else if (arg === "--limit") {
      options.limit = parseInt(readOptionValue(args, index, "--limit"), 10);
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printSearchHelp() {
  console.log(`Usage:
  dotaios search <query> [options]

Searches across your AIOS memory, vault, context, and projects for a keyword.

Examples:
  dotaios search "job application"
  dotaios search onomondo --scope vault
  dotaios search thesis --scope memory --limit 5

Options:
  --scope <s>   Limit search: memory, vault, context, or all (default: all)
  --limit <n>   Max results per scope (default: 20)
  --path <dir>  Use an AIOS folder other than ~/.aios
`);
}

async function ensureAiosFolder(target) {
  if (!await pathExists(path.join(target, "aios.json"))) {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
}

function truncate(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
