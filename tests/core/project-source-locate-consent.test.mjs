import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  addProjectSource,
  grantProjectSource,
  revokeProjectSource,
  retrieveProjectSource,
  resolveProjectSourceLocation
} from "../../packages/core/src/project-sources.mjs";
import { projectSourceStatePaths } from "../../packages/core/src/project-source-state.mjs";
import {
  CAMPAIGN_TASK,
  createProjectSourceRetrievalFixture
} from "../fixtures/project-source-retrieval.mjs";

// `resolveProjectSourceLocation` (#106) is the first result surface in the
// product that hands back an absolute filesystem path, and it is a consent
// path. `retrieveProjectSource` authorizes, does its work, and then RE-READS the
// authorization snapshot before publishing, refusing `authorization-changed` if
// the grant moved underneath it (project-sources.mjs enumerateAndRecheck).
// `locate` authorizes and publishes straight from the snapshot it already holds.
//
// readAuthorizationSnapshot takes the source lock, reads, and releases it, so a
// concurrent revoke can land between validation and publication. These tests pin
// the property that matters: whatever the owner did to consent must be true at
// the moment the path is handed over, and locate must not be weaker than
// retrieve about it.

async function authorizeCampaign(fixture) {
  const addOptions = {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    folder: fixture.sourceRoot,
    sourceId: "campaign-assets",
    label: "Campaign assets",
    purpose: "Launch campaign assets"
  };
  const addPreview = await addProjectSource(addOptions);
  await addProjectSource({
    ...addOptions,
    operationId: addPreview.operation_id,
    planFingerprint: addPreview.plan_fingerprint,
    apply: true
  });
  const grantOptions = {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    sourceId: "campaign-assets",
    purpose: "Launch campaign assets",
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
  const grantPreview = await grantProjectSource(grantOptions);
  const granted = await grantProjectSource({
    ...grantOptions,
    operationId: grantPreview.operation_id,
    planFingerprint: grantPreview.plan_fingerprint,
    apply: true
  });
  fixture.grantId = granted.grant_id;
}

async function revokeCampaign(fixture) {
  const revokeOptions = {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    sourceId: "campaign-assets",
    grantId: fixture.grantId
  };
  const preview = await revokeProjectSource(revokeOptions);
  return revokeProjectSource({
    ...revokeOptions,
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint,
    apply: true
  });
}

// Fires the owner's revoke from inside the operation, at the one lstat of the
// bound root that authorizeSelectedSource performs — after the grant has been
// read and validated, before anything is published. This is the real ordering a
// concurrent `dotaios project source revoke` produces; the hook only makes it
// deterministic instead of a timing coin flip.
function revokeDuringAuthorization(fixture) {
  const boundRoot = fs.realpathSync(fixture.sourceRoot);
  let fired = false;
  const state = { revokeCompleted: false };
  const filesystem = new Proxy(fs.promises, {
    get(target, property) {
      const value = target[property];
      if (property !== "lstat") return value;
      return async (targetPath, ...rest) => {
        let resolved = null;
        try {
          resolved = fs.realpathSync(targetPath);
        } catch {
          resolved = String(targetPath);
        }
        if (!fired && resolved === boundRoot && rest[0]?.bigint) {
          fired = true;
          await revokeCampaign(fixture);
          state.revokeCompleted = true;
        }
        return value.call(target, targetPath, ...rest);
      };
    }
  });
  return { filesystem, state };
}

test("retrieve refuses when consent is withdrawn mid-operation", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaign(fixture);
    const race = revokeDuringAuthorization(fixture);
    const result = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem: race.filesystem
    });
    assert.equal(race.state.revokeCompleted, true, "fixture assumption: the revoke landed inside the operation");
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "authorization-changed");
    assert.deepEqual(result.references, []);
  } finally {
    fixture.cleanup();
  }
});

test("locate refuses when consent is withdrawn mid-operation, and hands back no path", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaign(fixture);
    const race = revokeDuringAuthorization(fixture);
    const result = await resolveProjectSourceLocation({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem: race.filesystem
    });
    assert.equal(race.state.revokeCompleted, true, "fixture assumption: the revoke landed inside the operation");
    // The disclosed artifact is a path, so a wrong answer here outlives the
    // call: the agent keeps reading the folder after consent was withdrawn.
    assert.equal(result.root_path, undefined, "locate handed back a path after consent was withdrawn");
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "authorization-changed");
  } finally {
    fixture.cleanup();
  }
});

test("a refused locate writes no allowed receipt and never records the path", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaign(fixture);
    const race = revokeDuringAuthorization(fixture);
    await resolveProjectSourceLocation({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem: race.filesystem
    });
    const ledgerPath = path.join(projectSourceStatePaths(fixture.homePath).root, "access-receipts.jsonl");
    const ledger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
    const receipts = ledger.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const last = receipts.at(-1);
    assert.equal(last.decision, "refused", "the ledger recorded the withdrawn access as allowed");
    // Receipts are path-free by design; the ledger is the portable audit trail
    // while an absolute path is a fact about one machine.
    assert.ok(!ledger.includes(fs.realpathSync(fixture.sourceRoot)), "the ledger recorded an absolute path");
  } finally {
    fixture.cleanup();
  }
});

test("locate succeeds and returns the bound root while consent stands", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaign(fixture);
    const result = await resolveProjectSourceLocation({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK
    });
    assert.equal(result.decision, "allowed");
    assert.equal(fs.realpathSync(result.root_path), fs.realpathSync(fixture.sourceRoot));
    // The whole point of locate: fixed cost, no listing, so the receipt carries
    // no references and the closed schema is untouched.
    assert.deepEqual(result.references, []);
  } finally {
    fixture.cleanup();
  }
});

test("locate refuses a revoked grant outright, as retrieve does", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaign(fixture);
    await revokeCampaign(fixture);
    const shared = {
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK
    };
    const located = await resolveProjectSourceLocation(shared);
    const retrieved = await retrieveProjectSource(shared);
    assert.equal(located.decision, "refused");
    assert.equal(located.root_path, undefined);
    assert.equal(located.reason, retrieved.reason, "locate and retrieve disagree about a revoked grant");
  } finally {
    fixture.cleanup();
  }
});
