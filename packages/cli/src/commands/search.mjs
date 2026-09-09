import path from "node:path";
import { followSourceEvidence } from "../../../core/src/source-evidence.mjs";
import { renderSourceEvidence } from "../../../core/src/source-reference.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { createEvidenceReader } from "../../../core/src/evidence-reader.mjs";
import { resolveMemoryPolicy } from "../../../core/src/memory-policy.mjs";
import { markMatches, SEARCH_SCOPES, searchAios } from "../../../core/src/search.mjs";
import { validateProjectSelector } from "../../../core/src/projects.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const validScopes = new Set(SEARCH_SCOPES);
const MAX_SEARCH_CONFIG_BYTES = 1024 * 1024;

export async function searchCommand(args) {
  if (hasHelpFlag(args)) {
    printSearchHelp();
    return;
  }

  const options = parseOptions(args);
  const query = options.positionals.join(" ");
  if (options.follow !== null) {
    if (query || options.queryFilters) throw new Error("--follow cannot be combined with query text, scope, limit, or session filters.");
    const result = await followSourceEvidence({
      aiosPath: path.resolve(expandHome(options.path || defaultAiosPath())),
      memory: options.memory, project: options.projectSelector,
      follow: options.follow, budget: options.budget ?? undefined
    });
    // The exact JSON envelope is also the bounded text representation. This
    // preserves range/reference accounting for both human and machine callers.
    console.log(JSON.stringify(result));
    if (result.status === "refused") process.exitCode = 2;
    return;
  }
  if (options.budget !== null || options.json) throw new Error("--budget and --json are supported with --follow only.");

  if (!query) {
    throw new Error("Usage: dotaios search <query> [--scope memory|vault|context|sessions|skills|references|plugins|all]");
  }

  const scope = options.scope || "all";
  const limit = options.limit;
  validateScope(scope);
  validateLimit(limit);
  const memoryPolicy = resolveMemoryPolicy({
    mode: options.memory,
    project: options.projectSelector
  });
  if (memoryPolicy.mode === "off") {
    const groups = await searchAios({ query, scope, memoryPolicy });
    printMemoryReceipt(groups);
    console.log("No results found.");
    return;
  }
  console.log(memoryPolicy.receipt);
  if (scope === "projects" && !memoryPolicy.projectSelector) validateProjectSelector(null);
  if (memoryPolicy.projectSelector) validateProjectSelector(memoryPolicy.projectSelector);

  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  let reader = createEvidenceReader({ roots: [target] });
  const config = await reader.readJson(target, path.join(target, "aios.json"), {
    invalidCode: "DOTAIOS_EVIDENCE_CONFIG_INVALID",
    maxBytes: MAX_SEARCH_CONFIG_BYTES
  });
  const vaultPath = resolveVaultPath(config, target);
  reader = reader.withAuthorizedRoots([vaultPath]);
  console.log(`Searching for "${query}" in ${scope}...\n`);

  const sessionFilters = {};
  if (options.agent) sessionFilters.agent = options.agent;
  if (options.sessionProject) sessionFilters.project = options.sessionProject;
  if (options.since) sessionFilters.since = options.since;

  let totalResults = 0;
  const groups = await searchAios({
    aiosPath: target,
    vaultPath,
    query,
    scope,
    limit,
    projectSelector: memoryPolicy.projectSelector,
    memoryPolicy,
    sessionFilters,
    evidenceReader: reader
  });
  if (groups.scope.projects_omitted) {
    console.log("Project corpus omitted because no --project selector was supplied.\n");
  }
  for (const group of groups) {
    if (group.results.length === 0) continue;
    printGroup(group.scope, group.results, query);
    totalResults += group.results.length;
  }

  const omittedScopes = [...new Set(groups.omissions.map((omission) => omission.scope))];
  const incompleteSuffix = omittedScopes.length > 0
    ? ` Search incomplete; omitted scope(s): ${omittedScopes.join(", ")}.`
    : "";
  if (totalResults === 0) {
    console.log(`${groups.omissions.length > 0 ? "No results found in inspected sources." : "No results found."}${incompleteSuffix}`);
  } else {
    console.log(`${totalResults} result(s) found.${incompleteSuffix}`);
  }
  if (groups.omissions.length > 0) {
    for (const omission of groups.omissions) {
      console.error(
        `Search incomplete for ${omission.scope}: ${omission.recovery.message} `
        + `(reason: ${omission.reason})`
      );
    }
    process.exitCode = 2;
  }
}

function parseOptions(args = []) {
  const options = {
    limit: 20,
    follow: null,
    budget: null,
    json: false,
    queryFilters: false,
    path: null,
    positionals: [],
    scope: null,
    agent: null,
    projectSelector: null,
    sessionProject: null,
    memory: null,
    since: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--scope", "--limit", "--agent", "--session-project", "--since"].includes(arg)) options.queryFilters = true;
    if (arg === "--follow") {
      options.follow = readOptionValue(args, index, "--follow");
      index++;
    } else if (arg === "--budget") {
      const value = readOptionValue(args, index, "--budget");
      if (!/^\d+$/.test(value)) throw new Error("--budget must be a whole number.");
      options.budget = Number(value);
      index++;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--scope") {
      options.scope = readOptionValue(args, index, "--scope");
      index += 1;
    } else if (arg === "--limit") {
      const value = readOptionValue(args, index, "--limit");
      options.limit = parseLimit(value);
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--agent") {
      options.agent = readOptionValue(args, index, "--agent");
      index += 1;
    } else if (arg === "--project") {
      options.projectSelector = readOptionValue(args, index, "--project");
      index += 1;
    } else if (arg === "--memory") {
      options.memory = readOptionValue(args, index, "--memory");
      index += 1;
    } else if (arg === "--session-project") {
      options.sessionProject = readOptionValue(args, index, "--session-project");
      index += 1;
    } else if (arg === "--since") {
      options.since = readOptionValue(args, index, "--since");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function parseLimit(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid --limit "${value}". Use a positive whole number.`);
  }
  return Number(value);
}

function validateScope(scope) {
  if (!validScopes.has(scope)) {
    throw new Error(`Invalid --scope "${scope}". Use one of: memory, vault, context, skills, references, plugins, all.`);
  }
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid --limit "${limit}". Use a positive whole number.`);
  }
}

function printSearchHelp() {
  console.log(`Usage:
  dotaios search <query> [options]

Searches across your AIOS sessions, memory, vault, context, projects, skills, references, and plugins.

Examples:
  dotaios search "job application"
  dotaios search "session memory" --scope sessions
  dotaios search onomondo --scope vault
  dotaios search thesis --scope memory --limit 5
  dotaios search "launch timing" --agent claude-code --since 7d

Options:
  --follow <ref>   Read the exact source version from a brief/search Follow value.
                   Start here when an excerpt omits task-relevant constraints; repeat next until covered.
                   Cannot combine with query text, scope, limit or session filters.
  --budget <n>     Whole follow-response character budget (3530–32000; default 6000)
  --json           Explicit structured follow output (follow always returns bounded JSON)
  --scope <s>      Limit search: sessions, memory, vault, context, skills, references, plugins, or all (default: all)
  --agent <name>   Filter sessions by agent (e.g. claude-code, manual)
  --memory <mode>  Use shared, project, or off memory (default: shared)
  --project <id>   Select the portable project corpus by slug or stable id
  --session-project <name>
                   Filter sessions by arbitrary project tag
  --since <n>d     Filter sessions by age (e.g. 7d, 30d, 2w)
  --limit <n>      Max results per scope (default: 20)
  --path <dir>     Use an AIOS folder other than ~/aios

Use --project to select a portable project corpus; use --session-project only to filter session tags.
`);
}

function printMemoryReceipt(groups) {
  console.log(groups.receipt);
  if (groups.notice) console.log(groups.notice);
}

function printGroup(scope, results, query) {
  console.log(`── ${scope}/ (${results.length} match${results.length > 1 ? "es" : ""}) ──`);
  for (const result of results) {
    if (scope === "memory") {
      // The memory scope mixes JSONL entries with Markdown notes from
      // memory/daily and memory/inbox. Line-level matches mean it is a note.
      if (Array.isArray(result.matches)) printMarkdownResult(result, query);
      else printMemoryResult(result, query);
    } else if (scope === "sessions") {
      printSessionResult(result, query);
    } else {
      printMarkdownResult(result, query);
    }
  }
  console.log();
}

function printMemoryResult(result, query) {
  const summary = result.summary || result.type || JSON.stringify(result).slice(0, 100);
  const metadata = [result.project, result.domain].filter(Boolean).join(" / ");
  const suffix = metadata ? ` (${metadata})` : "";
  console.log(`  [${result.ts?.slice(0, 10) || "?"}] ${result.type || "?"}${suffix} — ${markMatches(truncate(summary, 100), query)}`);
  if (result.matchedField) {
    console.log(`    match: ${result.matchedField} = ${markMatches(truncate(result.matchedSnippet, 100), query)}`);
  }
  console.log(`    source: ${result.source}`);
}

function printSessionResult(result, query) {
  const project = result.project ? `  [${result.project}]` : "";
  console.log(`  [${result.date || "?"}] ${result.agent || "manual"}${project}  ${result.session_id || ""}`);
  console.log(`    ${markMatches(truncate(result.title, 80), query)}`);
  for (const match of result.matches) {
    if (match.content) {
      console.log(`    ${markMatches(truncate(match.content, 140), query)}`);
    }
  }
}

function printMarkdownResult(result, query) {
  for (const line of renderSourceEvidence(result.evidence)) console.log(`  ${line}`);
  console.log(`  ${result.title} (${result.file})`);
  for (const match of result.matches) {
    const lineLabel = match.lineEnd && match.lineEnd !== match.line ? `L${match.line}-${match.lineEnd}` : `L${match.line}`;
    console.log(`    ${lineLabel}: ${markMatches(truncate(match.content, 140), query)}`);
  }
}

function truncate(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
