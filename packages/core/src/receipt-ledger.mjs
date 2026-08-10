import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  acquireOperationLock,
  inspectOperationLock,
  poisonOperationLock,
  releaseOperationLock
} from "./operation-lock.mjs";
import {
  projectSourceOwnedDirectories,
  projectSourceStatePaths
} from "./project-source-state.mjs";
import {
  assertOwnedFileStats,
  ensureOwnedDirectory,
  publishOwnedFileExclusive,
  sameFileIdentity,
  syncOwnedDirectory,
  validateOwnedDirectoryIfPresent
} from "./owned-state.mjs";

const MAX_RECEIPT_BYTES = 32_000;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const LOCK_FORMAT = "dotaios-project-source-receipt-lock/v1";

export function createAccessReceipt({
  decision,
  reason = null,
  task,
  projectId = null,
  project = null,
  sourceId = null,
  grant = null,
  references = [],
  createId = randomUUID,
  now = () => new Date()
} = {}) {
  const receiptId = createId();
  const resolvedAt = now().toISOString();
  const normalizedReferences = references.map((reference) => Object.freeze({
    ...reference,
    resolved_at: resolvedAt,
    receipt_id: receiptId
  }));
  return Object.freeze({
    version: 1,
    receipt_id: receiptId,
    resolved_at: resolvedAt,
    decision,
    ...(reason ? { reason } : {}),
    task,
    ...(projectId ? { project_id: projectId } : {}),
    ...(project ? { project } : {}),
    ...(sourceId ? { source_id: sourceId } : {}),
    ...(grant ? { grant } : {}),
    references: normalizedReferences
  });
}

export async function appendAccessReceipt({ homePath, receipt, filesystem = fs } = {}) {
  let publication = null;
  let lock = null;
  let outcome = null;
  try {
    publication = receiptPublication(homePath, receipt);
    assertReceiptLineValid(publication.line);
    await prepareStateRoot(publication.ownedDirectories, filesystem);
    lock = await acquireOperationLock(publication.lockPath, {
      filesystem,
      format: LOCK_FORMAT,
      ownsParent: false,
      strictOwnedState: true,
      ownedDirectories: publication.ownedDirectories
    });
    if (!lock) throw auditError();
    outcome = await publishReceiptUnderLock(publication, filesystem);
    if (!outcome.ok) throw outcome.error;
    return receipt;
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED") throw error;
    throw auditError();
  } finally {
    if (lock && outcome?.retainLock === true) {
      await poisonOperationLock(lock, { filesystem, strictOwnedState: true }).catch(() => {});
    } else if (lock) {
      await releaseReceiptLock(lock, publication, filesystem);
    }
  }
}

export async function assertAccessReceiptStoreAvailable({ homePath, filesystem = fs } = {}) {
  const publication = receiptPublication(homePath, { receipt_id: "preflight" });
  try {
    for (const directory of publication.ownedDirectories) {
      if (!await validateOwnedDirectoryIfPresent(directory, { filesystem })) return;
    }
    const lock = await inspectOperationLock(publication.lockPath, {
      filesystem,
      format: LOCK_FORMAT,
      strictOwnedState: true
    });
    if (lock.exists && (lock.ownerAlive || lock.record.poisoned === true)) throw auditError();
    await assertLedgerHealthy({ ...publication, filesystem });
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED") throw error;
    throw auditError();
  }
}

function receiptPublication(homePath, receipt) {
  const stateRoot = projectSourceStatePaths(homePath).root;
  const line = `${JSON.stringify(receipt)}\n`;
  return Object.freeze({
    stateRoot,
    ownedDirectories: projectSourceOwnedDirectories(homePath),
    ledgerPath: path.join(stateRoot, "access-receipts.jsonl"),
    guardPath: path.join(stateRoot, "access-receipts.inflight.json"),
    lockPath: path.join(stateRoot, "access-receipts.lock"),
    line,
    guard: `${JSON.stringify({
      version: 1,
      receipt_id: receipt.receipt_id,
      line_sha256: createHash("sha256").update(line).digest("hex")
    })}\n`
  });
}

async function prepareStateRoot(ownedDirectories, filesystem) {
  for (const directory of ownedDirectories) {
    await ensureOwnedDirectory(directory, { filesystem });
  }
}

async function publishReceiptUnderLock(publication, filesystem) {
  await assertLedgerHealthy({ ...publication, filesystem });
  await assertLedgerFits(publication, filesystem);
  return attemptReceiptPublication(publication, filesystem);
}

async function attemptReceiptPublication(publication, filesystem) {
  let guardPublished = false;
  try {
    await publishGuard({ ...publication, filesystem });
    guardPublished = true;
    await appendSyncedLine(publication, filesystem);
    await filesystem.unlink(publication.guardPath);
    guardPublished = false;
    await syncDirectory(filesystem, publication.stateRoot);
    return Object.freeze({ ok: true, retainLock: false });
  } catch (error) {
    const poisonPreserved = guardPublished
      || await preservePoisonGuard({ ...publication, filesystem });
    return Object.freeze({ ok: false, error, retainLock: !poisonPreserved });
  }
}

function assertReceiptLineValid(line) {
  assertReceiptSchema(JSON.parse(line));
  if (Buffer.byteLength(line) > MAX_RECEIPT_BYTES) throw auditError();
}

async function assertLedgerFits({ ledgerPath, line }, filesystem) {
  const lineBytes = Buffer.byteLength(line);
  const ledgerStats = await ownedFileStatsIfPresent(filesystem, ledgerPath);
  if ((ledgerStats?.size || 0) + lineBytes > MAX_LEDGER_BYTES) throw auditError();
}

async function appendSyncedLine({ ledgerPath, line }, filesystem) {
  const handle = await filesystem.open(ledgerPath, "a", 0o600);
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    const canonical = await filesystem.lstat(ledgerPath);
    assertOwnedFileStats(canonical);
    if (!sameFileIdentity(opened, canonical)) throw auditError();
    await handle.writeFile(line, "utf8");
    await handle.sync();
    const after = await filesystem.lstat(ledgerPath);
    assertOwnedFileStats(after);
    if (!sameFileIdentity(opened, after)) throw auditError();
  } finally {
    await handle.close();
  }
}

async function releaseReceiptLock(lock, publication, filesystem) {
  try {
    await releaseOperationLock(lock, { filesystem, strictOwnedState: true });
  } catch {
    await preservePoisonGuard({ ...publication, filesystem });
    throw auditError();
  }
}

async function assertLedgerHealthy({ ledgerPath, guardPath, filesystem }) {
  if (await ownedFileStatsIfPresent(filesystem, guardPath)) throw auditError();
  const stats = await ownedFileStatsIfPresent(filesystem, ledgerPath);
  if (!stats) return;
  if (stats.size > MAX_LEDGER_BYTES) throw auditError();
  if (stats.size === 0) return;
  const tailLength = Math.min(stats.size, MAX_RECEIPT_BYTES + 1);
  const handle = await filesystem.open(ledgerPath, "r");
  let tail;
  try {
    const opened = await handle.stat();
    assertOwnedFileStats(opened);
    if (!sameFileIdentity(stats, opened)) throw auditError();
    const buffer = Buffer.allocUnsafe(tailLength);
    const { bytesRead } = await handle.read(buffer, 0, tailLength, stats.size - tailLength);
    tail = buffer.subarray(0, bytesRead);
    const after = await filesystem.lstat(ledgerPath);
    assertOwnedFileStats(after);
    if (!sameFileIdentity(opened, after)) throw auditError();
  } finally {
    await handle.close();
  }
  if (tail.at(-1) !== 0x0a) throw auditError();
  const previousNewline = tail.lastIndexOf(0x0a, tail.length - 2);
  if (previousNewline === -1 && stats.size > tail.length) throw auditError();
  const finalBytes = tail.subarray(previousNewline + 1, tail.length - 1);
  if (finalBytes.length < 1 || finalBytes.length + 1 > MAX_RECEIPT_BYTES) throw auditError();
  try {
    const finalLine = new TextDecoder("utf-8", { fatal: true }).decode(finalBytes);
    assertReceiptSchema(JSON.parse(finalLine));
  } catch {
    throw auditError();
  }
}

function assertReceiptSchema(receipt) {
  if (
    !isRecord(receipt)
    || receipt.version !== 1
    || !exactFields(receipt, [
      "version", "receipt_id", "resolved_at", "decision", "reason", "task",
      "project_id", "project", "source_id", "grant", "references"
    ])
    || !safeText(receipt.receipt_id, 256)
    || !canonicalUtc(receipt.resolved_at)
    || !["allowed", "refused"].includes(receipt.decision)
    || !safeText(receipt.task, 500)
    || !optionalSafeText(receipt.project_id, 200)
    || !optionalSafeText(receipt.project, 200)
    || !optionalSourceId(receipt.source_id)
    || !Array.isArray(receipt.references)
  ) throw auditError();
  if (receipt.decision === "refused") {
    if (!safeText(receipt.reason, 256) || receipt.references.length !== 0) throw auditError();
    if (Object.hasOwn(receipt, "grant")) assertReceiptGrant(receipt.grant);
  } else {
    if (
      Object.hasOwn(receipt, "reason")
      || !safeText(receipt.project_id, 200)
      || !safeText(receipt.project, 200)
      || !sourceId(receipt.source_id)
      || !Object.hasOwn(receipt, "grant")
    ) throw auditError();
    assertReceiptGrant(receipt.grant, true, receipt.resolved_at);
  }
  for (const reference of receipt.references) assertReceiptReference(reference, receipt);
}

function assertReceiptGrant(grant, completeRequired = false, resolvedAt = null) {
  const partial = sameFields(grant, ["grant_id", "revision"]);
  const complete = sameFields(grant, [
    "grant_id", "revision", "scope", "purpose", "approved_at", "expires_at",
    "source_revision", "binding_generation", "root_identity", "revoked_at"
  ]);
  if (
    !isRecord(grant)
    || (completeRequired ? !complete : (!partial && !complete))
    || !identifier(grant.grant_id)
    || !positiveInteger(grant.revision)
  ) {
    throw auditError();
  }
  if (!complete) return;
  if (
    (completeRequired ? grant.scope !== "read" : !safeText(grant.scope, 64))
    || !safeText(grant.purpose, 500)
    || !canonicalUtc(grant.approved_at)
    || !canonicalUtc(grant.expires_at)
    || !positiveInteger(grant.source_revision)
    || !positiveInteger(grant.binding_generation)
    || !rootIdentity(grant.root_identity)
    || (grant.revoked_at !== null && !canonicalUtc(grant.revoked_at))
    || (completeRequired && grant.revoked_at !== null)
    || (completeRequired && Date.parse(grant.expires_at) <= Date.parse(grant.approved_at))
    || (completeRequired && Date.parse(grant.approved_at) > Date.parse(resolvedAt))
    || (completeRequired && Date.parse(grant.expires_at) <= Date.parse(resolvedAt))
  ) throw auditError();
}

function assertReceiptReference(reference, receipt) {
  if (
    !exactFields(reference, [
      "project_id", "source_id", "path", "type", "size_bytes", "mtime_ns", "resolved_at", "receipt_id"
    ])
    || !safeText(reference.project_id, 200)
    || !sourceId(reference.source_id)
    || !sourceRelativePath(reference.path)
    || reference.type !== "regular-file"
    || !digitString(reference.size_bytes)
    || !digitString(reference.mtime_ns)
    || reference.resolved_at !== receipt.resolved_at
    || reference.receipt_id !== receipt.receipt_id
    || reference.project_id !== receipt.project_id
    || reference.source_id !== receipt.source_id
  ) throw auditError();
}

function exactFields(value, allowed) {
  return isRecord(value) && Object.keys(value).every((field) => allowed.includes(field));
}

function sameFields(value, expected) {
  return exactFields(value, expected) && Object.keys(value).length === expected.length;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeText(value, maximum) {
  return typeof value === "string"
    && Array.from(value).length >= 1
    && Array.from(value).length <= maximum
    && !/\p{Cc}/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

function optionalSafeText(value, maximum) {
  return value === undefined || safeText(value, maximum);
}

function optionalSourceId(value) {
  return value === undefined || sourceId(value);
}

function sourceId(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
}

function sourceRelativePath(value) {
  if (
    !safeText(value, 1024)
    || Buffer.byteLength(value, "utf8") > 1024
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || value.includes("\\")
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function identifier(value) {
  return typeof value === "string" && /^[a-f0-9-]{1,64}$/.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalUtc(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function digitString(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

function rootIdentity(value) {
  return sameFields(value, ["type", "dev", "ino"])
    && value.type === "directory"
    && digitString(value.dev)
    && digitString(value.ino);
}

async function preservePoisonGuard({ stateRoot, guardPath, guard, filesystem }) {
  try {
    if (await ownedFileStatsIfPresent(filesystem, guardPath)) return true;
    await publishGuard({ stateRoot, guardPath, guard, filesystem });
    return true;
  } catch {
    // The still-owned lock is the fallback poison marker when guard publication itself fails.
    return false;
  }
}

async function publishGuard({ stateRoot, guardPath, guard, filesystem }) {
  await publishOwnedFileExclusive(guardPath, guard, { filesystem });
}

async function syncDirectory(filesystem, directoryPath) {
  await syncOwnedDirectory(directoryPath, { filesystem });
}

async function ownedFileStatsIfPresent(filesystem, filePath) {
  try {
    const stats = await filesystem.lstat(filePath);
    assertOwnedFileStats(stats);
    return stats;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw auditError();
  }
}

function auditError() {
  const error = new Error("Project source access could not be recorded safely.");
  error.code = "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED";
  return error;
}
