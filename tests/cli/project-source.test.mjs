import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CAMPAIGN_TASK,
  OTHER_PROJECT_CANARY,
  createProjectSourceRetrievalFixture,
  snapshotTree,
} from "../fixtures/project-source-retrieval.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("spawned CLI retrieves one project's complete campaign asset references with finite consent", assertCliRetrieval);

function assertCliRetrieval() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const grantApplied = authorizeCliSource(fixture, true);
    assertAllowedCliRetrieval(fixture, grantApplied);
  } finally {
    fixture.cleanup();
  }
}

test("spawned CLI revokes one project-source grant before later retrieval", assertCliRevocation);

function assertCliRevocation() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const grantApplied = authorizeCliSource(fixture);
    const allowed = runJson(retrieveArgs(fixture));
    assert.equal(allowed.decision, "allowed");
    const receiptPath = accessReceiptPath(fixture);
    const receiptsBeforeRevoke = fs.readFileSync(receiptPath);
    revokeCliGrant(fixture, grantApplied.grant_id);
    assert.deepEqual(fs.readFileSync(receiptPath), receiptsBeforeRevoke);
    assertRevokedCliRetrieval(fixture, grantApplied.grant_id, receiptPath);
  } finally {
    fixture.cleanup();
  }
}

function authorizeCliSource(fixture, verifyPreview = false) {
  const portableBefore = snapshotTree(fixture.aiosPath);
  const localBefore = snapshotTree(path.join(fixture.homePath, ".dotaios"));
  const addPreview = runJson(sourceAddArgs(fixture));
  assert.equal(addPreview.applied, false);
  assert.match(addPreview.operation_id, /^[a-f0-9-]+$/);
  assert.match(addPreview.plan_fingerprint, /^[a-f0-9]{64}$/);
  if (verifyPreview) {
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), localBefore);
  }
  assert.equal(runJson(sourceAddArgs(fixture, addPreview)).applied, true);
  const grantPreview = runJson(sourceGrantArgs(fixture));
  assert.equal(grantPreview.applied, false);
  assert.equal(grantPreview.scope, "read");
  assert.equal(grantPreview.approved_at, null);
  assert.equal(grantPreview.expires_at, "2099-01-01T00:00:00.000Z");
  const applied = runJson(sourceGrantArgs(fixture, grantPreview));
  assert.equal(applied.applied, true);
  assert.match(applied.grant_id, /^[a-f0-9-]+$/);
  assert.equal(applied.scope, "read");
  assert.match(applied.approved_at, /^\d{4}-\d{2}-\d{2}T/);
  return applied;
}

function assertAllowedCliRetrieval(fixture, grantApplied) {
  const portableBefore = snapshotTree(fixture.aiosPath);
  const sourceBefore = snapshotTree(fixture.sourceRoot);
  const result = runJson(retrieveArgs(fixture));
  assert.equal(result.decision, "allowed");
  assert.equal(result.project_id, "project-acme-001");
  assert.equal(result.project, "acme-campaign");
  assert.equal(result.source_id, "campaign-assets");
  assert.deepEqual(result.references.map((reference) => reference.path), fixture.expectedPaths);
  assert.ok(result.references.every((reference) => validCliReference(reference, result)));
  const receipts = readReceipts(fixture);
  assertAllowedReceipt(receipts, result, grantApplied);
  assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
  assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  assertRetrievalHasNoContentOrForeignState(fixture, result, receipts);
}

function validCliReference(reference, result) {
  return reference.project_id === "project-acme-001"
    && reference.source_id === "campaign-assets"
    && reference.type === "regular-file"
    && /^\d+$/.test(reference.size_bytes)
    && /^\d+$/.test(reference.mtime_ns)
    && reference.resolved_at === result.resolved_at
    && reference.receipt_id === result.receipt_id;
}

function assertAllowedReceipt(receipts, result, grantApplied) {
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.equal(receipt.decision, "allowed");
  assert.equal(receipt.task, CAMPAIGN_TASK);
  assert.equal(receipt.receipt_id, result.receipt_id);
  assert.equal(receipt.grant.scope, "read");
  assert.equal(receipt.grant.purpose, "Launch campaign assets");
  assert.equal(receipt.grant.approved_at, grantApplied.approved_at);
  assert.equal(receipt.grant.expires_at, grantApplied.expires_at);
  assert.equal(receipt.grant.revoked_at, null);
  assert.deepEqual(Object.keys(receipt.grant.root_identity).sort(), ["dev", "ino", "type"]);
  assert.deepEqual(receipt.references, result.references);
}

function assertRetrievalHasNoContentOrForeignState(fixture, result, receipts) {
  const serialized = JSON.stringify({ result, receipts });
  assert.doesNotMatch(serialized, /CONTENT_READ_CANARY/);
  assert.doesNotMatch(serialized, new RegExp(OTHER_PROJECT_CANARY));
  assert.equal(serialized.includes(fixture.sourceRoot), false);
  assert.equal(serialized.includes(path.join(fixture.homePath, ".dotaios")), false);
}

function revokeCliGrant(fixture, grantId) {
  const localBefore = snapshotTree(path.join(fixture.homePath, ".dotaios"));
  const preview = runJson(sourceRevokeArgs(fixture, grantId));
  assert.equal(preview.applied, false);
  assert.equal(preview.grant_id, grantId);
  assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), localBefore);
  assert.equal(runJson(sourceRevokeArgs(fixture, grantId, preview)).applied, true);
}

function assertRevokedCliRetrieval(fixture, grantId, receiptPath) {
  const refused = runJson(retrieveArgs(fixture));
  assert.equal(refused.decision, "refused");
  assert.equal(refused.reason, "grant-revoked");
  assert.deepEqual(refused.references, []);
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1].task, CAMPAIGN_TASK);
  assert.equal(receipts[1].reason, "grant-revoked");
  assert.equal(receipts[1].grant.grant_id, grantId);
  assert.deepEqual(receipts[1].references, []);
  assert.equal(JSON.stringify({ refused, receipts }).includes(fixture.sourceRoot), false);
}

function sourceAddArgs(fixture, proof = null) {
  return [
    "project", "source", "add", "acme-campaign", fixture.sourceRoot,
    "--source-id", "campaign-assets", "--label", "Campaign assets",
    "--purpose", "Launch campaign assets",
    ...applyProofArgs(proof), ...commonFixtureArgs(fixture),
  ];
}

function sourceGrantArgs(fixture, proof = null) {
  return [
    "project", "source", "grant", "acme-campaign", "campaign-assets",
    "--purpose", "Launch campaign assets", "--expires-at", "2099-01-01T00:00:00.000Z",
    ...applyProofArgs(proof), ...commonFixtureArgs(fixture),
  ];
}

function sourceRevokeArgs(fixture, grantId, proof = null) {
  return [
    "project", "source", "revoke", "acme-campaign", "campaign-assets", "--grant-id", grantId,
    ...applyProofArgs(proof), ...commonFixtureArgs(fixture),
  ];
}

function retrieveArgs(fixture) {
  return [
    "project", "source", "retrieve", "acme-campaign", "--task", CAMPAIGN_TASK,
    ...commonFixtureArgs(fixture),
  ];
}

function applyProofArgs(proof) {
  return proof
    ? ["--operation-id", proof.operation_id, "--plan-fingerprint", proof.plan_fingerprint, "--apply"]
    : [];
}

function commonFixtureArgs(fixture) {
  return ["--path", fixture.aiosPath, "--home", fixture.homePath, "--json"];
}

function accessReceiptPath(fixture) {
  return path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
}

function readReceipts(fixture) {
  return fs.readFileSync(accessReceiptPath(fixture), "utf8").trim().split("\n").map(JSON.parse);
}

test("spawned CLI refuses incomplete grant and revoke previews without writing local state", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const before = snapshotTree(path.join(fixture.homePath, ".dotaios"));
    const failures = [
      runCli([
        "project", "source", "grant", "acme-campaign", "campaign-assets",
        "--expires-at", "2099-01-01T00:00:00.000Z",
        "--path", fixture.aiosPath,
        "--home", fixture.homePath,
        "--json",
      ]),
      runCli([
        "project", "source", "grant", "acme-campaign", "campaign-assets",
        "--purpose", "Launch campaign assets",
        "--path", fixture.aiosPath,
        "--home", fixture.homePath,
        "--json",
      ]),
      runCli([
        "project", "source", "revoke", "acme-campaign", "campaign-assets",
        "--path", fixture.aiosPath,
        "--home", fixture.homePath,
        "--json",
      ]),
    ];
    assert.ok(failures.every((result) => result.status === 1));
    assert.match(failures[0].stderr, /--purpose is required/);
    assert.match(failures[1].stderr, /--expires-at is required/);
    assert.match(failures[2].stderr, /--grant-id is required/);
    assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), before);
  } finally {
    fixture.cleanup();
  }
});

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" },
  });
}
