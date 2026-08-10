import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  appendAccessReceipt,
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
    if (String(filePath).endsWith("access-receipts.lock")) {
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
