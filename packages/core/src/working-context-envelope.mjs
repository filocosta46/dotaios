import { buildSessionDigest } from "./digest.mjs";
import { resolveMemoryPolicy } from "./memory-policy.mjs";
import { inspectMigrationState } from "./migrations.mjs";
import { resolveCliInvocation } from "./bridges.mjs";
import { assertWorkingContextCoverageBound } from "./working-context-coverage.mjs";

export const WORKING_CONTEXT_OPERATIONAL_OVERHEAD_LIMIT = 1024;

/**
 * Build the canonical digest and its read-only operational state together.
 * Maintenance stays outside the digest so it cannot change selection or budget
 * semantics; text-only adapters may render the returned notice ahead of it.
 */
export async function buildWorkingContextEnvelope(aiosPath, options = {}, dependencies = {}) {
  const memoryPolicy = resolveMemoryPolicy({
    mode: options.memory,
    project: options.project,
    firstUserMessage: options.firstUserMessage,
  });
  if (memoryPolicy.mode === "off") return buildOffEnvelope(memoryPolicy);

  const digestBuilder = dependencies.buildSessionDigest || buildSessionDigest;
  const migrationInspector = dependencies.inspectMigrationState || inspectMigrationState;
  const invocationResolver = dependencies.resolveCliInvocation || resolveCliInvocation;

  const [digestResult, migration] = await Promise.all([
    digestBuilder(aiosPath, options, dependencies),
    Promise.resolve()
      .then(() => migrationInspector({ aiosPath }, dependencies))
      .catch(migrationInspectionFailure),
  ]);
  const cli = migration.status === "current"
    ? null
    : await Promise.resolve().then(() => invocationResolver()).catch(() => null);
  const operational = { migration: describeMigrationAction(migration, cli) };

  const operationalNotice = renderOperationalNotice(operational);
  if (operationalNotice && operationalNotice.length > WORKING_CONTEXT_OPERATIONAL_OVERHEAD_LIMIT) {
    throw new Error("Working-context operational notice exceeded its fixed bound.");
  }
  const coverage = digestResult.coverage;
  assertWorkingContextCoverageBound(coverage);
  const notice = [operationalNotice, coverage?.notice].filter(Boolean).join("\n\n") || null;

  return {
    ...digestResult,
    operational,
    notice
  };
}

function buildOffEnvelope(memoryPolicy) {
  const digest = `${memoryPolicy.receipt}\n\n${memoryPolicy.notice}`;
  return {
    digest,
    sessionIds: [],
    budget: { limit: digest.length, used: digest.length, remaining: 0, truncated: false },
    generatedAt: null,
    projectFilter: null,
    memoryMode: memoryPolicy.mode,
    memoryReceipt: memoryPolicy.receipt,
    operational: {
      migration: { status: "not_read", severity: "none", action: null },
    },
    notice: null,
  };
}

export function renderOperationalNotice(operational) {
  const migration = operational?.migration;
  if (!migration || migration.status === "current") return null;

  if (migration.status === "transaction_present") {
    return [
      "> [DotAIOS] Migration transaction metadata is present; liveness is not verified.",
      "> Tell the user before writing to the folder and do not start blind recovery.",
      migration.action
        ? `> Diagnose this same folder with: ${migration.action.command} --path <this-aios-folder>`
        : "> The exact candidate invocation is unavailable; tell the user before attempting recovery."
    ].join("\n");
  }

  if (migration.status === "schema_outdated") {
    return [
      `> [DotAIOS] This folder uses schema ${migration.folder_schema_version}; this build supports ${migration.supported_schema_version}.`,
      "> A migration preview is required before any compatibility change.",
      migration.action
        ? `> Preview this same folder with: ${migration.action.command} --path <this-aios-folder>`
        : "> The exact candidate invocation is unavailable; tell the user before attempting migration."
    ].join("\n");
  }

  if (migration.status === "inspection_failed") {
    return [
      `> [DotAIOS] Folder migration state could not be verified (${migration.code}).`,
      "> Do not assume the folder is current or start a compatibility write.",
      migration.action
        ? `> Diagnose this same folder with: ${migration.action.command} --path <this-aios-folder>`
        : "> The exact candidate invocation is unavailable; tell the user before attempting diagnosis."
    ].join("\n");
  }

  return null;
}

function migrationInspectionFailure(error) {
  const candidate = typeof error?.code === "string" ? error.code : "INSPECTION_FAILED";
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : "INSPECTION_FAILED";
  return { status: "inspection_failed", code };
}

function describeMigrationAction(migration, cli) {
  if (migration.status === "current") {
    return { ...migration, severity: "none", action: null };
  }
  const actionCommand = typeof cli === "string" && cli.length > 0 ? cli : null;
  if (migration.status === "schema_outdated") {
    return {
      ...migration,
      severity: "notice",
      action: actionCommand
        ? { command: `${actionCommand} migrate`, path_scope: "configured_aios" }
        : null
    };
  }
  return {
    ...migration,
    severity: "warning",
    action: actionCommand
      ? { command: `${actionCommand} doctor`, path_scope: "configured_aios" }
      : null
  };
}
