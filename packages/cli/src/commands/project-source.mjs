import os from "node:os";
import path from "node:path";

import {
  addProjectSource,
  bindProjectSource,
  connectProjectSource,
  grantProjectSource,
  revokeProjectSource,
  retrieveProjectSource
} from "../../../core/src/project-sources.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios project source add <project> <folder> --source-id <id> --label <label> --purpose <purpose>
  dotaios project source bind <project> <source-id> <folder>
  dotaios project source grant <project> <source-id> --purpose <purpose> --expires-at <UTC>
  dotaios project source revoke <project> <source-id> --grant-id <id>
  dotaios project source retrieve [project] --task <text>
  dotaios project source connect <project> <folder> --source-id <id> --label <label> --purpose <purpose> --expires-at <UTC> [--yes]

Source add, bind, grant, and revoke preview by default. Apply an exact preview with:
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
  const jsonRequested = args.includes("--json");
  try {
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
  } catch (error) {
    if (!jsonRequested) throw error;
    const envelope = publicError(error);
    const logError = typeof output.error === "function" ? output.error.bind(output) : output.log.bind(output);
    logError(JSON.stringify(envelope));
    Object.defineProperty(error, "dotaiosCliReported", { value: true });
    throw error;
  }
}

async function dispatchSourceCommand(parsed, common) {
  if (parsed.subcommand === "add") return runAdd(parsed, common);
  if (parsed.subcommand === "bind") return runBind(parsed, common);
  if (parsed.subcommand === "grant") return runGrant(parsed, common);
  if (parsed.subcommand === "revoke") return runRevoke(parsed, common);
  if (parsed.subcommand === "retrieve") return runRetrieve(parsed, common);
  if (parsed.subcommand === "connect") return runConnect(parsed, common);
  throw new Error(`Unknown project source subcommand: ${parsed.subcommand || "(missing)"}.`);
}

function runAdd(parsed, common) {
  rejectYes(parsed);
  assertPositionals(parsed.positionals, 2, "dotaios project source add <project> <folder>");
  requireOption(parsed.sourceId, "--source-id");
  requireOption(parsed.label, "--label");
  requireOption(parsed.purpose, "--purpose");
  rejectOptions(parsed, ["expiresAt", "grantId", "task"]);
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
  rejectYes(parsed);
  assertPositionals(parsed.positionals, 3, "dotaios project source bind <project> <source-id> <folder>");
  rejectOptions(parsed, ["sourceId", "label", "purpose", "expiresAt", "grantId", "task"]);
  return bindProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    sourceId: parsed.positionals[1],
    folder: resolveUserPath(parsed.positionals[2], common.homePath)
  });
}

function runGrant(parsed, common) {
  rejectYes(parsed);
  assertPositionals(parsed.positionals, 2, "dotaios project source grant <project> <source-id>");
  requireOption(parsed.purpose, "--purpose");
  requireOption(parsed.expiresAt, "--expires-at");
  rejectOptions(parsed, ["sourceId", "label", "grantId", "task"]);
  return grantProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    sourceId: parsed.positionals[1],
    purpose: parsed.purpose,
    expiresAt: parsed.expiresAt
  });
}

function runRevoke(parsed, common) {
  rejectYes(parsed);
  assertPositionals(parsed.positionals, 2, "dotaios project source revoke <project> <source-id>");
  requireOption(parsed.grantId, "--grant-id");
  rejectOptions(parsed, ["sourceId", "label", "purpose", "expiresAt", "task"]);
  return revokeProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    sourceId: parsed.positionals[1],
    grantId: parsed.grantId
  });
}

function runRetrieve(parsed, common) {
  rejectYes(parsed);
  if (parsed.positionals.length > 1) {
    throw new Error("Usage: dotaios project source retrieve [project] --task <text>");
  }
  requireOption(parsed.task, "--task");
  rejectOptions(parsed, ["sourceId", "label", "purpose", "expiresAt", "grantId"]);
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

function runConnect(parsed, common) {
  assertPositionals(parsed.positionals, 2, "dotaios project source connect <project> <folder>");
  requireOption(parsed.sourceId, "--source-id");
  requireOption(parsed.label, "--label");
  requireOption(parsed.purpose, "--purpose");
  requireOption(parsed.expiresAt, "--expires-at");
  rejectOptions(parsed, ["grantId", "task"]);
  if (parsed.apply || parsed.operationId || parsed.planFingerprint) {
    throw new Error("Connect uses one explicit --yes confirmation and does not accept proof tokens.");
  }
  return connectProjectSource({
    ...common,
    projectSelector: parsed.positionals[0],
    folder: resolveUserPath(parsed.positionals[1], common.homePath),
    sourceId: parsed.sourceId,
    label: parsed.label,
    purpose: parsed.purpose,
    expiresAt: parsed.expiresAt,
    yes: parsed.yes
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
    grantId: null,
    task: null,
    operationId: null,
    planFingerprint: null,
    apply: false,
    yes: false,
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
  if (argument === "--yes") return parseOptions(args, index + 1, { ...current, yes: true });
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
  "--grant-id": "grantId",
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
    ...(Object.hasOwn(result, "idempotent") ? { idempotent: result.idempotent } : {}),
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
    ...(Object.hasOwn(result, "revoked_at") ? { revoked_at: result.revoked_at } : {}),
    ...(result.expires_at ? { expires_at: result.expires_at } : {}),
    ...(result.approval_timing ? { approval_timing: result.approval_timing } : {}),
    ...(result.recovery ? { recovery: true } : {}),
    ...(result.portable_path ? { portable: { path: result.portable_path } } : {}),
    ...(result.portable ? { portable: result.portable } : {}),
    machine_local: result.machine_local,
    ...(result.binding_generation ? { binding_generation: result.binding_generation } : {}),
    ...(result.grant_revision ? { grant_revision: result.grant_revision } : {})
  };
}

function publicError(error) {
  const domainReason = typeof error?.details?.reason === "string"
    ? error.details.reason
    : null;
  return Object.freeze({
    version: 1,
    error: Object.freeze({
      code: domainReason && /^DOTAIOS_[A-Z0-9_]+$/.test(error?.code)
        ? error.code
        : "DOTAIOS_PROJECT_SOURCE_INVALID_REQUEST",
      reason: domainReason || "invalid-request",
      message: domainReason ? error.message : safeCliErrorMessage(error),
    }),
  });
}

function safeCliErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (
    /^--[a-z-]+ is required\.$/.test(message)
    || /^Usage: dotaios project source [a-z]+ /.test(message)
    || /^--yes is only valid for project source connect\.$/.test(message)
    || /^Connect uses one explicit --yes confirmation/.test(message)
    || /^Option is not valid for (?:add|bind|grant|revoke|retrieve|connect): --[a-z-]+$/.test(message)
  ) return message;
  return "Project source request is invalid.";
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
  if (result.operation === "connect") {
    output.log(result.applied
      ? (result.idempotent ? "Project source is already connected." : "Project source connected.")
      : "Project source connection preview (no files changed)." );
    output.log(`Project: ${result.project} (${result.project_id})`);
    output.log(`Source: ${result.label} (${result.source_id})`);
    output.log(`Scope: ${result.scope}`);
    output.log(`Purpose: ${result.purpose}`);
    output.log(`Approval timing: ${result.approved_at || result.approval_timing}`);
    output.log(`Expires: ${result.expires_at}`);
    if (result.portable?.path) output.log(`Portable effect: ${result.portable.path}`);
    if (result.machine_local?.root) output.log(`Local folder: ${result.machine_local.root}`);
    if (!result.applied) output.log("Re-run this exact command with --yes to connect the folder and finite read grant.");
    if (result.grant_id) output.log(`Grant: ${result.grant_id}`);
    return;
  }
  output.log(result.applied ? "Project source change applied." : "Project source preview (no files changed)." );
  if (result.operation === "grant") {
    output.log(`Project: ${result.project} (${result.project_id})`);
    output.log(`Source: ${result.label} (${result.source_id})`);
    output.log(`Scope: ${result.scope}`);
    output.log(`Purpose: ${result.purpose}`);
    output.log(`Approval timing: ${result.approved_at || "when this exact preview is applied"}`);
    output.log(`Expires: ${result.expires_at}`);
  }
  output.log(`Operation: ${result.operation_id}`);
  output.log(`Plan fingerprint: ${result.plan_fingerprint}`);
  if (result.portable?.path) output.log(`Portable effect: ${result.portable.path}`);
  if (result.portable?.effect) output.log(`Portable effect: ${result.portable.effect}`);
  if (result.machine_local?.root) output.log(`Local folder: ${result.machine_local.root}`);
  if (result.machine_local?.authorization_effect) {
    output.log(`Machine-local authorization effect: ${result.machine_local.authorization_effect}`);
  }
  if (result.operation === "grant" && result.applied && result.grant_id) {
    output.log(`Grant ID: ${result.grant_id}`);
  }
}

function rejectYes(parsed) {
  if (parsed.yes) throw new Error(`--yes is only valid for project source connect.`);
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
