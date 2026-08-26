import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseDocument } from "yaml";
import {
  collectSkills,
  compareUtf8Bytes,
  renderResolverBytes,
  renderSkillsIndexBytes
} from "./skills.mjs";
import { acquireOperationLock, releaseOperationLock } from "./operation-lock.mjs";
import { assertOwnedFileStats, ensureOwnedDirectory } from "./owned-state.mjs";
import { normalizeAgentRegistry } from "./bridges.mjs";
import {
  isRecognizedOfficialSkillOverlay,
  loadOfficialSkillPackage,
  materializeOfficialCandidateBytes,
  officialSkillManifest,
  officialSkillNames
} from "./official-skills.mjs";
import { isPathWithinLexically } from "./paths.mjs";

const require = createRequire(import.meta.url);
const agentRegistry = require("./agents.json");

const INVENTORY_FORMAT = "dotaios-managed-skill-inventory/v1";
const PROOF_FORMAT = "dotaios-managed-skill-adoption-proof/v1";
const REMOVAL_PROOF_FORMAT = "dotaios-managed-skill-removal-proof/v1";
const REGISTRY_FORMAT = "dotaios-skill-install-inventory/v2";
const RECEIPT_FORMAT = "dotaios-managed-skill-receipt/v1";
const RECOVERY_RECORD_FORMAT = "dotaios-managed-skill-recovery/v1";
const PROJECTION_HISTORY_FORMAT = "dotaios-managed-projection-history/v1";
const JOURNAL_FORMAT = "dotaios-managed-skill-transaction/v1";
const LOCK_FORMAT = "dotaios-managed-skill-store-lock/v1";
const NAME_RE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const POSIX_MODE_MASK = 0o7777;
// Windows exposes synthetic permission bits; keep manifest modes as portable
// intent but do not classify those synthetic observations as ownership drift.
const ENFORCES_POSIX_MODES = process.platform !== "win32";
const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxEntries: 4096,
  maxFiles: 512,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRelativePathBytes: 1024,
  maxAgentRegistryBytes: 1024 * 1024,
  maxAgentRegistryEntries: 256,
  maxAgentFieldBytes: 1024,
  maxProjectionTargets: 128,
  maxProjectionFacts: 4096,
  maxOwnedSkills: 512,
  maxCatalogBytes: 4 * 1024 * 1024,
  maxRegistryBytes: 1024 * 1024,
  maxReceiptBytes: 4 * 1024 * 1024,
  maxJournalBytes: 16 * 1024 * 1024,
  maxRollbackBytes: 16 * 1024 * 1024
});
const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts",
  ".rb", ".pl", ".ps1", ".cmd", ".bat"
]);
const CONTENT_TYPES = new Map([
  [".bin", "application/octet-stream"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".sh", "text/x-shellscript"],
  [".py", "text/x-python"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".ts", "text/typescript"]
]);
const DERIVED_CANONICAL_FILES = new Set(["INDEX.md", "RESOLVER.md", "manifest.json"]);

export class ManagedSkillStoreError extends Error {
  constructor(code, reason, message = null) {
    super(message || reason.replaceAll("_", " "));
    this.name = "ManagedSkillStoreError";
    this.code = code;
    this.reason = reason;
  }
}

export function createManagedSkillStore({
  aiosPath,
  homePath,
  officialPackageRoot = null,
  officialCandidateVersion,
  limits = {},
  hooks = {}
}) {
  if (!aiosPath || !homePath) throw new TypeError("ManagedSkillStore requires aiosPath and homePath");
  const configuredLimits = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(configuredLimits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`ManagedSkillStore limit ${name} must be a positive safe integer`);
    }
  }
  const settings = Object.freeze({
    aiosPath: path.resolve(aiosPath),
    homePath: path.resolve(homePath),
    officialPackageRoot: officialPackageRoot ? path.resolve(officialPackageRoot) : null,
    officialCandidateVersion,
    limits: Object.freeze(configuredLimits),
    hooks
  });
  return Object.freeze({
    inspect: () => inspectManagedSkills(settings),
    previewOfficialBatch: () => previewOfficialSkillBatch(settings),
    applyOfficialBatch: (input) => applyOfficialSkillBatch(settings, input),
    previewAdoption: (input) => previewManagedSkillAdoption(settings, input),
    applyAdoption: (input) => applyManagedSkillAdoption(settings, input),
    reconcile: (input = {}) => reconcileManagedSkills(settings, input),
    remove: (input) => removeManagedSkill(settings, input)
  });
}

async function inspectManagedSkills(settings) {
  await assertStoreRoots(settings);
  const owned = [];
  const discovered = [];
  const excluded = [];
  const skillsRoot = path.join(settings.aiosPath, "skills");
  let inventoryEntries = 0;
  const canonicalEntries = await readDirectoryEntries(skillsRoot, {
    allowMissing: true,
    maxEntries: settings.limits.maxEntries
  });
  inventoryEntries += canonicalEntries.length;
  const targets = await projectionTargetsForSettings(settings);
  const nativeRoots = targets.map(({ path: targetPath }) => path.resolve(targetPath));
  const retainedRecovery = await readRetainedRecoveryRecords(settings);

  if (canonicalEntries.length > settings.limits.maxOwnedSkills + settings.limits.maxEntries) {
    throw managedError("bundle_bound_exceeded", "inventory_entry_bound_exceeded");
  }

  for (const entry of canonicalEntries) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_") || DERIVED_CANONICAL_FILES.has(entry.name)) continue;
    const entryPath = path.join(skillsRoot, entry.name);
    if (entry.kind === "directory") {
      const skillPath = path.join(entryPath, "SKILL.md");
      const skillStats = await lstatIfPresent(skillPath);
      if (skillStats?.isFile() && !skillStats.isSymbolicLink()) {
        owned.push({
          name: entry.name,
          source_kind: "aios-owned-directory",
          coordinate: `aios:${entry.name}`,
          path: entryPath
        });
        if (owned.length > settings.limits.maxOwnedSkills) {
          throw managedError("bundle_bound_exceeded", "owned_skill_bound_exceeded");
        }
      } else {
        excluded.push(excludedEntry(entry.name, "aios-owned-directory", `aios:${entry.name}`, "missing_real_skill_metadata"));
      }
      continue;
    }
    if (entry.kind === "symlink") {
      discovered.push({
        name: entry.name,
        source_kind: "discovered-canonical-link",
        coordinate: `aios-link:${entry.name}`,
        path: entryPath,
        link_target: await readLinkBounded(entryPath)
      });
      continue;
    }
    excluded.push(excludedEntry(entry.name, "canonical-entry", `aios:${entry.name}`, "canonical_entry_not_directory"));
  }

  for (const target of targets) {
    if (!(await projectionBoundarySafe(settings.homePath, target.path))) {
      excluded.push(excludedEntry(
        target.relativePath,
        "native-root",
        `native-root:${target.relativePath}`,
        "unsafe_native_root"
      ));
      continue;
    }
    const entries = await readDirectoryEntries(target.path, {
      allowMissing: true,
      maxEntries: settings.limits.maxEntries - inventoryEntries
    });
    inventoryEntries += entries.length;
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const entryPath = path.join(target.path, entry.name);
      const coordinate = `native:${target.relativePath}/${entry.name}`;
      if (entry.kind === "directory") {
        try {
          await inspectBundle(entryPath, entry.name, settings.limits);
          discovered.push({
            name: entry.name,
            source_kind: "discovered-native-directory",
            coordinate,
            path: entryPath,
            native_root: target.relativePath,
            hosts: target.hosts
          });
        } catch (error) {
          excluded.push(excludedEntry(
            entry.name,
            "discovered-native-directory",
            coordinate,
            stableReason(error)
          ));
        }
        continue;
      }
      if (entry.kind === "symlink") {
        const rawTarget = await readLinkBounded(entryPath);
        const resolved = path.resolve(path.dirname(entryPath), rawTarget);
        const canonical = path.join(skillsRoot, entry.name);
        if (sameLexicalPath(resolved, canonical)) continue;
        if (!nativeRoots.some((root) => path.dirname(resolved) === root)) {
          excluded.push(excludedEntry(entry.name, "discovered-native-link", coordinate, "linked_native_target_outside_configured_roots"));
          continue;
        }
        const intermediate = await lstatIfPresent(resolved);
        if (intermediate?.isSymbolicLink()) {
          const intermediateTarget = path.resolve(
            path.dirname(resolved),
            await readLinkBounded(resolved)
          );
          if (sameLexicalPath(intermediateTarget, canonical)) continue;
          excluded.push(excludedEntry(
            entry.name,
            "discovered-native-link",
            coordinate,
            "linked_native_chain_not_managed_projection"
          ));
          continue;
        }
        try {
          await inspectBundle(resolved, entry.name, settings.limits);
          discovered.push({
            name: entry.name,
            source_kind: "discovered-native-link",
            coordinate,
            path: entryPath,
            native_root: target.relativePath,
            hosts: target.hosts,
            link_target: rawTarget
          });
        } catch (error) {
          excluded.push(excludedEntry(entry.name, "discovered-native-link", coordinate, stableReason(error)));
        }
        continue;
      }
      excluded.push(excludedEntry(entry.name, "native-entry", coordinate, "native_entry_not_directory_or_link"));
    }
  }

  owned.sort(compareInventoryEntries);
  discovered.sort(compareInventoryEntries);
  excluded.sort(compareInventoryEntries);
  return Object.freeze({
    format: INVENTORY_FORMAT,
    owned,
    discovered_unmanaged: discovered,
    excluded_unsafe: excluded,
    retained_recovery: retainedRecovery,
    bounds: { ...settings.limits }
  });
}

async function readRetainedRecoveryRecords(settings) {
  const state = storeStatePaths(settings);
  const entries = await readDirectoryEntries(state.recoveries, {
    allowMissing: true,
    maxEntries: settings.limits.maxOwnedSkills
  });
  const records = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) {
      throw managedError("unsafe_state", "invalid_recovery_record_entry");
    }
    const record = await readOwnedJsonIfPresent(
      path.join(state.recoveries, entry.name),
      settings.limits.maxReceiptBytes
    );
    if (
      record?.format !== RECOVERY_RECORD_FORMAT
      || !/^skill-remove-[a-f0-9]{24}$/.test(record.operation_id || "")
      || entry.name !== `${record.operation_id}.json`
      || !NAME_RE.test(record.name || "")
      || !/^sha256:[a-f0-9]{64}$/.test(record.bundle_digest || "")
      || !sameLexicalPath(
        record.archive?.path || "",
        path.join(
          settings.aiosPath,
          "skills",
          ".managed-skill-store",
          "recovery",
          record.operation_id,
          record.name
        )
      )
      || record.archive?.identity?.type !== "directory"
    ) throw managedError("unsafe_state", "invalid_recovery_record");
    const archived = await inspectBundle(record.archive.path, record.name, settings.limits)
      .catch(() => null);
    if (
      archived?.bundleDigest !== record.bundle_digest
      || !matchesDirectoryProofIdentity(archived?.rootIdentity, record.archive.identity)
    ) throw managedError("unsafe_state", "stale_recovery_record");
    records.push({
      operation_id: record.operation_id,
      name: record.name,
      bundle_digest: record.bundle_digest,
      archive: record.archive.path,
      detached_projection_count: Array.isArray(record.detached_projections)
        ? record.detached_projections.length
        : 0
    });
  }
  return records.sort((left, right) => compareUtf8(left.operation_id, right.operation_id));
}

async function buildProjectionHistoryRecord(settings, proof) {
  const entries = [];
  const candidates = [
    ...proof.repairs.filter(({ kind }) => kind === "projection"),
    ...(proof.managed_projections || [])
  ];
  const seenCandidates = new Set();
  for (const candidate of candidates) {
    if (seenCandidates.has(candidate.relative_path)) continue;
    seenCandidates.add(candidate.relative_path);
    const segments = candidate.relative_path.split("/");
    const name = segments.pop();
    const targetRelativePath = segments.join("/");
    if (!NAME_RE.test(name || "")) continue;
    const receipt = await readOwnedJsonIfPresent(
      path.join(storeStatePaths(settings).receipts, `${name}.json`),
      settings.limits.maxReceiptBytes
    ).catch(() => null);
    if (!receipt) continue;
    try {
      await validateReceiptAuthority(settings, receipt, name);
    } catch {
      continue;
    }
    if (receipt.projections.some(({ relative_path: relativePath }) => relativePath === candidate.relative_path)) {
      continue;
    }
    entries.push({
      name,
      receipt_operation_id: receipt.operation_id,
      receipt_plan_fingerprint: receipt.plan_fingerprint,
      canonical_identity: receipt.canonical.identity,
      target_relative_path: targetRelativePath
    });
  }
  if (entries.length === 0) return null;
  entries.sort((left, right) => (
    compareUtf8(left.name, right.name)
    || compareUtf8(left.target_relative_path, right.target_relative_path)
  ));
  return {
    format: PROJECTION_HISTORY_FORMAT,
    operation_id: proof.operation_id,
    plan_fingerprint: proof.plan_fingerprint,
    entries
  };
}

function validateProjectionHistoryRecord(settings, record, expectedOperationId = null) {
  if (
    !record || typeof record !== "object" || Array.isArray(record)
    || record.format !== PROJECTION_HISTORY_FORMAT
    || !/^skill-reconcile-[a-f0-9]{24}$/.test(record.operation_id || "")
    || (expectedOperationId && record.operation_id !== expectedOperationId)
    || !/^sha256:[a-f0-9]{64}$/.test(record.plan_fingerprint || "")
    || !Array.isArray(record.entries)
    || record.entries.length === 0
    || record.entries.length > settings.limits.maxEntries
  ) throw managedError("unsafe_state", "invalid_projection_history");
  const seen = new Set();
  for (const entry of record.entries) {
    try { validateRelativePath(entry?.target_relative_path, settings.limits); } catch {
      throw managedError("unsafe_state", "invalid_projection_history_path");
    }
    const key = `${entry.name}:${entry.target_relative_path}`;
    if (
      !NAME_RE.test(entry?.name || "")
      || !/^skill-adopt-[a-f0-9]{24}$/.test(entry.receipt_operation_id || "")
      || !/^sha256:[a-f0-9]{64}$/.test(entry.receipt_plan_fingerprint || "")
      || entry.canonical_identity?.type !== "directory"
      || seen.has(key)
      || !isPathWithinLexically(
        settings.homePath,
        path.join(settings.homePath, ...entry.target_relative_path.split("/"), entry.name)
      )
    ) throw managedError("unsafe_state", "invalid_projection_history_entry");
    seen.add(key);
  }
}

async function refuseRetiredProjectionHistory(settings, receipt) {
  const state = storeStatePaths(settings);
  const records = await readDirectoryEntries(state.projectionHistory, {
    allowMissing: true,
    maxEntries: settings.limits.maxEntries
  });
  const currentTargets = new Set(
    (await projectionTargetsForSettings(settings)).map(({ relativePath }) => relativePath)
  );
  for (const entry of records) {
    if (entry.kind !== "file" || !/^skill-reconcile-[a-f0-9]{24}\.json$/.test(entry.name)) {
      throw managedError("unsafe_state", "invalid_projection_history_file");
    }
    const record = await readOwnedJsonIfPresent(
      path.join(state.projectionHistory, entry.name),
      settings.limits.maxReceiptBytes
    );
    validateProjectionHistoryRecord(settings, record);
    if (entry.name !== `${record.operation_id}.json`) {
      throw managedError("unsafe_state", "invalid_projection_history_file");
    }
    for (const history of record.entries) {
      if (
        history.name === receipt.name
        && history.receipt_operation_id === receipt.operation_id
        && history.receipt_plan_fingerprint === receipt.plan_fingerprint
        && matchesDirectoryProofIdentity(history.canonical_identity, receipt.canonical.identity)
        && !currentTargets.has(history.target_relative_path)
      ) throw managedError("unproved_removal", "retired_projection_target_requires_explicit_proof");
    }
  }
}

async function previewOfficialSkillBatch(settings) {
  return (await buildOfficialSkillBatchPlan(settings)).proof;
}

async function buildOfficialSkillBatchPlan(settings) {
  await assertStoreRoots(settings);
  const official = await loadOfficialPackageForStore(settings);
  const targets = [];
  const conflicts = [];
  for (const skill of official.skills) {
    const target = await classifyOfficialDestination(settings, skill);
    targets.push(target);
    conflicts.push(...target.conflicts);
  }

  const sourceFingerprint = officialSourceFingerprint(official);
  let desiredRegistry = null;
  let catalogSkills = null;
  let desiredCatalogs = null;
  if (conflicts.length === 0) {
    const catalogPlan = await buildOfficialCatalogPlan(settings, official);
    desiredRegistry = catalogPlan.registry;
    catalogSkills = catalogPlan.skills;
    desiredCatalogs = catalogPlan.catalogs;
  }
  const currentCatalogs = await inspectCatalogs(settings);
  const payload = {
    format: "dotaios-official-skill-batch-proof/v1",
    candidate_version: official.candidate_version,
    candidate_invocation: official.candidate_invocation,
    source_fingerprint: sourceFingerprint,
    targets,
    conflicts: conflicts.sort(compareCollisionEntries),
    catalogs: currentCatalogs,
    desired_catalogs: desiredCatalogs,
    effects: {
      repair_official_skills: targets.filter(({ action }) => action === "repair").map(({ name }) => name),
      publish_catalogs: conflicts.length === 0 && !sameCatalogDigests(currentCatalogs, desiredCatalogs)
    }
  };
  const hash = sha256(canonicalJson(payload));
  return {
    proof: deepFreeze({
      ...payload,
      operation_id: `skill-official-${hash.slice(0, 24)}`,
      plan_fingerprint: `sha256:${hash}`
    }),
    official,
    desiredRegistry,
    catalogSkills
  };
}

async function loadOfficialPackageForStore(settings) {
  const options = {};
  if (settings.officialPackageRoot) options.packageRoot = settings.officialPackageRoot;
  if (settings.officialCandidateVersion !== undefined) {
    options.candidateVersion = settings.officialCandidateVersion;
  }
  try {
    return await loadOfficialSkillPackage(options);
  } catch {
    throw managedError("unsafe_source", "official_skill_package_invalid");
  }
}

function officialSourceFingerprint(official) {
  return `sha256:${sha256(canonicalJson({
    manifest_format: official.manifest_format,
    candidate_version: official.candidate_version,
    skills: official.skills.map((skill) => ({
      name: skill.name,
      mode: skill.mode,
      overlays: skill.generated_overlays,
      files: skill.files.map((file) => ({
        path: file.path,
        mode: file.mode,
        bytes: file.bytes,
        packed_sha256: file.packed_sha256,
        installed_sha256: file.installed_sha256,
        predecessors: file.predecessors
      }))
    }))
  }))}`;
}

async function classifyOfficialDestination(settings, skill) {
  const destination = path.join(settings.aiosPath, "skills", skill.name);
  const rootStats = await lstatIfPresent(destination, { bigint: true });
  const candidateFiles = skill.files.map((file) => ({
    path: file.path,
    mode: file.mode,
    bytes: file.bytes,
    sha256: file.installed_sha256
  }));
  if (!rootStats) {
    return {
      name: skill.name,
      coordinate: `skills/${skill.name}`,
      classification: "missing-official",
      action: "repair",
      files: candidateFiles.map((file) => ({ ...file, classification: "missing-official" })),
      overlays: [],
      conflicts: [],
      current_manifest: null
    };
  }

  const rootIdentity = statIdentity(rootStats);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    const conflict = officialConflict(skill.name, "", "foreign-conflicting", "official_root_not_real_directory");
    return conflictingOfficialTarget(skill, rootIdentity, [conflict]);
  }
  if (ENFORCES_POSIX_MODES && (Number(rootStats.mode) & POSIX_MODE_MASK) !== skill.mode) {
    const conflict = officialConflict(skill.name, "", "mode-drift", "official_root_mode_drift");
    return conflictingOfficialTarget(skill, rootIdentity, [conflict]);
  }

  const entries = await readDirectoryEntries(destination, {
    maxEntries: settings.limits.maxEntries
  });
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const declaredFiles = new Set(skill.files.map(({ path: relative }) => relative));
  const declaredOverlays = new Map(skill.generated_overlays.map((overlay) => [overlay.path, overlay]));
  const conflicts = [];
  const files = [];
  const overlays = [];
  const manifestFiles = [];
  let recognizedExisting = false;

  for (const entry of entries) {
    if (!declaredFiles.has(entry.name) && !declaredOverlays.has(entry.name)) {
      conflicts.push(officialConflict(
        skill.name,
        entry.name,
        "unknown-extra",
        entry.kind === "directory" ? "unknown_extra_directory" : "unknown_extra_file"
      ));
    }
  }

  for (const expected of skill.files) {
    const entry = byName.get(expected.path);
    if (!entry) {
      files.push({
        path: expected.path,
        mode: expected.mode,
        bytes: expected.bytes,
        sha256: expected.installed_sha256,
        classification: "missing-official"
      });
      continue;
    }
    if (entry.kind !== "file") {
      conflicts.push(officialConflict(skill.name, expected.path, "foreign-conflicting", "official_file_not_regular"));
      files.push({ path: expected.path, classification: "foreign-conflicting" });
      continue;
    }
    let observed;
    try {
      observed = await readBoundedRegularFile(
        path.join(destination, expected.path),
        settings.limits.maxFileBytes
      );
    } catch {
      conflicts.push(officialConflict(skill.name, expected.path, "foreign-conflicting", "official_file_unreadable"));
      files.push({ path: expected.path, classification: "foreign-conflicting" });
      continue;
    }
    const mode = Number(observed.stats.mode) & POSIX_MODE_MASK;
    const digest = sha256(observed.bytes);
    const evidence = {
      path: expected.path,
      mode,
      bytes: observed.bytes.length,
      sha256: digest,
      identity: statIdentity(observed.stats)
    };
    manifestFiles.push(evidence);
    if (observed.stats.nlink !== 1n) {
      conflicts.push(officialConflict(skill.name, expected.path, "foreign-conflicting", "official_file_hardlinked"));
      files.push({ ...evidence, classification: "foreign-conflicting" });
    } else if (ENFORCES_POSIX_MODES && mode !== expected.mode) {
      conflicts.push(officialConflict(skill.name, expected.path, "mode-drift", "official_file_mode_drift"));
      files.push({ ...evidence, classification: "mode-drift" });
    } else if (digest === expected.installed_sha256) {
      recognizedExisting = true;
      files.push({ ...evidence, classification: "candidate-official" });
    } else {
      const releases = expected.predecessors
        .filter((predecessor) => (
          (!ENFORCES_POSIX_MODES || predecessor.mode === mode)
          && predecessor.sha256 === digest
        ))
        .map(({ release }) => release);
      if (releases.length > 0) {
        recognizedExisting = true;
        files.push({ ...evidence, classification: "accepted-official-predecessor", releases });
      } else {
        conflicts.push(officialConflict(skill.name, expected.path, "foreign-conflicting", "official_file_bytes_unrecognized"));
        files.push({ ...evidence, classification: "foreign-conflicting" });
      }
    }
  }

  for (const overlay of skill.generated_overlays) {
    const entry = byName.get(overlay.path);
    if (!entry) continue;
    if (entry.kind !== "file") {
      conflicts.push(officialConflict(skill.name, overlay.path, "foreign-conflicting", "generated_overlay_not_regular"));
      continue;
    }
    let observed;
    try {
      observed = await readBoundedRegularFile(
        path.join(destination, overlay.path),
        settings.limits.maxFileBytes
      );
    } catch {
      conflicts.push(officialConflict(skill.name, overlay.path, "foreign-conflicting", "generated_overlay_unreadable"));
      continue;
    }
    const mode = Number(observed.stats.mode) & POSIX_MODE_MASK;
    const evidence = {
      path: overlay.path,
      mode,
      bytes: observed.bytes.length,
      sha256: sha256(observed.bytes),
      identity: statIdentity(observed.stats),
      classification: "recognized-generated-overlay"
    };
    manifestFiles.push({ ...evidence, classification: undefined });
    if (
      observed.stats.nlink !== 1n
      || (ENFORCES_POSIX_MODES && mode !== overlay.mode)
      || !isRecognizedOfficialSkillOverlay(skill.name, overlay.path, observed.bytes)
    ) {
      conflicts.push(officialConflict(skill.name, overlay.path, "foreign-conflicting", "generated_overlay_unrecognized"));
      overlays.push({ ...evidence, classification: "foreign-conflicting" });
    } else {
      recognizedExisting = true;
      overlays.push(evidence);
    }
  }

  if (!recognizedExisting) {
    conflicts.push(officialConflict(skill.name, "", "personal-same-name-directory", "same_name_directory_unowned"));
  }
  const finalRootStats = await lstatIfPresent(destination, { bigint: true });
  if (!matchesProofIdentity(finalRootStats ? statIdentity(finalRootStats) : null, rootIdentity)) {
    throw managedError("source_changed", "official_destination_changed_during_preview");
  }
  const currentManifest = {
    root_identity: directoryProofIdentity(rootIdentity),
    mode: Number(rootStats.mode) & POSIX_MODE_MASK,
    files: manifestFiles.sort((left, right) => compareUtf8(left.path, right.path))
  };
  if (conflicts.length > 0) {
    return {
      name: skill.name,
      coordinate: `skills/${skill.name}`,
      classification: "foreign-conflicting",
      action: "blocked",
      files,
      overlays,
      conflicts,
      current_manifest: currentManifest
    };
  }

  const needsRepair = files.some(({ classification }) => classification !== "candidate-official");
  const hasPredecessor = files.some(({ classification }) => classification === "accepted-official-predecessor");
  return {
    name: skill.name,
    coordinate: `skills/${skill.name}`,
    classification: needsRepair
      ? (hasPredecessor ? "accepted-official-predecessor" : "mixed-recognized-official")
      : "candidate-official",
    action: needsRepair ? "repair" : "none",
    files,
    overlays,
    conflicts: [],
    current_manifest: currentManifest
  };
}

function conflictingOfficialTarget(skill, rootIdentity, conflicts) {
  return {
    name: skill.name,
    coordinate: `skills/${skill.name}`,
    classification: "foreign-conflicting",
    action: "blocked",
    files: [],
    overlays: [],
    conflicts,
    current_manifest: rootIdentity ? {
      root_identity: stableProofIdentity(rootIdentity),
      mode: Number(rootIdentity.mode) & POSIX_MODE_MASK,
      files: []
    } : null
  };
}

function officialConflict(name, relative, classification, reason) {
  return {
    coordinate: relative ? `skills/${name}/${relative}` : `skills/${name}`,
    classification,
    reason
  };
}

async function buildOfficialCatalogPlan(settings, official) {
  const officialNames = new Set(official.skills.map(({ name }) => name));
  const observed = await collectSkills(settings.aiosPath);
  const skills = [
    ...observed.filter(({ dir }) => !officialNames.has(dir)),
    ...official.skills.map(({ catalog }) => catalog)
  ].sort((left, right) => compareUtf8(left.name, right.name) || compareUtf8(left.dir, right.dir));
  const registry = normalizePortableRegistry(await readPortableRegistry(settings), skills);
  const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`);
  const indexBytes = renderSkillsIndexBytes(skills);
  const resolverBytes = renderResolverBytes(skills);
  if (
    registryBytes.length > settings.limits.maxRegistryBytes
    || indexBytes.length > settings.limits.maxCatalogBytes
    || resolverBytes.length > settings.limits.maxCatalogBytes
  ) throw managedError("bundle_bound_exceeded", "official_catalog_bound_exceeded");
  return {
    registry,
    skills,
    catalogs: {
      registry_sha256: sha256(registryBytes),
      index_sha256: sha256(indexBytes),
      resolver_sha256: sha256(resolverBytes)
    }
  };
}

function sameCatalogDigests(left, right) {
  return Boolean(right)
    && left.registry_sha256 === right.registry_sha256
    && left.index_sha256 === right.index_sha256
    && left.resolver_sha256 === right.resolver_sha256;
}

async function applyOfficialSkillBatch(settings, input = {}) {
  await assertStoreRoots(settings);
  const operationId = input.operationId || input.operation_id;
  const planFingerprint = input.planFingerprint || input.plan_fingerprint;
  if (!operationId || !planFingerprint) throw managedError("proof_mismatch", "exact_proof_required");

  const state = storeStatePaths(settings);
  await ensureStoreState(state);
  const lock = await acquireOperationLock(state.lock, {
    format: LOCK_FORMAT,
    strictOwnedState: true,
    ownedDirectories: [state.dotaios, state.root]
  });
  if (!lock) throw managedError("store_busy", "managed_skill_store_busy");
  try {
    await recoverPendingTransaction(settings, state);
    const plan = await buildOfficialSkillBatchPlan(settings);
    if (
      plan.proof.operation_id !== operationId
      || plan.proof.plan_fingerprint !== planFingerprint
    ) throw managedError("proof_mismatch", "official_batch_changed_under_lock");
    const repairs = plan.proof.targets.filter(({ action }) => action === "repair");
    const catalogsCurrent = sameCatalogDigests(plan.proof.catalogs, plan.proof.desired_catalogs);
    if (repairs.length === 0 && (plan.proof.conflicts.length > 0 || catalogsCurrent)) {
      return {
        status: plan.proof.conflicts.length > 0 ? "blocked-conflict" : "verified",
        repaired: [],
        conflicts: plan.proof.conflicts,
        catalogs_published: false
      };
    }
    return await commitOfficialSkillBatch(settings, state, plan);
  } finally {
    await releaseOperationLock(lock, { strictOwnedState: true }).catch(() => {});
    await cleanupEmptyStoreState(state).catch(() => {});
  }
}

async function commitOfficialSkillBatch(settings, state, plan) {
  const { proof, official, desiredRegistry, catalogSkills } = plan;
  const skillsRoot = path.join(settings.aiosPath, "skills");
  const stageRoot = path.join(skillsRoot, ".managed-skill-store", "staging", proof.operation_id);
  const recoveryRoot = path.join(skillsRoot, ".managed-skill-store", "recovery", proof.operation_id);
  const repairs = proof.targets.filter(({ action }) => action === "repair");
  const officialByName = new Map(official.skills.map((skill) => [skill.name, skill]));
  const oldArtifacts = await captureDerivedArtifacts(settings);
  const oldArtifactModes = await captureDerivedArtifactModes(settings);
  const journal = {
    format: JOURNAL_FORMAT,
    kind: "official-batch",
    state: "official_prepared",
    operation_id: proof.operation_id,
    plan_fingerprint: proof.plan_fingerprint,
    candidate_version: proof.candidate_version,
    source_fingerprint: proof.source_fingerprint,
    publish_catalogs: proof.effects.publish_catalogs,
    old_artifacts: oldArtifacts,
    old_artifact_modes: oldArtifactModes,
    targets: repairs.map((target) => ({
      name: target.name,
      destination: path.join(skillsRoot, target.name),
      staged_path: path.join(stageRoot, target.name),
      backup_path: path.join(recoveryRoot, "official-backups", target.name),
      rollback_path: path.join(recoveryRoot, "official-rollbacks", target.name),
      preimage: target.current_manifest,
      desired_files: desiredOfficialFiles(officialByName.get(target.name), target),
      stage_root_identity: null,
      staged_manifest: null
    }))
  };
  await writeJsonAtomic(state.journal, journal, settings.limits.maxJournalBytes);

  try {
    await checkpoint(settings, "official_prepared", journal);
    await ensureDirectoryChain(skillsRoot, stageRoot, 0o700);
    for (const target of journal.targets) {
      await createDurableDirectory(target.staged_path, 0o700);
      await checkpoint(settings, "official_stage_root_created", { name: target.name });
      target.stage_root_identity = directoryProofIdentity(
        statIdentity(await fs.lstat(target.staged_path, { bigint: true }))
      );
      await transitionJournal(state, journal, journal.state);
      await checkpoint(settings, "official_stage_root_identity_persisted", { name: target.name });
      await stageOfficialTarget(settings, target, officialByName.get(target.name));
      target.staged_manifest = await snapshotFlatOfficialTree(settings, target.staged_path);
      if (!officialTreeMatchesDesired(target.staged_manifest, target.desired_files, target.stage_root_identity)) {
        throw managedError("source_changed", "official_staged_tree_mismatch");
      }
      await transitionJournal(state, journal, journal.state);
    }
    await transitionJournal(state, journal, "official_staged");
    await checkpoint(settings, "official_batch_staged", journal);

    let revalidated;
    try {
      revalidated = await buildOfficialSkillBatchPlan(settings);
    } catch (error) {
      if (
        error instanceof ManagedSkillStoreError
        && !(error.code === "unsafe_source" && error.reason === "official_skill_package_invalid")
      ) throw error;
      throw managedError("source_changed", "official_source_changed_after_staging");
    }
    if (revalidated.proof.source_fingerprint !== proof.source_fingerprint) {
      throw managedError("source_changed", "official_source_changed_after_staging");
    }
    if (revalidated.proof.plan_fingerprint !== proof.plan_fingerprint) {
      throw managedError("destination_changed", "official_destination_changed_after_staging");
    }

    await transitionJournal(state, journal, "official_publishing");
    for (const target of journal.targets) {
      await assertOfficialPreimage(settings, target.destination, target.preimage);
      if (target.preimage) {
        await ensureDirectoryChain(skillsRoot, path.dirname(target.backup_path), 0o700);
        await renameAndSync(target.destination, target.backup_path);
        await checkpoint(settings, "official_target_backed_up", { name: target.name });
      }
      await renameAndSync(target.staged_path, target.destination);
      await checkpoint(settings, "official_target_published", { name: target.name });
      await transitionJournal(state, journal, journal.state);
    }

    const afterPublication = await buildOfficialSkillBatchPlan(settings);
    assertOfficialBatchVerification(afterPublication.proof, proof, repairs, {
      requireFullBatch: proof.conflicts.length === 0,
      expectedCurrentCatalogs: proof.conflicts.length === 0 ? proof.catalogs : null
    });
    await transitionJournal(state, journal, "official_verified");
    if (proof.conflicts.length === 0) {
      await checkpoint(settings, "official_batch_verified", { repaired: repairs.map(({ name }) => name) });
      const beforeCatalogPublication = await buildOfficialSkillBatchPlan(settings);
      assertOfficialBatchVerification(beforeCatalogPublication.proof, proof, repairs, {
        requireFullBatch: true,
        expectedCurrentCatalogs: proof.catalogs
      });
      if (proof.effects.publish_catalogs) {
        await transitionJournal(state, journal, "official_derived_publishing");
        await publishDerivedArtifacts(settings, desiredRegistry, catalogSkills);
        const afterCatalogPublication = await buildOfficialSkillBatchPlan(settings);
        assertOfficialBatchVerification(afterCatalogPublication.proof, proof, repairs, {
          requireFullBatch: true,
          expectedCurrentCatalogs: proof.desired_catalogs
        });
        await transitionJournal(state, journal, "official_derived_published");
      }
    } else {
      await checkpoint(settings, "official_repairs_verified", { repaired: repairs.map(({ name }) => name) });
      const afterRepairCheckpoint = await buildOfficialSkillBatchPlan(settings);
      assertOfficialBatchVerification(afterRepairCheckpoint.proof, proof, repairs);
    }

    await transitionJournal(state, journal, "official_committed");
    await finishCommittedOfficialBatch(settings, state, journal);
    return {
      status: proof.conflicts.length > 0 ? "blocked-conflict" : "verified",
      repaired: repairs.map(({ name }) => name),
      conflicts: proof.conflicts,
      catalogs_published: proof.effects.publish_catalogs
    };
  } catch (error) {
    if (!['official_committed', 'needs_attention'].includes(journal.state)) {
      await rollbackOfficialBatch(settings, state, journal).catch(() => {});
    }
    throw error;
  }
}

function assertOfficialBatchVerification(
  observed,
  expected,
  repairs,
  { requireFullBatch = false, expectedCurrentCatalogs = null } = {}
) {
  if (observed.source_fingerprint !== expected.source_fingerprint) {
    throw managedError("source_changed", "official_source_changed_after_publication");
  }
  for (const repaired of repairs) {
    const target = observed.targets.find(({ name }) => name === repaired.name);
    if (target?.classification !== "candidate-official") {
      throw managedError("destination_changed", "official_batch_verification_failed");
    }
  }
  if (!requireFullBatch) return;
  if (
    observed.conflicts.length > 0
    || observed.targets.some(({ classification }) => classification !== "candidate-official")
    || !sameCatalogDigests(observed.desired_catalogs, expected.desired_catalogs)
    || (expectedCurrentCatalogs && !sameCatalogDigests(observed.catalogs, expectedCurrentCatalogs))
  ) throw managedError("destination_changed", "official_batch_full_verification_failed");
}

function desiredOfficialFiles(skill, target) {
  const declaredOverlays = new Map(skill.generated_overlays.map((overlay) => [overlay.path, overlay]));
  const files = skill.files.map((file) => ({
    path: file.path,
    mode: file.mode,
    bytes: file.bytes,
    sha256: file.installed_sha256,
    packed_base64: file.packed_bytes.toString("base64"),
    kind: "candidate"
  }));
  for (const overlay of target.overlays.filter(({ classification }) => classification === "recognized-generated-overlay")) {
    const declared = declaredOverlays.get(overlay.path);
    if (!declared) throw managedError("unsafe_source", "official_overlay_manifest_invalid");
    files.push({
      path: overlay.path,
      // The journal records portable manifest intent. The observed mode is
      // synthetic on Windows and remains only in the destination preimage.
      mode: declared.mode,
      bytes: overlay.bytes,
      sha256: overlay.sha256,
      source_identity: overlay.identity,
      kind: "overlay"
    });
  }
  return files.sort((left, right) => compareUtf8(left.path, right.path));
}

async function stageOfficialTarget(settings, target, skill) {
  const candidateByPath = new Map(skill.files.map((file) => [file.path, file]));
  for (const desired of target.desired_files) {
    let bytes;
    if (desired.kind === "candidate") {
      bytes = candidateByPath.get(desired.path)?.installed_bytes;
    } else {
      const source = path.join(target.destination, desired.path);
      const observed = await readBoundedRegularFile(source, settings.limits.maxFileBytes);
      if (
        observed.stats.nlink !== 1n
        || (ENFORCES_POSIX_MODES && (Number(observed.stats.mode) & POSIX_MODE_MASK) !== desired.mode)
        || observed.bytes.length !== desired.bytes
        || sha256(observed.bytes) !== desired.sha256
        || !matchesProofIdentity(statIdentity(observed.stats), desired.source_identity)
      ) throw managedError("destination_changed", "official_overlay_changed_after_preview");
      bytes = observed.bytes;
    }
    if (!bytes || bytes.length !== desired.bytes || sha256(bytes) !== desired.sha256) {
      throw managedError("source_changed", "official_candidate_changed_after_preview");
    }
    const destination = path.join(target.staged_path, desired.path);
    await fs.writeFile(destination, bytes, { flag: "wx", mode: desired.mode });
    await fs.chmod(destination, desired.mode);
    await syncFile(destination);
  }
  await fs.chmod(target.staged_path, 0o755);
  await syncDirectory(target.staged_path);
}

async function snapshotFlatOfficialTree(settings, root) {
  const rootStats = await lstatIfPresent(root, { bigint: true });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw managedError("destination_changed", "official_tree_not_real_directory");
  }
  const entries = await readDirectoryEntries(root, { maxEntries: settings.limits.maxEntries });
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== "file") throw managedError("destination_changed", "official_tree_contains_unsafe_entry");
    const observed = await readBoundedRegularFile(path.join(root, entry.name), settings.limits.maxFileBytes);
    if (observed.stats.nlink !== 1n) throw managedError("destination_changed", "official_tree_file_hardlinked");
    totalBytes += observed.bytes.length;
    if (totalBytes > settings.limits.maxTotalBytes) {
      throw managedError("bundle_bound_exceeded", "official_tree_byte_bound_exceeded");
    }
    files.push({
      path: entry.name,
      mode: Number(observed.stats.mode) & POSIX_MODE_MASK,
      bytes: observed.bytes.length,
      sha256: sha256(observed.bytes),
      identity: statIdentity(observed.stats)
    });
  }
  const finalRootStats = await lstatIfPresent(root, { bigint: true });
  if (!matchesProofIdentity(finalRootStats ? statIdentity(finalRootStats) : null, statIdentity(rootStats))) {
    throw managedError("destination_changed", "official_tree_changed_during_inspection");
  }
  return {
    root_identity: directoryProofIdentity(statIdentity(rootStats)),
    mode: Number(rootStats.mode) & POSIX_MODE_MASK,
    files: files.sort((left, right) => compareUtf8(left.path, right.path))
  };
}

function stableProofIdentity(identity) {
  return identity ? {
    type: identity.type,
    dev: String(identity.dev),
    ino: String(identity.ino)
  } : null;
}

function directoryProofIdentity(identity) {
  const proof = stableProofIdentity(identity);
  return proof?.type === "directory" ? proof : null;
}

function officialTreeMatchesDesired(observed, desiredFiles, expectedRootIdentity) {
  if (
    (ENFORCES_POSIX_MODES && observed?.mode !== 0o755)
    || !matchesDirectoryProofIdentity(observed?.root_identity, expectedRootIdentity)
    || observed.files.length !== desiredFiles.length
  ) return false;
  return observed.files.every((file, index) => {
    const desired = desiredFiles[index];
    return file.path === desired.path
      && (!ENFORCES_POSIX_MODES || file.mode === desired.mode)
      && file.bytes === desired.bytes
      && file.sha256 === desired.sha256;
  });
}

function officialTreeMatchesManifest(observed, expected) {
  if (
    !observed || !expected
    || (ENFORCES_POSIX_MODES && observed.mode !== expected.mode)
    || !matchesDirectoryProofIdentity(observed.root_identity, expected.root_identity)
    || observed.files.length !== expected.files.length
  ) return false;
  return observed.files.every((file, index) => {
    const wanted = expected.files[index];
    return file.path === wanted.path
      && (!ENFORCES_POSIX_MODES || file.mode === wanted.mode)
      && file.bytes === wanted.bytes
      && file.sha256 === wanted.sha256
      && matchesLeafProofIdentity(file.identity, wanted.identity);
  });
}

async function assertOfficialPreimage(settings, destination, preimage) {
  const stats = await lstatIfPresent(destination);
  if (!preimage) {
    if (stats) throw managedError("destination_changed", "official_destination_appeared");
    return;
  }
  if (!stats) throw managedError("destination_changed", "official_destination_disappeared");
  const observed = await snapshotFlatOfficialTree(settings, destination);
  if (!officialTreeMatchesManifest(observed, preimage)) {
    throw managedError("destination_changed", "official_destination_changed");
  }
}

async function rollbackOfficialBatch(settings, state, journal) {
  try {
    for (const target of [...journal.targets].reverse()) {
      const [destinationStats, backupStats, stagedStats] = await Promise.all([
        lstatIfPresent(target.destination),
        lstatIfPresent(target.backup_path),
        lstatIfPresent(target.staged_path)
      ]);
      if (destinationStats) {
        const destination = await snapshotFlatOfficialTree(settings, target.destination);
        if (target.staged_manifest && officialTreeMatchesManifest(destination, target.staged_manifest)) {
          await ensureDirectoryChain(
            path.join(settings.aiosPath, "skills"),
            path.dirname(target.rollback_path),
            0o700
          );
          if (await lstatIfPresent(target.rollback_path)) {
            throw managedError("recovery_required", "official_rollback_path_changed");
          }
          await renameAndSync(target.destination, target.rollback_path);
          if (target.preimage) {
            if (!backupStats) throw managedError("recovery_required", "official_backup_missing");
            const backup = await snapshotFlatOfficialTree(settings, target.backup_path);
            if (!officialTreeMatchesManifest(backup, target.preimage)) {
              throw managedError("recovery_required", "official_backup_changed");
            }
            await renameAndSync(target.backup_path, target.destination);
          } else if (backupStats) {
            throw managedError("recovery_required", "unexpected_official_backup");
          }
          await removePartialOfficialTree(
            settings,
            target.rollback_path,
            target.staged_manifest.files,
            target.staged_manifest.root_identity
          );
        } else if (!target.preimage || !officialTreeMatchesManifest(destination, target.preimage) || backupStats) {
          throw managedError("recovery_required", "official_destination_rollback_needs_attention");
        }
      } else if (backupStats) {
        if (!target.preimage) throw managedError("recovery_required", "unexpected_official_backup");
        const backup = await snapshotFlatOfficialTree(settings, target.backup_path);
        if (!officialTreeMatchesManifest(backup, target.preimage)) {
          throw managedError("recovery_required", "official_backup_changed");
        }
        await renameAndSync(target.backup_path, target.destination);
      } else if (target.preimage) {
        throw managedError("recovery_required", "official_destination_and_backup_missing");
      }

      if (await lstatIfPresent(target.rollback_path)) {
        if (!target.staged_manifest) {
          throw managedError("recovery_required", "official_rollback_manifest_missing");
        }
        await removePartialOfficialTree(
          settings,
          target.rollback_path,
          target.staged_manifest.files,
          target.staged_manifest.root_identity
        );
      }

      if (stagedStats) {
        await removeOfficialStagedTree(settings, target, {
          allowIncomplete: journal.state === "official_prepared",
          candidateVersion: journal.candidate_version
        });
      }
    }
    // A conflict batch repairs only safe official roots and never publishes
    // dependent catalogs. Its rollback therefore has no catalog write to undo;
    // restoring the prepared snapshot would clobber an unrelated concurrent edit.
    if (
      journal.publish_catalogs
      && ["official_derived_publishing", "official_derived_published"].includes(journal.state)
    ) {
      await restoreDerivedArtifacts(settings.aiosPath, journal.old_artifacts);
      await restoreDerivedArtifactModes(settings.aiosPath, journal.old_artifact_modes);
    }
    await removeFileAndSync(state.journal);
    await cleanupOfficialBatchParents(settings.aiosPath, journal.operation_id);
  } catch (error) {
    await transitionJournal(state, journal, "needs_attention").catch(() => {});
    throw error;
  }
}

async function finishCommittedOfficialBatch(settings, state, journal) {
  try {
    for (const target of journal.targets) {
      if (await lstatIfPresent(target.backup_path)) {
        if (!target.preimage) throw managedError("recovery_required", "unexpected_official_backup");
        await removePartialOfficialTree(
          settings,
          target.backup_path,
          target.preimage.files,
          target.preimage.root_identity
        );
      }
      if (await lstatIfPresent(target.staged_path)) {
        await removeOfficialStagedTree(settings, target, {
          candidateVersion: journal.candidate_version
        });
      }
      if (await lstatIfPresent(target.rollback_path)) {
        await removePartialOfficialTree(
          settings,
          target.rollback_path,
          target.staged_manifest?.files || target.desired_files,
          target.staged_manifest?.root_identity || target.stage_root_identity
        );
      }
    }
    await removeFileAndSync(state.journal);
    await cleanupOfficialBatchParents(settings.aiosPath, journal.operation_id);
  } catch (error) {
    await transitionJournal(state, journal, "needs_attention").catch(() => {});
    throw error;
  }
}

async function removePartialOfficialTree(
  settings,
  root,
  allowedFiles,
  expectedRootIdentity,
  { beforeUnlink = null } = {}
) {
  const rootStats = await lstatIfPresent(root, { bigint: true });
  if (!rootStats) return;
  if (
    !rootStats.isDirectory()
    || rootStats.isSymbolicLink()
    || !matchesDirectoryProofIdentity(statIdentity(rootStats), expectedRootIdentity)
  ) throw managedError("recovery_required", "official_cleanup_root_changed");
  const allowed = new Map(allowedFiles.map((file) => [file.path, file]));
  const entries = await readDirectoryEntries(root, { maxEntries: settings.limits.maxEntries });
  for (const entry of entries) {
    const expected = allowed.get(entry.name);
    if (!expected || entry.kind !== "file") {
      throw managedError("recovery_required", "official_cleanup_tree_changed");
    }
    const observed = await readBoundedRegularFile(path.join(root, entry.name), settings.limits.maxFileBytes);
    if (
      observed.stats.nlink !== 1n
      || (ENFORCES_POSIX_MODES && (Number(observed.stats.mode) & POSIX_MODE_MASK) !== expected.mode)
      || observed.bytes.length !== expected.bytes
      || sha256(observed.bytes) !== expected.sha256
      || (expected.identity && !matchesLeafProofIdentity(statIdentity(observed.stats), expected.identity))
    ) throw managedError("recovery_required", "official_cleanup_file_changed");
    if (beforeUnlink) await beforeUnlink(expected, observed);
    await unlinkAndSync(path.join(root, entry.name));
    await checkpoint(settings, "official_cleanup_file_removed", { root, path: entry.name });
  }
  await removeEmptyDirectoryAndSync(root);
}

async function removeOfficialStagedTree(
  settings,
  target,
  { allowIncomplete = false, candidateVersion = null } = {}
) {
  const rootStats = await lstatIfPresent(target.staged_path, { bigint: true });
  if (!rootStats) return;
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw managedError("recovery_required", "official_cleanup_root_changed");
  }

  if (!target.stage_root_identity) {
    if (!allowIncomplete) {
      throw managedError("recovery_required", "official_cleanup_manifest_missing");
    }
    const entries = await readDirectoryEntries(target.staged_path, {
      maxEntries: settings.limits.maxEntries
    });
    if (entries.length > 0) {
      throw managedError("recovery_required", "official_cleanup_tree_changed");
    }
    await removeEmptyDirectoryAndSync(target.staged_path);
    return;
  }

  if (!matchesDirectoryProofIdentity(statIdentity(rootStats), target.stage_root_identity)) {
    throw managedError("recovery_required", "official_cleanup_root_changed");
  }
  if (target.staged_manifest) {
    await removePartialOfficialTree(
      settings,
      target.staged_path,
      target.staged_manifest.files,
      target.stage_root_identity
    );
    return;
  }
  if (!allowIncomplete || !candidateVersion) {
    throw managedError("recovery_required", "official_cleanup_manifest_missing");
  }

  const rootMode = Number(rootStats.mode) & POSIX_MODE_MASK;
  if (!ENFORCES_POSIX_MODES || rootMode === 0o700) {
    await removeIncompleteOfficialStage(settings, target, candidateVersion);
    return;
  }
  if (ENFORCES_POSIX_MODES && rootMode !== 0o755) {
    throw managedError("recovery_required", "official_cleanup_root_changed");
  }

  const observed = await snapshotFlatOfficialTree(settings, target.staged_path);
  if (!await officialTreeMatchesCleanupAuthority(
    settings,
    target,
    observed,
    candidateVersion
  )) {
    throw managedError("recovery_required", "official_cleanup_tree_changed");
  }
  await removePartialOfficialTree(
    settings,
    target.staged_path,
    target.desired_files,
    target.stage_root_identity,
    {
      beforeUnlink: async (desired, staged) => {
        const authority = await officialCleanupAuthorityBytes(
          settings,
          target,
          desired,
          candidateVersion
        );
        if (
          staged.bytes.length !== authority.length
          || !staged.bytes.equals(authority)
        ) throw managedError("recovery_required", "official_cleanup_file_changed");
      }
    }
  );
}

async function removeIncompleteOfficialStage(settings, target, candidateVersion) {
  const allowed = new Map(target.desired_files.map((file) => [file.path, file]));
  const entries = await readDirectoryEntries(target.staged_path, {
    maxEntries: settings.limits.maxEntries
  });
  const leaves = [];
  for (const entry of entries) {
    const expected = allowed.get(entry.name);
    if (!expected || entry.kind !== "file") {
      throw managedError("recovery_required", "official_cleanup_tree_changed");
    }
    let observed;
    try {
      observed = await readBoundedRegularFile(
        path.join(target.staged_path, entry.name),
        expected.bytes
      );
    } catch {
      throw managedError("recovery_required", "official_cleanup_file_changed");
    }
    const authority = await officialCleanupAuthorityBytes(
      settings,
      target,
      expected,
      candidateVersion
    );
    if (
      observed.bytes.length > authority.length
      || !observed.bytes.equals(authority.subarray(0, observed.bytes.length))
    ) throw managedError("recovery_required", "official_cleanup_file_changed");
    leaves.push({
      path: path.join(target.staged_path, entry.name),
      expected,
      identity: statIdentity(observed.stats)
    });
  }

  const rootStats = await lstatIfPresent(target.staged_path, { bigint: true });
  if (
    !rootStats?.isDirectory()
    || rootStats.isSymbolicLink()
    || (ENFORCES_POSIX_MODES && (Number(rootStats.mode) & POSIX_MODE_MASK) !== 0o700)
    || !matchesDirectoryProofIdentity(statIdentity(rootStats), target.stage_root_identity)
  ) throw managedError("recovery_required", "official_cleanup_root_changed");

  for (const leaf of leaves) {
    let current;
    try {
      current = await readBoundedRegularFile(leaf.path, leaf.expected.bytes);
    } catch {
      throw managedError("recovery_required", "official_cleanup_file_changed");
    }
    if (!matchesProofIdentity(statIdentity(current.stats), leaf.identity)) {
      throw managedError("recovery_required", "official_cleanup_file_changed");
    }
    const authority = await officialCleanupAuthorityBytes(
      settings,
      target,
      leaf.expected,
      candidateVersion
    );
    if (
      current.bytes.length > authority.length
      || !current.bytes.equals(authority.subarray(0, current.bytes.length))
    ) throw managedError("recovery_required", "official_cleanup_file_changed");
    await unlinkAndSync(leaf.path);
    await checkpoint(settings, "official_cleanup_file_removed", {
      root: target.staged_path,
      path: path.basename(leaf.path)
    });
  }
  await removeEmptyDirectoryAndSync(target.staged_path);
}

async function officialTreeMatchesCleanupAuthority(
  settings,
  target,
  observed,
  candidateVersion
) {
  if (
    (ENFORCES_POSIX_MODES && observed?.mode !== 0o755)
    || !matchesDirectoryProofIdentity(observed?.root_identity, target.stage_root_identity)
    || observed.files.length !== target.desired_files.length
  ) return false;
  for (let index = 0; index < observed.files.length; index += 1) {
    const file = observed.files[index];
    const desired = target.desired_files[index];
    if (
      file.path !== desired.path
      || (ENFORCES_POSIX_MODES && file.mode !== desired.mode)
    ) return false;
    const authority = await officialCleanupAuthorityBytes(
      settings,
      target,
      desired,
      candidateVersion
    );
    if (file.bytes !== authority.length || file.sha256 !== sha256(authority)) return false;
  }
  return true;
}

async function officialCleanupAuthorityBytes(settings, target, desired, candidateVersion) {
  if (desired.kind === "candidate") {
    const definition = officialSkillManifest().skills
      .find(({ name }) => name === target.name)
      ?.files.find(({ path: relative }) => relative === desired.path);
    let packed;
    let installed;
    try {
      packed = decodeCanonicalBase64(desired.packed_base64, settings.limits.maxFileBytes);
      installed = materializeOfficialCandidateBytes(packed, definition?.render, candidateVersion);
    } catch {
      throw managedError("recovery_required", "official_cleanup_file_changed");
    }
    if (
      !definition
      || packed.length !== definition.bytes
      || sha256(packed) !== definition.packed_sha256
      || installed.length !== desired.bytes
      || sha256(installed) !== desired.sha256
    ) throw managedError("recovery_required", "official_cleanup_file_changed");
    return installed;
  }

  const declaredOverlay = officialSkillManifest().skills
    .find(({ name }) => name === target.name)
    ?.generated_overlays.find(({ path: relative }) => relative === desired.path);
  if (!declaredOverlay || desired.kind !== "overlay") {
    throw managedError("recovery_required", "official_cleanup_file_changed");
  }
  let source;
  try {
    source = await readBoundedRegularFile(
      path.join(target.destination, desired.path),
      settings.limits.maxFileBytes
    );
  } catch {
    throw managedError("recovery_required", "official_cleanup_file_changed");
  }
  if (
    source.stats.nlink !== 1n
    || (ENFORCES_POSIX_MODES && (Number(source.stats.mode) & POSIX_MODE_MASK) !== declaredOverlay.mode)
    || source.bytes.length !== desired.bytes
    || sha256(source.bytes) !== desired.sha256
    || !matchesProofIdentity(statIdentity(source.stats), desired.source_identity)
    || !isRecognizedOfficialSkillOverlay(target.name, desired.path, source.bytes)
  ) throw managedError("recovery_required", "official_cleanup_file_changed");
  return source.bytes;
}

async function cleanupOfficialBatchParents(aiosPath, operationId) {
  const internal = path.join(aiosPath, "skills", ".managed-skill-store");
  const candidates = [
    path.join(internal, "staging", operationId),
    path.join(internal, "recovery", operationId, "official-backups"),
    path.join(internal, "recovery", operationId, "official-rollbacks"),
    path.join(internal, "recovery", operationId),
    path.join(internal, "staging"),
    path.join(internal, "recovery"),
    internal
  ];
  for (const directory of candidates) await fs.rmdir(directory).catch(() => {});
}

async function previewManagedSkillAdoption(settings, input = {}) {
  await assertStoreRoots(settings);
  const selectedPath = resolveSelectedSource(input.sourcePath);
  const source = await resolveAdoptionSource(settings, selectedPath, input.sourceKind);
  const bundle = await inspectBundle(source.bundlePath, path.basename(selectedPath), settings.limits);
  const registry = await readPortableRegistry(settings);
  const canonicalPath = path.join(settings.aiosPath, "skills", bundle.name);
  const canonicalCollision = await classifyCanonicalCollision({
    canonicalPath,
    selectedPath,
    source,
    bundle,
    registry,
    limits: settings.limits
  });
  const projections = [];
  const collisions = [];
  const targets = await projectionTargetsForSettings(settings);
  assertProjectionFactBound(settings, 1, targets.length);
  if (canonicalCollision.classification !== "absent") collisions.push(canonicalCollision);

  for (const target of targets) {
    const destination = path.join(target.path, bundle.name);
    const classification = await classifyProjection({
      homePath: settings.homePath,
      destination,
      canonicalPath,
      sourcePath: selectedPath,
      sourceBundlePath: source.bundlePath
    });
    const projection = {
      relative_path: `${target.relativePath}/${bundle.name}`,
      hosts: target.hosts,
      classification: classification.classification,
      target: canonicalPath
    };
    projections.push(projection);
    if (!["absent", "exact-managed-projection"].includes(classification.classification)) {
      collisions.push({
        classification: classification.classification,
        coordinate: projection.relative_path,
        hosts: target.hosts
      });
    }
  }

  const catalogs = await inspectCatalogs(settings);
  const proofPayload = {
    format: PROOF_FORMAT,
    source: {
      kind: source.kind,
      path: selectedPath,
      bundle_path: source.bundlePath,
      identity: source.identity,
      ...(source.link && { link: source.link }),
      portable_provenance: await portableProvenance(settings, source, bundle)
    },
    skill: publicBundle(bundle),
    collisions: collisions.sort(compareCollisionEntries),
    projections: projections.sort((left, right) => compareUtf8(left.relative_path, right.relative_path)),
    catalogs,
    effects: adoptionEffects(source, bundle, projections)
  };
  const hash = sha256(canonicalJson(proofPayload));
  return deepFreeze({
    ...proofPayload,
    operation_id: `skill-adopt-${hash.slice(0, 24)}`,
    plan_fingerprint: `sha256:${hash}`
  });
}

async function applyManagedSkillAdoption(settings, input = {}) {
  await assertStoreRoots(settings);
  const selectedPath = resolveSelectedSource(input.sourcePath || input.source?.path);
  const operationId = input.operationId || input.operation_id;
  const planFingerprint = input.planFingerprint || input.plan_fingerprint;
  if (!operationId || !planFingerprint) throw managedError("proof_mismatch", "exact_proof_required");

  const state = storeStatePaths(settings);
  await ensureStoreState(state);
  const lock = await acquireOperationLock(state.lock, {
    format: LOCK_FORMAT,
    strictOwnedState: true,
    ownedDirectories: [state.dotaios, state.root]
  });
  if (!lock) throw managedError("store_busy", "managed_skill_store_busy");

  try {
    await recoverPendingTransaction(settings, state);
    const existing = await exactExistingAdoption(settings, {
      selectedPath,
      operationId,
      planFingerprint
    });
    if (existing) return existing;
    let proof;
    try {
      proof = await previewManagedSkillAdoption(settings, {
        sourcePath: selectedPath,
        sourceKind: input.sourceKind || input.source?.kind
      });
    } catch (error) {
      if (error instanceof ManagedSkillStoreError) throw error;
      throw managedError("source_changed", "source_changed");
    }
    if (proof.operation_id !== operationId || proof.plan_fingerprint !== planFingerprint) {
      const collision = proof.collisions.some((entry) => entry.classification !== "exact-managed-projection");
      throw managedError(collision ? "destination_changed" : "source_changed", "proof_changed_under_lock");
    }
    assertAdoptionPlanApplicable(proof);
    return await commitAdoption(settings, state, proof);
  } finally {
    await releaseOperationLock(lock, { strictOwnedState: true }).catch(() => {});
    await cleanupEmptyStoreState(state).catch(() => {});
  }
}

async function exactExistingAdoption(settings, { selectedPath, operationId, planFingerprint }) {
  const name = path.basename(selectedPath);
  if (!NAME_RE.test(name)) return null;
  const state = storeStatePaths(settings);
  const receipt = await readOwnedJsonIfPresent(
    path.join(state.receipts, `${name}.json`),
    settings.limits.maxReceiptBytes
  );
  if (
    receipt?.format !== RECEIPT_FORMAT
    || receipt.operation_id !== operationId
    || receipt.plan_fingerprint !== planFingerprint
    || receipt.name !== name
  ) return null;
  await validateReceiptAuthority(settings, receipt, name);
  const canonicalPath = path.join(settings.aiosPath, "skills", name);
  const canonical = await inspectBundle(canonicalPath, name, settings.limits).catch(() => null);
  if (
    canonical?.bundleDigest !== receipt.bundle.bundle_digest
    || !matchesProofIdentity(canonical.rootIdentity, receipt.canonical?.identity)
  ) {
    throw managedError("destination_changed", "canonical_destination_changed");
  }
  if (receipt.source.kind === "local-reviewed-directory") {
    const source = await inspectBundle(selectedPath, name, settings.limits).catch(() => null);
    if (
      source?.bundleDigest !== receipt.bundle.bundle_digest
      || !matchesDirectoryProofIdentity(source?.rootIdentity, receipt.source.identity)
    ) {
      throw managedError("source_changed", "source_changed_after_adoption");
    }
  } else if (receipt.source.kind === "discovered-native-directory") {
    const stats = await lstatIfPresent(selectedPath);
    if (!stats?.isSymbolicLink()) throw managedError("destination_changed", "native_projection_changed");
    const target = path.resolve(path.dirname(selectedPath), await readLinkBounded(selectedPath));
    if (!sameLexicalPath(target, canonicalPath)) throw managedError("destination_changed", "native_projection_changed");
    const backup = receipt.replaced_source?.backup;
    const archived = backup ? await inspectBundle(backup, name, settings.limits).catch(() => null) : null;
    if (
      archived?.bundleDigest !== receipt.bundle.bundle_digest
      || !matchesDirectoryProofIdentity(
        archived?.rootIdentity,
        receipt.replaced_source?.backup_evidence?.identity
          || receipt.replaced_source?.source_evidence?.identity
      )
    ) {
      throw managedError("recovery_required", "native_backup_changed");
    }
  } else if (receipt.source.kind === "discovered-canonical-link") {
    const backup = receipt.replaced_source?.backup;
    const expected = receipt.replaced_source?.backup_evidence || receipt.replaced_source?.source_evidence;
    const observed = backup ? await linkEvidence(backup).catch(() => null) : null;
    if (
      !observed
      || observed.target !== expected?.target
      || !matchesLeafProofIdentity(observed.identity, expected?.identity)
    ) throw managedError("recovery_required", "shelf_backup_changed");
  }
  const projections = await inspectReceiptProjections(settings, receipt);
  if (receipt.projections.length !== (await projectionTargetsForSettings(settings)).length) return null;
  if (projections.some(({ classification }) => classification === "absent")) return null;
  const registry = await readPortableRegistry(settings);
  const row = (registry.managed || []).find((entry) => entry.name === name);
  if (
    row?.bundle_digest !== receipt.bundle.bundle_digest
    || row?.source_kind !== receipt.source.kind
  ) return null;
  const skills = await collectSkills(settings.aiosPath);
  const catalogs = await inspectCatalogs(settings);
  if (
    catalogs.index_sha256 !== sha256(renderSkillsIndexBytes(skills))
    || catalogs.resolver_sha256 !== sha256(renderResolverBytes(skills))
  ) return null;
  return { status: "already_adopted", name, bundle_digest: receipt.bundle.bundle_digest };
}

function assertAdoptionPlanApplicable(proof) {
  const blocking = proof.collisions.filter((entry) => ![
    "selected-canonical-link",
    "selected-native-source",
    "indirect-selected-source",
    "canonical-owned-identical",
    "exact-managed-projection"
  ].includes(entry.classification));
  if (blocking.length > 0) throw managedError("collision", "unmanaged_collision");
}

async function commitAdoption(settings, state, proof) {
  const name = proof.skill.name;
  const canonicalPath = path.join(settings.aiosPath, "skills", name);
  const stageRoot = path.join(settings.aiosPath, "skills", ".managed-skill-store", "staging", proof.operation_id);
  const stagedBundle = path.join(stageRoot, name);
  const receiptPath = path.join(state.receipts, `${name}.json`);
  const oldReceipt = await readOwnedJsonIfPresent(receiptPath, settings.limits.maxReceiptBytes);
  if (oldReceipt) await validateReceiptAuthority(settings, oldReceipt, name);
  const skillsRoot = path.join(settings.aiosPath, "skills");
  await ensureRealDirectory(skillsRoot);
  const sourceBundlePath = proof.source.bundle_path;
  const oldArtifacts = await captureDerivedArtifacts(settings);
  const journal = {
    format: JOURNAL_FORMAT,
    kind: "adoption",
    state: "prepared",
    operation_id: proof.operation_id,
    plan_fingerprint: proof.plan_fingerprint,
    name,
    source: proof.source,
    skill: proof.skill,
    canonical_path: canonicalPath,
    staged_bundle: stagedBundle,
    staged_root_identity: null,
    canonical_publish_identity: null,
    canonical_preexisting_identity: null,
    old_artifacts: oldArtifacts,
    old_receipt: oldReceipt,
    created_projections: [],
    created_projection_evidence: {},
    projection_parent_chains: {},
    created_directories: [],
    pending_projection: null,
    replaced_source: null
  };
  await writeJsonAtomic(state.journal, journal, settings.limits.maxJournalBytes);

  try {
    await checkpoint(settings, "prepared", journal);
    await ensureDirectoryChain(skillsRoot, path.dirname(stagedBundle), 0o700);
    const stagedRootStats = await lstatIfPresent(stageRoot, { bigint: true });
    journal.staged_root_identity = stagedRootStats ? statIdentity(stagedRootStats) : null;
    await transitionJournal(state, journal, journal.state);
    await createDurableDirectory(stagedBundle, 0o700);
    const emptyStagedStats = await fs.lstat(stagedBundle, { bigint: true });
    journal.canonical_publish_identity = statIdentity(emptyStagedStats);
    await transitionJournal(state, journal, journal.state);
    await copyProofBundle(sourceBundlePath, stagedBundle, proof.skill);
    await checkpoint(settings, "bundle_durable", { operation_id: proof.operation_id, name });
    const staged = await inspectBundle(stagedBundle, name, settings.limits);
    if (
      staged.bundleDigest !== proof.skill.bundle_digest
      || !matchesDirectoryProofIdentity(staged.rootIdentity, journal.canonical_publish_identity)
    ) {
      throw managedError("source_changed", "staged_bundle_digest_mismatch");
    }
    await checkpoint(settings, "bundle_staged", { operation_id: proof.operation_id, name });
    const sourceBeforePublish = await inspectBundle(sourceBundlePath, name, settings.limits);
    if (
      sourceBeforePublish.bundleDigest !== proof.skill.bundle_digest
      || !matchesProofIdentity(sourceBeforePublish.rootIdentity, proof.source.identity)
    ) {
      throw managedError("source_changed", "source_changed_after_staging");
    }
    if (proof.source.kind === "discovered-canonical-link") {
      const backup = path.join(
        skillsRoot,
        ".managed-skill-store",
        "recovery",
        "source-backups",
        proof.operation_id,
        "canonical-link"
      );
      await ensureDirectoryChain(skillsRoot, path.dirname(backup), 0o700);
      if (await lstatIfPresent(backup)) throw managedError("destination_changed", "source_backup_collision");
      await assertProvedLink(proof.source.path, proof.source.link);
      journal.replaced_source = {
        kind: "canonical-link",
        original: proof.source.path,
        backup,
        source_evidence: proof.source.link,
        backup_evidence: null
      };
      await transitionJournal(state, journal, journal.state);
      await renameAndSync(proof.source.path, backup);
      await checkpoint(settings, "source_moved_uncommitted", { kind: "canonical-link", original: proof.source.path, backup });
      journal.replaced_source.backup_evidence = await linkEvidence(backup);
      await transitionJournal(state, journal, "source_backed_up");
    }

    const canonicalStats = await lstatIfPresent(canonicalPath, { bigint: true });
    if (!canonicalStats) {
      await renameAndSync(stagedBundle, canonicalPath);
    } else {
      if (!(await canonicalMatchesProof(canonicalPath, proof.skill, settings.limits))) {
        throw managedError("destination_changed", "canonical_destination_changed");
      }
      journal.canonical_preexisting_identity = statIdentity(canonicalStats);
      await transitionJournal(state, journal, journal.state);
    }
    await transitionJournal(state, journal, "canonical_published");
    await checkpoint(settings, "canonical_published", journal);

    const sourceProjection = proof.projections.find((entry) => entry.classification === "selected-native-source");
    if (sourceProjection) {
      const sourcePath = proof.source.path;
      const backup = siblingBackupPath(sourcePath, proof.operation_id);
      if (await lstatIfPresent(backup)) throw managedError("destination_changed", "source_backup_collision");
      const current = await inspectBundle(sourcePath, name, settings.limits);
      if (
        current.bundleDigest !== proof.skill.bundle_digest
        || !matchesProofIdentity(current.rootIdentity, proof.source.identity)
      ) throw managedError("source_changed", "native_source_changed");
      journal.replaced_source = {
        kind: "native-directory",
        original: sourcePath,
        backup,
        source_evidence: {
          identity: proof.source.identity,
          bundle_digest: proof.skill.bundle_digest
        },
        backup_evidence: null,
        projection_evidence: null,
        projection_parent_chain: await captureDirectoryChain(settings.homePath, path.dirname(sourcePath))
      };
      await transitionJournal(state, journal, journal.state);
      await renameAndSync(sourcePath, backup);
      await checkpoint(settings, "source_moved_uncommitted", { kind: "native-directory", original: sourcePath, backup });
      const archivedSource = await inspectBundle(backup, name, settings.limits);
      if (
        archivedSource.bundleDigest !== proof.skill.bundle_digest
        || !matchesDirectoryProofIdentity(archivedSource.rootIdentity, proof.source.identity)
      ) throw managedError("recovery_required", "native_backup_changed");
      journal.replaced_source.backup_evidence = {
        identity: archivedSource.rootIdentity,
        bundle_digest: archivedSource.bundleDigest
      };
      await transitionJournal(state, journal, journal.state);
      await assertDirectoryChain(journal.replaced_source.projection_parent_chain);
      await fs.symlink(canonicalPath, sourcePath, process.platform === "win32" ? "junction" : "dir");
      await syncDirectory(path.dirname(sourcePath));
      await checkpoint(settings, "native_projection_created_uncommitted", { destination: sourcePath, target: canonicalPath });
      await assertDirectoryChain(journal.replaced_source.projection_parent_chain);
      journal.replaced_source.projection_evidence = await linkEvidence(sourcePath);
      await transitionJournal(state, journal, journal.state);
      await transitionJournal(state, journal, "source_backed_up");
      await checkpoint(settings, "source_backed_up", journal);
    }

    for (const projection of proof.projections) {
      const destination = path.join(settings.homePath, ...projection.relative_path.split("/"));
      if (["selected-native-source", "indirect-selected-source", "exact-managed-projection"].includes(projection.classification)) continue;
      const stats = await lstatIfPresent(destination);
      if (stats) throw managedError("destination_changed", "projection_destination_changed");
      await publishManagedProjection(settings, state, journal, destination, canonicalPath);
    }
    await transitionJournal(state, journal, "projections_published");
    await checkpoint(settings, "projections_published", journal);

    const registry = await readPortableRegistry(settings);
    const updatedRegistry = upsertManagedRegistry(registry, proof);
    await publishDerivedArtifacts(settings, updatedRegistry);
    await transitionJournal(state, journal, "derived_published");
    await checkpoint(settings, "derived_published", journal);

    const committedBundle = await inspectBundle(canonicalPath, name, settings.limits);
    if (committedBundle.bundleDigest !== proof.skill.bundle_digest) {
      throw managedError("destination_changed", "canonical_destination_changed");
    }
    const committedProjections = [];
    for (const projection of proof.projections) {
      const destination = path.join(settings.homePath, ...projection.relative_path.split("/"));
      const stats = await lstatIfPresent(destination, { bigint: true });
      committedProjections.push({
        ...projection,
        ...(stats?.isSymbolicLink() && {
          identity: statIdentity(stats),
          link_target: await readLinkBounded(destination)
        })
      });
    }
    const receipt = {
      format: RECEIPT_FORMAT,
      operation_id: proof.operation_id,
      plan_fingerprint: proof.plan_fingerprint,
      name,
      source: {
        kind: proof.source.kind,
        path: proof.source.path,
        bundle_path: proof.source.bundle_path,
        identity: proof.source.identity
      },
      bundle: proof.skill,
      portable_record: managedRegistryRowForProof(proof),
      canonical: { path: canonicalPath, identity: committedBundle.rootIdentity },
      projections: committedProjections,
      replaced_source: journal.replaced_source
    };
    await writeJsonAtomic(receiptPath, receipt, settings.limits.maxReceiptBytes);
    await transitionJournal(state, journal, "receipt_published");
    await checkpoint(settings, "receipt_published", journal);

    await transitionJournal(state, journal, "committed");
    await removeOwnedStage(
      stageRoot,
      proof.skill,
      settings.limits,
      journal.canonical_publish_identity,
      journal.staged_root_identity
    );
    await cleanupEmptyCanonicalInternals(settings.aiosPath);
    await removeFileAndSync(state.journal);
    return { status: "adopted", name, bundle_digest: proof.skill.bundle_digest };
  } catch (error) {
    await rollbackAdoption(settings, state, journal).catch(() => {});
    throw error;
  }
}

async function reconcileManagedSkills(settings, input = {}) {
  const plan = await buildReconcilePlan(settings);
  const proof = plan.proof;
  if (!input.apply) return proof;
  const operationId = input.operationId || input.operation_id;
  const planFingerprint = input.planFingerprint || input.plan_fingerprint;
  if (operationId !== proof.operation_id || planFingerprint !== proof.plan_fingerprint) {
    throw managedError("proof_mismatch", "reconcile_proof_mismatch");
  }
  const state = storeStatePaths(settings);
  await ensureStoreState(state);
  const lock = await acquireOperationLock(state.lock, {
    format: LOCK_FORMAT,
    strictOwnedState: true,
    ownedDirectories: [state.dotaios, state.root]
  });
  if (!lock) throw managedError("store_busy", "managed_skill_store_busy");
  try {
    await recoverPendingTransaction(settings, state);
    const locked = await buildReconcilePlan(settings);
    if (locked.proof.operation_id !== operationId || locked.proof.plan_fingerprint !== planFingerprint) {
      throw managedError("proof_mismatch", "reconcile_changed_under_lock");
    }
    return await commitReconcile(settings, state, locked.proof, locked.desiredRegistry, locked.skills);
  } finally {
    await releaseOperationLock(lock, { strictOwnedState: true }).catch(() => {});
    await cleanupEmptyStoreState(state).catch(() => {});
  }
}

async function buildReconcilePlan(settings) {
  await assertStoreRoots(settings);
  const targets = await projectionTargetsForSettings(settings);
  const registry = await readPortableRegistry(settings);
  const currentCatalogs = await inspectCatalogs(settings);
  const skills = await collectSkills(settings.aiosPath);
  if (skills.length > settings.limits.maxOwnedSkills) {
    throw managedError("bundle_bound_exceeded", "owned_skill_bound_exceeded");
  }
  assertProjectionFactBound(settings, skills.length, targets.length);
  const desiredRegistry = await normalizeReceiptBackedRegistry(settings, registry, skills);
  const desired = {
    index_sha256: sha256(renderSkillsIndexBytes(skills)),
    resolver_sha256: sha256(renderResolverBytes(skills))
  };
  const repairs = [];
  const unresolved = [];
  const managedProjections = [];
  if (currentCatalogs.index_sha256 !== desired.index_sha256) repairs.push({ kind: "catalog", name: "INDEX.md" });
  if (currentCatalogs.resolver_sha256 !== desired.resolver_sha256) repairs.push({ kind: "catalog", name: "RESOLVER.md" });
  if (canonicalJson(registry) !== canonicalJson(desiredRegistry)) repairs.push({ kind: "inventory", name: "_registry.json" });
  for (const skill of skills) {
    const canonicalPath = path.join(settings.aiosPath, "skills", skill.dir);
    for (const target of targets) {
      const destination = path.join(target.path, skill.dir);
      const classification = await classifyProjection({
        homePath: settings.homePath,
        destination,
        canonicalPath,
        sourcePath: "",
        sourceBundlePath: ""
      });
      const relativePath = `${target.relativePath}/${skill.dir}`;
      if (classification.classification === "absent") {
        repairs.push({ kind: "projection", relative_path: relativePath, target: canonicalPath, hosts: target.hosts });
      } else if (classification.classification === "exact-managed-projection") {
        managedProjections.push({ relative_path: relativePath, target: canonicalPath, hosts: target.hosts });
      } else if (classification.classification !== "exact-managed-projection") {
        unresolved.push({
          kind: "projection-collision",
          relative_path: relativePath,
          classification: classification.classification,
          hosts: target.hosts
        });
      }
    }
  }
  const payload = {
    format: "dotaios-managed-skill-reconcile-proof/v1",
    inventory_digest: sha256(canonicalJson(skills.map(({ dir }) => dir))),
    catalogs: currentCatalogs,
    desired_catalogs: desired,
    repairs,
    managed_projections: managedProjections,
    unresolved
  };
  const hash = sha256(canonicalJson(payload));
  return {
    proof: deepFreeze({
    ...payload,
    operation_id: `skill-reconcile-${hash.slice(0, 24)}`,
    plan_fingerprint: `sha256:${hash}`
    }),
    desiredRegistry,
    skills
  };
}

async function commitReconcile(settings, state, proof, desiredRegistry, skills) {
  const projectionHistoryRecord = await buildProjectionHistoryRecord(settings, proof);
  const journal = {
    format: JOURNAL_FORMAT,
    kind: "reconcile",
    state: "reconcile_prepared",
    operation_id: proof.operation_id,
    plan_fingerprint: proof.plan_fingerprint,
    old_artifacts: await captureDerivedArtifacts(settings),
    created_projections: [],
    created_projection_evidence: {},
    projection_parent_chains: {},
    created_directories: [],
    pending_projection: null,
    projection_history_record: projectionHistoryRecord
  };
  await writeJsonAtomic(state.journal, journal, settings.limits.maxJournalBytes);
  try {
    await checkpoint(settings, "reconcile_prepared", journal);
    await publishDerivedArtifacts(settings, desiredRegistry, skills);
    await transitionJournal(state, journal, "reconcile_derived_published");
    for (const repair of proof.repairs.filter(({ kind }) => kind === "projection")) {
      const destination = path.join(settings.homePath, ...repair.relative_path.split("/"));
      if (await lstatIfPresent(destination)) throw managedError("destination_changed", "projection_destination_changed");
      await publishManagedProjection(settings, state, journal, destination, repair.target);
      await checkpoint(settings, "reconcile_projection_published", { destination });
    }
    await transitionJournal(state, journal, "reconcile_committed");
    await finishCommittedReconcile(settings, state, journal);
    return {
      status: proof.repairs.length ? "reconciled" : "already_reconciled",
      repairs: proof.repairs,
      unresolved: proof.unresolved,
      skill_count: skills.length,
      catalog: {
        index_text: renderSkillsIndexBytes(skills).toString("utf8").replace(/\n$/, ""),
        resolver_text: renderResolverBytes(skills).toString("utf8").replace(/\n$/, "")
      }
    };
  } catch (error) {
    if (!["reconcile_committed", "reconcile_history_published", "needs_attention"].includes(journal.state)) {
      await rollbackReconcile(settings, state, journal).catch(() => {});
    }
    throw error;
  }
}

async function removeManagedSkill(settings, input = {}) {
  await assertStoreRoots(settings);
  if (!input?.name || !NAME_RE.test(input.name)) throw managedError("unproved_removal", "invalid_skill_name");
  const name = input.name;
  const receiptPath = path.join(storeStatePaths(settings).receipts, `${name}.json`);
  const receipt = await readOwnedJsonIfPresent(receiptPath, settings.limits.maxReceiptBytes);
  if (!receipt || receipt.format !== RECEIPT_FORMAT || receipt.name !== name) {
    throw managedError("unproved_removal", "managed_receipt_required");
  }
  await validateReceiptAuthority(settings, receipt, name);
  await refuseRetiredProjectionHistory(settings, receipt);
  const canonicalPath = path.join(settings.aiosPath, "skills", name);
  const bundle = await inspectBundle(canonicalPath, name, settings.limits);
  if (bundle.bundleDigest !== receipt.bundle.bundle_digest) {
    throw managedError("unproved_removal", "canonical_bundle_changed");
  }
  if (!matchesProofIdentity(bundle.rootIdentity, receipt.canonical?.identity)) {
    throw managedError("unproved_removal", "canonical_identity_changed");
  }
  const projections = await inspectReceiptProjections(settings, receipt);
  const registry = await readPortableRegistry(settings);
  const portableRow = (registry.managed || []).find((entry) => entry?.name === name) || null;
  const catalogs = await inspectCatalogs(settings);
  const parentStats = await lstatIfPresent(path.dirname(canonicalPath), { bigint: true });
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
    throw managedError("unproved_removal", "canonical_parent_changed");
  }
  const payload = {
    format: REMOVAL_PROOF_FORMAT,
    name,
    bundle_digest: bundle.bundleDigest,
    canonical_identity: bundle.rootIdentity,
    canonical_parent_identity: statIdentity(parentStats),
    receipt_digest: sha256(canonicalJson(receipt)),
    portable_record_sha256: portableRow ? sha256(canonicalJson(portableRow)) : null,
    catalogs,
    projections,
    replaced_source: receipt.replaced_source || null
  };
  const hash = sha256(canonicalJson(payload));
  const proof = deepFreeze({
    ...payload,
    operation_id: `skill-remove-${hash.slice(0, 24)}`,
    plan_fingerprint: `sha256:${hash}`
  });
  if (!input.apply) return proof;
  const operationId = input.operationId || input.operation_id;
  const planFingerprint = input.planFingerprint || input.plan_fingerprint;
  if (operationId !== proof.operation_id || planFingerprint !== proof.plan_fingerprint) {
    throw managedError("proof_mismatch", "removal_proof_mismatch");
  }

  const state = storeStatePaths(settings);
  await ensureStoreState(state);
  const lock = await acquireOperationLock(state.lock, {
    format: LOCK_FORMAT,
    strictOwnedState: true,
    ownedDirectories: [state.dotaios, state.root]
  });
  if (!lock) throw managedError("store_busy", "managed_skill_store_busy");
  try {
    await recoverPendingTransaction(settings, state);
    const current = await removeManagedSkill(settings, { name });
    if (current.operation_id !== operationId || current.plan_fingerprint !== planFingerprint) {
      throw managedError("proof_mismatch", "removal_changed_under_lock");
    }
    return await commitRemoval(settings, state, receipt, current);
  } finally {
    await releaseOperationLock(lock, { strictOwnedState: true }).catch(() => {});
    await cleanupEmptyStoreState(state).catch(() => {});
  }
}

async function commitRemoval(settings, state, receipt, proof) {
  const canonicalPath = path.join(settings.aiosPath, "skills", proof.name);
  const archive = path.join(settings.aiosPath, "skills", ".managed-skill-store", "recovery", proof.operation_id, proof.name);
  const oldArtifacts = await captureDerivedArtifacts(settings);
  const journal = {
    format: JOURNAL_FORMAT,
    kind: "removal",
    state: "remove_prepared",
    operation_id: proof.operation_id,
    plan_fingerprint: proof.plan_fingerprint,
    name: proof.name,
    canonical_path: canonicalPath,
    archive,
    skill: receipt.bundle,
    receipt,
    old_artifacts: oldArtifacts,
    detached_projection_intents: []
  };
  await writeJsonAtomic(state.journal, journal, settings.limits.maxJournalBytes);
  try {
    await checkpoint(settings, "remove_prepared", journal);
    await ensureDirectoryChain(path.join(settings.aiosPath, "skills"), path.dirname(archive), 0o700);
    if (await lstatIfPresent(archive)) throw managedError("recovery_required", "removal_archive_collision");
    for (const [index, projection] of proof.projections.entries()) {
      if (projection.classification !== "exact-managed-projection") continue;
      const destination = path.join(settings.homePath, ...projection.relative_path.split("/"));
      const backup = siblingDetachedProjectionPath(destination, proof.operation_id, index);
      if (await lstatIfPresent(backup)) throw managedError("recovery_required", "projection_backup_collision");
      await assertProvedLink(destination, {
        identity: projection.identity,
        target: projection.link_target
      });
      const intent = {
        destination,
        backup,
        evidence: { identity: projection.identity, target: projection.link_target },
        backup_evidence: null,
        parent_chain: await captureDirectoryChain(settings.homePath, path.dirname(destination)),
        state: "planned"
      };
      journal.detached_projection_intents.push(intent);
      await transitionJournal(state, journal, journal.state);
      await assertDirectoryChain(intent.parent_chain);
      await assertProvedLink(destination, intent.evidence);
      await renameAndSync(destination, backup);
      await checkpoint(settings, "projection_detached_uncommitted", { destination, backup });
      await assertDirectoryChain(intent.parent_chain);
      intent.backup_evidence = await linkEvidence(backup);
      if (
        intent.backup_evidence.target !== intent.evidence.target
        || !matchesLeafProofIdentity(intent.backup_evidence.identity, intent.evidence.identity)
      ) throw managedError("recovery_required", "detached_projection_changed");
      intent.state = "detached";
      await transitionJournal(state, journal, journal.state);
    }
    await transitionJournal(state, journal, "projections_detached");
    await checkpoint(settings, "projections_detached", journal);

    const before = await inspectBundle(canonicalPath, proof.name, settings.limits);
    const parentBeforeRename = await lstatIfPresent(path.dirname(canonicalPath), { bigint: true });
    const archiveParent = await lstatIfPresent(path.dirname(archive), { bigint: true });
    if (
      before.bundleDigest !== proof.bundle_digest
      || !matchesProofIdentity(before.rootIdentity, proof.canonical_identity)
      || !matchesDirectoryIdentity(parentBeforeRename, proof.canonical_parent_identity)
      || !archiveParent?.isDirectory()
      || archiveParent.isSymbolicLink()
      || String(archiveParent.dev) !== String(before.rootIdentity.dev)
    ) throw managedError("unproved_removal", "canonical_identity_changed");
    await renameAndSync(canonicalPath, archive);
    await checkpoint(settings, "canonical_moved_uncommitted", { canonical_path: canonicalPath, archive });
    await transitionJournal(state, journal, "canonical_archived");
    await checkpoint(settings, "canonical_archived", journal);

    await assertRemovalArchiveExclusive(settings, state, journal, proof, canonicalPath, archive);
    await transitionJournal(state, journal, "archive_verified");
    await checkpoint(settings, "archive_verified", journal);
    await assertRemovalArchiveExclusive(settings, state, journal, proof, canonicalPath, archive);

    if (receipt.replaced_source?.kind === "native-directory") {
      const { original, backup } = receipt.replaced_source;
      const originalStats = await lstatIfPresent(original);
      if (originalStats) throw managedError("recovery_required", "native_restore_destination_changed");
      const backupBundle = await inspectBundle(backup, proof.name, settings.limits);
      if (
        backupBundle.bundleDigest !== proof.bundle_digest
        || !matchesDirectoryProofIdentity(
          backupBundle.rootIdentity,
          receipt.replaced_source.backup_evidence?.identity
            || receipt.replaced_source.source_evidence?.identity
        )
      ) throw managedError("recovery_required", "native_backup_changed");
      await renameAndSync(backup, original);
      journal.source_restored = { kind: "native-directory", original, backup };
      await transitionJournal(state, journal, "source_restored");
      await checkpoint(settings, "source_restored", journal);
    } else if (receipt.replaced_source?.kind === "canonical-link") {
      const { original, backup } = receipt.replaced_source;
      if (await lstatIfPresent(original)) throw managedError("recovery_required", "shelf_restore_destination_changed");
      const backupStats = await lstatIfPresent(backup);
      if (!backupStats?.isSymbolicLink()) throw managedError("recovery_required", "shelf_backup_changed");
      const observed = await linkEvidence(backup);
      const expected = receipt.replaced_source.backup_evidence || receipt.replaced_source.source_evidence;
      if (
        observed.target !== expected?.target
        || !matchesLeafProofIdentity(observed.identity, expected?.identity)
      ) throw managedError("recovery_required", "shelf_backup_changed");
      await renameAndSync(backup, original);
      journal.source_restored = { kind: "canonical-link", original, backup };
      await transitionJournal(state, journal, "source_restored");
      await checkpoint(settings, "source_restored", journal);
    }

    await assertRemovalArchiveExclusive(settings, state, journal, proof, canonicalPath, archive);
    const registry = await readPortableRegistry(settings);
    const updated = removeManagedRegistryRow(registry, proof.name);
    await publishDerivedArtifacts(settings, updated);
    await transitionJournal(state, journal, "derived_published");
    await assertRemovalArchiveExclusive(settings, state, journal, proof, canonicalPath, archive);
    await removeFileAndSync(path.join(state.receipts, `${proof.name}.json`));
    await transitionJournal(state, journal, "receipt_tombstoned");
    await checkpoint(settings, "receipt_tombstoned", journal);
    await assertRemovalArchiveExclusive(settings, state, journal, proof, canonicalPath, archive);
    await transitionJournal(state, journal, "remove_committed");
    await checkpoint(settings, "remove_committed", journal);
    await transitionJournal(state, journal, "cleanup_started");
    await checkpoint(settings, "cleanup_started", journal);
    // Portable Node cannot conditionally unlink a path by its proved inode.
    // Keep the verified whole-root archive (and detached-link backups) as
    // non-routable recovery evidence instead of risking deletion of raced bytes.
    const retainedArchive = await assertRemovalArchiveExclusive(
      settings,
      state,
      journal,
      proof,
      canonicalPath,
      archive
    );
    const recoveryRecordPath = path.join(state.recoveries, `${proof.operation_id}.json`);
    const recoveryRecord = {
      format: RECOVERY_RECORD_FORMAT,
      operation_id: proof.operation_id,
      plan_fingerprint: proof.plan_fingerprint,
      name: proof.name,
      bundle_digest: proof.bundle_digest,
      archive: { path: archive, identity: retainedArchive.rootIdentity },
      detached_projections: journal.detached_projection_intents.map((intent) => ({
        destination: intent.destination,
        backup: intent.backup,
        evidence: intent.backup_evidence || intent.evidence
      })),
      source_restored: journal.source_restored || null
    };
    await writeJsonAtomic(recoveryRecordPath, recoveryRecord, settings.limits.maxReceiptBytes);
    journal.recovery_record_path = recoveryRecordPath;
    await transitionJournal(state, journal, "cleanup_completed");
    await checkpoint(settings, "cleanup_completed", journal);
    await cleanupManagedBackupParents(settings.aiosPath, receipt.replaced_source?.backup);
    await removeFileAndSync(state.journal);
    return {
      status: "removed",
      name: proof.name,
      recovery_retained: true,
      recovery_record: recoveryRecordPath
    };
  } catch (error) {
    if (journal.state === "cleanup_started") {
      await transitionJournal(state, journal, "needs_attention").catch(() => {});
    } else if (!["cleanup_completed", "needs_attention"].includes(journal.state)) {
      await rollbackRemoval(settings, state, journal).catch(() => {});
    }
    throw error;
  }
}

async function assertRemovalArchiveExclusive(settings, state, journal, proof, canonicalPath, archive) {
  const archived = await inspectBundle(archive, proof.name, settings.limits).catch(() => null);
  const live = await lstatIfPresent(canonicalPath);
  let expectedRestoredShelfLink = false;
  if (
    live?.isSymbolicLink()
    && journal.source_restored?.kind === "canonical-link"
    && sameLexicalPath(journal.source_restored.original, canonicalPath)
    && journal.receipt?.replaced_source?.kind === "canonical-link"
    && sameLexicalPath(journal.receipt.replaced_source.original, canonicalPath)
  ) {
    const observed = await linkEvidence(canonicalPath).catch(() => null);
    const expected = journal.receipt.replaced_source.backup_evidence
      || journal.receipt.replaced_source.source_evidence;
    expectedRestoredShelfLink = Boolean(
      observed
      && observed.target === expected?.target
      && matchesLeafProofIdentity(observed.identity, expected?.identity)
    );
  }
  if (
    archived?.bundleDigest !== proof.bundle_digest
    || !matchesDirectoryProofIdentity(archived?.rootIdentity, proof.canonical_identity)
    || (live && !expectedRestoredShelfLink)
  ) {
    await transitionJournal(state, journal, "needs_attention");
    throw managedError("recovery_required", "removal_archive_needs_attention");
  }
  return archived;
}

async function resolveAdoptionSource(settings, selectedPath, requestedKind) {
  const stats = await lstatIfPresent(selectedPath, { bigint: true });
  if (!stats) throw managedError("unsafe_source", "source_missing");
  const skillsRoot = path.join(settings.aiosPath, "skills");
  const isCanonicalCoordinate = path.dirname(selectedPath) === skillsRoot;
  if (stats.isSymbolicLink()) {
    if (!isCanonicalCoordinate) throw managedError("unsafe_source", "linked_source_root_refused");
    if (requestedKind && requestedKind !== "discovered-canonical-link") {
      throw managedError("unsafe_source", "source_kind_mismatch");
    }
    const target = await readLinkBounded(selectedPath);
    const bundlePath = path.resolve(path.dirname(selectedPath), target);
    const targetStats = await lstatIfPresent(bundlePath, { bigint: true });
    if (!targetStats?.isDirectory() || targetStats.isSymbolicLink()) {
      throw managedError("unsafe_source", "canonical_link_target_not_real_directory");
    }
    return {
      kind: "discovered-canonical-link",
      bundlePath,
      identity: statIdentity(targetStats),
      link: { identity: statIdentity(stats), target }
    };
  }
  if (!stats.isDirectory()) throw managedError("unsafe_source", "source_root_not_directory");
  const native = (await projectionTargetsForSettings(settings))
    .find(({ path: root }) => path.dirname(selectedPath) === root);
  const inferred = native ? "discovered-native-directory" : "local-reviewed-directory";
  if (requestedKind && requestedKind !== inferred) throw managedError("unsafe_source", "source_kind_mismatch");
  return { kind: inferred, bundlePath: selectedPath, identity: statIdentity(stats) };
}

async function inspectBundle(root, expectedName, limits) {
  const firstRoot = await lstatIfPresent(root, { bigint: true });
  if (!firstRoot?.isDirectory() || firstRoot.isSymbolicLink()) throw managedError("unsafe_source", "source_root_not_real_directory");
  const rootIdentity = statIdentity(firstRoot);
  const files = [];
  const directories = [];
  let entryCount = 0;
  let totalBytes = 0;

  async function walk(directory, relativeDirectory, depth) {
    if (depth > limits.maxDepth) throw managedError("bundle_bound_exceeded", "bundle_depth_bound_exceeded");
    const entries = await readDirectoryEntries(directory, {
      maxEntries: limits.maxEntries - entryCount
    });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) throw managedError("bundle_bound_exceeded", "bundle_entry_bound_exceeded");
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validateRelativePath(relative, limits);
      if (relative !== "SKILL.md" && entry.name === "SKILL.md") {
        throw managedError("unsafe_source", "nested_skill_bundle_refused");
      }
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
        throw managedError("unsafe_source", "derived_artifact_refused");
      }
      const absolute = path.join(directory, entry.name);
      if (entry.kind === "symlink") throw managedError("unsafe_source", "nested_link_refused");
      if (entry.kind === "directory") {
        const stats = await lstatIfPresent(absolute, { bigint: true });
        if (!stats?.isDirectory() || stats.isSymbolicLink()) throw managedError("unsafe_source", "directory_identity_changed");
        directories.push(relative);
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (entry.kind !== "file") throw managedError("unsafe_source", "special_file_refused");
      if (files.length >= limits.maxFiles) throw managedError("bundle_bound_exceeded", "bundle_file_bound_exceeded");
      const opened = await readBoundedRegularFile(absolute, limits.maxFileBytes);
      if (opened.stats.nlink !== 1n) throw managedError("unsafe_source", "hardlinked_file_refused");
      if ((Number(opened.stats.mode) & 0o7000) !== 0) throw managedError("unsafe_source", "unsafe_file_mode");
      totalBytes += opened.bytes.length;
      if (totalBytes > limits.maxTotalBytes) throw managedError("bundle_bound_exceeded", "bundle_byte_bound_exceeded");
      const executable = (Number(opened.stats.mode) & 0o111) !== 0;
      const classification = classifyFile(relative, executable);
      if (classification === "authority-text") {
        try {
          UTF8_DECODER.decode(opened.bytes);
        } catch {
          throw managedError("invalid_skill_metadata", "skill_metadata_not_utf8");
        }
      }
      files.push({
        path: relative,
        bytes: opened.bytes.length,
        executable,
        classification,
        content_type: contentType(relative),
        sha256: sha256(opened.bytes),
        identity: statIdentity(opened.stats),
        ...(relative === "SKILL.md" && { content: opened.bytes })
      });
    }
  }

  await walk(root, "", 0);
  files.sort((left, right) => compareUtf8(left.path, right.path));
  directories.sort(compareUtf8);
  const skillFile = files.find(({ path: relative }) => relative === "SKILL.md");
  if (!skillFile) throw managedError("invalid_skill_metadata", "skill_metadata_missing");
  let skillText;
  try {
    skillText = UTF8_DECODER.decode(skillFile.content);
  } catch {
    throw managedError("invalid_skill_metadata", "skill_metadata_not_utf8");
  }
  const metadata = parseAdoptionMetadata(skillText);
  if (metadata.name !== expectedName) throw managedError("invalid_skill_metadata", "skill_name_mismatch");
  const secondRoot = await lstatIfPresent(root, { bigint: true });
  if (!secondRoot || !sameIdentity(firstRoot, secondRoot)) throw managedError("source_changed", "source_root_changed");
  const publicFiles = files.map(({ content: _content, identity: _identity, ...entry }) => entry);
  const digestPayload = {
    format: "dotaios-skill-bundle-manifest/v1",
    name: metadata.name,
    description: metadata.description,
    directories,
    files: publicFiles
  };
  return {
    name: metadata.name,
    description: metadata.description,
    directories,
    files,
    publicFiles,
    scripts: files.filter(({ classification }) => classification === "script").map(({ path: relative }) => relative),
    executables: files.filter(({ executable }) => executable).map(({ path: relative }) => relative),
    bundleDigest: `sha256:${sha256(canonicalJson(digestPayload))}`,
    rootIdentity
  };
}

function parseAdoptionMetadata(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) throw managedError("invalid_skill_metadata", "skill_frontmatter_missing");
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw managedError("invalid_skill_metadata", "skill_frontmatter_invalid");
  let metadata;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw managedError("invalid_skill_metadata", "skill_frontmatter_alias_refused");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw managedError("invalid_skill_metadata", "skill_frontmatter_not_mapping");
  }
  if (typeof metadata.name !== "string" || !NAME_RE.test(metadata.name)) {
    throw managedError("invalid_skill_metadata", "skill_name_invalid");
  }
  if (
    typeof metadata.description !== "string"
    || !metadata.description.trim()
    || [...metadata.description].length > 1024
    || metadata.description.includes("\0")
  ) {
    throw managedError("invalid_skill_metadata", "skill_description_invalid");
  }
  if (
    (metadata.license != null && !validMetadataString(metadata.license))
    || (metadata.compatibility != null && !validMetadataString(metadata.compatibility, 500))
    || (metadata["allowed-tools"] != null && !validMetadataString(metadata["allowed-tools"]))
    || (metadata.metadata != null && !validStringMetadata(metadata.metadata))
  ) throw managedError("invalid_skill_metadata", "skill_optional_metadata_invalid");
  return { name: metadata.name, description: metadata.description.trim() };
}

function validMetadataString(value, maxCharacters = null) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && (maxCharacters == null || [...value].length <= maxCharacters);
}

function validStringMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) => (
    validMetadataString(key) && validMetadataString(entry)
  ));
}

async function readBoundedRegularFile(filePath, maxBytes) {
  const before = await lstatIfPresent(filePath, { bigint: true });
  if (!before?.isFile() || before.isSymbolicLink()) throw managedError("unsafe_source", "non_regular_file_refused");
  if (before.nlink !== 1n) throw managedError("unsafe_source", "hardlinked_file_refused");
  if (before.size > BigInt(maxBytes)) throw managedError("bundle_bound_exceeded", "bundle_file_byte_bound_exceeded");
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile() || handleStats.nlink !== 1n || !sameIdentity(before, handleStats)) {
      throw managedError("source_changed", "source_file_changed");
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw managedError("bundle_bound_exceeded", "bundle_file_byte_bound_exceeded");
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstatIfPresent(filePath, { bigint: true });
    if (!pathAfter || !sameIdentity(handleStats, after) || !sameIdentity(after, pathAfter)) {
      throw managedError("source_changed", "source_file_changed");
    }
    return { bytes, stats: after };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function copyProofBundle(sourceRoot, destinationRoot, skillProof) {
  for (const relative of skillProof.directories || []) {
    await ensureDirectoryChain(
      destinationRoot,
      path.join(destinationRoot, ...relative.split("/")),
      0o755
    );
  }
  for (const expected of skillProof.files) {
    const source = path.join(sourceRoot, ...expected.path.split("/"));
    const destination = path.join(destinationRoot, ...expected.path.split("/"));
    const observed = await readBoundedRegularFile(source, expected.bytes);
    if (observed.bytes.length !== expected.bytes || sha256(observed.bytes) !== expected.sha256) {
      throw managedError("source_changed", "source_file_digest_changed");
    }
    await fs.writeFile(destination, observed.bytes, { flag: "wx", mode: expected.executable ? 0o755 : 0o644 });
    await fs.chmod(destination, expected.executable ? 0o755 : 0o644);
    await syncFile(destination);
  }
  const directories = [
    destinationRoot,
    ...(skillProof.directories || []).map((relative) => (
      path.join(destinationRoot, ...relative.split("/"))
    ))
  ].sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
  for (const directory of directories) await syncDirectory(directory);
}

function publicBundle(bundle) {
  return {
    name: bundle.name,
    description: bundle.description,
    bundle_digest: bundle.bundleDigest,
    directories: bundle.directories,
    files: bundle.publicFiles,
    scripts: bundle.scripts,
    executables: bundle.executables
  };
}

function classifyFile(relative, executable) {
  if (relative === "SKILL.md") return "authority-text";
  if (executable || SCRIPT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) return "script";
  return "opaque-asset";
}

function contentType(relative) {
  if (relative === "SKILL.md") return "text/markdown";
  return CONTENT_TYPES.get(path.posix.extname(relative).toLowerCase()) || "application/octet-stream";
}

async function portableProvenance(settings, source, bundle) {
  if (source.kind === "local-reviewed-directory") return { attribution: "reviewed-local" };
  if (source.kind === "discovered-canonical-link") return { attribution: "canonical-shelf-link" };
  if (source.kind !== "discovered-native-directory") return { attribution: "native-unattributed" };

  const lockPath = path.join(path.dirname(path.dirname(source.bundlePath)), ".skill-lock.json");
  const lock = await readUntrustedJsonBounded(lockPath, settings.limits.maxFileBytes);
  const row = lock?.skills?.[bundle.name];
  if (!row || typeof row !== "object" || Array.isArray(row)) return { attribution: "native-unattributed" };
  const provenance = { attribution: "native-lockfile" };
  copyPortableString(row, "source", provenance, "source");
  copyPortableString(row, "sourceType", provenance, "source_type");
  copyPortableString(row, "skillPath", provenance, "skill_path");
  copyPortableString(row, "skillFolderHash", provenance, "revision");
  return provenance;
}

function copyPortableString(source, sourceKey, destination, destinationKey) {
  const value = source[sourceKey];
  if (
    typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 512
    && !value.includes("\0")
    && isPortableProvenanceValue(destinationKey, value)
  ) {
    destination[destinationKey] = value;
  }
}

function isPortableProvenanceValue(key, value) {
  if (
    path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.startsWith("~")
    || /^file:/i.test(value)
  ) return false;
  if (key === "skill_path") {
    return !value.split(/[\\/]+/).some((segment) => !segment || segment === "." || segment === "..");
  }
  return true;
}

function adoptionEffects(source, bundle, projections) {
  const effects = [
    { action: "publish-canonical-bundle", coordinate: `skills/${bundle.name}` },
    { action: "publish-portable-inventory", coordinate: "skills/_registry.json" },
    { action: "publish-catalog-generation", coordinate: "skills/INDEX.md+RESOLVER.md" }
  ];
  if (source.kind !== "local-reviewed-directory") {
    effects.push({ action: "replace-proved-source", coordinate: source.kind });
  }
  for (const projection of projections) {
    effects.push({ action: "project-or-preserve", coordinate: projection.relative_path });
  }
  return effects;
}

async function classifyCanonicalCollision({ canonicalPath, selectedPath, source, bundle, registry, limits }) {
  const stats = await lstatIfPresent(canonicalPath);
  if (!stats) return { classification: "absent", coordinate: `skills/${bundle.name}` };
  if (source.kind === "discovered-canonical-link" && sameLexicalPath(canonicalPath, selectedPath)) {
    const raw = await readLinkBounded(canonicalPath);
    if (raw !== source.link.target) return { classification: "foreign-link", coordinate: `skills/${bundle.name}` };
    return { classification: "selected-canonical-link", coordinate: `skills/${bundle.name}` };
  }
  if (stats.isSymbolicLink()) return { classification: "foreign-link", coordinate: `skills/${bundle.name}` };
  if (!stats.isDirectory()) return { classification: "special", coordinate: `skills/${bundle.name}` };
  try {
    const current = await inspectBundle(canonicalPath, bundle.name, limits);
    const row = (registry.managed || []).find(({ name }) => name === bundle.name);
    if (current.bundleDigest === bundle.bundleDigest && row?.bundle_digest === bundle.bundleDigest) {
      return { classification: "canonical-owned-identical", coordinate: `skills/${bundle.name}` };
    }
  } catch {
    // The collision classification intentionally avoids exposing parse details.
  }
  return { classification: "canonical-owned-different", coordinate: `skills/${bundle.name}` };
}

async function classifyProjection({ homePath, destination, canonicalPath, sourcePath, sourceBundlePath }) {
  if (!(await projectionBoundarySafe(homePath, path.dirname(destination)))) {
    return { classification: "unsafe-parent", blocking: true };
  }
  const stats = await lstatIfPresent(destination);
  if (!stats) return { classification: "absent", blocking: false };
  if (sameLexicalPath(destination, sourcePath) && stats.isDirectory() && !stats.isSymbolicLink()) {
    return { classification: "selected-native-source", blocking: false };
  }
  if (stats.isSymbolicLink()) {
    const raw = await readLinkBounded(destination);
    const resolved = path.resolve(path.dirname(destination), raw);
    if (sameLexicalPath(resolved, canonicalPath)) return { classification: "exact-managed-projection", blocking: false };
    if (sameLexicalPath(resolved, sourcePath) || sameLexicalPath(resolved, sourceBundlePath)) {
      return { classification: "indirect-selected-source", blocking: false };
    }
    return { classification: "foreign-link", blocking: true };
  }
  if (stats.isDirectory()) return { classification: "real-unmanaged", blocking: true };
  return { classification: "special", blocking: true };
}

async function projectionBoundarySafe(homePath, destination) {
  const relative = path.relative(homePath, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = homePath;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stats = await lstatIfPresent(current);
    if (!stats) return true;
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  }
  return true;
}

function projectionTargets(homePath, registry, limits) {
  const grouped = new Map();
  const add = (relativePath, hosts) => {
    if (!relativePath) return;
    const clean = relativePath.replace(/^~?[\\/]+/, "").replaceAll("\\", "/");
    validateRelativePath(clean, limits);
    const current = grouped.get(clean) || new Set();
    for (const host of hosts) {
      if (Buffer.byteLength(host || "", "utf8") > limits.maxAgentFieldBytes) {
        throw managedError("bundle_bound_exceeded", "agent_registry_field_bound_exceeded");
      }
      current.add(host);
    }
    grouped.set(clean, current);
    if (grouped.size > limits.maxProjectionTargets) {
      throw managedError("bundle_bound_exceeded", "projection_target_bound_exceeded");
    }
  };
  for (const agent of registry.agents || []) {
    if (agent.skills?.mode === "symlink") add(agent.skills.dir, [agent.name]);
  }
  for (const target of registry.wellKnownSkillDirs || []) {
    if (target.mode === "symlink") add(target.dir, target.serves || []);
  }
  return [...grouped.entries()]
    .map(([relativePath, hosts]) => ({
      relativePath,
      path: path.join(homePath, ...relativePath.split("/")),
      hosts: [...hosts].sort(compareUtf8)
    }))
    .sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
}

async function projectionTargetsForSettings(settings) {
  const agents = await readAgentRegistryForStore(settings);
  return projectionTargets(settings.homePath, {
    agents,
    wellKnownSkillDirs: agentRegistry.wellKnownSkillDirs || []
  }, settings.limits);
}

async function readAgentRegistryForStore(settings) {
  const defaults = normalizeAgentRegistry(agentRegistry);
  const custom = await readManagedBytesIfPresent(
    path.join(settings.aiosPath, "agents.json"),
    settings.limits.maxAgentRegistryBytes,
    "unsafe_agent_registry"
  );
  if (!custom) return defaults;
  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(custom));
  } catch {
    throw managedError("unsafe_state", "invalid_agent_registry");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.agents)) {
    throw managedError("unsafe_state", "invalid_agent_registry");
  }
  if (value.agents.length > settings.limits.maxAgentRegistryEntries) {
    throw managedError("bundle_bound_exceeded", "agent_registry_entry_bound_exceeded");
  }
  for (const raw of value.agents) assertAgentRegistryFieldBounds(raw, settings.limits);
  const userRegistry = normalizeAgentRegistry(value);
  const byName = new Map(defaults.map((agent) => [agent.name.toLowerCase(), agent]));
  for (const agent of userRegistry) byName.set(agent.name.toLowerCase(), agent);
  if (byName.size > settings.limits.maxAgentRegistryEntries) {
    throw managedError("bundle_bound_exceeded", "agent_registry_entry_bound_exceeded");
  }
  return [...byName.values()];
}

function assertAgentRegistryFieldBounds(raw, limits) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  for (const value of [raw.name, raw.detect, raw.command, raw.bridge]) {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > limits.maxAgentFieldBytes) {
      throw managedError("bundle_bound_exceeded", "agent_registry_field_bound_exceeded");
    }
  }
  for (const target of [raw.skills, raw.skills?.project]) {
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    for (const value of [target.mode, target.dir, target.configFile, target.key]) {
      if (typeof value === "string" && Buffer.byteLength(value, "utf8") > limits.maxAgentFieldBytes) {
        throw managedError("bundle_bound_exceeded", "agent_registry_field_bound_exceeded");
      }
    }
  }
}

function assertProjectionFactBound(settings, skillCount, targetCount) {
  if (skillCount > Math.floor(settings.limits.maxProjectionFacts / Math.max(1, targetCount))) {
    throw managedError("bundle_bound_exceeded", "projection_fact_bound_exceeded");
  }
}

async function inspectCatalogs(settings) {
  const skillsRoot = path.join(settings.aiosPath, "skills");
  return {
    registry_sha256: await fileDigestIfPresent(path.join(skillsRoot, "_registry.json"), settings.limits.maxRegistryBytes),
    index_sha256: await fileDigestIfPresent(path.join(skillsRoot, "INDEX.md"), settings.limits.maxCatalogBytes),
    resolver_sha256: await fileDigestIfPresent(path.join(skillsRoot, "RESOLVER.md"), settings.limits.maxCatalogBytes)
  };
}

async function publishDerivedArtifacts(settings, registry, knownSkills = null) {
  const skills = knownSkills || await collectSkills(settings.aiosPath);
  const portableRegistry = normalizePortableRegistry(registry, skills);
  const indexBytes = renderSkillsIndexBytes(skills);
  const resolverBytes = renderResolverBytes(skills);
  if (indexBytes.length > settings.limits.maxCatalogBytes || resolverBytes.length > settings.limits.maxCatalogBytes) {
    throw managedError("bundle_bound_exceeded", "catalog_byte_bound_exceeded");
  }
  const skillsRoot = path.join(settings.aiosPath, "skills");
  const registryBytes = Buffer.from(`${JSON.stringify(portableRegistry, null, 2)}\n`);
  if (registryBytes.length > settings.limits.maxRegistryBytes) {
    throw managedError("bundle_bound_exceeded", "registry_byte_bound_exceeded");
  }
  await writeBufferAtomic(path.join(skillsRoot, "_registry.json"), registryBytes);
  await checkpoint(settings, "portable_inventory_published", { registry_format: portableRegistry.format });
  await writeBufferAtomic(path.join(skillsRoot, "INDEX.md"), indexBytes);
  await checkpoint(settings, "index_catalog_published", { bytes: indexBytes.length });
  await writeBufferAtomic(path.join(skillsRoot, "RESOLVER.md"), resolverBytes);
  await checkpoint(settings, "resolver_catalog_published", { bytes: resolverBytes.length });
}

async function captureDerivedArtifacts(settings) {
  const root = path.join(settings.aiosPath, "skills");
  const artifacts = {};
  for (const name of ["_registry.json", "INDEX.md", "RESOLVER.md"]) {
    const maxBytes = name === "_registry.json"
      ? settings.limits.maxRegistryBytes
      : settings.limits.maxCatalogBytes;
    const bytes = await readManagedBytesIfPresent(path.join(root, name), maxBytes, "unsafe_derived_artifact");
    artifacts[name] = bytes?.toString("base64") ?? null;
  }
  return artifacts;
}

async function captureDerivedArtifactModes(settings) {
  const root = path.join(settings.aiosPath, "skills");
  const modes = {};
  for (const name of ["_registry.json", "INDEX.md", "RESOLVER.md"]) {
    const stats = await lstatIfPresent(path.join(root, name));
    if (stats && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)) {
      throw managedError("unsafe_state", "unsafe_derived_artifact");
    }
    modes[name] = stats ? Number(stats.mode) & 0o777 : null;
  }
  return modes;
}

async function restoreDerivedArtifacts(aiosPath, artifacts) {
  const root = path.join(aiosPath, "skills");
  for (const [name, encoded] of Object.entries(artifacts || {})) {
    const destination = path.join(root, name);
    if (encoded === null) await removeFileAndSync(destination);
    else await writeBufferAtomic(destination, Buffer.from(encoded, "base64"));
  }
}

async function restoreDerivedArtifactModes(aiosPath, modes) {
  const root = path.join(aiosPath, "skills");
  for (const [name, mode] of Object.entries(modes || {})) {
    if (mode === null) continue;
    const destination = path.join(root, name);
    await fs.chmod(destination, mode);
    await syncFile(destination);
  }
  await syncDirectory(root);
}

async function readPortableRegistry(settings) {
  const registryPath = path.join(settings.aiosPath, "skills", "_registry.json");
  const value = await readJsonStrictIfPresent(registryPath, settings.limits.maxRegistryBytes);
  if (!value) return { format: REGISTRY_FORMAT, skills: [], managed: [], plugins: [] };
  if (value.format && value.format !== REGISTRY_FORMAT) throw managedError("unsafe_state", "unsupported_skill_inventory_version");
  if (!Array.isArray(value.skills || []) || !Array.isArray(value.managed || []) || !Array.isArray(value.plugins || [])) {
    throw managedError("unsafe_state", "invalid_skill_inventory");
  }
  return { ...value, format: REGISTRY_FORMAT, managed: value.managed || [], plugins: value.plugins || [] };
}

function upsertManagedRegistry(registry, proof) {
  const managed = (registry.managed || []).filter(({ name }) => name !== proof.skill.name);
  managed.push(managedRegistryRowForProof(proof));
  managed.sort((left, right) => compareUtf8(left.name, right.name));
  const skills = [...new Set([...(registry.skills || []), proof.skill.name])].sort(compareUtf8);
  return { ...registry, format: REGISTRY_FORMAT, skills, managed, plugins: registry.plugins || [] };
}

function managedRegistryRowForProof(proof) {
  return {
    name: proof.skill.name,
    bundle_digest: proof.skill.bundle_digest,
    source_kind: proof.source.kind,
    provenance: proof.source.portable_provenance
  };
}

function removeManagedRegistryRow(registry, name) {
  return {
    ...registry,
    format: REGISTRY_FORMAT,
    skills: (registry.skills || []).filter((entry) => entry !== name),
    managed: (registry.managed || []).filter((entry) => entry.name !== name),
    plugins: registry.plugins || []
  };
}

function normalizePortableRegistry(registry, skills) {
  const names = skills.map(({ dir }) => dir).sort(compareUtf8);
  const owned = new Set(names);
  const managed = [];
  for (const row of registry.managed || []) {
    if (
      !row || typeof row !== "object" || Array.isArray(row)
      || !owned.has(row.name)
      || typeof row.source_kind !== "string"
      || typeof row.bundle_digest !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(row.bundle_digest)
    ) continue;
    const provenance = {};
    for (const key of ["attribution", "source", "source_type", "skill_path", "revision"]) {
      copyPortableString(row.provenance || {}, key, provenance, key);
    }
    managed.push({
      name: row.name,
      bundle_digest: row.bundle_digest,
      source_kind: row.source_kind,
      provenance
    });
  }
  managed.sort((left, right) => compareUtf8(left.name, right.name));
  return { format: REGISTRY_FORMAT, skills: names, managed, plugins: [] };
}

async function normalizeReceiptBackedRegistry(settings, registry, skills) {
  const normalized = normalizePortableRegistry(registry, skills);
  const owned = new Set(skills.map(({ dir }) => dir));
  const backed = [];
  const receiptEntries = await readDirectoryEntries(storeStatePaths(settings).receipts, {
    allowMissing: true,
    maxEntries: settings.limits.maxOwnedSkills
  });
  for (const entry of receiptEntries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -5);
    if (!owned.has(name) || !NAME_RE.test(name)) continue;
    const receipt = await readOwnedJsonIfPresent(
      path.join(storeStatePaths(settings).receipts, entry.name),
      settings.limits.maxReceiptBytes
    ).catch(() => null);
    if (!receipt) continue;
    try {
      await validateReceiptAuthority(settings, receipt, name);
    } catch {
      continue;
    }
    const canonical = await inspectBundle(
      path.join(settings.aiosPath, "skills", name),
      name,
      settings.limits
    ).catch(() => null);
    if (
      canonical?.bundleDigest === receipt.bundle.bundle_digest
      && matchesDirectoryProofIdentity(canonical?.rootIdentity, receipt.canonical.identity)
    ) backed.push(receipt.portable_record);
  }
  backed.sort((left, right) => compareUtf8(left.name, right.name));
  return { ...normalized, managed: backed };
}

async function rollbackAdoption(settings, state, journal) {
  await rollbackCreatedProjections(settings, state, journal);
  await rollbackCreatedDirectories(journal);
  if (journal.replaced_source?.kind === "native-directory") {
    const { original, backup, source_evidence: sourceEvidence, backup_evidence: backupEvidence } = journal.replaced_source;
    const current = await lstatIfPresent(original);
    const backupStats = await lstatIfPresent(backup, { bigint: true });
    if (current?.isDirectory() && !current.isSymbolicLink()) {
      if (backupStats) throw managedError("recovery_required", "native_restore_destination_changed");
      const unchanged = await inspectBundle(original, journal.name, settings.limits).catch(() => null);
      if (
        unchanged?.bundleDigest !== journal.skill.bundle_digest
        || !matchesDirectoryProofIdentity(unchanged?.rootIdentity, sourceEvidence?.identity)
      ) throw managedError("recovery_required", "native_restore_destination_changed");
    } else if (current?.isSymbolicLink()) {
      const observed = await linkEvidence(original);
      const expected = journal.replaced_source.projection_evidence;
      if (
        !expected
        || observed.target !== expected.target
        || !matchesLeafProofIdentity(observed.identity, expected.identity)
      ) {
        await transitionJournal(state, journal, "needs_attention");
        throw managedError("recovery_required", "native_restore_destination_changed");
      }
      await assertDirectoryChain(journal.replaced_source.projection_parent_chain);
      await unlinkAndSync(original);
    } else if (current) {
      throw managedError("recovery_required", "native_restore_destination_changed");
    }
    if (backupStats) {
      const archived = await inspectBundle(backup, journal.name, settings.limits).catch(() => null);
      const expectedIdentity = backupEvidence?.identity || sourceEvidence?.identity;
      if (
        archived?.bundleDigest !== journal.skill.bundle_digest
        || !matchesDirectoryProofIdentity(archived?.rootIdentity, expectedIdentity)
      ) throw managedError("recovery_required", "native_backup_changed");
    }
    if (!(await lstatIfPresent(original)) && backupStats) await renameAndSync(backup, original);
    if (!(await lstatIfPresent(original))) throw managedError("recovery_required", "native_backup_missing");
  }
  const canonical = await lstatIfPresent(journal.canonical_path, { bigint: true });
  if (canonical) {
    const observed = await inspectBundle(journal.canonical_path, journal.name, settings.limits).catch(() => null);
    if (journal.canonical_preexisting_identity) {
      if (
        observed?.bundleDigest !== journal.skill.bundle_digest
        || !matchesDirectoryProofIdentity(observed?.rootIdentity, journal.canonical_preexisting_identity)
      ) {
        await transitionJournal(state, journal, "needs_attention");
        throw managedError("recovery_required", "canonical_rollback_needs_attention");
      }
    } else if (
      observed?.bundleDigest === journal.skill.bundle_digest
      && matchesDirectoryProofIdentity(observed?.rootIdentity, journal.canonical_publish_identity)
    ) {
      const recovery = path.join(
        settings.aiosPath,
        "skills",
        ".managed-skill-store",
        "recovery",
        `${journal.operation_id}-rollback`,
        journal.name
      );
      await ensureDirectoryChain(
        path.join(settings.aiosPath, "skills"),
        path.dirname(recovery),
        0o700
      );
      await renameAndSync(journal.canonical_path, recovery);
      try {
        await settings.hooks?.beforeRollbackCanonicalCleanup?.(recovery);
        await removeManifestTree(recovery, journal.skill, settings.limits);
      } catch {
        await transitionJournal(state, journal, "needs_attention");
        throw managedError("recovery_required", "canonical_rollback_cleanup_needs_attention");
      }
      await fs.rmdir(path.dirname(recovery)).catch(() => {});
    } else {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "canonical_rollback_needs_attention");
    }
  } else if (journal.canonical_preexisting_identity || adoptionStateRequiresCanonical(journal.state)) {
    await transitionJournal(state, journal, "needs_attention");
    throw managedError("recovery_required", "canonical_rollback_needs_attention");
  }
  if (journal.replaced_source?.kind === "canonical-link") {
    const { original, backup, source_evidence: sourceEvidence, backup_evidence: backupEvidence } = journal.replaced_source;
    const originalStats = await lstatIfPresent(original);
    const backupStats = await lstatIfPresent(backup, { bigint: true });
    if (originalStats && backupStats) throw managedError("recovery_required", "shelf_restore_destination_changed");
    if (originalStats?.isSymbolicLink() && !backupStats) {
      const observed = await linkEvidence(original);
      if (
        observed.target !== sourceEvidence?.target
        || !matchesLeafProofIdentity(observed.identity, sourceEvidence?.identity)
      ) throw managedError("recovery_required", "shelf_restore_destination_changed");
    } else if (originalStats && !backupStats) {
      throw managedError("recovery_required", "shelf_restore_destination_changed");
    }
    if (!originalStats && backupStats) {
      const observed = await linkEvidence(backup);
      const expected = backupEvidence || sourceEvidence;
      if (
        observed.target !== expected?.target
        || !matchesLeafProofIdentity(observed.identity, expected?.identity)
      ) throw managedError("recovery_required", "shelf_backup_changed");
      await renameAndSync(backup, original);
      await cleanupManagedBackupParents(settings.aiosPath, backup);
    }
    if (!(await lstatIfPresent(original))) throw managedError("recovery_required", "shelf_backup_missing");
  }
  await restoreDerivedArtifacts(settings.aiosPath, journal.old_artifacts);
  const receiptPath = path.join(state.receipts, `${journal.name}.json`);
  if (journal.old_receipt) {
    await writeJsonAtomic(receiptPath, journal.old_receipt, settings.limits.maxReceiptBytes);
  } else {
    await removeFileAndSync(receiptPath);
  }
  const stageRoot = path.dirname(journal.staged_bundle);
  try {
    await removeOwnedStage(
      stageRoot,
      journal.skill,
      settings.limits,
      journal.canonical_publish_identity,
      journal.staged_root_identity
    );
  } catch {
    await transitionJournal(state, journal, "needs_attention");
    throw managedError("recovery_required", "managed_skill_recovery_needs_attention");
  }
  await removeFileAndSync(state.journal);
  await cleanupEmptyCanonicalInternals(settings.aiosPath);
}

function adoptionStateRequiresCanonical(state) {
  return new Set([
    "canonical_published",
    "projections_published",
    "derived_published",
    "receipt_published",
    "committed"
  ]).has(state);
}

async function rollbackCreatedProjections(settings, state, journal) {
  if (journal.pending_projection) {
    const pending = journal.pending_projection;
    await assertDirectoryChain(journal.projection_parent_chains?.[pending.destination] || []);
    const stats = await lstatIfPresent(pending.destination, { bigint: true });
    if (stats) {
      const evidence = pending.evidence;
      if (
        !evidence
        || !stats.isSymbolicLink()
        || await readLinkBounded(pending.destination) !== evidence.target
        || !matchesLeafProofIdentity(statIdentity(stats), evidence.identity)
      ) {
        await transitionJournal(state, journal, "needs_attention");
        throw managedError("recovery_required", "projection_publication_needs_attention");
      }
      await unlinkAndSync(pending.destination);
    }
    journal.pending_projection = null;
  }
  for (const destination of [...(journal.created_projections || [])].reverse()) {
    await assertDirectoryChain(journal.projection_parent_chains?.[destination] || []);
    const stats = await lstatIfPresent(destination, { bigint: true });
    const evidence = journal.created_projection_evidence?.[destination];
    if (!evidence) {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "projection_evidence_missing");
    }
    if (!stats) continue;
    const rawTarget = stats.isSymbolicLink() ? await readLinkBounded(destination) : null;
    if (
      !stats.isSymbolicLink()
      || rawTarget !== evidence.target
      || !matchesProofIdentity(statIdentity(stats), evidence.identity)
    ) {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "projection_publication_needs_attention");
    }
    await unlinkAndSync(destination);
  }
}

async function rollbackCreatedDirectories(journal) {
  for (const created of [...(journal.created_directories || [])].reverse()) {
    const stats = await lstatIfPresent(created.path, { bigint: true });
    if (
      stats?.isDirectory()
      && !stats.isSymbolicLink()
      && String(stats.dev) === created.dev
      && String(stats.ino) === created.ino
    ) {
      await fs.rmdir(created.path).catch(() => {});
    }
  }
}

async function publishManagedProjection(settings, state, journal, destination, target) {
  const chain = await ensureTrackedDirectoryChain(settings.homePath, path.dirname(destination), state, journal);
  journal.projection_parent_chains[destination] = chain;
  journal.pending_projection = { destination, target, evidence: null };
  await transitionJournal(state, journal, journal.state);
  await assertDirectoryChain(chain);
  if (await lstatIfPresent(destination)) throw managedError("destination_changed", "projection_destination_changed");
  await fs.symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
  await syncDirectory(path.dirname(destination));
  await checkpoint(settings, "projection_link_created_uncommitted", { destination, target });
  const evidence = await linkEvidence(destination);
  await assertDirectoryChain(chain);
  journal.pending_projection.evidence = evidence;
  await transitionJournal(state, journal, journal.state);
  journal.created_projections.push(destination);
  journal.created_projection_evidence[destination] = evidence;
  journal.pending_projection = null;
  await transitionJournal(state, journal, journal.state);
}

async function rollbackReconcile(settings, state, journal) {
  await rollbackCreatedProjections(settings, state, journal);
  await rollbackCreatedDirectories(journal);
  await restoreDerivedArtifacts(settings.aiosPath, journal.old_artifacts);
  await removeFileAndSync(state.journal);
}

async function finishCommittedReconcile(settings, state, journal) {
  const record = journal.projection_history_record;
  if (record) {
    validateProjectionHistoryRecord(settings, record, journal.operation_id);
    await ensureDurableOwnedDirectory(state.projectionHistory);
    const destination = path.join(state.projectionHistory, `${journal.operation_id}.json`);
    const existing = await readOwnedJsonIfPresent(destination, settings.limits.maxReceiptBytes);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "projection_history_changed");
    }
    if (!existing) await writeJsonAtomic(destination, record, settings.limits.maxReceiptBytes);
  }
  await transitionJournal(state, journal, "reconcile_history_published");
  await removeFileAndSync(state.journal);
}

async function ensureTrackedDirectoryChain(root, destination, state, journal) {
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) return captureDirectoryChain(root, destination);
    throw managedError("unsafe_state", "projection_parent_outside_home");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const existing = await lstatIfPresent(current, { bigint: true });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw managedError("destination_changed", "projection_parent_changed");
      }
      continue;
    }
    await createDurableDirectory(current, 0o700);
    const created = await fs.lstat(current, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw managedError("destination_changed", "projection_parent_changed");
    }
    journal.created_directories.push({
      path: current,
      dev: String(created.dev),
      ino: String(created.ino)
    });
    await transitionJournal(state, journal, journal.state);
  }
  return captureDirectoryChain(root, destination);
}

async function captureDirectoryChain(root, destination) {
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw managedError("unsafe_state", "projection_parent_outside_home");
  }
  const chain = [];
  let current = root;
  for (const segment of [null, ...(relative ? relative.split(path.sep) : [])]) {
    if (segment) current = path.join(current, segment);
    const stats = await lstatIfPresent(current, { bigint: true });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw managedError("destination_changed", "projection_parent_changed");
    }
    chain.push({ path: current, identity: statIdentity(stats) });
  }
  return chain;
}

async function assertDirectoryChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw managedError("recovery_required", "projection_parent_evidence_missing");
  }
  for (const expected of chain) {
    const stats = await lstatIfPresent(expected.path, { bigint: true });
    if (!matchesDirectoryProofIdentity(stats ? statIdentity(stats) : null, expected.identity)) {
      throw managedError("destination_changed", "projection_parent_changed");
    }
  }
}

function validRecordedDirectoryChain(root, destination, chain) {
  if (!Array.isArray(chain)) return false;
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const expected = [path.resolve(root)];
  let current = path.resolve(root);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    expected.push(current);
  }
  return chain.length === expected.length && chain.every((entry, index) => (
    entry?.identity?.type === "directory" && sameLexicalPath(entry.path || "", expected[index])
  ));
}

async function rollbackRemoval(settings, state, journal) {
  const replaced = journal.receipt?.replaced_source;
  if (replaced?.kind === "native-directory") {
    const original = await lstatIfPresent(replaced.original);
    const backup = await lstatIfPresent(replaced.backup);
    if (original?.isDirectory() && !original.isSymbolicLink() && !backup) {
      const bundle = await inspectBundle(replaced.original, journal.name, settings.limits).catch(() => null);
      const expectedIdentity = replaced.backup_evidence?.identity || replaced.source_evidence?.identity;
      if (
        bundle?.bundleDigest === journal.skill.bundle_digest
        && matchesDirectoryProofIdentity(bundle?.rootIdentity, expectedIdentity)
      ) {
        await renameAndSync(replaced.original, replaced.backup);
      } else {
        throw managedError("recovery_required", "native_restore_destination_changed");
      }
    }
  } else if (replaced?.kind === "canonical-link") {
    const original = await lstatIfPresent(replaced.original);
    const backup = await lstatIfPresent(replaced.backup);
    if (original?.isSymbolicLink() && !backup) {
      const observed = await linkEvidence(replaced.original);
      const expected = replaced.backup_evidence || replaced.source_evidence;
      if (
        observed.target !== expected?.target
        || !matchesLeafProofIdentity(observed.identity, expected?.identity)
      ) throw managedError("recovery_required", "shelf_restore_destination_changed");
      await renameAndSync(replaced.original, replaced.backup);
    }
  }
  const archiveStats = await lstatIfPresent(journal.archive);
  const liveStats = await lstatIfPresent(journal.canonical_path);
  if ((archiveStats && liveStats) || (!archiveStats && !liveStats)) {
    await transitionJournal(state, journal, "needs_attention");
    throw managedError("recovery_required", "removal_archive_needs_attention");
  }
  if (archiveStats && !liveStats) {
    const archived = await inspectBundle(journal.archive, journal.name, settings.limits).catch(() => null);
    if (
      archived?.bundleDigest === journal.skill.bundle_digest
      && matchesDirectoryProofIdentity(archived?.rootIdentity, journal.receipt?.canonical?.identity)
    ) {
      await renameAndSync(journal.archive, journal.canonical_path);
    } else {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "removal_archive_needs_attention");
    }
  } else {
    const live = await inspectBundle(journal.canonical_path, journal.name, settings.limits).catch(() => null);
    if (
      live?.bundleDigest !== journal.skill.bundle_digest
      || !matchesDirectoryProofIdentity(live?.rootIdentity, journal.receipt?.canonical?.identity)
    ) {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "removal_archive_needs_attention");
    }
  }
  for (const intent of journal.detached_projection_intents || []) {
    const destinationStats = await lstatIfPresent(intent.destination);
    const backupStats = await lstatIfPresent(intent.backup, { bigint: true });
    if (destinationStats && backupStats) {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "projection_restore_needs_attention");
    }
    if (backupStats) {
      const observed = await linkEvidence(intent.backup);
      const expected = intent.backup_evidence || intent.evidence;
      if (
        observed.target !== expected?.target
        || !matchesLeafProofIdentity(observed.identity, expected?.identity)
      ) {
        await transitionJournal(state, journal, "needs_attention");
        throw managedError("recovery_required", "projection_restore_needs_attention");
      }
      const chain = await captureDirectoryChain(settings.homePath, path.dirname(intent.destination));
      await assertDirectoryChain(chain);
      await renameAndSync(intent.backup, intent.destination);
      await assertDirectoryChain(chain);
    } else if (!destinationStats) {
      await transitionJournal(state, journal, "needs_attention");
      throw managedError("recovery_required", "projection_restore_needs_attention");
    }
  }
  await restoreDerivedArtifacts(settings.aiosPath, journal.old_artifacts);
  await writeJsonAtomic(
    path.join(state.receipts, `${journal.name}.json`),
    journal.receipt,
    settings.limits.maxReceiptBytes
  );
  await removeFileAndSync(state.journal);
  await fs.rmdir(path.dirname(journal.archive)).catch(() => {});
  await cleanupEmptyCanonicalInternals(settings.aiosPath);
}

async function recoverPendingTransaction(settings, state) {
  const journal = await readOwnedJsonIfPresent(state.journal, settings.limits.maxJournalBytes);
  if (!journal) return { status: "clean" };
  await validateJournalAuthority(settings, state, journal);
  if (journal.state === "needs_attention") throw managedError("recovery_required", "managed_skill_recovery_needs_attention");
  if (journal.kind === "removal" && journal.state === "cleanup_started") {
    await transitionJournal(state, journal, "needs_attention");
    throw managedError("recovery_required", "managed_skill_recovery_needs_attention");
  }
  if (journal.kind === "removal" && journal.state === "cleanup_completed") {
    await removeFileAndSync(state.journal);
    return { status: "completed" };
  }
  if (
    journal.kind === "reconcile"
    && ["reconcile_committed", "reconcile_history_published"].includes(journal.state)
  ) {
    await finishCommittedReconcile(settings, state, journal);
    return { status: "completed" };
  }
  if (journal.kind === "official-batch" && journal.state === "official_committed") {
    await finishCommittedOfficialBatch(settings, state, journal);
    return { status: "completed" };
  }
  if (journal.kind === "adoption") {
    await rollbackAdoption(settings, state, journal);
    return { status: "rolled_back" };
  }
  if (journal.kind === "removal") {
    await rollbackRemoval(settings, state, journal);
    return { status: "rolled_back" };
  }
  if (journal.kind === "reconcile") {
    await rollbackReconcile(settings, state, journal);
    return { status: "rolled_back" };
  }
  if (journal.kind === "official-batch") {
    await rollbackOfficialBatch(settings, state, journal);
    return { status: "rolled_back" };
  }
  throw managedError("unsafe_state", "unknown_transaction_kind");
}

async function transitionJournal(state, journal, nextState) {
  journal.state = nextState;
  await writeJsonAtomic(state.journal, journal, state.maxJournalBytes);
}

async function checkpoint(settings, name, journal) {
  if (typeof settings.hooks?.checkpoint === "function") await settings.hooks.checkpoint(name, structuredClone(journal));
}

async function inspectReceiptProjections(settings, receipt) {
  const canonicalPath = path.join(settings.aiosPath, "skills", receipt.name);
  const projections = [];
  const receiptRows = new Map((receipt.projections || []).map((row) => [row.relative_path, row]));
  const targets = await projectionTargetsForSettings(settings);
  for (const target of targets) {
    const relativePath = `${target.relativePath}/${receipt.name}`;
    const projection = receiptRows.get(relativePath) || {
      relative_path: relativePath,
      hosts: target.hosts,
      classification: "absent"
    };
    const destination = path.join(settings.homePath, ...projection.relative_path.split("/"));
    const stats = await lstatIfPresent(destination, { bigint: true });
    let classification = "absent";
    let linkTarget = null;
    if (stats?.isSymbolicLink()) {
      linkTarget = await readLinkBounded(destination);
      const target = path.resolve(path.dirname(destination), linkTarget);
      if (sameLexicalPath(target, canonicalPath)) classification = "exact-managed-projection";
      else if (
        projection.classification === "indirect-selected-source"
        && sameLexicalPath(target, receipt.source.path)
      ) classification = "indirect-preserved";
      else classification = "foreign-link";
    } else if (stats) classification = "real-unmanaged";
    projections.push({
      relative_path: projection.relative_path,
      hosts: target.hosts,
      classification,
      ...(stats?.isSymbolicLink() && {
        identity: statIdentity(stats),
        link_target: linkTarget
      })
    });
  }
  const blocking = projections.find(({ classification }) => ![
    "exact-managed-projection",
    "indirect-preserved",
    "absent"
  ].includes(classification));
  if (blocking) throw managedError("unproved_removal", "projection_changed");
  return projections.sort((left, right) => compareUtf8(left.relative_path, right.relative_path));
}

async function removeManifestTree(root, skill, limits) {
  const current = await inspectBundle(root, skill.name, limits);
  if (current.bundleDigest !== skill.bundle_digest) throw managedError("unproved_removal", "archive_manifest_changed");
  for (const file of [...skill.files].sort((left, right) => compareUtf8(right.path, left.path))) {
    const target = path.join(root, ...file.path.split("/"));
    const observed = await readBoundedRegularFile(target, file.bytes);
    if (observed.bytes.length !== file.bytes || sha256(observed.bytes) !== file.sha256) {
      throw managedError("unproved_removal", "archive_file_changed");
    }
    await unlinkAndSync(target);
  }
  const dirs = [...(skill.directories || [])].sort((left, right) => {
    const depth = right.split("/").length - left.split("/").length;
    return depth || compareUtf8(right, left);
  });
  for (const relative of dirs) await removeEmptyDirectoryAndSync(path.join(root, ...relative.split("/")));
  await removeEmptyDirectoryAndSync(root);
}

async function removeOwnedStage(
  stageRoot,
  skill,
  limits,
  expectedBundleIdentity = null,
  expectedStageRootIdentity = null
) {
  const stats = await lstatIfPresent(stageRoot, { bigint: true });
  if (!stats) return;
  if (
    !expectedStageRootIdentity
    || !matchesDirectoryProofIdentity(statIdentity(stats), expectedStageRootIdentity)
  ) throw managedError("recovery_required", "staged_root_identity_changed");
  const bundle = path.join(stageRoot, skill.name);
  if (await lstatIfPresent(bundle)) {
    const observed = await inspectBundle(bundle, skill.name, limits);
    if (
      !expectedBundleIdentity
      || !matchesDirectoryProofIdentity(observed.rootIdentity, expectedBundleIdentity)
    ) throw managedError("recovery_required", "staged_bundle_identity_changed");
    await removeManifestTree(bundle, skill, limits);
  }
  await fs.rmdir(stageRoot);
}

async function canonicalMatchesProof(canonicalPath, skill, limits) {
  try {
    const observed = await inspectBundle(canonicalPath, skill.name, limits);
    return observed.bundleDigest === skill.bundle_digest;
  } catch {
    return false;
  }
}

async function validateReceiptAuthority(settings, receipt, expectedName) {
  if (
    !receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.format !== RECEIPT_FORMAT
    || receipt.name !== expectedName
    || !NAME_RE.test(expectedName)
    || typeof receipt.operation_id !== "string"
    || !/^skill-adopt-[a-f0-9]{24}$/.test(receipt.operation_id)
    || typeof receipt.plan_fingerprint !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.plan_fingerprint)
    || receipt.bundle?.name !== expectedName
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.bundle?.bundle_digest || "")
  ) throw managedError("unsafe_state", "invalid_managed_receipt");
  validateSkillProof(receipt.bundle, expectedName, settings.limits);

  const canonicalPath = path.join(settings.aiosPath, "skills", expectedName);
  if (!sameLexicalPath(receipt.canonical?.path || "", canonicalPath)) {
    throw managedError("unsafe_state", "invalid_managed_receipt_path");
  }
  if (receipt.canonical?.identity?.type !== "directory") {
    throw managedError("unsafe_state", "invalid_managed_receipt_identity");
  }

  const targets = await projectionTargetsForSettings(settings);
  const expectedProjections = new Set(targets.map(({ relativePath }) => `${relativePath}/${expectedName}`));
  const observedProjections = new Set();
  if (!Array.isArray(receipt.projections) || receipt.projections.length > expectedProjections.size) {
    throw managedError("unsafe_state", "invalid_managed_receipt_projections");
  }
  for (const projection of receipt.projections) {
    if (
      !projection || typeof projection !== "object" || Array.isArray(projection)
      || typeof projection.relative_path !== "string"
      || !expectedProjections.has(projection.relative_path)
      || observedProjections.has(projection.relative_path)
    ) throw managedError("unsafe_state", "invalid_managed_receipt_projection_path");
    const destination = path.join(settings.homePath, ...projection.relative_path.split("/"));
    if (!isPathWithinLexically(settings.homePath, destination)) {
      throw managedError("unsafe_state", "invalid_managed_receipt_projection_path");
    }
    observedProjections.add(projection.relative_path);
  }
  if (observedProjections.size === 0) throw managedError("unsafe_state", "incomplete_managed_receipt_projections");
  validateReplacedSource(settings, receipt.replaced_source, receipt.operation_id, expectedName, targets);
  validateSourceAuthority(settings, receipt.source, receipt.replaced_source, expectedName, targets, {
    requireReplacement: true
  });
  const portable = normalizePortableRegistry(
    { managed: [receipt.portable_record] },
    [{ dir: expectedName }]
  ).managed;
  if (
    portable.length !== 1
    || portable[0].name !== expectedName
    || portable[0].bundle_digest !== receipt.bundle.bundle_digest
    || portable[0].source_kind !== receipt.source.kind
    || canonicalJson(portable[0]) !== canonicalJson(receipt.portable_record)
  ) throw managedError("unsafe_state", "invalid_managed_receipt_portable_record");
}

async function validateJournalAuthority(settings, state, journal) {
  if (
    !journal || typeof journal !== "object" || Array.isArray(journal)
    || journal.format !== JOURNAL_FORMAT
    || !["adoption", "reconcile", "removal", "official-batch"].includes(journal.kind)
    || typeof journal.operation_id !== "string"
    || !/^skill-(?:adopt|reconcile|remove|official)-[a-f0-9]{24}$/.test(journal.operation_id)
  ) throw managedError("unsafe_state", "invalid_transaction_journal");
  const allowedStates = {
    adoption: new Set(["prepared", "source_backed_up", "canonical_published", "projections_published", "derived_published", "receipt_published", "committed", "needs_attention"]),
    reconcile: new Set([
      "reconcile_prepared",
      "reconcile_derived_published",
      "reconcile_committed",
      "reconcile_history_published",
      "needs_attention"
    ]),
    removal: new Set(["remove_prepared", "projections_detached", "canonical_archived", "archive_verified", "source_restored", "derived_published", "receipt_tombstoned", "remove_committed", "cleanup_started", "cleanup_completed", "needs_attention"]),
    "official-batch": new Set([
      "official_prepared",
      "official_staged",
      "official_publishing",
      "official_verified",
      "official_derived_publishing",
      "official_derived_published",
      "official_committed",
      "needs_attention"
    ])
  };
  if (!allowedStates[journal.kind].has(journal.state)) {
    throw managedError("unsafe_state", "invalid_transaction_state");
  }
  validateArtifactSnapshot(journal.old_artifacts, settings.limits);
  if (journal.kind === "reconcile" && journal.projection_history_record != null) {
    validateProjectionHistoryRecord(settings, journal.projection_history_record, journal.operation_id);
  }

  const targets = await projectionTargetsForSettings(settings);
  const targetRoots = new Set(targets.map(({ path: targetPath }) => path.resolve(targetPath)));
  const validProjectionPath = (candidate, expectedName = null) => {
    if (typeof candidate !== "string" || !isPathWithinLexically(settings.homePath, candidate)) return false;
    const parent = path.resolve(path.dirname(candidate));
    return targetRoots.has(parent) && NAME_RE.test(path.basename(candidate))
      && (!expectedName || path.basename(candidate) === expectedName);
  };
  const validCreatedDirectory = (candidate) => {
    if (typeof candidate !== "string" || !isPathWithinLexically(settings.homePath, candidate)) return false;
    const resolved = path.resolve(candidate);
    return resolved !== path.resolve(settings.homePath)
      && [...targetRoots].some((targetRoot) => isPathWithinLexically(resolved, targetRoot));
  };
  for (const destination of journal.created_projections || []) {
    const evidence = journal.created_projection_evidence?.[destination];
    if (!validProjectionPath(destination, journal.kind === "adoption" ? journal.name : null)) {
      throw managedError("unsafe_state", "invalid_transaction_projection_path");
    }
    if (
      !evidence
      || evidence.identity?.type !== "symlink"
      || typeof evidence.target !== "string"
    ) throw managedError("unsafe_state", "invalid_transaction_projection_evidence");
    if (!validRecordedDirectoryChain(
      settings.homePath,
      path.dirname(destination),
      journal.projection_parent_chains?.[destination]
    )) throw managedError("unsafe_state", "invalid_transaction_parent_chain");
  }
  if (journal.pending_projection) {
    if (
      !validProjectionPath(
        journal.pending_projection.destination,
        journal.kind === "adoption" ? journal.name : null
      )
      || typeof journal.pending_projection.target !== "string"
      || !isPathWithinLexically(path.join(settings.aiosPath, "skills"), journal.pending_projection.target)
      || !validRecordedDirectoryChain(
        settings.homePath,
        path.dirname(journal.pending_projection.destination),
        journal.projection_parent_chains?.[journal.pending_projection.destination]
      )
    ) throw managedError("unsafe_state", "invalid_transaction_projection_path");
  }
  for (const created of journal.created_directories || []) {
    if (!created || !validCreatedDirectory(created.path)) {
      throw managedError("unsafe_state", "invalid_transaction_directory_path");
    }
  }

  if (journal.kind === "official-batch") {
    await validateOfficialBatchJournal(settings, journal);
  } else if (journal.kind === "adoption") {
    if (!NAME_RE.test(journal.name || "")) throw managedError("unsafe_state", "invalid_transaction_skill_name");
    const canonical = path.join(settings.aiosPath, "skills", journal.name);
    const staged = path.join(settings.aiosPath, "skills", ".managed-skill-store", "staging", journal.operation_id, journal.name);
    if (!sameLexicalPath(journal.canonical_path || "", canonical) || !sameLexicalPath(journal.staged_bundle || "", staged)) {
      throw managedError("unsafe_state", "invalid_transaction_canonical_path");
    }
    validateSkillProof(journal.skill, journal.name, settings.limits);
    if (
      journal.canonical_preexisting_identity != null
      && journal.canonical_preexisting_identity?.type !== "directory"
    ) throw managedError("unsafe_state", "invalid_transaction_canonical_identity");
    if (
      (journal.staged_root_identity != null && journal.staged_root_identity?.type !== "directory")
      || (journal.canonical_publish_identity != null && journal.canonical_publish_identity?.type !== "directory")
    ) throw managedError("unsafe_state", "invalid_transaction_staged_identity");
    if (journal.old_receipt != null) {
      await validateReceiptAuthority(settings, journal.old_receipt, journal.name);
    }
    validateReplacedSource(settings, journal.replaced_source, journal.operation_id, journal.name, targets);
    validateSourceAuthority(settings, journal.source, journal.replaced_source, journal.name, targets);
  } else if (journal.kind === "removal") {
    if (!NAME_RE.test(journal.name || "")) throw managedError("unsafe_state", "invalid_transaction_skill_name");
    const canonical = path.join(settings.aiosPath, "skills", journal.name);
    const archive = path.join(settings.aiosPath, "skills", ".managed-skill-store", "recovery", journal.operation_id, journal.name);
    if (!sameLexicalPath(journal.canonical_path || "", canonical) || !sameLexicalPath(journal.archive || "", archive)) {
      throw managedError("unsafe_state", "invalid_transaction_canonical_path");
    }
    await validateReceiptAuthority(settings, journal.receipt, journal.name);
    for (const [index, intent] of (journal.detached_projection_intents || []).entries()) {
      if (
        !intent
        || !validProjectionPath(intent.destination, journal.name)
        || !sameLexicalPath(
          intent.backup || "",
          siblingDetachedProjectionPath(intent.destination, journal.operation_id, index)
        )
        || !validRecordedDirectoryChain(settings.homePath, path.dirname(intent.destination), intent.parent_chain)
      ) {
        throw managedError("unsafe_state", "invalid_transaction_projection_path");
      }
    }
  }
  if (!sameLexicalPath(state.journal, path.join(state.root, "transaction.json"))) {
    throw managedError("unsafe_state", "invalid_transaction_state_root");
  }
}

async function validateOfficialBatchJournal(settings, journal) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(journal.plan_fingerprint || "")
    || journal.operation_id !== `skill-official-${journal.plan_fingerprint.slice(7, 31)}`
    || !/^sha256:[a-f0-9]{64}$/.test(journal.source_fingerprint || "")
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(journal.candidate_version || "")
    || typeof journal.publish_catalogs !== "boolean"
    || !Array.isArray(journal.targets)
    || journal.targets.length > settings.limits.maxOwnedSkills
  ) throw managedError("unsafe_state", "invalid_official_batch_journal");
  validateOfficialArtifactModes(journal.old_artifact_modes);

  const manifestByName = new Map(officialSkillManifest().skills.map((skill) => [skill.name, skill]));
  const expectedNames = new Set(officialSkillNames());
  const observedNames = new Set();
  const skillsRoot = path.join(settings.aiosPath, "skills");
  const stageRoot = path.join(skillsRoot, ".managed-skill-store", "staging", journal.operation_id);
  const recoveryRoot = path.join(skillsRoot, ".managed-skill-store", "recovery", journal.operation_id);
  for (const target of journal.targets) {
    if (
      !target || typeof target !== "object" || Array.isArray(target)
      || !expectedNames.has(target.name)
      || observedNames.has(target.name)
    ) throw managedError("unsafe_state", "invalid_official_batch_target");
    observedNames.add(target.name);
    const definition = manifestByName.get(target.name);
    const candidateByPath = new Map(definition.files.map((file) => [file.path, file]));
    const officialPaths = new Set(definition.files.map(({ path: relative }) => relative));
    const overlayPaths = new Set(definition.generated_overlays.map(({ path: relative }) => relative));
    const allowedPaths = new Set([...officialPaths, ...overlayPaths]);
    if (
      !sameLexicalPath(target.destination || "", path.join(skillsRoot, target.name))
      || !sameLexicalPath(target.staged_path || "", path.join(stageRoot, target.name))
      || !sameLexicalPath(
        target.backup_path || "",
        path.join(recoveryRoot, "official-backups", target.name)
      )
      || !sameLexicalPath(
        target.rollback_path || "",
        path.join(recoveryRoot, "official-rollbacks", target.name)
      )
      || !Array.isArray(target.desired_files)
    ) throw managedError("unsafe_state", "invalid_official_batch_path");

    const desiredPaths = new Set();
    for (const file of target.desired_files) {
      validateOfficialJournalFile(file, allowedPaths, settings.limits, { desired: true });
      if (desiredPaths.has(file.path)) throw managedError("unsafe_state", "invalid_official_batch_file");
      desiredPaths.add(file.path);
      if (officialPaths.has(file.path) !== (file.kind === "candidate")) {
        throw managedError("unsafe_state", "invalid_official_batch_file_kind");
      }
      if (overlayPaths.has(file.path) !== (file.kind === "overlay")) {
        throw managedError("unsafe_state", "invalid_official_batch_file_kind");
      }
      if (file.kind === "candidate") {
        const candidate = candidateByPath.get(file.path);
        let packed;
        let installed;
        try {
          packed = decodeCanonicalBase64(file.packed_base64, settings.limits.maxFileBytes);
          installed = materializeOfficialCandidateBytes(
            packed,
            candidate?.render,
            journal.candidate_version
          );
        } catch {
          throw managedError("unsafe_state", "invalid_official_batch_candidate_authority");
        }
        if (
          !candidate
          || packed.length !== candidate.bytes
          || sha256(packed) !== candidate.packed_sha256
          || file.mode !== candidate.mode
          || file.bytes !== installed.length
          || file.sha256 !== sha256(installed)
          || file.source_identity != null
        ) throw managedError("unsafe_state", "invalid_official_batch_candidate_authority");
      } else {
        const preimage = target.preimage?.files?.find(({ path: relative }) => relative === file.path);
        if (
          !preimage
          || (ENFORCES_POSIX_MODES && preimage.mode !== file.mode)
          || preimage.bytes !== file.bytes
          || preimage.sha256 !== file.sha256
          || file.packed_base64 != null
          || !matchesLeafProofIdentity(preimage.identity, file.source_identity)
        ) throw managedError("unsafe_state", "invalid_official_batch_overlay_authority");
      }
    }
    if ([...officialPaths].some((relative) => !desiredPaths.has(relative))) {
      throw managedError("unsafe_state", "incomplete_official_batch_files");
    }
    if (target.stage_root_identity != null && target.stage_root_identity?.type !== "directory") {
      throw managedError("unsafe_state", "invalid_official_batch_stage_identity");
    }
    validateOfficialJournalTree(target.preimage, allowedPaths, settings.limits, { allowNull: true });
    validateOfficialJournalTree(target.staged_manifest, desiredPaths, settings.limits, { allowNull: true });
    if (target.staged_manifest && !target.stage_root_identity) {
      throw managedError("unsafe_state", "invalid_official_batch_stage_identity");
    }
    if (
      !["official_prepared", "needs_attention"].includes(journal.state)
      && (!target.stage_root_identity || !target.staged_manifest)
    ) throw managedError("unsafe_state", "incomplete_official_batch_staged_authority");
    if (target.staged_manifest) {
      if (
        !matchesDirectoryProofIdentity(
          target.staged_manifest.root_identity,
          target.stage_root_identity
        )
        || !officialJournalManifestMatchesDesired(target.staged_manifest, target.desired_files)
      ) throw managedError("unsafe_state", "invalid_official_batch_staged_authority");
    }
  }
}

function decodeCanonicalBase64(encoded, maxBytes) {
  if (
    typeof encoded !== "string"
    || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) throw new Error("invalid base64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== encoded) throw new Error("invalid base64");
  return bytes;
}

function officialJournalManifestMatchesDesired(staged, desired) {
  if (staged.files.length !== desired.length) return false;
  const byPath = new Map(desired.map((file) => [file.path, file]));
  return staged.files.every((file) => {
    const expected = byPath.get(file.path);
    return Boolean(
      expected
      && file.identity?.type === "file"
      && file.bytes === expected.bytes
      && file.sha256 === expected.sha256
      && (!ENFORCES_POSIX_MODES || file.mode === expected.mode)
    );
  });
}

function validateOfficialArtifactModes(modes) {
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) {
    throw managedError("unsafe_state", "invalid_official_batch_artifact_modes");
  }
  const expected = new Set(["_registry.json", "INDEX.md", "RESOLVER.md"]);
  for (const [name, mode] of Object.entries(modes)) {
    if (
      !expected.delete(name)
      || (mode !== null && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777))
    ) throw managedError("unsafe_state", "invalid_official_batch_artifact_modes");
  }
  if (expected.size > 0) throw managedError("unsafe_state", "invalid_official_batch_artifact_modes");
}

function validateOfficialJournalTree(tree, allowedPaths, limits, { allowNull = false } = {}) {
  if (tree == null) {
    if (allowNull) return;
    throw managedError("unsafe_state", "invalid_official_batch_tree");
  }
  if (
    !tree || typeof tree !== "object" || Array.isArray(tree)
    || tree.root_identity?.type !== "directory"
    || (ENFORCES_POSIX_MODES
      ? tree.mode !== 0o755
      : (!Number.isSafeInteger(tree.mode) || tree.mode < 0 || tree.mode > POSIX_MODE_MASK))
    || !Array.isArray(tree.files)
    || tree.files.length > limits.maxFiles
  ) throw managedError("unsafe_state", "invalid_official_batch_tree");
  const seen = new Set();
  for (const file of tree.files) {
    validateOfficialJournalFile(file, allowedPaths, limits);
    if (seen.has(file.path) || file.identity?.type !== "file") {
      throw managedError("unsafe_state", "invalid_official_batch_tree_file");
    }
    seen.add(file.path);
  }
}

function validateOfficialJournalFile(file, allowedPaths, limits, { desired = false } = {}) {
  if (
    !file || typeof file !== "object" || Array.isArray(file)
    || typeof file.path !== "string" || !allowedPaths.has(file.path)
    || file.path.includes("/") || file.path.includes("\\") || file.path.includes("\0")
    || (desired
      ? file.mode !== 0o644
      : (ENFORCES_POSIX_MODES
        ? file.mode !== 0o644
        : (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > POSIX_MODE_MASK)))
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.maxFileBytes
    || !/^[a-f0-9]{64}$/.test(file.sha256 || "")
    || (desired && !["candidate", "overlay"].includes(file.kind))
    || (desired && file.kind === "overlay" && file.source_identity?.type !== "file")
  ) throw managedError("unsafe_state", "invalid_official_batch_file");
}

function validateReplacedSource(settings, replaced, operationId, name, targets) {
  if (replaced == null) return;
  if (!replaced || typeof replaced !== "object" || Array.isArray(replaced)) {
    throw managedError("unsafe_state", "invalid_replaced_source");
  }
  if (replaced.kind === "native-directory") {
    const originals = new Set(targets.map(({ path: targetPath }) => path.join(targetPath, name)));
    if (!originals.has(path.resolve(replaced.original || ""))) {
      throw managedError("unsafe_state", "invalid_replaced_source_path");
    }
    if (!sameLexicalPath(replaced.backup || "", siblingBackupPath(replaced.original, operationId))) {
      throw managedError("unsafe_state", "invalid_replaced_source_backup");
    }
    if (
      replaced.source_evidence?.identity?.type !== "directory"
      || replaced.source_evidence?.bundle_digest == null
      || (replaced.backup_evidence != null && replaced.backup_evidence?.identity?.type !== "directory")
      || (replaced.projection_evidence != null && replaced.projection_evidence?.identity?.type !== "symlink")
      || (replaced.projection_evidence != null && typeof replaced.projection_evidence?.target !== "string")
      || !validRecordedDirectoryChain(
        settings.homePath,
        path.dirname(replaced.original),
        replaced.projection_parent_chain
      )
    ) throw managedError("unsafe_state", "invalid_replaced_source_evidence");
    return;
  }
  if (replaced.kind === "canonical-link") {
    const original = path.join(settings.aiosPath, "skills", name);
    const backup = path.join(
      settings.aiosPath,
      "skills",
      ".managed-skill-store",
      "recovery",
      "source-backups",
      operationId,
      "canonical-link"
    );
    if (!sameLexicalPath(replaced.original || "", original) || !sameLexicalPath(replaced.backup || "", backup)) {
      throw managedError("unsafe_state", "invalid_replaced_source_path");
    }
    if (
      replaced.source_evidence?.identity?.type !== "symlink"
      || typeof replaced.source_evidence?.target !== "string"
      || (replaced.backup_evidence != null && replaced.backup_evidence?.identity?.type !== "symlink")
    ) throw managedError("unsafe_state", "invalid_replaced_source_evidence");
    return;
  }
  throw managedError("unsafe_state", "invalid_replaced_source_kind");
}

function validateSourceAuthority(
  settings,
  source,
  replaced,
  name,
  targets,
  { requireReplacement = false } = {}
) {
  if (
    !source || typeof source !== "object" || Array.isArray(source)
    || !["local-reviewed-directory", "discovered-native-directory", "discovered-canonical-link"].includes(source.kind)
    || typeof source.path !== "string" || !path.isAbsolute(source.path)
    || typeof source.bundle_path !== "string" || !path.isAbsolute(source.bundle_path)
    || Buffer.byteLength(source.path, "utf8") > settings.limits.maxRelativePathBytes * 4
    || Buffer.byteLength(source.bundle_path, "utf8") > settings.limits.maxRelativePathBytes * 4
    || source.identity?.type !== "directory"
  ) throw managedError("unsafe_state", "invalid_managed_source");

  const canonical = path.join(settings.aiosPath, "skills", name);
  if (source.kind === "local-reviewed-directory") {
    if (!sameLexicalPath(source.path, source.bundle_path) || replaced != null) {
      throw managedError("unsafe_state", "invalid_managed_source_replacement");
    }
    return;
  }
  if (source.kind === "discovered-native-directory") {
    const originals = new Set(targets.map(({ path: targetPath }) => path.join(targetPath, name)));
    if (!originals.has(path.resolve(source.path)) || !sameLexicalPath(source.path, source.bundle_path)) {
      throw managedError("unsafe_state", "invalid_managed_source_path");
    }
    if (requireReplacement && replaced?.kind !== "native-directory") {
      throw managedError("unsafe_state", "invalid_managed_source_replacement");
    }
    if (replaced != null && (
      replaced.kind !== "native-directory"
      || !sameLexicalPath(replaced.original, source.path)
      || !matchesDirectoryProofIdentity(replaced.source_evidence?.identity, source.identity)
    )) throw managedError("unsafe_state", "invalid_managed_source_replacement");
    return;
  }
  if (!sameLexicalPath(source.path, canonical)) {
    throw managedError("unsafe_state", "invalid_managed_source_path");
  }
  if (requireReplacement && replaced?.kind !== "canonical-link") {
    throw managedError("unsafe_state", "invalid_managed_source_replacement");
  }
  if (replaced != null && (
    replaced.kind !== "canonical-link"
    || !sameLexicalPath(replaced.original, source.path)
  )) throw managedError("unsafe_state", "invalid_managed_source_replacement");
}

function validateSkillProof(skill, expectedName, limits) {
  if (
    !skill || typeof skill !== "object" || Array.isArray(skill)
    || skill.name !== expectedName
    || !Array.isArray(skill.files) || skill.files.length > limits.maxFiles
    || !Array.isArray(skill.directories) || skill.directories.length > limits.maxEntries
  ) throw managedError("unsafe_state", "invalid_skill_proof");
  let totalBytes = 0;
  const paths = new Set();
  for (const file of skill.files) {
    try { validateRelativePath(file?.path, limits); } catch { throw managedError("unsafe_state", "invalid_skill_proof_path"); }
    if (
      paths.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > limits.maxFileBytes
      || !/^[a-f0-9]{64}$/.test(file.sha256 || "")
    ) throw managedError("unsafe_state", "invalid_skill_proof_file");
    paths.add(file.path);
    totalBytes += file.bytes;
  }
  if (totalBytes > limits.maxTotalBytes || !paths.has("SKILL.md")) {
    throw managedError("unsafe_state", "invalid_skill_proof_bound");
  }
  for (const directory of skill.directories) {
    try { validateRelativePath(directory, limits); } catch { throw managedError("unsafe_state", "invalid_skill_proof_path"); }
    if (paths.has(`directory:${directory}`)) throw managedError("unsafe_state", "invalid_skill_proof_path");
    paths.add(`directory:${directory}`);
  }
}

function validateArtifactSnapshot(artifacts, limits) {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw managedError("unsafe_state", "invalid_transaction_artifacts");
  }
  const expected = new Set(["_registry.json", "INDEX.md", "RESOLVER.md"]);
  for (const [name, encoded] of Object.entries(artifacts)) {
    if (!expected.delete(name) || (encoded !== null && typeof encoded !== "string")) {
      throw managedError("unsafe_state", "invalid_transaction_artifacts");
    }
    if (encoded !== null) {
      const bound = name === "_registry.json" ? limits.maxRegistryBytes : limits.maxCatalogBytes;
      if (Buffer.byteLength(encoded, "base64") > bound) {
        throw managedError("unsafe_state", "invalid_transaction_artifacts");
      }
    }
  }
  if (expected.size > 0) throw managedError("unsafe_state", "invalid_transaction_artifacts");
}

function storeStatePaths(settings) {
  const dotaios = path.join(settings.homePath, ".dotaios");
  const root = path.join(dotaios, "managed-skills");
  return {
    dotaios,
    root,
    receipts: path.join(root, "receipts"),
    recoveries: path.join(root, "recovery"),
    projectionHistory: path.join(root, "projection-history"),
    lock: path.join(root, "store.lock"),
    journal: path.join(root, "transaction.json"),
    maxJournalBytes: settings.limits.maxJournalBytes
  };
}

async function ensureStoreState(state) {
  await ensureDurableOwnedDirectory(state.dotaios);
  await ensureDurableOwnedDirectory(state.root);
  await ensureDurableOwnedDirectory(state.receipts);
  await ensureDurableOwnedDirectory(state.recoveries);
}

async function cleanupEmptyStoreState(state) {
  await fs.rmdir(state.receipts).catch(() => {});
  await fs.rmdir(state.recoveries).catch(() => {});
  await fs.rmdir(state.projectionHistory).catch(() => {});
  await fs.rmdir(state.root).catch(() => {});
  await fs.rmdir(state.dotaios).catch(() => {});
}

async function cleanupEmptyCanonicalInternals(aiosPath) {
  const internal = path.join(aiosPath, "skills", ".managed-skill-store");
  for (const child of ["staging", "recovery"]) {
    await fs.rmdir(path.join(internal, child)).catch(() => {});
  }
  await fs.rmdir(internal).catch(() => {});
}

async function cleanupManagedBackupParents(aiosPath, backup) {
  if (!backup) return;
  const internal = path.join(aiosPath, "skills", ".managed-skill-store");
  const relative = path.relative(internal, backup);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  let current = path.dirname(backup);
  while (current !== internal) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

async function ensureRealDirectory(directory, mode = 0o755) {
  const missing = [];
  let currentPath = directory;
  let current = await lstatIfPresent(currentPath);
  while (!current) {
    missing.push(currentPath);
    const parent = path.dirname(currentPath);
    if (parent === currentPath) throw managedError("unsafe_state", "unsafe_managed_directory");
    currentPath = parent;
    current = await lstatIfPresent(currentPath);
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw managedError("unsafe_state", "unsafe_managed_directory");
  }
  for (const missingPath of missing.reverse()) {
    await createDurableDirectory(missingPath, mode);
  }
}

async function ensureDirectoryChain(root, destination, mode = 0o700) {
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw managedError("unsafe_state", "managed_directory_outside_root");
  }
  await ensureRealDirectory(root, mode);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const existing = await lstatIfPresent(current);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw managedError("unsafe_state", "unsafe_managed_directory");
      }
      continue;
    }
    await createDurableDirectory(current, mode);
  }
}

async function createDurableDirectory(directory, mode) {
  await fs.mkdir(directory, { mode });
  await fs.chmod(directory, mode).catch(() => {});
  await syncDirectory(directory);
  await syncDirectory(path.dirname(directory));
}

async function ensureDurableOwnedDirectory(directory) {
  const before = await lstatIfPresent(directory);
  await ensureOwnedDirectory(directory);
  if (!before) {
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertStoreRoots(settings) {
  const [aiosStats, homeStats] = await Promise.all([
    lstatIfPresent(settings.aiosPath),
    lstatIfPresent(settings.homePath)
  ]);
  if (!aiosStats?.isDirectory() || aiosStats.isSymbolicLink()) {
    throw managedError("unsafe_state", "aios_root_not_real_directory");
  }
  if (!homeStats?.isDirectory() || homeStats.isSymbolicLink()) {
    throw managedError("unsafe_state", "home_root_not_real_directory");
  }
  const skillsStats = await lstatIfPresent(path.join(settings.aiosPath, "skills"));
  if (skillsStats && (!skillsStats.isDirectory() || skillsStats.isSymbolicLink())) {
    throw managedError("unsafe_state", "skills_root_not_real_directory");
  }
}

async function writeJsonAtomic(destination, value, maxBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > maxBytes) throw managedError("bundle_bound_exceeded", "managed_json_byte_bound_exceeded");
  return writeBufferAtomic(destination, bytes);
}

async function writeBufferAtomic(destination, bytes) {
  await ensureRealDirectory(path.dirname(destination), 0o700);
  const existing = await lstatIfPresent(destination);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || Number(existing.nlink) !== 1)) {
    throw managedError("unsafe_state", "unsafe_managed_file");
  }
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    const handle = await fs.open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeFileAndSync(filePath) {
  await fs.rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

async function unlinkAndSync(filePath) {
  await fs.unlink(filePath);
  await syncDirectory(path.dirname(filePath));
}

async function renameAndSync(source, destination) {
  const sourceBefore = await lstatIfPresent(source, { bigint: true });
  if (!sourceBefore) throw managedError("recovery_required", "rename_source_missing");
  if (await lstatIfPresent(destination)) {
    throw managedError("destination_changed", "rename_destination_changed");
  }
  await fs.rename(source, destination);
  const parents = [...new Set([path.dirname(source), path.dirname(destination)])];
  await Promise.all(parents.map((directory) => syncDirectory(directory)));
  const [sourceAfter, destinationAfter] = await Promise.all([
    lstatIfPresent(source, { bigint: true }),
    lstatIfPresent(destination, { bigint: true })
  ]);
  if (
    sourceAfter
    || !destinationAfter
    || String(sourceBefore.dev) !== String(destinationAfter.dev)
    || String(sourceBefore.ino) !== String(destinationAfter.ino)
    || sourceBefore.isDirectory() !== destinationAfter.isDirectory()
    || sourceBefore.isFile() !== destinationAfter.isFile()
    || sourceBefore.isSymbolicLink() !== destinationAfter.isSymbolicLink()
  ) throw managedError("recovery_required", "rename_result_changed");
}

async function removeEmptyDirectoryAndSync(directory) {
  await fs.rmdir(directory);
  await syncDirectory(path.dirname(directory));
}

async function readJsonStrictIfPresent(filePath, maxBytes) {
  const bytes = await readManagedBytesIfPresent(filePath, maxBytes, "unsafe_managed_file");
  if (!bytes) return null;
  let text;
  try { text = UTF8_DECODER.decode(bytes); } catch { throw managedError("unsafe_state", "managed_json_not_utf8"); }
  try { return JSON.parse(text); } catch { throw managedError("unsafe_state", "managed_json_invalid"); }
}

async function readOwnedJsonIfPresent(filePath, maxBytes) {
  const bytes = await readManagedBytesIfPresent(filePath, maxBytes, "unsafe_managed_file", { owned: true });
  if (!bytes) return null;
  let text;
  try { text = UTF8_DECODER.decode(bytes); } catch { throw managedError("unsafe_state", "managed_json_not_utf8"); }
  try { return JSON.parse(text); } catch { throw managedError("unsafe_state", "managed_json_invalid"); }
}

async function readManagedBytesIfPresent(filePath, maxBytes, reason, { owned = false } = {}) {
  const stats = await lstatIfPresent(filePath);
  if (!stats) return null;
  try {
    if (owned) assertOwnedFileStats(stats);
    const opened = await readBoundedRegularFile(filePath, maxBytes);
    return opened.bytes;
  } catch (error) {
    if (error instanceof ManagedSkillStoreError && error.code === "bundle_bound_exceeded") {
      throw managedError("bundle_bound_exceeded", `${reason}_byte_bound_exceeded`);
    }
    throw managedError("unsafe_state", reason);
  }
}

async function readUntrustedJsonBounded(filePath, maxBytes) {
  try {
    const opened = await readBoundedRegularFile(filePath, maxBytes);
    const text = UTF8_DECODER.decode(opened.bytes);
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function fileDigestIfPresent(filePath, maxBytes) {
  const bytes = await readManagedBytesIfPresent(filePath, maxBytes, "unsafe_catalog_file");
  return bytes ? sha256(bytes) : null;
}

async function readDirectoryEntries(directory, { allowMissing = false, maxEntries = Number.MAX_SAFE_INTEGER } = {}) {
  let directoryStats;
  let opened;
  try {
    directoryStats = await fs.lstat(directory, { bigint: true });
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw managedError("unsafe_source", "directory_root_not_real");
    }
    opened = await fs.opendir(directory, { encoding: "buffer" });
  } catch (error) {
    if (allowMissing && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
    throw error;
  }
  const entries = [];
  try {
    for await (const dirent of opened) {
      if (entries.length >= maxEntries) {
        throw managedError("bundle_bound_exceeded", "directory_entry_bound_exceeded");
      }
      let name;
      try {
        name = Buffer.isBuffer(dirent.name) ? UTF8_DECODER.decode(dirent.name) : dirent.name;
      } catch {
        throw managedError("unsafe_source", "entry_name_not_utf8");
      }
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
        throw managedError("unsafe_source", "invalid_entry_name");
      }
      let kind = "special";
      if (dirent.isDirectory()) kind = "directory";
      else if (dirent.isFile()) kind = "file";
      else if (dirent.isSymbolicLink()) kind = "symlink";
      entries.push({ name, kind });
    }
  } finally {
    await opened?.close().catch(() => {});
  }
  const after = await lstatIfPresent(directory, { bigint: true });
  if (!after || !sameIdentity(directoryStats, after)) {
    throw managedError("source_changed", "directory_root_changed");
  }
  return entries.sort((left, right) => compareUtf8(left.name, right.name));
}

function validateRelativePath(relative, limits) {
  if (Buffer.byteLength(relative || "", "utf8") > limits.maxRelativePathBytes) {
    throw managedError("bundle_bound_exceeded", "bundle_relative_path_bound_exceeded");
  }
  if (
    !relative
    || path.posix.isAbsolute(relative)
    || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw managedError("unsafe_source", "invalid_relative_path");
  }
}

async function lstatIfPresent(filePath, options = undefined) {
  try {
    return options ? await fs.lstat(filePath, options) : await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function statIdentity(stats) {
  return {
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "special",
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    nlink: Number(stats.nlink),
    size: String(stats.size),
    mtime_ns: String(stats.mtimeNs ?? BigInt(Math.trunc(Number(stats.mtimeMs) * 1e6))),
    ctime_ns: String(stats.ctimeNs ?? BigInt(Math.trunc(Number(stats.ctimeMs) * 1e6)))
  };
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.nlink) === String(right.nlink)
    && String(left.size) === String(right.size)
    && String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs)
    && String(left.ctimeNs ?? left.ctimeMs) === String(right.ctimeNs ?? right.ctimeMs);
}

async function readLinkBounded(linkPath) {
  const target = await fs.readlink(linkPath);
  if (typeof target !== "string" || !target || Buffer.byteLength(target, "utf8") > 4096 || target.includes("\0")) {
    throw managedError("unsafe_source", "invalid_link_target");
  }
  return target;
}

async function assertProvedLink(linkPath, proof) {
  const stats = await lstatIfPresent(linkPath, { bigint: true });
  if (
    !stats?.isSymbolicLink()
    || !proof?.identity
    || !matchesProofIdentity(statIdentity(stats), proof.identity)
  ) throw managedError("destination_changed", "expected_link_changed");
  const target = await readLinkBounded(linkPath);
  if (target !== proof.target) throw managedError("destination_changed", "expected_link_target_changed");
}

async function linkEvidence(linkPath) {
  const stats = await lstatIfPresent(linkPath, { bigint: true });
  if (!stats?.isSymbolicLink()) throw managedError("destination_changed", "expected_link_changed");
  return { identity: statIdentity(stats), target: await readLinkBounded(linkPath) };
}

function matchesProofIdentity(observed, expected) {
  if (!observed || !expected) return false;
  return ["type", "dev", "ino", "mode", "nlink", "size", "mtime_ns", "ctime_ns"]
    .every((key) => String(observed[key]) === String(expected[key]));
}

function matchesDirectoryIdentity(stats, expected) {
  return Boolean(stats?.isDirectory() && !stats.isSymbolicLink())
    && matchesDirectoryProofIdentity(statIdentity(stats), expected);
}

function matchesDirectoryProofIdentity(observed, expected) {
  return Boolean(
    observed?.type === "directory"
    && expected?.type === "directory"
    && String(observed.dev) === String(expected.dev)
    && String(observed.ino) === String(expected.ino)
  );
}

function matchesLeafProofIdentity(observed, expected) {
  return Boolean(
    observed?.type === expected?.type
    && String(observed.dev) === String(expected.dev)
    && String(observed.ino) === String(expected.ino)
  );
}

function siblingBackupPath(sourcePath, operationId) {
  return path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.dotaios-backup-${operationId}`);
}

function siblingDetachedProjectionPath(destination, operationId, index) {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.dotaios-detached-${operationId}-${index}`
  );
}

function resolveSelectedSource(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw managedError("unsafe_source", "source_path_required");
  }
  return path.resolve(value);
}

function excludedEntry(name, sourceKind, coordinate, reason) {
  return { name, source_kind: sourceKind, coordinate, reason };
}

function compareInventoryEntries(left, right) {
  return compareUtf8(left.name, right.name)
    || compareUtf8(left.source_kind, right.source_kind)
    || compareUtf8(left.coordinate, right.coordinate);
}

function compareCollisionEntries(left, right) {
  return compareUtf8(left.coordinate || "", right.coordinate || "")
    || compareUtf8(left.classification || "", right.classification || "");
}

function compareUtf8(left, right) {
  return compareUtf8Bytes(left, right);
}

function sameLexicalPath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    if (value[key] !== undefined) sorted[key] = sortCanonicalValue(value[key]);
  }
  return sorted;
}

function managedError(code, reason) {
  return new ManagedSkillStoreError(code, reason);
}

function stableReason(error) {
  return error instanceof ManagedSkillStoreError ? error.reason : "candidate_inspection_failed";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
