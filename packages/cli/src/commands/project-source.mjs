import os from "node:os";
import path from "node:path";

import {
  addProjectSource,
  bindProjectSource,
  grantProjectSource,
  retrieveProjectSource
} from "../../../core/src/project-sources.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios project source add <project> <folder> --source-id <id> --label <label> --purpose <purpose>
  dotaios project source bind <project> <source-id> <folder>
  dotaios project source grant <project> <source-id> --purpose <purpose> --expires-at <UTC>
  dotaios project source retrieve [project] --task <text>

Source add, bind, and grant preview by default. Apply an exact preview with:
  --operation-id <id> --plan-fingerprint <sha256> --apply

Common options:
  --path <dir>       Use an AIOS folder other than ~/aios
  --home <dir>       Use a different home for machine-local source state
  --json             Print structured JSON
`;

export async function projectSourceCommand(args = [], dependencies = {}) {
  const output = dependencies.output || console;
  if (hasHelpFlag(args)) {
    output.log(HELP_TEXT);
    return;
  }
  const parsed = parseOptions(args);
  const homePath = resolveUserPath(parsed.home || dependencies.homePath || os.homedir(), os.homedir());
  const common = {
    aiosPath: resolveUserPath(parsed.path || path.join(homePath, "aios"), homePath),
    homePath,
    operationId: parsed.operationId,
    planFingerprint: parsed.planFingerprint,
    apply: parsed.apply,
    filesystem: dependencies.fs,
    createId: dependencies.createId,
    now: dependencies.now
  };
  const result = await dispatchSourceCommand(parsed, common);

  if (parsed.json) output.log(JSON.stringify(publicResult(result), null, 2));
  else printResult(output, publicResult(result));
  return result;
}

async function dispatchSourceCommand(parsed, common) {
  if (parsed.subcommand === "add") return runAdd(parsed, common);
  if (parsed.subcommand === "bind") return runBind(parsed, common);
  if (parsed.subcommand === "grant") return runGrant(parsed, common);
  if (parsed.subcommand === "retrieve") return runRetrieve(parsed, common);
  throw new Error(`Unknown project source subcommand: ${parsed.subcommand || "(missing)"}.`);
}

function runAdd(parsed, common) {
  assertPositionals(parsed.positionals, 2, "dotaios project source add <project> <folder>");
  requireOption(parsed.sourceId, "--source-id");
  requireOption(parsed.label, "--label");
  requireOption(parsed.purpose, "--purpose");
  rejectOptions(parsed, ["expiresAt", "task"]);
  return addProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    folder: resolveUserPath(parsed.positionals[1], common.homePath),
    sourceId: parsed.sourceId,
    label: parsed.label,
    purpose: parsed.purpose
  });
}

function runBind(parsed, common) {
  assertPositionals(parsed.positionals, 3, "dotaios project source bind <project> <source-id> <folder>");
  rejectOptions(parsed, ["sourceId", "label", "purpose", "expiresAt", "task"]);
  return bindProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    sourceId: parsed.positionals[1],
    folder: resolveUserPath(parsed.positionals[2], common.homePath)
  });
}

function runGrant(parsed, common) {
  assertPositionals(parsed.positionals, 2, "dotaios project source grant <project> <source-id>");
  requireOption(parsed.purpose, "--purpose");
  requireOption(parsed.expiresAt, "--expires-at");
  rejectOptions(parsed, ["sourceId", "label", "task"]);
  return grantProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    sourceId: parsed.positionals[1],
    purpose: parsed.purpose,
    expiresAt: parsed.expiresAt
  });
}

function runRetrieve(parsed, common) {
  if (parsed.positionals.length > 1) {
    throw new Error("Usage: dotaios project source retrieve [project] --task <text>");
  }
  requireOption(parsed.task, "--task");
  rejectOptions(parsed, ["sourceId", "label", "purpose", "expiresAt"]);
  if (parsed.apply || parsed.operationId || parsed.planFingerprint) {
    throw new Error("Retrieval cannot authorize or apply project source consent.");
  }
  return retrieveProjectSource({
    ...common,
    apply: false,
    projectSelector: parsed.positionals[0],
    task: parsed.task
  });
}

function parseOptions(args, index = 0, parsed = null) {
  const current = parsed || {
    subcommand: null,
    positionals: [],
    path: null,
    home: null,
    sourceId: null,
    label: null,
    purpose: null,
    expiresAt: null,
    task: null,
    operationId: null,
    planFingerprint: null,
    apply: false,
    json: false
  };
  if (index >= args.length) return current;
  const argument = args[index];
  const optionKey = OPTION_KEYS[argument];
  if (optionKey) {
    return parseOptions(args, index + 2, {
      ...current,
      [optionKey]: readOptionValue(args, index, argument)
    });
  }
  if (argument === "--apply") return parseOptions(args, index + 1, { ...current, apply: true });
  if (argument === "--json") return parseOptions(args, index + 1, { ...current, json: true });
  if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
  if (!current.subcommand) return parseOptions(args, index + 1, { ...current, subcommand: argument });
  return parseOptions(args, index + 1, {
    ...current,
    positionals: [...current.positionals, argument]
  });
}

const OPTION_KEYS = Object.freeze({
  "--path": "path",
  "--home": "home",
  "--source-id": "sourceId",
  "--label": "label",
  "--purpose": "purpose",
  "--expires-at": "expiresAt",
  "--task": "task",
  "--operation-id": "operationId",
  "--plan-fingerprint": "planFingerprint"
});

function publicResult(result) {
  if (result.decision) return result;
  return {
    version: result.version,
    operation: result.operation,
    applied: result.applied,
    operation_id: result.operation_id,
    plan_fingerprint: result.plan_fingerprint,
    ...(result.grant_id ? { grant_id: result.grant_id } : {}),
    project_id: result.project_id,
    project: result.project,
    source_id: result.source_id,
    ...(result.label ? { label: result.label } : {}),
    ...(result.purpose ? { purpose: result.purpose } : {}),
    ...(result.scope ? { scope: result.scope } : {}),
    ...(Object.hasOwn(result, "approved_at") ? { approved_at: result.approved_at } : {}),
    ...(result.expires_at ? { expires_at: result.expires_at } : {}),
    ...(result.recovery ? { recovery: true } : {}),
    ...(result.portable_path ? { portable: { path: result.portable_path } } : {}),
    ...(result.portable ? { portable: result.portable } : {}),
    machine_local: result.machine_local,
    ...(result.binding_generation ? { binding_generation: result.binding_generation } : {}),
    ...(result.grant_revision ? { grant_revision: result.grant_revision } : {})
  };
}

function printResult(output, result) {
  if (result.decision === "allowed") {
    output.log(`Retrieved ${result.references.length} reference(s) for ${result.project}/${result.source_id}.`);
    for (const reference of result.references) output.log(`  ${reference.path}`);
    output.log(`Receipt: ${result.receipt_id}`);
    return;
  }
  if (result.decision === "refused") {
    output.log(`Project source retrieval refused: ${result.reason}`);
    output.log(`Receipt: ${result.receipt_id}`);
    return;
  }
  output.log(result.applied ? "Project source change applied." : "Project source preview (no files changed)." );
  output.log(`Operation: ${result.operation_id}`);
  output.log(`Plan fingerprint: ${result.plan_fingerprint}`);
  if (result.portable?.path) output.log(`Portable effect: ${result.portable.path}`);
  if (result.machine_local?.root) output.log(`Local folder: ${result.machine_local.root}`);
}

function rejectOptions(parsed, names) {
  for (const name of names) {
    if (parsed[name] !== null) throw new Error(`Option is not valid for ${parsed.subcommand}: ${optionName(name)}`);
  }
}

function optionName(name) {
  return `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function requireOption(value, name) {
  if (value === null) throw new Error(`${name} is required.`);
}

function assertPositionals(positionals, expected, usage) {
  if (positionals.length !== expected) throw new Error(`Usage: ${usage}`);
}

function resolveUserPath(value, homePath) {
  if (value === "~") return path.resolve(homePath);
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(homePath, value.slice(2));
  return path.resolve(value);
}
