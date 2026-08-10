import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const STATE_VERSION = 1;

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
    locks: path.join(root, "locks")
  });
}

export function projectSourceCoordinate(projectId, sourceId) {
  return `${projectId}\u0000${sourceId}`;
}

export async function readProjectSourceState({
  homePath,
  projectId,
  sourceId,
  filesystem = fs
} = {}) {
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const [binding, grant] = await Promise.all([
    readRecord(paths.binding, "binding", projectId, sourceId, filesystem),
    readRecord(paths.grant, "grant", projectId, sourceId, filesystem)
  ]);
  return Object.freeze({ paths, binding, grant });
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

export async function publishGrant({
  homePath,
  projectId,
  sourceId,
  operationId,
  planFingerprint,
  grantId,
  purpose,
  expiresAt,
  approvedAt,
  binding,
  sourceRevision,
  filesystem = fs
} = {}) {
  const paths = projectSourceStatePaths(homePath, projectId, sourceId);
  const current = await readRecord(paths.grant, "grant", projectId, sourceId, filesystem);
  if (
    current
    && current.operation_id === operationId
    && current.plan_fingerprint === planFingerprint
  ) {
    return current;
  }
  const record = Object.freeze({
    version: STATE_VERSION,
    kind: "grant",
    project_id: projectId,
    source_id: sourceId,
    grant_id: grantId,
    revision: (current?.revision || 0) + 1,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    scope: "read",
    purpose,
    approved_at: approvedAt,
    expires_at: expiresAt,
    source_revision: sourceRevision,
    binding_generation: binding.generation,
    root_identity: binding.root_identity,
    revoked_at: null
  });
  assertGrantRecord(record, projectId, sourceId);
  await writeRecord(paths.grant, record, filesystem);
  return record;
}

export function sourceStateLockPath(homePath, projectId, sourceId) {
  return path.join(projectSourceStatePaths(homePath).locks, `${coordinateStem(projectId, sourceId)}.lock`);
}

async function readRecord(filePath, kind, projectId, sourceId, filesystem) {
  if (!filePath || !projectId || !sourceId) throw stateError();
  let raw;
  try {
    const stats = await filesystem.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw stateError();
    raw = await filesystem.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  }
  try {
    const record = JSON.parse(raw);
    if (kind === "binding") assertBindingRecord(record, projectId, sourceId);
    else assertGrantRecord(record, projectId, sourceId);
    return Object.freeze(record);
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  }
}

async function writeRecord(filePath, value, filesystem) {
  const directory = path.dirname(filePath);
  await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await filesystem.chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await filesystem.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const existing = await filesystem.lstat(filePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw stateError();
    await filesystem.rename(temporary, filePath);
    if (process.platform !== "win32") await filesystem.chmod(filePath, 0o600);
    await syncDirectory(filesystem, directory);
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") throw error;
    throw stateError();
  } finally {
    if (handle) await handle.close().catch(() => {});
    await filesystem.rm(temporary, { force: true }).catch(() => {});
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

function assertGrantRecord(record, projectId, sourceId) {
  if (
    !isRecord(record)
    || record.version !== STATE_VERSION
    || record.kind !== "grant"
    || record.project_id !== projectId
    || record.source_id !== sourceId
    || !operationId(record.grant_id)
    || !positiveInteger(record.revision)
    || !operationId(record.operation_id)
    || !fingerprint(record.plan_fingerprint)
    || record.scope !== "read"
    || !safeText(record.purpose, 500)
    || !canonicalUtc(record.approved_at)
    || !canonicalUtc(record.expires_at)
    || !positiveInteger(record.source_revision)
    || !positiveInteger(record.binding_generation)
    || !rootIdentity(record.root_identity)
    || (record.revoked_at !== null && !canonicalUtc(record.revoked_at))
  ) throw stateError();
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
  const handle = await filesystem.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function stateError() {
  const error = new Error("Project source authorization state is invalid or unavailable.");
  error.code = "DOTAIOS_PROJECT_SOURCE_STATE_INVALID";
  return error;
}
