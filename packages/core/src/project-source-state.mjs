import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  assertOwnedFileStats,
  ensureOwnedDirectory,
  publishOwnedFileExclusive,
  sameFileIdentity,
  syncOwnedDirectory,
  validateOwnedDirectoryIfPresent
} from "./owned-state.mjs";

const STATE_VERSION = 1;
const GRANT_GUARD_VERSION = 1;

export function projectSourceStatePaths(homePath, projectId = null, sourceId = null) {
  const root = path.join(path.resolve(homePath), ".dotaios", "project-sources");
  const bindings = path.join(root, "bindings");
  const grants = path.join(root, "grants");
  const coordinate = projectId && sourceId ? coordinateFilename(projectId, sourceId) : null;
  return Object.freeze({
    root,
    bindings,
    grants,
    binding: coordinate ? path.join(bindings, coordinate) : null,
    grant: coordinate ? path.join(grants, coordinate) : null,
    grantGuard: coordinate ? path.join(grants, `${coordinate}.inflight.json`) : null,
    locks: path.join(root, "locks")
  });
}

export function projectSourceOwnedDirectories(homePath, leaf = null) {
  const dotaios = path.join(path.resolve(homePath), ".dotaios");
  const root = path.join(dotaios, "project-sources");
  return Object.freeze([
    Object.freeze({ path: dotaios, sharedParent: true }),
    root,
    ...(leaf ? [path.join(root, leaf)] : []),
  ]);
}

export function projectSourceCoordinate(projectId, sourceId) {
  return `${projectId}\u0000${sourceId}`;
}

export async function readProjectSourceState({
  homePath,
  projectId,
  sourceId,
  recoveryOperationId = null,
  recoveryPlanFingerprint = null,
  filesystem = fs
} = {}) {
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const [binding, grantState] = await Promise.all([
    readRecord(paths.binding, "binding", projectId, sourceId, filesystem),
    readMutationGrantState({
      paths,
      projectId,
      sourceId,
      recoveryOperationId,
      recoveryPlanFingerprint,
      filesystem
    })
  ]);
  return Object.freeze({ paths, binding, grant: grantState.grant, grantRecovery: grantState.recovery });
}

// Policy callers must own this coordinate's strict source lock for the entire read.
export async function readProjectSourceAuthorizationSnapshotUnderLock({
  homePath,
  projectId,
  sourceId,
  filesystem = fs
} = {}) {
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  if (await ownedFileExists(paths.grantGuard, filesystem)) throw stateError();
  const [binding, grantState] = await Promise.all([
    readRecord(paths.binding, "binding", projectId, sourceId, filesystem),
    readRetrievalGrantState(paths.grant, projectId, sourceId, filesystem)
  ]);
  return Object.freeze({
    paths,
    binding,
    grant: grantState.grant,
    grantIssue: grantState.issue,
    grantReceipt: grantState.receipt
  });
}

export async function publishBinding({
  homePath,
  projectId,
  sourceId,
  operationId,
  planFingerprint,
  rootPath,
  rootIdentity,
  portablePublished = false,
  filesystem = fs
} = {}) {
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const current = await readRecord(paths.binding, "binding", projectId, sourceId, filesystem);
  if (
    current
    && current.operation_id === operationId
    && current.plan_fingerprint === planFingerprint
  ) {
    return current;
  }
  const record = Object.freeze({
    version: STATE_VERSION,
    kind: "binding",
    project_id: projectId,
    source_id: sourceId,
    generation: (current?.generation || 0) + 1,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    root_path: rootPath,
    root_identity: rootIdentity,
    portable_published: portablePublished
  });
  assertBindingRecord(record, projectId, sourceId);
  await writeRecord(paths.binding, record, filesystem);
  return record;
}

export async function markBindingPortablePublished({
  homePath,
  projectId,
  sourceId,
  operationId,
  planFingerprint,
  filesystem = fs
} = {}) {
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const current = await readRecord(paths.binding, "binding", projectId, sourceId, filesystem);
  if (
    !current
    || current.operation_id !== operationId
    || current.plan_fingerprint !== planFingerprint
  ) throw stateError();
  if (current.portable_published) return current;
  const completed = Object.freeze({ ...current, portable_published: true });
  assertBindingRecord(completed, projectId, sourceId);
  await writeRecord(paths.binding, completed, filesystem);
  return completed;
}

export async function publishGrant(options = {}) {
  const {
    homePath, projectId, sourceId, operationId, planFingerprint, grantId, purpose,
    expiresAt, approvedAt, binding, sourceRevision, filesystem = fs
  } = options;
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const grantState = await readMutationGrantState({
    paths,
    projectId,
    sourceId,
    recoveryOperationId: operationId,
    recoveryPlanFingerprint: planFingerprint,
    filesystem
  });
  const current = grantState.grant;
  if (
    !grantState.recovery
    && current
    && current.operation_id === operationId
    && current.plan_fingerprint === planFingerprint
  ) return current;
  const record = grantPublicationRecord({ ...options, current, recovery: grantState.recovery });
  return publishGuardedGrantRecord({
    paths,
    projectId,
    sourceId,
    operationId,
    planFingerprint,
    previousRecord: current,
    intendedRecord: record,
    recovery: grantState.recovery,
    filesystem
  });
}

export async function publishGrantRevocation(options = {}) {
  const {
    homePath, projectId, sourceId, operationId, planFingerprint, grantId,
    revokedAt, filesystem = fs
  } = options;
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const grantState = await readMutationGrantState({
    paths,
    projectId,
    sourceId,
    recoveryOperationId: operationId,
    recoveryPlanFingerprint: planFingerprint,
    filesystem
  });
  const current = grantState.grant;
  if (
    !grantState.recovery
    && current
    && current.operation_id === operationId
    && current.plan_fingerprint === planFingerprint
  ) return current;
  if (!current || current.grant_id !== grantId || current.revoked_at) throw stateError();
  const record = grantState.recovery?.intended_record || Object.freeze({
    ...current,
    revision: current.revision + 1,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    revoked_at: revokedAt
  });
  assertRevokePublication(record, { ...options, current, recovery: grantState.recovery });
  return publishGuardedGrantRecord({
    paths,
    projectId,
    sourceId,
    operationId,
    planFingerprint,
    previousRecord: current,
    intendedRecord: record,
    recovery: grantState.recovery,
    filesystem
  });
}

function grantPublicationRecord(options) {
  const {
    projectId, sourceId, operationId, planFingerprint, grantId, purpose, expiresAt,
    approvedAt, binding, sourceRevision, current, recovery
  } = options;
  const record = recovery?.intended_record || Object.freeze({
    version: STATE_VERSION, kind: "grant", project_id: projectId, source_id: sourceId,
    grant_id: grantId, revision: (current?.revision || 0) + 1,
    operation_id: operationId, plan_fingerprint: planFingerprint, scope: "read", purpose,
    approved_at: approvedAt, expires_at: expiresAt, source_revision: sourceRevision,
    binding_generation: binding.generation, root_identity: binding.root_identity, revoked_at: null
  });
  assertGrantPublication(record, options);
  return record;
}

function assertGrantPublication(record, options) {
  const {
    projectId, sourceId, operationId, planFingerprint, grantId, purpose, expiresAt,
    approvedAt, binding, sourceRevision, recovery
  } = options;
  assertGrantRecordExact(record, projectId, sourceId);
  if (
    record.grant_id !== grantId || record.purpose !== purpose || record.expires_at !== expiresAt
    || record.source_revision !== sourceRevision || record.binding_generation !== binding.generation
    || stableJson(record.root_identity) !== stableJson(binding.root_identity)
    || record.operation_id !== operationId || record.plan_fingerprint !== planFingerprint
    || record.scope !== "read" || record.revoked_at !== null
    || (!recovery && record.approved_at !== approvedAt)
    || (recovery && Date.parse(record.approved_at) > Date.parse(approvedAt))
    || Date.parse(record.expires_at) <= Date.parse(record.approved_at)
  ) throw stateError();
}

function assertRevokePublication(record, options) {
  const { projectId, sourceId, operationId, planFingerprint, grantId, revokedAt, current, recovery } = options;
  assertGrantRecordExact(record, projectId, sourceId);
  if (
    record.grant_id !== grantId || record.operation_id !== operationId
    || record.plan_fingerprint !== planFingerprint || !sameRevokeTransition(current, record)
    || (!recovery && record.revoked_at !== revokedAt)
    || (recovery && Date.parse(record.revoked_at) > Date.parse(revokedAt))
  ) throw stateError();
}

export function sourceStateLockPath(homePath, projectId, sourceId) {
  return path.join(projectSourceStatePaths(homePath).locks, `${coordinateStem(projectId, sourceId)}.lock`);
}

async function readMutationGrantState({
  paths,
  projectId,
  sourceId,
  recoveryOperationId,
  recoveryPlanFingerprint,
  filesystem
}) {
  const recovery = await readGrantGuard(paths.grantGuard, projectId, sourceId, filesystem);
  if (recovery) {
    if (
      recovery.operation_id !== recoveryOperationId
      || recovery.plan_fingerprint !== recoveryPlanFingerprint
    ) throw stateError();
    return Object.freeze({ grant: recovery.previous_record, recovery });
  }
  const grant = await readRecord(paths.grant, "grant", projectId, sourceId, filesystem);
  return Object.freeze({ grant, recovery: null });
}

async function readRetrievalGrantState(filePath, projectId, sourceId, filesystem) {
  const parsed = await readJsonRecordIfPresent(filePath, filesystem);
  if (!parsed) return Object.freeze({ grant: null, issue: null, receipt: null });
  if (
    !isRecord(parsed)
    || parsed.version !== STATE_VERSION
    || parsed.kind !== "grant"
    || !safeText(parsed.project_id, 200)
    || !safeSourceId(parsed.source_id)
  ) {
    return Object.freeze({ grant: null, issue: "authorization-state-invalid", receipt: null });
  }
  if (parsed.project_id !== projectId || parsed.source_id !== sourceId) {
    return Object.freeze({ grant: null, issue: "grant-scope-mismatch", receipt: null });
  }
  const receipt = safeGrantIdentity(parsed);
  try {
    assertGrantRecordStructure(parsed);
    return Object.freeze({ grant: Object.freeze(parsed), issue: null, receipt });
  } catch {
    return Object.freeze({ grant: null, issue: "authorization-state-invalid", receipt });
  }
}

async function publishGuardedGrantRecord({
  paths,
  projectId,
  sourceId,
  operationId,
  planFingerprint,
  previousRecord,
  intendedRecord,
  recovery,
  filesystem
}) {
  const guard = recovery || createGrantGuard({
    projectId,
    sourceId,
    operationId,
    planFingerprint,
    previousRecord,
    intendedRecord
  });
  try {
    if (!recovery) await publishGrantGuard(paths, guard, filesystem);
    const live = await readRecord(paths.grant, "grant", projectId, sourceId, filesystem);
    if (sameJson(live, guard.previous_record)) {
      await writeRecord(paths.grant, guard.intended_record, filesystem);
    } else if (sameJson(live, guard.intended_record)) {
      await syncDirectory(filesystem, paths.grants);
    } else {
      throw stateError();
    }
    await clearGrantGuard(paths, guard, filesystem);
    return Object.freeze(guard.intended_record);
  } catch (error) {
    const poisoned = await preserveGrantGuard(paths, guard, filesystem);
    throw stateError({ retainOperationLock: !poisoned, cause: error });
  }
}

function createGrantGuard({
  projectId,
  sourceId,
  operationId,
  planFingerprint,
  previousRecord,
  intendedRecord
}) {
  const guard = Object.freeze({
    version: GRANT_GUARD_VERSION,
    kind: "grant-publication",
    project_id: projectId,
    source_id: sourceId,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    transition: intendedRecord.revoked_at === null ? "grant" : "revoke",
    intended_record_sha256: createHash("sha256").update(stableJson(intendedRecord)).digest("hex"),
    previous_record: previousRecord,
    intended_record: intendedRecord
  });
  assertGrantGuard(guard, projectId, sourceId);
  return guard;
}

async function readGrantGuard(filePath, projectId, sourceId, filesystem) {
  const parsed = await readJsonRecordIfPresent(filePath, filesystem);
  if (!parsed) return null;
  assertGrantGuard(parsed, projectId, sourceId);
  return Object.freeze(parsed);
}

function assertGrantGuard(guard, projectId, sourceId) {
  if (
    !isRecord(guard)
    || guard.version !== GRANT_GUARD_VERSION
    || guard.kind !== "grant-publication"
    || guard.project_id !== projectId
    || guard.source_id !== sourceId
    || !operationId(guard.operation_id)
    || !fingerprint(guard.plan_fingerprint)
    || !["grant", "revoke"].includes(guard.transition)
    || !fingerprint(guard.intended_record_sha256)
    || !exactFields(guard, [
      "version", "kind", "project_id", "source_id", "operation_id", "plan_fingerprint",
      "transition", "intended_record_sha256", "previous_record", "intended_record"
    ])
    || (guard.previous_record !== null && !isRecord(guard.previous_record))
    || !isRecord(guard.intended_record)
  ) throw stateError();
  if (guard.previous_record !== null) {
    assertGrantRecordExact(guard.previous_record, projectId, sourceId);
  }
  assertGrantRecordExact(guard.intended_record, projectId, sourceId);
  if (
    guard.intended_record.operation_id !== guard.operation_id
    || guard.intended_record.plan_fingerprint !== guard.plan_fingerprint
    || guard.intended_record.revision !== (guard.previous_record?.revision || 0) + 1
    || createHash("sha256").update(stableJson(guard.intended_record)).digest("hex") !== guard.intended_record_sha256
  ) throw stateError();
  if (guard.transition === "revoke" && !sameRevokeTransition(guard.previous_record, guard.intended_record)) {
    throw stateError();
  }
  if (guard.transition === "grant" && guard.intended_record.revoked_at !== null) throw stateError();
}

function sameRevokeTransition(previous, intended) {
  if (!previous || previous.revoked_at !== null || !canonicalUtc(intended.revoked_at)) return false;
  const expected = {
    ...previous,
    revision: previous.revision + 1,
    operation_id: intended.operation_id,
    plan_fingerprint: intended.plan_fingerprint,
    revoked_at: intended.revoked_at
  };
  return sameJson(expected, intended);
}

function exactFields(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((field) => expected.includes(field));
}

async function publishGrantGuard(paths, guard, filesystem) {
  await prepareOwnedRecordDirectory(paths.grantGuard, filesystem);
  await publishOwnedFileExclusive(paths.grantGuard, `${JSON.stringify(guard)}\n`, { filesystem });
}

async function clearGrantGuard(paths, guard, filesystem) {
  try {
    await filesystem.unlink(paths.grantGuard);
    await syncDirectory(filesystem, paths.grants);
  } catch (error) {
    const poisoned = await preserveGrantGuard(paths, guard, filesystem);
    throw stateError({ retainOperationLock: !poisoned, cause: error });
  }
}

async function preserveGrantGuard(paths, guard, filesystem) {
  try {
    if (await ownedFileExists(paths.grantGuard, filesystem)) return true;
    await publishGrantGuard(paths, guard, filesystem);
    return true;
  } catch {
    return false;
  }
}

async function readRecord(filePath, kind, projectId, sourceId, filesystem) {
  if (!filePath || !projectId || !sourceId) throw stateError();
  let raw;
  try {
    raw = await readOwnedTextIfPresent(filePath, filesystem);
    if (raw === null) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  }
  try {
    const record = JSON.parse(raw);
    if (kind === "binding") assertBindingRecord(record, projectId, sourceId);
    else assertGrantRecordExact(record, projectId, sourceId);
    return Object.freeze(record);
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  }
}

async function readJsonRecordIfPresent(filePath, filesystem) {
  let raw;
  try {
    raw = await readOwnedTextIfPresent(filePath, filesystem);
    if (raw === null) return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw stateError();
  }
}

async function readOwnedTextIfPresent(filePath, filesystem) {
  if (!await validateOwnedRecordDirectory(filePath, filesystem)) return null;
  const before = await filesystem.lstat(filePath);
  assertOwnedFileStats(before);
  const handle = await filesystem.open(filePath, "r");
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    if (!sameFileIdentity(before, opened)) throw stateError();
    const raw = await handle.readFile("utf8");
    const openedAfter = await handle.stat();
    const canonicalAfter = await filesystem.lstat(filePath);
    assertOwnedFileStats(openedAfter);
    assertOwnedFileStats(canonicalAfter);
    if (
      !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(openedAfter, canonicalAfter)
    ) throw stateError();
    return raw;
  } finally {
    await handle.close();
  }
}

async function writeRecord(filePath, value, filesystem) {
  const directory = path.dirname(filePath);
  await prepareOwnedRecordDirectory(filePath, filesystem);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await filesystem.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const temporaryStats = await filesystem.lstat(temporary);
    assertOwnedFileStats(temporaryStats);
    const existing = await filesystem.lstat(filePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) assertOwnedFileStats(existing);
    await filesystem.rename(temporary, filePath);
    const publishedStats = await filesystem.lstat(filePath);
    assertOwnedFileStats(publishedStats);
    if (!sameFileIdentity(temporaryStats, publishedStats)) throw stateError();
    await syncDirectory(filesystem, directory);
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  } finally {
    if (handle) await handle.close().catch(() => {});
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

async function prepareOwnedRecordDirectory(filePath, filesystem) {
  try {
    for (const directory of ownedDirectoriesForRecord(filePath)) {
      await ensureOwnedDirectory(directory, { filesystem });
    }
  } catch {
    throw stateError();
  }
}

async function validateOwnedRecordDirectory(filePath, filesystem) {
  try {
    for (const directory of ownedDirectoriesForRecord(filePath)) {
      if (!await validateOwnedDirectoryIfPresent(directory, { filesystem })) return false;
    }
    return true;
  } catch {
    throw stateError();
  }
}

function ownedDirectoriesForRecord(filePath) {
  const recordDirectory = path.dirname(filePath);
  const root = path.dirname(recordDirectory);
  return [
    Object.freeze({ path: path.dirname(root), sharedParent: true }),
    root,
    recordDirectory,
  ];
}

async function ownedFileExists(filePath, filesystem) {
  try {
    if (!await validateOwnedRecordDirectory(filePath, filesystem)) return false;
    const stats = await filesystem.lstat(filePath);
    assertOwnedFileStats(stats);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw stateError();
  }
}

function assertBindingRecord(record, projectId, sourceId) {
  if (
    !isRecord(record)
    || record.version !== STATE_VERSION
    || record.kind !== "binding"
    || record.project_id !== projectId
    || record.source_id !== sourceId
    || !positiveInteger(record.generation)
    || !operationId(record.operation_id)
    || !fingerprint(record.plan_fingerprint)
    || typeof record.root_path !== "string"
    || !path.isAbsolute(record.root_path)
    || record.root_path.includes("\u0000")
    || !rootIdentity(record.root_identity)
    || typeof record.portable_published !== "boolean"
  ) throw stateError();
}

function assertGrantRecordExact(record, projectId, sourceId) {
  assertGrantRecordStructure(record);
  if (
    record.project_id !== projectId
    || record.source_id !== sourceId
    || record.scope !== "read"
  ) throw stateError();
}

function assertGrantRecordStructure(record) {
  if (
    !isRecord(record)
    || record.version !== STATE_VERSION
    || record.kind !== "grant"
    || !safeText(record.project_id, 200)
    || !safeSourceId(record.source_id)
    || !operationId(record.grant_id)
    || !positiveInteger(record.revision)
    || !operationId(record.operation_id)
    || !fingerprint(record.plan_fingerprint)
    || !safeText(record.scope, 64)
    || !safeText(record.purpose, 500)
    || !canonicalUtc(record.approved_at)
    || !canonicalUtc(record.expires_at)
    || !positiveInteger(record.source_revision)
    || !positiveInteger(record.binding_generation)
    || !rootIdentity(record.root_identity)
    || (record.revoked_at !== null && !canonicalUtc(record.revoked_at))
  ) throw stateError();
}

function safeGrantIdentity(record) {
  if (!operationId(record.grant_id) || !positiveInteger(record.revision)) return null;
  return Object.freeze({ grant_id: record.grant_id, revision: record.revision });
}

function safeSourceId(value) {
  return typeof value === "string"
    && value.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function operationId(value) {
  return typeof value === "string" && /^[a-f0-9-]{1,64}$/.test(value);
}

function fingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeText(value, maximum) {
  return typeof value === "string"
    && Array.from(value).length >= 1
    && Array.from(value).length <= maximum
    && !/\p{Cc}/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

function canonicalUtc(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function rootIdentity(value) {
  return isRecord(value)
    && value.type === "directory"
    && typeof value.dev === "string"
    && /^\d+$/.test(value.dev)
    && typeof value.ino === "string"
    && /^\d+$/.test(value.ino);
}

function coordinateFilename(projectId, sourceId) {
  return `${coordinateStem(projectId, sourceId)}.json`;
}

function coordinateStem(projectId, sourceId) {
  return createHash("sha256").update(projectSourceCoordinate(projectId, sourceId)).digest("hex");
}

async function syncDirectory(filesystem, directory) {
  await syncOwnedDirectory(directory, { filesystem });
}

function stateError(details = {}) {
  return Object.assign(
    new Error("Project source authorization state is invalid or unavailable.", { cause: details.cause }),
    {
      code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID",
      ...(details.retainOperationLock ? { retainOperationLock: true } : {})
    }
  );
}
