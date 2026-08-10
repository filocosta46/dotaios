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

test("spawned CLI retrieves one project's complete campaign asset references with finite consent", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const initialPortable = snapshotTree(fixture.aiosPath);
    const initialLocalState = snapshotTree(path.join(fixture.homePath, ".dotaios"));
    const addPreview = runJson([
      "project", "source", "add", "acme-campaign", fixture.sourceRoot,
      "--source-id", "campaign-assets",
      "--label", "Campaign assets",
      "--purpose", "Launch campaign assets",
      "--path", fixture.aiosPath,
      "--home", fixture.homePath,
      "--json",
    ]);
    assert.equal(addPreview.applied, false);
    assert.match(addPreview.operation_id, /^[a-f0-9-]+$/);
    assert.match(addPreview.plan_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(snapshotTree(fixture.aiosPath), initialPortable);
    assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), initialLocalState);

    const addApplied = runJson([
      "project", "source", "add", "acme-campaign", fixture.sourceRoot,
      "--source-id", "campaign-assets",
      "--label", "Campaign assets",
      "--purpose", "Launch campaign assets",
      "--operation-id", addPreview.operation_id,
      "--plan-fingerprint", addPreview.plan_fingerprint,
      "--apply",
      "--path", fixture.aiosPath,
      "--home", fixture.homePath,
      "--json",
    ]);
    assert.equal(addApplied.applied, true);

    const grantPreview = runJson([
      "project", "source", "grant", "project-acme-001", "campaign-assets",
      "--purpose", "Launch campaign assets",
      "--expires-at", "2099-01-01T00:00:00.000Z",
      "--path", fixture.aiosPath,
      "--home", fixture.homePath,
      "--json",
    ]);
    assert.equal(grantPreview.applied, false);
    assert.equal(grantPreview.scope, "read");
    assert.equal(grantPreview.approved_at, null);
    assert.equal(grantPreview.expires_at, "2099-01-01T00:00:00.000Z");

    const grantApplied = runJson([
      "project", "source", "grant", "project-acme-001", "campaign-assets",
      "--purpose", "Launch campaign assets",
      "--expires-at", "2099-01-01T00:00:00.000Z",
      "--operation-id", grantPreview.operation_id,
      "--plan-fingerprint", grantPreview.plan_fingerprint,
      "--apply",
      "--path", fixture.aiosPath,
      "--home", fixture.homePath,
      "--json",
    ]);
    assert.equal(grantApplied.applied, true);
    assert.match(grantApplied.grant_id, /^[a-f0-9-]+$/);
    assert.equal(grantApplied.scope, "read");
    assert.match(grantApplied.approved_at, /^\d{4}-\d{2}-\d{2}T/);

    const portableBeforeRetrieval = snapshotTree(fixture.aiosPath);
    const sourceBeforeRetrieval = snapshotTree(fixture.sourceRoot);
    const result = runJson([
      "project", "source", "retrieve", "acme-campaign",
      "--task", CAMPAIGN_TASK,
      "--path", fixture.aiosPath,
      "--home", fixture.homePath,
      "--json",
    ]);

    assert.equal(result.decision, "allowed");
    assert.equal(result.project_id, "project-acme-001");
    assert.equal(result.project, "acme-campaign");
    assert.equal(result.source_id, "campaign-assets");
    assert.deepEqual(result.references.map((reference) => reference.path), fixture.expectedPaths);
    assert.ok(result.references.every((reference) => (
      reference.project_id === "project-acme-001"
      && reference.source_id === "campaign-assets"
      && reference.type === "regular-file"
      && /^\d+$/.test(reference.size_bytes)
      && /^\d+$/.test(reference.mtime_ns)
      && reference.resolved_at === result.resolved_at
      && reference.receipt_id === result.receipt_id
    )));

    const receiptPath = path.join(
      fixture.homePath,
      ".dotaios",
      "project-sources",
      "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "allowed");
    assert.equal(receipts[0].task, CAMPAIGN_TASK);
    assert.equal(receipts[0].receipt_id, result.receipt_id);
    assert.equal(receipts[0].grant.scope, "read");
    assert.equal(receipts[0].grant.purpose, "Launch campaign assets");
    assert.equal(receipts[0].grant.approved_at, grantApplied.approved_at);
    assert.equal(receipts[0].grant.expires_at, grantApplied.expires_at);
    assert.equal(receipts[0].grant.revoked_at, null);
    assert.deepEqual(Object.keys(receipts[0].grant.root_identity).sort(), ["dev", "ino", "type"]);
    assert.deepEqual(receipts[0].references, result.references);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBeforeRetrieval);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBeforeRetrieval);

    const serialized = JSON.stringify({ result, receipts });
    assert.doesNotMatch(serialized, /CONTENT_READ_CANARY/);
    assert.doesNotMatch(serialized, new RegExp(OTHER_PROJECT_CANARY));
    assert.equal(serialized.includes(fixture.sourceRoot), false);
    assert.equal(serialized.includes(path.join(fixture.homePath, ".dotaios")), false);
  } finally {
    fixture.cleanup();
  }
});

function runJson(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
