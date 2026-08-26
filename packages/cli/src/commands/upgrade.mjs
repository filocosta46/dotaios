import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  applyManagedBridgeFile,
  bridgeContent,
  bridgeManagedBlock,
  bridgePath,
  exactCliInvocation,
  loadAgentRegistry,
  previewManagedBridgeFile,
  readPackageVersion
} from "../../../core/src/bridges.mjs";
import { readAiosConfig } from "../../../core/src/config.mjs";
import {
  createManagedSkillStore,
  ManagedSkillStoreError
} from "../../../core/src/managed-skill-store.mjs";
import { inspectMigrationState } from "../../../core/src/migrations.mjs";
import {
  defaultAiosPath,
  ensureAiosFolder,
  expandHome
} from "../../../core/src/paths.mjs";
import { compareUtf8Bytes } from "../../../core/src/skills.mjs";
import {
  applyManagedScheduleFile,
  previewManagedScheduleFile
} from "./schedule.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const UPGRADE_FORMAT = "dotaios-upgrade-preview/v1";
const upgradeDomains = new WeakMap();
const OFFICIAL_APPLY_CONFLICT_CODES = new Set([
  "destination_changed",
  "proof_mismatch",
  "source_changed",
  "store_busy"
]);
const OFFICIAL_APPLY_RECOVERY_CODES = new Set([
  "recovery_required",
  "unsafe_state"
]);

const HELP_TEXT = `Usage:
  dotaios upgrade [--dry-run] [--path <dir>]
  dotaios upgrade --apply --id <id> --fingerprint <sha256> [--path <dir>]

Refreshes only managed DotAIOS scaffold in an already-connected AIOS folder.
Preview is the default and writes nothing. Apply accepts only the exact id and
fingerprint from that preview. Upgrade does not change user memory and does not sync.
This is different from \`dotaios update [text]\`, which logs a memory note.

Options:
  --path <dir>              Use an AIOS folder other than ~/aios
  --dry-run                 Preview only (the default)
  --apply                   Apply the exact approved preview
  --id <id>                 Exact preview id
  --fingerprint <sha256>    Exact preview fingerprint
`;

export async function previewUpgrade(input = {}) {
  const context = await resolveUpgradeContext(input);
  await ensureAiosFolder(context.aiosPath);

  let migration;
  try {
    migration = await inspectMigrationState({ aiosPath: context.aiosPath });
  } catch (error) {
    return recoveryRequiredPreview(context, {
      reason: error?.code || "migration-state-unavailable",
      detail: error?.message || "Migration compatibility state could not be inspected.",
      recover: false
    });
  }
  if (migration.status !== "current") {
    return recoveryRequiredPreview(context, {
      reason: migration.status,
      detail: migration.status === "transaction_present"
        ? "An interrupted migration must be recovered before managed scaffold can be refreshed."
        : `Folder schema ${migration.folder_schema_version} is not current (${migration.supported_schema_version}).`,
      recover: migration.status === "transaction_present"
    });
  }

  const store = createManagedSkillStore({
    aiosPath: context.aiosPath,
    homePath: context.homePath,
    officialCandidateVersion: context.candidateVersion
  });
  const officialComposition = await store.previewOfficialBatchComposition();
  const officialProof = officialComposition.proof;
  if (officialProof.candidate_invocation !== context.candidateInvocation) {
    throw new Error("Official skill preview did not use the running candidate invocation.");
  }

  const schedulePlan = await previewManagedScheduleFile(
    path.join(context.aiosPath, "schedules.yml"),
    {
      boundaryRoot: context.aiosPath,
      candidateVersion: context.candidateVersion
    }
  );
  const config = await readAiosConfig(context.aiosPath);
  const skillsFirst = Boolean(config.skills_first);
  const conflicts = [
    ...officialProof.conflicts.map((conflict) => ({
      domain: "official-skills",
      ...conflict
    })),
    ...schedulePlan.conflicts.map((conflict) => ({
      domain: "managed-schedules",
      path: schedulePlan.target?.path || path.join(context.aiosPath, "schedules.yml"),
      ...conflict
    }))
  ];
  const bridgeEntries = [];

  if (skillsFirst && officialComposition.skillsCatalog === null) {
    conflicts.push({
      domain: "managed-bridges",
      reason: "skills-first-catalog-conflict",
      detail: "Skills-first bridge refresh is suppressed until official catalog conflicts are resolved."
    });
  } else {
    const managedBlock = await bridgeManagedBlock(context.aiosPath, {
      skillsFirst,
      ...(skillsFirst ? { skillsCatalog: officialComposition.skillsCatalog } : {}),
      cli: context.candidateInvocation
    });
    const agents = await loadAgentRegistry(context.aiosPath);
    const destinations = new Map();
    for (const agent of agents) {
      const destination = bridgePath(context.homePath, agent);
      if (!destination || destinations.has(destination)) continue;
      destinations.set(destination, agent);
    }
    for (const [destination, agent] of [...destinations.entries()].sort(comparePathEntry)) {
      const generatedContent = await bridgeContent(agent, context.aiosPath, { managedBlock });
      const plan = await previewManagedBridgeFile(destination, generatedContent, {
        refreshOnly: true,
        boundaryRoot: context.homePath
      });
      bridgeEntries.push({ destination, generatedContent, plan });
      if (plan.status === "blocked-conflict") {
        conflicts.push({
          domain: "managed-bridges",
          path: destination,
          reason: plan.reason || "bridge-conflict",
          detail: "The existing bridge was preserved."
        });
      }
    }
  }

  conflicts.sort(compareCanonical);
  const targets = buildTargetSummaries(officialProof, schedulePlan, bridgeEntries);
  const hasChanges = officialProof.effects.repair_official_skills.length > 0
    || officialProof.effects.publish_catalogs
    || schedulePlan.status === "ready"
    || bridgeEntries.some(({ plan }) => plan.status === "ready");
  const status = conflicts.length > 0
    ? "blocked-conflict"
    : hasChanges
      ? "ready"
      : "current";
  const proofPayload = {
    format: UPGRADE_FORMAT,
    candidate_version: context.candidateVersion,
    candidate_invocation: context.candidateInvocation,
    aios_path: context.aiosPath,
    home_path: context.homePath,
    skills_first: skillsFirst,
    migration: {
      status: migration.status,
      folder_schema_version: migration.folder_schema_version,
      supported_schema_version: migration.supported_schema_version
    },
    official: {
      operation_id: officialProof.operation_id,
      plan_fingerprint: officialProof.plan_fingerprint
    },
    schedule: {
      path: schedulePlan.target?.path || path.join(context.aiosPath, "schedules.yml"),
      status: schedulePlan.status,
      fingerprint: schedulePlan.fingerprint
    },
    bridges: bridgeEntries.map(({ destination, plan }) => ({
      path: destination,
      status: plan.status,
      action: plan.action,
      fingerprint: plan.fingerprint
    })),
    targets,
    conflicts
  };
  const digest = sha256(canonicalJson(proofPayload));
  const preview = {
    ...proofPayload,
    status,
    id: `upgrade-${digest.slice(0, 24)}`,
    fingerprint: `sha256:${digest}`
  };
  upgradeDomains.set(preview, {
    store,
    officialProof,
    schedulePlan,
    bridgeEntries
  });
  return deepFreeze(preview);
}

export async function applyUpgrade(input = {}) {
  const preview = await previewUpgrade(input);
  if (preview.status === "recovery-required") return preview;

  if (
    typeof input.id !== "string"
    || typeof input.fingerprint !== "string"
    || input.id !== preview.id
    || input.fingerprint !== preview.fingerprint
  ) {
    return deepFreeze({
      status: "blocked-conflict",
      id: preview.id,
      fingerprint: preview.fingerprint,
      targets: preview.targets,
      conflicts: [{
        domain: "upgrade",
        reason: "proof-mismatch",
        detail: "The upgrade preview is stale or its exact id and fingerprint were not supplied; no files changed."
      }],
      results: []
    });
  }

  const domains = upgradeDomains.get(preview);
  const results = [];
  const conflicts = [...preview.conflicts];
  let recoveryRequired = false;
  let suppressSkillsFirstBridges = false;

  try {
    const official = await domains.store.applyOfficialBatch({
      operationId: domains.officialProof.operation_id,
      planFingerprint: domains.officialProof.plan_fingerprint
    });
    results.push({ domain: "official-skills", ...official });
    if (official.status === "blocked-conflict") {
      suppressSkillsFirstBridges = preview.skills_first;
      conflicts.push(...official.conflicts.map((conflict) => ({
        domain: "official-skills",
        ...conflict
      })));
    }
  } catch (error) {
    if (!(error instanceof ManagedSkillStoreError)) throw error;
    const failure = officialApplyFailure(error);
    if (!failure) throw error;
    results.push({ domain: "official-skills", ...failure.result });
    conflicts.push(failure.conflict);
    if (failure.recoveryRequired) {
      return deepFreeze({
        status: "recovery-required",
        id: preview.id,
        fingerprint: preview.fingerprint,
        targets: preview.targets,
        conflicts: uniqueCanonical(conflicts),
        results
      });
    }
    suppressSkillsFirstBridges = preview.skills_first;
  }

  const schedule = await applyManagedScheduleFile(
    domains.schedulePlan.target?.path || path.join(preview.aios_path, "schedules.yml"),
    {
      boundaryRoot: preview.aios_path,
      candidateVersion: preview.candidate_version,
      expectedFingerprint: domains.schedulePlan.fingerprint
    }
  );
  results.push({ domain: "managed-schedules", ...schedule });
  if (schedule.status === "blocked-conflict" || schedule.action === "conflict") {
    conflicts.push({
      domain: "managed-schedules",
      path: schedule.path,
      reason: "schedule-conflict",
      detail: schedule.note || "The schedules file was preserved."
    });
  }
  if (schedule.status === "recovery-required") {
    recoveryRequired = true;
    conflicts.push({
      domain: "managed-schedules",
      path: schedule.path,
      reason: "schedule-verification-recovery-required",
      detail: schedule.note || "Schedule repair requires recovery before it can be called verified."
    });
  }

  if (suppressSkillsFirstBridges && domains.bridgeEntries.length > 0) {
    conflicts.push({
      domain: "managed-bridges",
      reason: "skills-first-official-apply-blocked",
      detail: "Skills-first bridge refresh was suppressed because the official skill batch did not verify."
    });
    results.push({
      domain: "managed-bridges",
      status: "blocked-conflict",
      action: "skipped",
      reason: "skills-first-official-apply-blocked"
    });
  }

  for (const entry of suppressSkillsFirstBridges ? [] : domains.bridgeEntries) {
    const bridge = await applyManagedBridgeFile(entry.destination, entry.generatedContent, {
      refreshOnly: true,
      expectedFingerprint: entry.plan.fingerprint,
      boundaryRoot: preview.home_path
    });
    results.push({ domain: "managed-bridges", ...bridge });
    if (["conflict", "unsafe-target", "kept"].includes(bridge.action)) {
      conflicts.push({
        domain: "managed-bridges",
        path: bridge.path,
        reason: "bridge-conflict",
        detail: bridge.note || "The existing bridge was preserved."
      });
    }
  }

  const uniqueConflicts = uniqueCanonical(conflicts);
  return deepFreeze({
    status: recoveryRequired
      ? "recovery-required"
      : uniqueConflicts.length > 0
        ? "blocked-conflict"
        : "verified",
    id: preview.id,
    fingerprint: preview.fingerprint,
    targets: preview.targets,
    conflicts: uniqueConflicts,
    results
  });
}

export async function upgradeCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }
  const options = parseOptions(args);
  const input = {
    aiosPath: options.path
  };
  if (!options.apply) {
    const preview = await previewUpgrade(input);
    printPreview(preview);
    return preview;
  }

  const result = await applyUpgrade({
    ...input,
    id: options.id,
    fingerprint: options.fingerprint
  });
  printApply(result);
  return result;
}

function parseOptions(args = []) {
  const options = {
    apply: false,
    dryRun: false,
    fingerprint: null,
    id: null,
    path: null
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--id") {
      options.id = readOptionValue(args, index, "--id");
      index += 1;
    } else if (arg === "--fingerprint") {
      options.fingerprint = readOptionValue(args, index, "--fingerprint");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.apply && options.dryRun) {
    throw new Error("Choose preview or --apply, not both.");
  }
  if (options.apply && (!options.id || !options.fingerprint)) {
    throw new Error("Upgrade apply requires both --id and --fingerprint from the exact preview.");
  }
  if (!options.apply && (options.id || options.fingerprint)) {
    throw new Error("--id and --fingerprint are accepted only with --apply.");
  }
  return options;
}

async function resolveUpgradeContext(input) {
  const aiosPath = path.resolve(expandHome(input.aiosPath || defaultAiosPath()));
  const homePath = path.resolve(expandHome(input.homePath || os.homedir()));
  const candidateVersion = input.candidateVersion ?? await readPackageVersion();
  return {
    aiosPath,
    homePath,
    candidateVersion,
    candidateInvocation: exactCliInvocation(candidateVersion)
  };
}

function recoveryRequiredPreview(context, { reason, detail, recover }) {
  const guidance = [
    `${context.candidateInvocation} migrate${recover ? " --recover" : ""}${pathOption(context.aiosPath)}`
  ];
  return deepFreeze({
    format: UPGRADE_FORMAT,
    status: "recovery-required",
    id: null,
    fingerprint: null,
    candidate_version: context.candidateVersion,
    candidate_invocation: context.candidateInvocation,
    aios_path: context.aiosPath,
    home_path: context.homePath,
    targets: [],
    conflicts: [{ domain: "migration", reason, detail }],
    guidance
  });
}

function buildTargetSummaries(officialProof, schedulePlan, bridgeEntries) {
  const officialStatus = officialProof.conflicts.length > 0
    ? "blocked-conflict"
    : officialProof.effects.repair_official_skills.length > 0 || officialProof.effects.publish_catalogs
      ? "ready"
      : "current";
  return deepFreeze([
    {
      domain: "official-skills",
      status: officialStatus,
      id: officialProof.operation_id,
      fingerprint: officialProof.plan_fingerprint,
      repair_count: officialProof.effects.repair_official_skills.length,
      publish_catalogs: officialProof.effects.publish_catalogs
    },
    {
      domain: "managed-schedules",
      path: schedulePlan.target?.path || null,
      status: schedulePlan.status,
      fingerprint: schedulePlan.fingerprint,
      change_count: schedulePlan.changes.length
    },
    ...bridgeEntries.map(({ destination, plan }) => ({
      domain: "managed-bridges",
      path: destination,
      status: plan.status,
      action: plan.action,
      fingerprint: plan.fingerprint
    }))
  ]);
}

function printPreview(preview) {
  console.log(`DotAIOS managed-scaffold upgrade preview for ${preview.aios_path}`);
  if (preview.status === "recovery-required") {
    console.error(`[blocked] ${preview.conflicts[0].detail}`);
    for (const command of preview.guidance) console.error(`Run: ${command}`);
    console.log("No files changed.");
    process.exitCode = 1;
    return;
  }
  for (const target of preview.targets) {
    console.log(`[${target.status}] ${target.domain}${target.path ? ` ${target.path}` : ""}`);
  }
  for (const conflict of preview.conflicts) {
    console.error(`[conflict] ${conflict.domain}: ${conflict.detail || conflict.reason}`);
  }
  console.log(`Preview ID: ${preview.id}`);
  console.log(`Fingerprint: ${preview.fingerprint}`);
  console.log("No files changed.");
  console.log(`Apply exactly this preview with: ${preview.candidate_invocation} upgrade --apply --id ${preview.id} --fingerprint ${preview.fingerprint}${pathOption(preview.aios_path)}`);
  if (preview.status === "blocked-conflict") process.exitCode = 1;
}

function printApply(result) {
  if (result.status === "verified") {
    console.log("[ok] Managed scaffold upgrade verified.");
    return;
  }
  if (result.status === "recovery-required") {
    console.error("[blocked] Recovery is required before managed scaffold upgrade can continue.");
    for (const conflict of result.conflicts || []) {
      console.error(`  ${conflict.domain}: ${conflict.detail || conflict.reason}`);
    }
    for (const command of result.guidance || []) console.error(`Run: ${command}`);
  } else {
    console.error("[blocked] Managed scaffold upgrade preserved one or more conflicts.");
    for (const conflict of result.conflicts) {
      console.error(`  ${conflict.domain}: ${conflict.detail || conflict.reason}`);
    }
  }
  process.exitCode = 1;
}

function pathOption(target) {
  const defaultPath = path.resolve(expandHome(defaultAiosPath()));
  return target === defaultPath ? "" : ` --path ${shellQuote(target)}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function comparePathEntry([left], [right]) {
  return compareUtf8Bytes(left, right);
}

function compareCanonical(left, right) {
  return Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right)));
}

function uniqueCanonical(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort(compareCanonical);
}

function officialApplyFailure(error) {
  if (OFFICIAL_APPLY_RECOVERY_CODES.has(error.code)) {
    const detail = error.code === "recovery_required"
      ? `Official managed-skill recovery is required (${error.reason}).`
      : `Official managed-skill state requires attention (${error.reason}).`;
    return {
      recoveryRequired: true,
      conflict: {
        domain: "official-skills",
        reason: error.code,
        detail
      },
      result: {
        status: "recovery-required",
        reason: error.code,
        detail: error.reason
      }
    };
  }
  if (!OFFICIAL_APPLY_CONFLICT_CODES.has(error.code)) return null;
  return {
    recoveryRequired: false,
    conflict: {
      domain: "official-skills",
      reason: error.code,
      detail: `Official skill apply did not verify (${error.reason}); dependent skills-first bridges were suppressed when applicable.`
    },
    result: {
      status: "blocked-conflict",
      reason: error.code,
      detail: error.reason
    }
  };
}

function canonicalJson(value) {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort(compareUtf8Bytes)) {
    if (value[key] !== undefined) sorted[key] = sortCanonicalValue(value[key]);
  }
  return sorted;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
