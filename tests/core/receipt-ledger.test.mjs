import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendAccessReceipt,
  assertAccessReceiptStoreAvailable,
  createAccessReceipt
} from "../../packages/core/src/receipt-ledger.mjs";

test("receipt publication appends one complete synced line and clears the in-flight guard", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-ledger-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const receipt = createAccessReceipt({
    decision: "allowed",
    task: "retrieve the campaign assets for that client.",
    projectId: "project-acme-001",
    project: "acme-campaign",
    sourceId: "campaign-assets",
    grant: validReceiptGrant(),
    references: []
  });

  await appendAccessReceipt({ homePath, receipt });

  const root = path.join(homePath, ".dotaios", "project-sources");
  const ledgerPath = path.join(root, "access-receipts.jsonl");
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), receipt);
  assert.equal(fs.existsSync(path.join(root, "access-receipts.inflight.json")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600);
  }
});

test("ledger sync failure withholds success and preserves poison evidence", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-failure-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const receipt = createAccessReceipt({ decision: "refused", reason: "source-no-match", task: "valid task" });
  const filesystem = Object.create(fsp);
  filesystem.open = async (filePath, flags, mode) => {
    const handle = await fsp.open(filePath, flags, mode);
    if (String(filePath).endsWith("access-receipts.jsonl") && flags === "a") {
      return Object.create(handle, {
        sync: { value: async () => { throw new Error("forced sync failure"); } }
      });
    }
    return handle;
  };

  await assert.rejects(
    () => appendAccessReceipt({ homePath, receipt, filesystem }),
    { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" }
  );

  const root = path.join(homePath, ".dotaios", "project-sources");
  assert.equal(fs.existsSync(path.join(root, "access-receipts.inflight.json")), true);
  await assert.rejects(
    () => appendAccessReceipt({ homePath, receipt }),
    { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" }
  );
});

test("receipt-lock release failure reinstalls poison evidence before returning", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-release-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const receipt = createAccessReceipt({
    decision: "refused",
    reason: "source-no-match",
    task: "valid task"
  });
  const filesystem = Object.create(fsp);
  filesystem.unlink = async (filePath) => {
    if (String(filePath).includes("access-receipts.lock.release.")) {
      throw new Error("forced release failure");
    }
    return fsp.unlink(filePath);
  };

  await assert.rejects(
    () => appendAccessReceipt({ homePath, receipt, filesystem }),
    { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" }
  );

  const root = path.join(homePath, ".dotaios", "project-sources");
  assert.equal(fs.existsSync(path.join(root, "access-receipts.inflight.json")), true);
  await assert.rejects(
    () => appendAccessReceipt({ homePath, receipt }),
    { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" }
  );
});

test("receipt health rejects an invalid UTF-8 final line without rewriting it", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-utf8-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const root = path.join(homePath, ".dotaios", "project-sources");
  const ledgerPath = path.join(root, "access-receipts.jsonl");
  fs.mkdirSync(root, { recursive: true });
  const poisoned = Buffer.concat([
    Buffer.from('{"version":1,"task":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n')
  ]);
  fs.writeFileSync(ledgerPath, poisoned);
  const receipt = createAccessReceipt({ decision: "refused", reason: "source-no-match", task: "valid task" });

  await assert.rejects(
    () => appendAccessReceipt({ homePath, receipt }),
    { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" }
  );
  assert.deepEqual(fs.readFileSync(ledgerPath), poisoned);
});

test("receipt health rejects malformed and unknown-version final records without rewrite", async (t) => {
  await t.test("malformed schema", () => assertInvalidReceiptTail({}));
  await t.test("unknown future version", () => assertInvalidReceiptTail({ ...refusedReceipt(), version: 2 }));
  await t.test("incomplete allowed receipt", () => assertInvalidReceiptTail(createAccessReceipt({
    decision: "allowed", task: "valid task", projectId: "project-acme-001",
    project: "acme-campaign", sourceId: "campaign-assets",
  })));
  await t.test("reference coordinate mismatch", () => assertInvalidReceiptTail(allowedReceipt([{
    ...receiptReference("asset.txt"), project_id: "project-other-002",
  }])));
  await t.test("revoked allowed grant", () => assertInvalidReceiptTail(allowedReceipt([], {
    ...validReceiptGrant(), revoked_at: "2026-08-10T11:30:00.000Z",
  })));
  await t.test("allowed grant expires before approval", () => assertInvalidReceiptTail(allowedReceipt([], {
    ...validReceiptGrant(), expires_at: "2026-08-10T10:00:00.000Z",
  })));
});

test("receipt reference paths are normalized source-relative UTF-8 paths", async (t) => {
  await t.test("awkward UTF-8 name", () => assertValidReceiptReferencePath("visual assets/café-🚀.svg"));
  for (const [name, invalidPath] of [
    ["absolute", "/private/asset.txt"],
    ["Windows absolute", "C:/private/asset.txt"],
    ["UNC", "\\\\server\\share\\asset.txt"],
    ["traversal", "visual assets/../secret.txt"],
    ["over byte bound", "🚀".repeat(257)],
  ]) {
    await t.test(`${name} append`, () => assertInvalidReceiptReferenceAppend(invalidPath));
    await t.test(`${name} durable tail`, () => assertInvalidReceiptTail(allowedReceipt([receiptReference(invalidPath)])));
  }
});

test("deterministic receipt prevalidation failures do not poison a later valid append", async (t) => {
  for (const [name, invalidReceipt] of [
    ["malformed schema", {}],
    ["receipt byte size", receiptWithExactBytes(32_001)],
    ["absolute reference path", allowedReceipt([receiptReference("/private/asset.txt")])],
  ]) {
    await t.test(name, () => assertInvalidReceiptAppendRecovers(invalidReceipt));
  }
});

test("allowed receipt authority is live at its resolved timestamp", async (t) => {
  for (const [name, grant] of [
    ["expired at resolution", {
      ...validReceiptGrant(),
      expires_at: "2026-08-10T12:00:00.000Z",
    }],
    ["not yet approved", {
      ...validReceiptGrant(),
      approved_at: "2026-08-10T12:00:00.001Z",
    }],
  ]) {
    const receipt = allowedReceipt([], grant);
    await t.test(`${name} append`, () => assertInvalidReceiptAppendRecovers(receipt));
    await t.test(`${name} durable tail`, () => assertInvalidReceiptTail(receipt));
  }
});

test("refused receipt publication faults stay path-free and preserve uncertainty across restart", async (t) => {
  for (const stage of [
    "lock-temp-sync",
    "lock-link",
    "lock-parent-sync",
    "guard-write",
    "guard-temp-sync",
    "guard-link",
    "guard-parent-sync",
    "append-open",
    "append-write",
    "ledger-sync",
    "guard-removal",
    "guard-clear-parent-sync",
  ]) {
    await t.test(stage, () => assertReceiptPublicationFault(stage));
  }
});

test("receipt and ledger byte boundaries fail rather than truncate or rewrite", async (t) => {
  await t.test("receipt exactly 32000 bytes", () => assertReceiptByteBoundary(32_000, true));
  await t.test("receipt 32001 bytes", () => assertReceiptByteBoundary(32_001, false));
  await t.test("ledger exactly 64 MiB", () => assertLedgerByteBoundary(0, true));
  await t.test("ledger above 64 MiB", () => assertLedgerByteBoundary(1, false));
});

test("receipt task follows the 500-code-point core contract", async (t) => {
  await t.test("500 code points", () => appendReceiptWithTask("x".repeat(500), true));
  await t.test("501 code points", () => appendReceiptWithTask("x".repeat(501), false));
});

test("a failed guard re-poison durably marks the retained lock while an ordinary dead lock stays reclaimable", async (t) => {
  await t.test("retained lock poison survives restart", assertRetainedReceiptLockPoison);
  await t.test("dead pre-guard lock is reclaimed", assertDeadReceiptLockReclaimed);
});

test("strict lock publication sync failure leaves a poisoned lock after the owner process exits", async (t) => {
  await t.test("parent directory sync", () => assertDeadPublishedLockPoison("sync"));
  await t.test("temporary unlink", () => assertDeadPublishedLockPoison("unlink"));
});

test("owned receipt state refuses linked, special, wrong-owner, and permissive targets without rewrite", async (t) => {
  for (const target of ["ledger", "guard", "lock"]) {
    for (const mutation of ["linked", "symlinked", "special", "wrong-owner", "permissive"]) {
      await t.test(`${target} ${mutation}`, () => assertUnsafeReceiptTarget(target, mutation));
    }
  }
  await t.test("permissive owned directory", assertUnsafeReceiptDirectory);
});

async function assertReceiptPublicationFault(stage) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-matrix-"));
  try {
    const receipt = refusedReceipt();
    const root = path.join(homePath, ".dotaios", "project-sources");
    const filesystem = receiptFaultFilesystem(stage, root);
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt, filesystem }),
      (error) => error?.code === "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED"
        && !error.message.includes(homePath),
    );
    const cleanRetry = () => appendAccessReceipt({ homePath, receipt });
    if (["lock-temp-sync", "lock-link"].includes(stage)) await cleanRetry();
    else await assert.rejects(cleanRetry, { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" });
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertDeadPublishedLockPoison(stage) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-lock-restart-"));
  try {
    const child = spawnLockPublicationFailure(homePath, stage);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const lockPath = path.join(homePath, ".dotaios", "project-sources", "access-receipts.lock");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).poisoned, true);
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt: refusedReceipt() }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

function spawnLockPublicationFailure(homePath, stage) {
  const moduleUrl = new URL("../../packages/core/src/receipt-ledger.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { appendAccessReceipt, createAccessReceipt } from ${JSON.stringify(moduleUrl)};
    const homePath = process.argv[1];
    const stage = process.argv[2];
    const stateRoot = path.join(homePath, ".dotaios", "project-sources");
    let failed = false;
    const filesystem = Object.create(fs);
    filesystem.open = async (filePath, flags, mode) => {
      const handle = await fs.open(filePath, flags, mode);
      if (path.resolve(String(filePath)) !== path.resolve(stateRoot) || flags !== "r") return handle;
      return Object.create(handle, { sync: { value: async () => {
        if (!failed && stage === "sync") {
          failed = true;
          throw new Error("forced lock publication directory sync failure");
        }
        return handle.sync();
      } } });
    };
    filesystem.unlink = async (filePath) => {
      if (!failed && stage === "unlink" && String(filePath).includes("access-receipts.lock.")) {
        failed = true;
        throw new Error("forced lock temporary unlink failure");
      }
      return fs.unlink(filePath);
    };
    const receipt = createAccessReceipt({
      decision: "refused", reason: "source-no-match", task: "valid task",
    });
    try {
      await appendAccessReceipt({ homePath, receipt, filesystem });
      process.exitCode = 2;
    } catch (error) {
      if (error?.code !== "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED") process.exitCode = 3;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script, homePath, stage], {
    encoding: "utf8",
  });
}

function receiptFaultFilesystem(stage, stateRoot) {
  let failed = false;
  let directorySyncs = 0;
  const filesystem = Object.create(fsp);
  filesystem.open = async (filePath, flags, mode) => {
    const text = String(filePath);
    if (!failed && stage === "append-open" && text.endsWith("access-receipts.jsonl") && flags === "a") {
      failed = true;
      throw new Error("forced receipt fault");
    }
    const handle = await fsp.open(filePath, flags, mode);
    return faultedReceiptHandle({ handle, text, flags, stage, stateRoot, failed: () => failed, fail: () => { failed = true; }, nextDirectorySync: () => ++directorySyncs });
  };
  filesystem.link = async (source, destination) => {
    const isTarget = (stage === "lock-link" && String(destination).endsWith("access-receipts.lock"))
      || (stage === "guard-link" && String(destination).endsWith("access-receipts.inflight.json"));
    if (!failed && isTarget) {
      failed = true;
      throw new Error("forced receipt fault");
    }
    return fsp.link(source, destination);
  };
  filesystem.unlink = async (filePath) => {
    if (!failed && stage === "guard-removal" && String(filePath).endsWith("access-receipts.inflight.json")) {
      failed = true;
      throw new Error("forced receipt fault");
    }
    return fsp.unlink(filePath);
  };
  return filesystem;
}

function faultedReceiptHandle({ handle, text, flags, stage, stateRoot, failed, fail, nextDirectorySync }) {
  const wrapped = Object.create(handle);
  wrapped.writeFile = async (...args) => {
    const target = (stage === "guard-write" && text.includes(".access-receipts.inflight."))
      || (stage === "append-write" && text.endsWith("access-receipts.jsonl"));
    if (!failed() && target) {
      fail();
      throw new Error("forced receipt fault");
    }
    return handle.writeFile(...args);
  };
  wrapped.sync = async () => {
    const directorySync = path.resolve(text) === path.resolve(stateRoot) && flags === "r"
      ? nextDirectorySync()
      : 0;
    const target = (stage === "lock-temp-sync" && text.includes("access-receipts.lock.") && text.endsWith(".tmp"))
      || (stage === "guard-temp-sync" && text.includes(".access-receipts.inflight."))
      || (stage === "ledger-sync" && text.endsWith("access-receipts.jsonl"))
      || (stage === "lock-parent-sync" && directorySync === 1)
      || (stage === "guard-parent-sync" && directorySync === 2)
      || (stage === "guard-clear-parent-sync" && directorySync === 3);
    if (!failed() && target) {
      fail();
      throw new Error("forced receipt fault");
    }
    return handle.sync();
  };
  return wrapped;
}

async function assertReceiptByteBoundary(byteLength, succeeds) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-boundary-"));
  try {
    const receipt = receiptWithExactBytes(byteLength);
    const action = () => appendAccessReceipt({ homePath, receipt });
    if (succeeds) await action();
    else await assert.rejects(action, { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" });
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertLedgerByteBoundary(excessBytes, succeeds) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-ledger-boundary-"));
  try {
    const receipt = refusedReceipt();
    const lineBytes = Buffer.byteLength(`${JSON.stringify(receipt)}\n`);
    const root = path.join(homePath, ".dotaios", "project-sources");
    const ledgerPath = path.join(root, "access-receipts.jsonl");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(homePath, ".dotaios"), 0o700);
    fs.chmodSync(root, 0o700);
    const initialBytes = 64 * 1024 * 1024 - lineBytes + excessBytes;
    fs.writeFileSync(ledgerPath, "");
    const seedLine = `${JSON.stringify(refusedReceipt("seed receipt"))}\n`;
    fs.truncateSync(ledgerPath, initialBytes - Buffer.byteLength(seedLine) - 1);
    fs.appendFileSync(ledgerPath, `\n${seedLine}`);
    fs.chmodSync(ledgerPath, 0o600);
    const before = fs.statSync(ledgerPath).size;
    const action = () => appendAccessReceipt({ homePath, receipt });
    if (succeeds) {
      await action();
      assert.equal(fs.statSync(ledgerPath).size, 64 * 1024 * 1024);
    } else {
      await assert.rejects(action, { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" });
      assert.equal(fs.statSync(ledgerPath).size, before);
    }
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertInvalidReceiptTail(value) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-schema-"));
  try {
    const root = path.join(homePath, ".dotaios", "project-sources");
    const ledgerPath = path.join(root, "access-receipts.jsonl");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(homePath, ".dotaios"), 0o700);
    fs.chmodSync(root, 0o700);
    const bytes = `${JSON.stringify(value)}\n`;
    fs.writeFileSync(ledgerPath, bytes, { mode: 0o600 });
    await assert.rejects(
      () => assertAccessReceiptStoreAvailable({ homePath }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), bytes);
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt: refusedReceipt() }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), bytes);
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

function receiptWithExactBytes(byteLength) {
  for (let count = 1; count <= 200; count += 1) {
    const references = Array.from({ length: count }, (_, index) => receiptReference(`asset-${index}`));
    const baseline = allowedReceipt(references);
    const remaining = byteLength - Buffer.byteLength(`${JSON.stringify(baseline)}\n`);
    if (remaining >= 0 && remaining <= 1024 - references.at(-1).path.length) {
      const exactReferences = references.map((reference, index) => index === references.length - 1
        ? { ...reference, path: `${reference.path}${"x".repeat(remaining)}` }
        : reference);
      return allowedReceipt(exactReferences);
    }
  }
  throw new Error(`Unable to construct a valid ${byteLength}-byte receipt.`);
}

async function appendReceiptWithTask(task, succeeds) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-task-"));
  try {
    const action = () => appendAccessReceipt({ homePath, receipt: refusedReceipt(task) });
    if (succeeds) await action();
    else await assert.rejects(action, { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" });
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

function allowedReceipt(references, grant = validReceiptGrant()) {
  return createAccessReceipt({
    decision: "allowed",
    task: "valid task",
    projectId: "project-acme-001",
    project: "acme-campaign",
    sourceId: "campaign-assets",
    grant,
    references,
    createId: () => "receipt-fixed",
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
}

async function assertValidReceiptReferencePath(relativePath) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-reference-"));
  try {
    await appendAccessReceipt({
      homePath,
      receipt: allowedReceipt([receiptReference(relativePath)]),
    });
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertInvalidReceiptReferenceAppend(relativePath) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-reference-"));
  try {
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt: allowedReceipt([receiptReference(relativePath)]) }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    const ledgerPath = path.join(homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
    assert.equal(fs.existsSync(ledgerPath), false);
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertInvalidReceiptAppendRecovers(invalidReceipt) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-prevalidation-"));
  try {
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt: invalidReceipt }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    const root = path.join(homePath, ".dotaios", "project-sources");
    assert.equal(fs.existsSync(path.join(root, "access-receipts.inflight.json")), false);
    const validReceipt = refusedReceipt("valid recovery receipt");
    await appendAccessReceipt({ homePath, receipt: validReceipt });
    const ledgerPath = path.join(root, "access-receipts.jsonl");
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), validReceipt);
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

function receiptReference(relativePath) {
  return {
    project_id: "project-acme-001",
    source_id: "campaign-assets",
    path: relativePath,
    type: "regular-file",
    size_bytes: "1",
    mtime_ns: "1",
  };
}

function validReceiptGrant() {
  return {
    grant_id: "a11-dead",
    revision: 1,
    scope: "read",
    purpose: "Launch campaign assets",
    approved_at: "2026-08-10T11:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    source_revision: 1,
    binding_generation: 1,
    root_identity: { type: "directory", dev: "1", ino: "1" },
    revoked_at: null,
  };
}

function refusedReceipt(task = "valid task") {
  return createAccessReceipt({
    decision: "refused",
    reason: "source-no-match",
    task,
    createId: () => "receipt-fixed",
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
}

async function assertRetainedReceiptLockPoison() {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-lock-poison-"));
  try {
    const receipt = refusedReceipt();
    const root = path.join(homePath, ".dotaios", "project-sources");
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt, filesystem: failReceiptGuardRepoison(root) }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    const guardPath = path.join(root, "access-receipts.inflight.json");
    const lockPath = path.join(root, "access-receipts.lock");
    assert.equal(fs.existsSync(guardPath), false);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).poisoned, true);
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

function failReceiptGuardRepoison(stateRoot) {
  let directorySyncs = 0;
  let clearFailed = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (filePath, flags, mode) => {
    const text = String(filePath);
    if (clearFailed && flags === "wx" && text.includes(".access-receipts.inflight.")) {
      throw new Error("forced guard re-poison failure");
    }
    const handle = await fsp.open(filePath, flags, mode);
    if (path.resolve(text) !== path.resolve(stateRoot) || flags !== "r") return handle;
    return Object.create(handle, { sync: { value: async () => {
      directorySyncs += 1;
      if (directorySyncs === 3) {
        clearFailed = true;
        throw new Error("forced guard clear sync failure");
      }
      return handle.sync();
    } } });
  };
  return filesystem;
}

async function assertDeadReceiptLockReclaimed() {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-dead-lock-"));
  try {
    const root = path.join(homePath, ".dotaios", "project-sources");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(homePath, ".dotaios"), 0o700);
    fs.chmodSync(root, 0o700);
    const lockPath = path.join(root, "access-receipts.lock");
    fs.writeFileSync(lockPath, `${JSON.stringify({
      format: "dotaios-project-source-receipt-lock/v1",
      pid: 2_147_483_647,
      owner: "a11-dead",
      at: Date.now(),
    })}\n`, { mode: 0o600 });
    await assertAccessReceiptStoreAvailable({ homePath });
    await appendAccessReceipt({ homePath, receipt: refusedReceipt() });
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertUnsafeReceiptTarget(target, mutation) {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-owned-"));
  try {
    const receipt = refusedReceipt();
    await appendAccessReceipt({ homePath, receipt });
    const root = path.join(homePath, ".dotaios", "project-sources");
    const targetPath = receiptTargetPath(root, target);
    if (!fs.existsSync(targetPath)) seedReceiptTarget(targetPath, target);
    let filesystem = fsp;
    if (mutation === "linked") fs.linkSync(targetPath, `${targetPath}.linked`);
    if (mutation === "symlinked") {
      fs.renameSync(targetPath, `${targetPath}.real`);
      fs.symlinkSync(`${targetPath}.real`, targetPath);
    }
    if (mutation === "special") {
      fs.rmSync(targetPath);
      fs.mkdirSync(targetPath, { mode: 0o700 });
    }
    if (mutation === "permissive") fs.chmodSync(targetPath, 0o644);
    if (mutation === "wrong-owner") filesystem = wrongOwnerReceiptFilesystem(targetPath);
    const before = snapshotReceiptNode(targetPath);
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt, filesystem }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    assert.deepEqual(snapshotReceiptNode(targetPath), before);
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

async function assertUnsafeReceiptDirectory() {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-receipt-owned-dir-"));
  try {
    await appendAccessReceipt({ homePath, receipt: refusedReceipt() });
    const root = path.join(homePath, ".dotaios", "project-sources");
    fs.chmodSync(root, 0o755);
    await assert.rejects(
      () => appendAccessReceipt({ homePath, receipt: refusedReceipt() }),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" },
    );
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(homePath, { recursive: true, force: true });
  }
}

function receiptTargetPath(root, target) {
  if (target === "ledger") return path.join(root, "access-receipts.jsonl");
  if (target === "guard") return path.join(root, "access-receipts.inflight.json");
  return path.join(root, "access-receipts.lock");
}

function seedReceiptTarget(targetPath, target) {
  const value = target === "guard"
    ? { version: 1, receipt_id: "seed", line_sha256: "a".repeat(64) }
    : {
      format: "dotaios-project-source-receipt-lock/v1",
      pid: 2_147_483_647,
      owner: "a11-dead",
      at: Date.now(),
    };
  fs.writeFileSync(targetPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function wrongOwnerReceiptFilesystem(targetPath) {
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (filePath, ...args) => {
    const stats = await fsp.lstat(filePath, ...args);
    if (path.resolve(String(filePath)) !== path.resolve(targetPath)) return stats;
    return Object.create(stats, { uid: { value: stats.uid + 1 } });
  };
  return filesystem;
}

function snapshotReceiptNode(targetPath) {
  const stats = fs.lstatSync(targetPath);
  return Object.freeze({
    type: stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file",
    mode: stats.mode & 0o777,
    nlink: stats.nlink,
    ...(stats.isFile() ? { bytes: fs.readFileSync(targetPath, "utf8") } : {}),
    ...(stats.isSymbolicLink() ? { target: fs.readlinkSync(targetPath) } : {}),
  });
}
