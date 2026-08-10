import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { acquireOperationLock, releaseOperationLock } from "./operation-lock.mjs";
import { projectSourceStatePaths } from "./project-source-state.mjs";

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
  const publication = receiptPublication(homePath, receipt);
  let lock = null;
  let outcome = null;
  try {
    await prepareStateRoot(publication.stateRoot, filesystem);
    lock = await acquireOperationLock(publication.lockPath, {
      filesystem,
      format: LOCK_FORMAT,
      ownsParent: false
    });
    if (!lock) throw auditError();
    outcome = await publishReceiptUnderLock(publication, filesystem);
    if (!outcome.ok) throw outcome.error;
    return receipt;
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED") throw error;
    throw auditError();
  } finally {
    if (lock && outcome?.retainLock !== true) await releaseReceiptLock(lock, publication, filesystem);
  }
}

function receiptPublication(homePath, receipt) {
  const stateRoot = projectSourceStatePaths(homePath).root;
  const line = `${JSON.stringify(receipt)}\n`;
  return Object.freeze({
    stateRoot,
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

async function prepareStateRoot(stateRoot, filesystem) {
  await filesystem.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await filesystem.chmod(stateRoot, 0o700);
}

async function publishReceiptUnderLock(publication, filesystem) {
  let guardCleared = false;
  try {
    await assertLedgerHealthy({ ...publication, filesystem });
    await assertReceiptFits(publication, filesystem);
    await publishGuard({ ...publication, filesystem });
    await appendSyncedLine(publication, filesystem);
    await filesystem.unlink(publication.guardPath);
    guardCleared = true;
    await syncDirectory(filesystem, publication.stateRoot);
    return Object.freeze({ ok: true, retainLock: false });
  } catch (error) {
    const poisonPreserved = !guardCleared
      || await preservePoisonGuard({ ...publication, filesystem });
    return Object.freeze({ ok: false, error, retainLock: !poisonPreserved });
  }
}

async function assertReceiptFits({ ledgerPath, line }, filesystem) {
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > MAX_RECEIPT_BYTES) throw auditError();
  const ledgerStats = await lstatIfPresent(filesystem, ledgerPath);
  if ((ledgerStats?.size || 0) + lineBytes > MAX_LEDGER_BYTES) throw auditError();
}

async function appendSyncedLine({ ledgerPath, line }, filesystem) {
  const handle = await filesystem.open(ledgerPath, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await filesystem.chmod(ledgerPath, 0o600);
}

async function releaseReceiptLock(lock, publication, filesystem) {
  try {
    await releaseOperationLock(lock, { filesystem });
  } catch {
    await preservePoisonGuard({ ...publication, filesystem });
    throw auditError();
  }
}

async function assertLedgerHealthy({ ledgerPath, guardPath, filesystem }) {
  if (await lstatIfPresent(filesystem, guardPath)) throw auditError();
  const stats = await lstatIfPresent(filesystem, ledgerPath);
  if (!stats) return;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LEDGER_BYTES) throw auditError();
  if (stats.size === 0) return;
  const tailLength = Math.min(stats.size, MAX_RECEIPT_BYTES + 1);
  const handle = await filesystem.open(ledgerPath, "r");
  let tail;
  try {
    const buffer = Buffer.allocUnsafe(tailLength);
    const { bytesRead } = await handle.read(buffer, 0, tailLength, stats.size - tailLength);
    tail = buffer.subarray(0, bytesRead);
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
    JSON.parse(finalLine);
  } catch {
    throw auditError();
  }
}

async function preservePoisonGuard({ stateRoot, guardPath, guard, filesystem }) {
  try {
    if (await lstatIfPresent(filesystem, guardPath)) return true;
    await publishGuard({ stateRoot, guardPath, guard, filesystem });
    return true;
  } catch {
    // The still-owned lock is the fallback poison marker when guard publication itself fails.
    return false;
  }
}

async function publishGuard({ stateRoot, guardPath, guard, filesystem }) {
  const temporary = path.join(stateRoot, `.access-receipts.inflight.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await filesystem.open(temporary, "wx", 0o600);
    await handle.writeFile(guard, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await filesystem.link(temporary, guardPath);
    await syncDirectory(filesystem, stateRoot);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(filesystem, directoryPath) {
  const handle = await filesystem.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lstatIfPresent(filesystem, filePath) {
  try {
    return await filesystem.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function auditError() {
  const error = new Error("Project source access could not be recorded safely.");
  error.code = "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED";
  return error;
}
