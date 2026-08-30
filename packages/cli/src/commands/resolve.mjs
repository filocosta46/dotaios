import os from "node:os";
import path from "node:path";

import {
  renderIntentResolution,
  resolveIntentResolution
} from "../../../core/src/intent-resolution.mjs";
import { expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios resolve "<intent>" [options]

Resolve one verified primary project folder, bounded project context, governing
skill, optional configured read-only tool, omissions, and approval state. This
command recommends only; it never runs the tool or approves an action.

Options:
  --project <slug-or-id>  Select one exact registered project (otherwise cwd)
  --supports-conventions <kinds>
                           Comma-separated native kinds: agents-md, claude-md,
                           repository-skill
  --tool <capability>     Request one closed, product-owned tool capability
  --query <text>          Bounded Gmail/Drive query for a matching capability
  --message-id <id>       Validated Gmail message id
  --date-window <range>   today, tomorrow, or week
  --page-size <n>         Drive list size from 1 through 100
  --budget <n>            Complete JSON limit from 1024 through 32000 (default 8000)
  --path <dir>            Use a non-default AIOS folder
  --home <dir>            Use a different home for machine-local project state
  --state-path <file>     Override the machine-local project path registry
  --json                  Accepted for callers; JSON is always the default
`;

export async function resolveCommand(args = [], dependencies = {}) {
  const output = dependencies.output || console;
  if (hasHelpFlag(args)) {
    output.log(HELP_TEXT);
    return null;
  }
  const options = parseOptions(args);
  if (options.positionals.length !== 1) {
    throw new Error('Usage: dotaios resolve "<intent>" [options]');
  }
  const homePath = path.resolve(expandHome(options.home || dependencies.homePath || os.homedir()));
  const aiosPath = path.resolve(expandHome(options.path || path.join(homePath, "aios")));
  const tool = buildToolRequest(options);
  const result = await resolveIntentResolution({
    aiosPath,
    homePath,
    statePath: options.statePath
      ? path.resolve(expandHome(options.statePath))
      : dependencies.statePath,
    fs: dependencies.fs,
    cwd: dependencies.cwd || process.cwd(),
    project: options.project,
    intent: options.positionals[0],
    tool,
    supportedConventionKinds: options.supportedConventionKinds,
    visibleCharacterBudget: options.budget
  }, {
    filesystem: dependencies.fs,
    clock: dependencies.clock
  });
  output.log(renderIntentResolution(result));
  if (result.status === "refused") {
    const setExitCode = dependencies.setExitCode || ((code) => { process.exitCode = code; });
    setExitCode(2);
  }
  return result;
}

function parseOptions(args) {
  const options = {
    budget: undefined,
    dateWindow: undefined,
    home: null,
    messageId: undefined,
    pageSize: undefined,
    path: null,
    positionals: [],
    project: null,
    query: undefined,
    statePath: null,
    supportedConventions: null,
    supportedConventionKinds: [],
    tool: null
  };
  const valueOptions = new Map([
    ["--budget", "budget"],
    ["--date-window", "dateWindow"],
    ["--home", "home"],
    ["--message-id", "messageId"],
    ["--page-size", "pageSize"],
    ["--path", "path"],
    ["--project", "project"],
    ["--query", "query"],
    ["--state-path", "statePath"],
    ["--supports-conventions", "supportedConventions"],
    ["--tool", "tool"]
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (seen.has(arg)) throw new Error(`${arg} may only be provided once`);
      seen.add(arg);
      continue;
    }
    const key = valueOptions.get(arg);
    if (key) {
      if (seen.has(arg)) throw new Error(`${arg} may only be provided once`);
      seen.add(arg);
      options[key] = readOptionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown resolve option: ${arg}`);
    options.positionals.push(arg);
  }
  if (options.budget !== undefined && !/^\d+$/.test(options.budget)) {
    throw new Error("--budget must be an integer");
  }
  if (options.pageSize !== undefined && !/^\d+$/.test(options.pageSize)) {
    throw new Error("--page-size must be an integer");
  }
  options.budget = options.budget === undefined ? undefined : Number(options.budget);
  options.pageSize = options.pageSize === undefined ? undefined : Number(options.pageSize);
  options.supportedConventionKinds = parseSupportedConventionKinds(options.supportedConventions);
  return options;
}

function parseSupportedConventionKinds(value) {
  if (value === null) return [];
  const allowed = new Set(["agents-md", "claude-md", "repository-skill"]);
  const kinds = value.split(",");
  if (
    kinds.length === 0
    || kinds.some((kind) => !allowed.has(kind))
    || new Set(kinds).size !== kinds.length
  ) {
    throw new Error("--supports-conventions requires unique supported convention kinds: agents-md, claude-md, repository-skill");
  }
  return kinds;
}

function buildToolRequest(options) {
  const parameterEntries = [
    ["query", options.query],
    ["messageId", options.messageId],
    ["dateWindow", options.dateWindow],
    ["pageSize", options.pageSize]
  ].filter(([, value]) => value !== undefined);
  if (!options.tool) {
    if (parameterEntries.length > 0) throw new Error("Tool parameters require --tool <capability>");
    return null;
  }
  return Object.fromEntries([["capability", options.tool], ...parameterEntries]);
}
