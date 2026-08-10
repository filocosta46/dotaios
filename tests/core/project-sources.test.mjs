import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  addProjectSource,
  grantProjectSource,
  retrieveProjectSource,
  validateSourceId,
  validateTask
} from "../../packages/core/src/project-sources.mjs";
import {
  projectSourceStatePaths,
  publishBinding,
  publishGrant,
  readProjectSourceState
} from "../../packages/core/src/project-source-state.mjs";
import {
  CAMPAIGN_TASK,
  createProjectSourceRetrievalFixture,
  snapshotTree
} from "../fixtures/project-source-retrieval.mjs";

test("project source syntax bounds fail before project discovery or receipt state", async () => {
  assert.equal(validateTask("x"), "x");
  assert.equal(validateTask("🚀".repeat(500)), "🚀".repeat(500));
  for (const task of ["", "x".repeat(501), "line\nbreak", "\ud800"]) {
    assert.throws(() => validateTask(task), { code: "DOTAIOS_PROJECT_SOURCE_TASK_INVALID" });
  }
  for (const sourceId of ["../escape", ".", "two--hyphens", "UPPER", "x".repeat(65), "bad\u0000id"]) {
    assert.throws(() => validateSourceId(sourceId), { code: "DOTAIOS_PROJECT_SOURCE_REFUSED" });
  }
  await assert.rejects(
    () => addProjectSource({
      aiosPath: "/this-path-must-not-be-observed",
      homePath: "/this-state-must-not-be-observed",
      projectSelector: "acme-campaign",
      folder: "/this-root-must-not-be-observed",
      sourceId: "../escape",
      label: "Campaign assets",
      purpose: "Launch campaign assets"
    }),
    (error) => error?.details?.reason === "source-id-invalid"
  );
});

test("core composes finite consent, metadata-only retrieval, provenance, and one receipt", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const portableBefore = snapshotTree(fixture.aiosPath);
    const addPreview = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets"
    });
    assert.equal(addPreview.applied, false);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);

    await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: addPreview.operation_id,
      planFingerprint: addPreview.plan_fingerprint,
      apply: true
    });
    const grantPreview = await grantProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "project-acme-001",
      sourceId: "campaign-assets",
      purpose: "Launch campaign assets",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    const grantApplied = await grantProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "project-acme-001",
      sourceId: "campaign-assets",
      purpose: "Launch campaign assets",
      expiresAt: "2099-01-01T00:00:00.000Z",
      operationId: grantPreview.operation_id,
      planFingerprint: grantPreview.plan_fingerprint,
      apply: true
    });
    assert.equal(grantPreview.scope, "read");
    assert.equal(grantPreview.approved_at, null);
    assert.equal(grantApplied.scope, "read");
    assert.match(grantApplied.approved_at, /^\d{4}-\d{2}-\d{2}T/);

    const sourceStats = fs.lstatSync(fixture.sourceRoot, { bigint: true });
    const otherBinding = await publishBinding({
      homePath: fixture.homePath,
      projectId: "project-other-002",
      sourceId: "campaign-assets",
      operationId: "a11-b1d",
      planFingerprint: "a".repeat(64),
      rootPath: fixture.sourceRoot,
      rootIdentity: { type: "directory", dev: sourceStats.dev.toString(), ino: sourceStats.ino.toString() }
    });
    await publishGrant({
      homePath: fixture.homePath,
      projectId: "project-other-002",
      sourceId: "campaign-assets",
      operationId: "a11-a12",
      planFingerprint: "b".repeat(64),
      grantId: "a11-a12",
      purpose: "Private launch campaign assets",
      expiresAt: "2099-01-01T00:00:00.000Z",
      approvedAt: "2098-01-01T00:00:00.000Z",
      binding: otherBinding,
      sourceRevision: 1
    });
    const otherPaths = projectSourceStatePaths(
      fixture.homePath,
      "project-other-002",
      "campaign-assets"
    );
    const observations = [];
    const instrumentedFilesystem = Object.create(fsp);
    instrumentedFilesystem.readFile = async (filePath, ...args) => {
      const observedPath = path.resolve(String(filePath));
      if (observedPath === otherPaths.binding || observedPath === otherPaths.grant) {
        observations.push(`other-state:${observedPath}`);
        throw new Error("other-project state must not be read");
      }
      if (observedPath.startsWith(`${path.resolve(fixture.sourceRoot)}${path.sep}`)) {
        observations.push(`source-content:${observedPath}`);
        throw new Error("source content must not be read");
      }
      return fsp.readFile(filePath, ...args);
    };
    instrumentedFilesystem.open = async (filePath, ...args) => {
      const observedPath = path.resolve(String(filePath));
      const otherDeclaration = path.join(
        fixture.aiosPath,
        "projects",
        "other-client",
        "sources",
        "campaign-assets.md"
      );
      if (observedPath === otherDeclaration) {
        observations.push(`other-source:${observedPath}`);
        throw new Error("other-project source must not be opened");
      }
      if (observedPath.startsWith(`${path.resolve(fixture.sourceRoot)}${path.sep}`)) {
        observations.push(`source-content:${observedPath}`);
        throw new Error("source content must not be opened");
      }
      return fsp.open(filePath, ...args);
    };

    const result = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem: instrumentedFilesystem
    });

    assert.equal(result.decision, "allowed");
    assert.deepEqual(observations, []);
    assert.deepEqual(result.references.map((reference) => reference.path), fixture.expectedPaths);
    const receiptPath = path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0].grant.root_identity, {
      type: "directory",
      dev: sourceStats.dev.toString(),
      ino: sourceStats.ino.toString()
    });
    assert.equal(receipts[0].grant.revoked_at, null);

    const selectedPaths = projectSourceStatePaths(
      fixture.homePath,
      "project-acme-001",
      "campaign-assets"
    );
    const malformedGrant = JSON.parse(fs.readFileSync(selectedPaths.grant, "utf8"));
    fs.writeFileSync(selectedPaths.grant, `${JSON.stringify({
      ...malformedGrant,
      expires_at: "not-a-timestamp"
    })}\n`);
    instrumentedFilesystem.lstat = async (filePath, ...args) => {
      const observedPath = path.resolve(String(filePath));
      if (
        observedPath === path.resolve(fixture.sourceRoot)
        || observedPath.startsWith(`${path.resolve(fixture.sourceRoot)}${path.sep}`)
      ) {
        observations.push(`source-metadata:${observedPath}`);
        throw new Error("invalid consent must refuse before source observation");
      }
      return fsp.lstat(filePath, ...args);
    };
    const refused = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem: instrumentedFilesystem
    });
    assert.equal(refused.decision, "refused");
    assert.equal(refused.reason, "source-unavailable");
    assert.deepEqual(refused.references, []);
    assert.deepEqual(observations, []);
  } finally {
    fixture.cleanup();
  }
});

test("binding-first source publication exposes only its operation-owned recovery token", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const preview = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets"
    });
    const failingFilesystem = Object.create(fsp);
    failingFilesystem.link = async (source, destination) => {
      if (String(destination).endsWith(path.join("sources", "campaign-assets.md"))) {
        throw new Error("forced portable publication barrier");
      }
      return fsp.link(source, destination);
    };
    await assert.rejects(() => addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint,
      apply: true,
      filesystem: failingFilesystem
    }));

    const recovery = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets"
    });
    assert.equal(recovery.recovery, true);
    assert.equal(recovery.operation_id, preview.operation_id);
    assert.equal(recovery.plan_fingerprint, preview.plan_fingerprint);

    const applied = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: recovery.operation_id,
      planFingerprint: recovery.plan_fingerprint,
      apply: true
    });
    assert.equal(applied.applied, true);
    const replayed = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: recovery.operation_id,
      planFingerprint: recovery.plan_fingerprint,
      apply: true
    });
    assert.equal(replayed.applied, true);
    await assert.rejects(() => addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: recovery.operation_id,
      planFingerprint: "0".repeat(64),
      apply: true
    }));
  } finally {
    fixture.cleanup();
  }
});

test("independent source coordinates do not lose or observe sibling authority", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const stats = fs.lstatSync(fixture.sourceRoot, { bigint: true });
    const rootIdentity = {
      type: "directory",
      dev: stats.dev.toString(),
      ino: stats.ino.toString()
    };
    await Promise.all([
      publishBinding({
        homePath: fixture.homePath,
        projectId: "project-acme-001",
        sourceId: "campaign-assets",
        operationId: "a11",
        planFingerprint: "a".repeat(64),
        rootPath: fixture.sourceRoot,
        rootIdentity
      }),
      publishBinding({
        homePath: fixture.homePath,
        projectId: "project-other-002",
        sourceId: "private-assets",
        operationId: "b22",
        planFingerprint: "b".repeat(64),
        rootPath: fixture.sourceRoot,
        rootIdentity
      })
    ]);
    const [selected, sibling] = await Promise.all([
      readProjectSourceState({
        homePath: fixture.homePath,
        projectId: "project-acme-001",
        sourceId: "campaign-assets"
      }),
      readProjectSourceState({
        homePath: fixture.homePath,
        projectId: "project-other-002",
        sourceId: "private-assets"
      })
    ]);
    assert.equal(selected.binding.operation_id, "a11");
    assert.equal(sibling.binding.operation_id, "b22");
    assert.notEqual(selected.paths.binding, sibling.paths.binding);
  } finally {
    fixture.cleanup();
  }
});

test("exact source-add retry forward-completes after portable publication uncertainty", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const preview = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets"
    });
    const sourcesDirectory = path.join(fixture.aiosPath, "projects", "acme-campaign", "sources");
    const failingFilesystem = Object.create(fsp);
    failingFilesystem.open = async (filePath, flags, mode) => {
      const handle = await fsp.open(filePath, flags, mode);
      if (path.resolve(String(filePath)) === sourcesDirectory && flags === "r") {
        return Object.create(handle, {
          sync: { value: async () => { throw new Error("forced portable directory sync failure"); } }
        });
      }
      return handle;
    };
    await assert.rejects(() => addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint,
      apply: true,
      filesystem: failingFilesystem
    }));
    assert.equal(fs.existsSync(path.join(sourcesDirectory, "campaign-assets.md")), true);

    const completed = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint,
      apply: true
    });
    assert.equal(completed.applied, true);
    assert.equal(completed.recovery, true);
  } finally {
    fixture.cleanup();
  }
});

test("exact source-add retry succeeds after publication-marker sync uncertainty", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const preview = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets"
    });
    const bindingsDirectory = path.join(fixture.homePath, ".dotaios", "project-sources", "bindings");
    let bindingDirectorySyncs = 0;
    const failingFilesystem = Object.create(fsp);
    failingFilesystem.open = async (filePath, flags, mode) => {
      const handle = await fsp.open(filePath, flags, mode);
      if (path.resolve(String(filePath)) === bindingsDirectory && flags === "r") {
        bindingDirectorySyncs += 1;
        if (bindingDirectorySyncs === 2) {
          return Object.create(handle, {
            sync: { value: async () => { throw new Error("forced marker directory sync failure"); } }
          });
        }
      }
      return handle;
    };
    await assert.rejects(() => addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint,
      apply: true,
      filesystem: failingFilesystem
    }));

    const completed = await addProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      folder: fixture.sourceRoot,
      sourceId: "campaign-assets",
      label: "Campaign assets",
      purpose: "Launch campaign assets",
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint,
      apply: true
    });
    assert.equal(completed.applied, true);
    assert.equal(completed.recovery, true);
  } finally {
    fixture.cleanup();
  }
});
