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
import {
  assertSafeTerminalText,
  guidanceShellLabel,
  renderGuidanceCommand,
  visibleTerminalText
} from "../lib/command-guidance.mjs";

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

class SkillsFirstCatalogDriftError extends Error {}

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
      recover: false,
      guidanceAction: "doctor"
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
      assertSafeTerminalText(destination, "Agent bridge path");
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
    officialComposition,
    officialProof,
    schedulePlan,
    bridgeEntries
  });
  return deepFreeze(preview);
}

export async function applyUpgrade(input = {}, lifecycle = {}) {
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
      expectedFingerprint: domains.schedulePlan.fingerprint,
      beforeVerify: lifecycle.beforeScheduleVerify
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

  if (preview.skills_first && !suppressSkillsFirstBridges && domains.bridgeEntries.length > 0) {
    const catalogCheck = await skillsFirstCatalogCheck(domains, preview);
    if (!catalogCheck.current) {
      suppressSkillsFirstBridges = true;
      conflicts.push({
        domain: "managed-bridges",
        reason: "skills-first-catalog-changed",
        detail: "Skills-first bridge refresh was suppressed because the published catalog changed after official verification."
      });
      results.push({
        domain: "managed-bridges",
        status: "blocked-conflict",
        action: "skipped",
        reason: "skills-first-catalog-changed"
      });
    }
  }

  if (
    suppressSkillsFirstBridges
    && domains.bridgeEntries.length > 0
    && !conflicts.some(({ reason }) => reason === "skills-first-catalog-changed")
  ) {
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
    let bridge;
    try {
      bridge = await applyManagedBridgeFile(entry.destination, entry.generatedContent, {
        refreshOnly: true,
        expectedFingerprint: entry.plan.fingerprint,
        boundaryRoot: preview.home_path,
        ...(preview.skills_first ? {
          beforePublish: async () => {
            await lifecycle.beforeBridgePublish?.();
            if (!(await skillsFirstCatalogCheck(domains, preview)).current) {
              throw new SkillsFirstCatalogDriftError();
            }
          }
        } : {})
      });
    } catch (error) {
      if (!(error instanceof SkillsFirstCatalogDriftError)) throw error;
      suppressSkillsFirstBridges = true;
      conflicts.push({
        domain: "managed-bridges",
        path: entry.destination,
        reason: "skills-first-catalog-changed",
        detail: "Skills-first bridge refresh was suppressed because the catalog changed before bridge publication."
      });
      results.push({
        domain: "managed-bridges",
        status: "blocked-conflict",
        action: "skipped",
        path: entry.destination,
        reason: "skills-first-catalog-changed"
      });
      break;
    }
    results.push({ domain: "managed-bridges", ...bridge });
    if (["conflict", "unsafe-target", "kept"].includes(bridge.action)) {
      conflicts.push({
        domain: "managed-bridges",
        path: bridge.path,
        reason: "bridge-conflict",
        detail: bridge.note || "The existing bridge was preserved."
      });
    }
    await lifecycle.afterBridgeApply?.({
      destination: entry.destination,
      result: bridge
    });
    if (
      preview.skills_first
      && bridge.action === "updated"
      && !(await skillsFirstCatalogCheck(domains, preview)).current
    ) {
      suppressSkillsFirstBridges = true;
      conflicts.push({
        domain: "managed-bridges",
        reason: "skills-first-catalog-changed",
        detail: "Skills-first catalogs changed while bridges were being published; rerun upgrade before treating the bridge refresh as verified."
      });
      break;
    }
  }

  if (
    preview.skills_first
    && !suppressSkillsFirstBridges
    && !(await skillsFirstCatalogCheck(domains, preview)).current
  ) {
    conflicts.push({
      domain: "managed-bridges",
      reason: "skills-first-catalog-changed",
      detail: "Skills-first catalogs changed before aggregate verification; rerun upgrade before treating the bridge refresh as verified."
    });
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
  assertSafeTerminalText(aiosPath, "AIOS path");
  assertSafeTerminalText(homePath, "Home path");
  const candidateVersion = input.candidateVersion ?? await readPackageVersion();
  return {
    aiosPath,
    homePath,
    candidateVersion,
    candidateInvocation: exactCliInvocation(candidateVersion)
  };
}

function recoveryRequiredPreview(context, { reason, detail, recover, guidanceAction = "migrate" }) {
  const guidance = [
    renderGuidanceCommand(
      `${context.candidateInvocation} ${guidanceAction}${recover ? " --recover" : ""}`,
      { targetPath: context.aiosPath, defaultPath: path.resolve(expandHome(defaultAiosPath())) }
    )
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
    guidance_shell: guidanceShellLabel(),
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
  console.log(`DotAIOS managed-scaffold upgrade preview for ${visibleTerminalText(preview.aios_path)}`);
  if (preview.status === "recovery-required") {
    console.error(`[blocked] ${visibleTerminalText(preview.conflicts[0].detail)}`);
    console.error(`Run in ${visibleTerminalText(preview.guidance_shell)}:`);
    for (const command of preview.guidance) console.error(visibleTerminalText(command));
    console.log("No files changed.");
    process.exitCode = 1;
    return;
  }
  for (const target of preview.targets) {
    console.log(`[${target.status}] ${target.domain}${target.path ? ` ${visibleTerminalText(target.path)}` : ""}`);
  }
  for (const conflict of preview.conflicts) {
    console.error(`[conflict] ${visibleTerminalText(conflict.domain)}: ${visibleTerminalText(conflict.detail || conflict.reason)}`);
  }
  console.log(`Preview ID: ${preview.id}`);
  console.log(`Fingerprint: ${preview.fingerprint}`);
  console.log("No files changed.");
  console.log(`Apply exactly this preview in ${guidanceShellLabel()}:`);
  console.log(renderGuidanceCommand(
    `${preview.candidate_invocation} upgrade --apply --id ${preview.id} --fingerprint ${preview.fingerprint}`,
    { targetPath: preview.aios_path, defaultPath: path.resolve(expandHome(defaultAiosPath())) }
  ));
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
      console.error(`  ${visibleTerminalText(conflict.domain)}: ${visibleTerminalText(conflict.detail || conflict.reason)}`);
    }
    if (result.guidance_shell) {
      console.error(`Run in ${visibleTerminalText(result.guidance_shell)}:`);
    }
    for (const command of result.guidance || []) console.error(visibleTerminalText(command));
  } else {
    console.error("[blocked] Managed scaffold upgrade preserved one or more conflicts.");
    for (const conflict of result.conflicts) {
      console.error(`  ${visibleTerminalText(conflict.domain)}: ${visibleTerminalText(conflict.detail || conflict.reason)}`);
    }
  }
  process.exitCode = 1;
}

function comparePathEntry([left], [right]) {
  return compareUtf8Bytes(left, right);
}

async function skillsFirstCatalogCheck(domains, preview) {
  try {
    const [observed, config] = await Promise.all([
      domains.store.previewOfficialBatchComposition(),
      readAiosConfig(preview.aios_path)
    ]);
    const expected = domains.officialComposition.proof;
    const proof = observed.proof;
    return {
      current: Boolean(observed.skillsCatalog)
        && proof.conflicts.length === 0
        && proof.effects.repair_official_skills.length === 0
        && proof.effects.publish_catalogs === false
        && proof.candidate_invocation === expected.candidate_invocation
        && proof.source_fingerprint === expected.source_fingerprint
        && sameCatalogDigests(proof.desired_catalogs, expected.desired_catalogs)
        && sameCatalogDigests(proof.catalogs, expected.desired_catalogs)
        && Boolean(config.skills_first) === preview.skills_first
    };
  } catch {
    return { current: false };
  }
}

function sameCatalogDigests(left, right) {
  return Boolean(left && right)
    && left.registry_sha256 === right.registry_sha256
    && left.index_sha256 === right.index_sha256
    && left.resolver_sha256 === right.resolver_sha256;
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
