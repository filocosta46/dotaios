import { buildSessionDigest } from "./digest.mjs";
import { resolveMemoryPolicy } from "./memory-policy.mjs";
import { inspectMigrationState } from "./migrations.mjs";

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

  const [digestResult, migration] = await Promise.all([
    digestBuilder(aiosPath, options, dependencies),
    Promise.resolve()
      .then(() => migrationInspector({ aiosPath }, dependencies))
      .catch(migrationInspectionFailure)
  ]);
  const operational = { migration: describeMigrationAction(migration) };

  const notice = renderOperationalNotice(operational);
  if (notice && notice.length > WORKING_CONTEXT_OPERATIONAL_OVERHEAD_LIMIT) {
    throw new Error("Working-context operational notice exceeded its fixed bound.");
  }

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
      "> Diagnose this same folder with: dotaios doctor --path <this-aios-folder>"
    ].join("\n");
  }

  if (migration.status === "schema_outdated") {
    return [
      `> [DotAIOS] This folder uses schema ${migration.folder_schema_version}; this build supports ${migration.supported_schema_version}.`,
      "> A migration preview is required before any compatibility change.",
      "> Preview this same folder with: dotaios migrate --path <this-aios-folder>"
    ].join("\n");
  }

  if (migration.status === "inspection_failed") {
    return [
      `> [DotAIOS] Folder migration state could not be verified (${migration.code}).`,
      "> Do not assume the folder is current or start a compatibility write.",
      "> Diagnose this same folder with: dotaios doctor --path <this-aios-folder>"
    ].join("\n");
  }

  return null;
}

function migrationInspectionFailure(error) {
  const candidate = typeof error?.code === "string" ? error.code : "INSPECTION_FAILED";
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : "INSPECTION_FAILED";
  return { status: "inspection_failed", code };
}

function describeMigrationAction(migration) {
  if (migration.status === "current") {
    return { ...migration, severity: "none", action: null };
  }
  if (migration.status === "schema_outdated") {
    return {
      ...migration,
      severity: "notice",
      action: { command: "dotaios migrate", path_scope: "configured_aios" }
    };
  }
  return {
    ...migration,
    severity: "warning",
    action: { command: "dotaios doctor", path_scope: "configured_aios" }
  };
}
