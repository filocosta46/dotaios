import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  addProjectSource,
  bindProjectSource,
  connectProjectSource,
  grantProjectSource,
  revokeProjectSource,
  retrieveProjectSource,
  validateSourceId,
  validateTask
} from "../../packages/core/src/project-sources.mjs";
import {
  projectSourceStatePaths,
  publishBinding,
  publishGrant,
  readProjectSourceState,
  sourceStateLockPath
} from "../../packages/core/src/project-source-state.mjs";
import {
  CAMPAIGN_TASK,
  createProjectSourceRetrievalFixture,
  snapshotTree
} from "../fixtures/project-source-retrieval.mjs";
import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";

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

test("retrieval refuses a selector shared by a project slug and another stable id", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const neighborReadme = path.join(fixture.aiosPath, "projects", "other-client", "README.md");
    fs.writeFileSync(
      neighborReadme,
      fs.readFileSync(neighborReadme, "utf8").replace("id: project-other-002", "id: acme-campaign"),
    );

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "project-ambiguous");
    assert.deepEqual(result.references, []);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses and receipts a selected catalog identity outside the selector contract", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const selectedReadme = path.join(fixture.aiosPath, "projects", "acme-campaign", "README.md");
    fs.writeFileSync(
      selectedReadme,
      fs.readFileSync(selectedReadme, "utf8").replace(
        "id: project-acme-001",
        "id: \" project-acme-001 \"",
      ),
    );

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "project-catalog-invalid");
    assert.deepEqual(result.references, []);
    const receiptPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "refused");
    assert.equal(receipts[0].reason, "project-catalog-invalid");
    assert.equal(receipts[0].receipt_id, result.receipt_id);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses and receipts conflicting canonical and legacy project ids", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const selectedReadme = path.join(fixture.aiosPath, "projects", "acme-campaign", "README.md");
    fs.writeFileSync(
      selectedReadme,
      fs.readFileSync(selectedReadme, "utf8").replace(
        "id: project-acme-001",
        "id: project-acme-001\nproject_id: conflicting-id",
      ),
    );

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "project-catalog-invalid");
    assert.deepEqual(result.references, []);
    const receiptPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "refused");
    assert.equal(receipts[0].reason, "project-catalog-invalid");
    assert.equal(receipts[0].receipt_id, result.receipt_id);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses and receipts a present malformed canonical project id", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const selectedReadme = path.join(fixture.aiosPath, "projects", "acme-campaign", "README.md");
    fs.writeFileSync(
      selectedReadme,
      fs.readFileSync(selectedReadme, "utf8").replace(
        "id: project-acme-001",
        "id: 123\nproject_id: project-acme-001",
      ),
    );

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "project-catalog-invalid");
    assert.deepEqual(result.references, []);
    const receiptPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "refused");
    assert.equal(receipts[0].reason, "project-catalog-invalid");
    assert.equal(receipts[0].receipt_id, result.receipt_id);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses and receipts non-mapping selected project metadata", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const selectedReadme = path.join(fixture.aiosPath, "projects", "acme-campaign", "README.md");
    fs.writeFileSync(selectedReadme, "---\nnull\n---\n# Invalid metadata\n");

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "project-catalog-invalid");
    assert.deepEqual(result.references, []);
    const receiptPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "refused");
    assert.equal(receipts[0].reason, "project-catalog-invalid");
    assert.equal(receipts[0].receipt_id, result.receipt_id);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval receipts survive structurally unselectable neighbor identities", async (t) => {
  for (const kind of ["missing", "linked", "special", "oversized", "padded-id"]) {
    await t.test(kind, async () => {
      const fixture = createProjectSourceRetrievalFixture();
      try {
        await applyCampaignGrant(fixture);
        const neighborReadme = path.join(fixture.aiosPath, "projects", "other-client", "README.md");
        if (kind === "linked") {
          const outside = path.join(fixture.root, "outside-neighbor.md");
          fs.writeFileSync(outside, "---\nid: acme-campaign\nproject: other-client\n---\n");
          fs.rmSync(neighborReadme);
          fs.symlinkSync(outside, neighborReadme);
        } else if (kind === "missing") {
          fs.rmSync(neighborReadme);
        } else if (kind === "special") {
          fs.rmSync(neighborReadme);
          fs.mkdirSync(neighborReadme);
        } else if (kind === "padded-id") {
          fs.writeFileSync(
            neighborReadme,
            fs.readFileSync(neighborReadme, "utf8").replace(
              "id: project-other-002",
              "id: \" acme-campaign \"",
            ),
          );
        } else {
          fs.writeFileSync(neighborReadme, "x".repeat((1024 * 1024) + 1));
        }

        const result = await retrieveCampaignSource(fixture);

        assert.equal(result.decision, "allowed");
        assert.ok(result.references.length > 0);
        const receiptPath = path.join(
          fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
        );
        const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].decision, "allowed");
        assert.equal(receipts[0].receipt_id, result.receipt_id);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("retrieval refuses and receipts a readable collision replaced by a link", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const neighborReadme = path.join(fixture.aiosPath, "projects", "other-client", "README.md");
    const outside = path.join(fixture.root, "outside-neighbor.md");
    fs.writeFileSync(
      neighborReadme,
      "---\nid: acme-campaign\nproject: other-client\n---\n# Readable collision\n",
    );
    fs.writeFileSync(outside, "---\nid: unrelated\nproject: outside\n---\n");
    const replacement = replaceOnNeighborFrontmatter(
      createEvidenceReader({ roots: [fixture.aiosPath] }), neighborReadme, outside,
    );

    const result = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      evidenceReader: replacement.reader,
    });

    assert.equal(replacement.didReplace(), true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    const receiptPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "refused");
    assert.equal(receipts[0].reason, "source-changed");
    assert.equal(receipts[0].receipt_id, result.receipt_id);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses and receipts a missing identity replaced by a readable collision", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const neighborReadme = path.join(fixture.aiosPath, "projects", "other-client", "README.md");
    fs.rmSync(neighborReadme);
    const insertion = insertCollisionAfterMissingInspection(
      createEvidenceReader({ roots: [fixture.aiosPath] }), neighborReadme,
    );

    const result = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      evidenceReader: insertion.reader,
    });

    assert.equal(insertion.didInsert(), true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    const receiptPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].decision, "refused");
    assert.equal(receipts[0].reason, "source-changed");
    assert.equal(receipts[0].receipt_id, result.receipt_id);
  } finally {
    fixture.cleanup();
  }
});

test("core composes finite consent, metadata-only retrieval, provenance, and one receipt", assertCoreConsentSlice);

test("portable source declarations require the exact bounded metadata-only schema", async (t) => {
  const scenarios = [
    ["absolute root field", (declaration) => declaration.replace("type: local-folder", "type: local-folder\nroot: /private/client")],
    ["credentials field", (declaration) => declaration.replace("type: local-folder", "type: local-folder\ncredentials: secret")],
    ["grant field", (declaration) => declaration.replace("type: local-folder", "type: local-folder\ngrant: permanent")],
    ["document body", (declaration) => `${declaration}# Hidden authority\n`],
    ["malformed YAML", (declaration) => declaration.replace("label: \"Campaign assets\"", "label: [unterminated")],
    ["oversized declaration", (declaration) => declaration.replace("label: \"Campaign assets\"", `label: \"${"x".repeat(65 * 1024)}\"`)],
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, async () => {
      const fixture = createProjectSourceRetrievalFixture();
      try {
        await applyCampaignGrant(fixture);
        const declarationPath = path.join(
          fixture.aiosPath, "projects", "acme-campaign", "sources", "campaign-assets.md",
        );
        fs.writeFileSync(declarationPath, mutate(fs.readFileSync(declarationPath, "utf8")));
        const result = await retrieveCampaignSource(fixture);
        assert.equal(result.decision, "refused");
        assert.equal(result.reason, "source-declaration-invalid");
        assert.deepEqual(result.references, []);
      } finally {
        fixture.cleanup();
      }
    });
  }

  for (const kind of ["linked", "special"]) {
    await t.test(`${kind} Markdown declaration candidate`, async () => {
      const fixture = createProjectSourceRetrievalFixture();
      try {
        await applyCampaignGrant(fixture);
        const sourcesPath = path.join(fixture.aiosPath, "projects", "acme-campaign", "sources");
        const candidate = path.join(sourcesPath, "unsafe.md");
        if (kind === "linked") {
          const outside = path.join(fixture.root, "outside-source.md");
          fs.writeFileSync(outside, projectSourceDeclaration("unsafe"));
          fs.symlinkSync(outside, candidate);
        } else {
          fs.mkdirSync(candidate);
        }
        const result = await retrieveCampaignSource(fixture);
        assert.equal(result.decision, "refused");
        assert.equal(result.reason, "source-declaration-invalid");
        assert.deepEqual(result.references, []);
      } finally {
        fixture.cleanup();
      }
    });
  }

  await t.test("declaration 33", async () => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      await applyCampaignGrant(fixture);
      const sourcesPath = path.join(fixture.aiosPath, "projects", "acme-campaign", "sources");
      for (let index = 0; index < 32; index += 1) {
        const sourceId = `archive-${index}`;
        fs.writeFileSync(
          path.join(sourcesPath, `${sourceId}.md`),
          projectSourceDeclaration(sourceId)
            .replace("label: Campaign assets", `label: Archive ${index}`)
            .replace("purpose: Launch campaign assets", `purpose: Historical material ${index}`),
        );
      }
      const result = await retrieveCampaignSource(fixture);
      assert.equal(result.decision, "refused");
      assert.equal(result.reason, "source-declaration-bound-exceeded");
      assert.deepEqual(result.references, []);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("declaration discovery observes the approved bound", async () => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      await applyCampaignGrant(fixture);
      const reader = createEvidenceReader({ roots: [fixture.aiosPath] });
      let observedBound = null;
      const instrumentedReader = {
        ...reader,
        listDirectory: async (root, directoryPath, options) => {
          if (directoryPath.endsWith(path.join("acme-campaign", "sources"))) {
            observedBound = options?.maxEntries;
          }
          return reader.listDirectory(root, directoryPath, options);
        },
      };
      const result = await retrieveProjectSource({
        aiosPath: fixture.aiosPath,
        homePath: fixture.homePath,
        projectSelector: "acme-campaign",
        task: CAMPAIGN_TASK,
        evidenceReader: instrumentedReader,
      });
      assert.equal(result.decision, "allowed");
      assert.equal(observedBound, 32);
    } finally {
      fixture.cleanup();
    }
  });
});

test("machine-local project-source state cannot overlap the portable AIOS", async (t) => {
  for (const relation of ["equal", "inside", "containing"]) {
    await t.test(relation, async () => {
      const fixture = createStateOverlapFixture(relation);
      try {
        const before = snapshotTree(fixture.root);
        await assert.rejects(
          () => addProjectSource(campaignAddOptions(fixture)),
          (error) => error?.details?.reason === "state-root-overlap",
        );
        assert.deepEqual(snapshotTree(fixture.root), before);
      } finally {
        fixture.cleanup();
      }
    });
  }

  await t.test("normal sibling layout", async () => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      const preview = await addProjectSource(campaignAddOptions(fixture));
      assert.equal(preview.applied, false);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("symlink alias", async () => {
    const fixture = createSymlinkStateOverlapFixture();
    try {
      const before = snapshotTree(fixture.root);
      await assert.rejects(
        () => addProjectSource(campaignAddOptions(fixture)),
        (error) => error?.details?.reason === "state-root-overlap",
      );
      assert.deepEqual(snapshotTree(fixture.root), before);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("source root through a symlinked home alias", async () => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      const aliasHome = path.join(fixture.root, "home-alias");
      fs.symlinkSync(fixture.homePath, aliasHome, "dir");
      const stateRoot = path.join(fixture.homePath, ".dotaios", "project-sources");
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      await assert.rejects(
        () => addProjectSource({
          ...campaignAddOptions(fixture),
          homePath: aliasHome,
          folder: stateRoot,
        }),
        (error) => error?.details?.reason === "root-overlap",
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test("project-source state accepts an existing same-user DotAIOS parent", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const sharedParent = path.join(fixture.homePath, ".dotaios");
    fs.mkdirSync(sharedParent, { recursive: true, mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(sharedParent, 0o755);
    const preview = await previewCampaignSourceAdd(fixture);
    const applied = await applyCampaignSourceAdd(fixture, preview);
    assert.equal(applied.applied, true);
    assert.equal(fs.statSync(sharedParent).mode & 0o777, process.platform === "win32" ? fs.statSync(sharedParent).mode & 0o777 : 0o755);
    assert.equal(fs.statSync(projectSourceStatePaths(fixture.homePath).root).mode & 0o777, process.platform === "win32" ? fs.statSync(projectSourceStatePaths(fixture.homePath).root).mode & 0o777 : 0o700);
  } finally {
    fixture.cleanup();
  }
});

test("project-source state refuses a linked DotAIOS parent", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const sharedParent = path.join(fixture.homePath, ".dotaios");
    const outside = path.join(fixture.root, "outside-local-state");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, sharedParent, "dir");
    await assert.rejects(
      () => previewCampaignSourceAdd(fixture),
      { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" },
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fixture.cleanup();
  }
});

test("source add refuses a linked portable sources directory", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const projectPath = path.join(fixture.aiosPath, "projects", "acme-campaign");
    const sourcesPath = path.join(projectPath, "sources");
    const outside = path.join(fixture.root, "outside-portable-sources");
    fs.mkdirSync(outside);
    fs.mkdirSync(projectPath, { recursive: true });
    fs.symlinkSync(outside, sourcesPath, "dir");
    const preview = await previewCampaignSourceAdd(fixture);
    await assert.rejects(
      () => applyCampaignSourceAdd(fixture, preview),
      (error) => error?.details?.reason === "stale-plan",
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fixture.cleanup();
  }
});

async function assertCoreConsentSlice() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await prepareCoreCampaignGrant(fixture);
    const sourceStats = fs.lstatSync(fixture.sourceRoot, { bigint: true });
    const otherPaths = await seedOtherProjectAuthority(fixture, sourceStats);
    const instrumentation = metadataOnlyFilesystem(fixture, otherPaths);
    const result = await retrieveCampaignSourceWithFilesystem(fixture, instrumentation.filesystem);
    assert.equal(result.decision, "allowed");
    assert.deepEqual(instrumentation.observations(), []);
    assert.deepEqual(result.references.map((reference) => reference.path), fixture.expectedPaths);
    assertCoreAllowedReceipt(fixture, sourceStats);
    await assertMalformedConsentRefusal(fixture, instrumentation);
  } finally {
    fixture.cleanup();
  }
}

async function prepareCoreCampaignGrant(fixture) {
  const portableBefore = snapshotTree(fixture.aiosPath);
  const addPreview = await addProjectSource({ ...campaignAddOptions(fixture) });
  assert.equal(addPreview.applied, false);
  assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
  await addProjectSource({
    ...campaignAddOptions(fixture), operationId: addPreview.operation_id,
    planFingerprint: addPreview.plan_fingerprint, apply: true
  });
  const grantOptions = {
    aiosPath: fixture.aiosPath, homePath: fixture.homePath, projectSelector: "project-acme-001",
    sourceId: "campaign-assets", purpose: "Launch campaign assets",
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
  const preview = await grantProjectSource(grantOptions);
  const applied = await grantProjectSource({
    ...grantOptions, operationId: preview.operation_id, planFingerprint: preview.plan_fingerprint, apply: true
  });
  assert.equal(preview.scope, "read");
  assert.equal(preview.approved_at, null);
  assert.equal(applied.scope, "read");
  assert.match(applied.approved_at, /^\d{4}-\d{2}-\d{2}T/);
}

function campaignAddOptions(fixture) {
  return {
    aiosPath: fixture.aiosPath, homePath: fixture.homePath, projectSelector: "acme-campaign",
    folder: fixture.sourceRoot, sourceId: "campaign-assets", label: "Campaign assets",
    purpose: "Launch campaign assets"
  };
}

function campaignSourceOptions(fixture) {
  return {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    sourceId: "campaign-assets",
  };
}

function campaignGrantOptions(fixture) {
  return {
    ...campaignSourceOptions(fixture),
    purpose: "Launch campaign assets",
  };
}

async function seedOtherProjectAuthority(fixture, sourceStats) {
  const binding = await publishBinding({
    homePath: fixture.homePath, projectId: "project-other-002", sourceId: "campaign-assets",
    operationId: "a11-b1d", planFingerprint: "a".repeat(64), rootPath: fixture.sourceRoot,
    rootIdentity: { type: "directory", dev: sourceStats.dev.toString(), ino: sourceStats.ino.toString() }
  });
  await publishGrant({
    homePath: fixture.homePath, projectId: "project-other-002", sourceId: "campaign-assets",
    operationId: "a11-a12", planFingerprint: "b".repeat(64), grantId: "a11-a12",
    purpose: "Private launch campaign assets", expiresAt: "2099-01-01T00:00:00.000Z",
    approvedAt: "2098-01-01T00:00:00.000Z", binding, sourceRevision: 1
  });
  return projectSourceStatePaths(fixture.homePath, "project-other-002", "campaign-assets");
}

function metadataOnlyFilesystem(fixture, otherPaths) {
  let observed = [];
  const record = (value) => { observed = [...observed, value]; };
  const filesystem = Object.create(fsp);
  filesystem.readFile = async (filePath, ...args) => {
    const candidate = path.resolve(String(filePath));
    if ([otherPaths.binding, otherPaths.grant].includes(candidate)) {
      record(`other-state:${candidate}`);
      throw new Error("other-project state must not be read");
    }
    if (candidate.startsWith(`${path.resolve(fixture.sourceRoot)}${path.sep}`)) {
      record(`source-content:${candidate}`);
      throw new Error("source content must not be read");
    }
    return fsp.readFile(filePath, ...args);
  };
  filesystem.open = async (filePath, ...args) => {
    const candidate = path.resolve(String(filePath));
    const other = path.join(fixture.aiosPath, "projects", "other-client", "sources", "campaign-assets.md");
    if (candidate === other) {
      record(`other-source:${candidate}`);
      throw new Error("other-project source must not be opened");
    }
    if (candidate.startsWith(`${path.resolve(fixture.sourceRoot)}${path.sep}`)) {
      record(`source-content:${candidate}`);
      throw new Error("source content must not be opened");
    }
    return fsp.open(filePath, ...args);
  };
  return Object.freeze({ filesystem, observations: () => observed });
}

function assertCoreAllowedReceipt(fixture, sourceStats) {
  const receiptPath = path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].grant.root_identity, {
    type: "directory", dev: sourceStats.dev.toString(), ino: sourceStats.ino.toString()
  });
  assert.equal(receipts[0].grant.revoked_at, null);
}

async function assertMalformedConsentRefusal(fixture, instrumentation) {
  const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
  const grant = JSON.parse(fs.readFileSync(paths.grant, "utf8"));
  writeJsonRecord(paths.grant, { ...grant, expires_at: "not-a-timestamp" });
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  instrumentation.filesystem.lstat = async (filePath, ...args) => {
    const candidate = path.resolve(String(filePath));
    if (candidate === canonicalRoot || candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error("invalid consent must refuse before source observation");
    }
    return fsp.lstat(filePath, ...args);
  };
  const refused = await retrieveCampaignSourceWithFilesystem(fixture, instrumentation.filesystem);
  assert.equal(refused.decision, "refused");
  assert.equal(refused.reason, "authorization-state-invalid");
  assert.deepEqual(refused.references, []);
  assert.deepEqual(instrumentation.observations(), []);
}

test(
  "authorization refusals are distinct, receipted, and stop before the external root",
  assertAuthorizationRefusalMatrix,
);

async function assertAuthorizationRefusalMatrix() {
  const scenarios = [
    ...missingAuthorizationScenarios(),
    ...mismatchedAuthorizationScenarios(),
    ...revisionAuthorizationScenarios(),
  ];
  for (const scenario of scenarios) await testAuthorizationRefusal(scenario);
}

function missingAuthorizationScenarios() {
  return [
    {
      name: "missing binding",
      reason: "binding-missing",
      mutate({ paths }) { fs.rmSync(paths.binding); },
    },
    {
      name: "missing grant",
      reason: "grant-missing",
      mutate({ paths }) { fs.rmSync(paths.grant); },
      expectsGrant: false,
    },
    {
      name: "missing scope",
      reason: "authorization-state-invalid",
      mutate({ grant, paths }) {
        const { scope: _scope, ...incompleteGrant } = grant;
        writeJsonRecord(paths.grant, incompleteGrant);
      },
      grantKeys: ["grant_id", "revision"],
    },
    {
      name: "missing purpose",
      reason: "authorization-state-invalid",
      mutate({ grant, paths }) {
        const { purpose: _purpose, ...incompleteGrant } = grant;
        writeJsonRecord(paths.grant, incompleteGrant);
      },
      grantKeys: ["grant_id", "revision"],
    },
    {
      name: "missing duration",
      reason: "authorization-state-invalid",
      mutate({ grant, paths }) {
        const { expires_at: _expiresAt, ...incompleteGrant } = grant;
        writeJsonRecord(paths.grant, incompleteGrant);
      },
      grantKeys: ["grant_id", "revision"],
    },
  ];
}

function mismatchedAuthorizationScenarios() {
  return [
    {
      name: "mismatched purpose",
      reason: "purpose-mismatch",
      mutate({ grant, paths }) { writeJsonRecord(paths.grant, { ...grant, purpose: "Another exact purpose" }); },
    },
    {
      name: "expired grant",
      reason: "grant-expired",
      mutate({ grant, paths }) { writeJsonRecord(paths.grant, { ...grant, expires_at: "2020-01-01T00:00:00.000Z" }); },
    },
    {
      name: "wrong operation scope",
      reason: "grant-scope-mismatch",
      mutate({ grant, paths }) { writeJsonRecord(paths.grant, { ...grant, scope: "write" }); },
    },
    {
      name: "wrong project scope",
      reason: "grant-scope-mismatch",
      mutate({ grant, paths }) {
        writeJsonRecord(paths.grant, {
          ...grant,
          project_id: "project-other-002",
          grant_id: "f0a1-bad",
          purpose: "WRONG_SCOPE_PRIVATE_PURPOSE",
        });
      },
      expectsGrant: false,
    },
    {
      name: "wrong source scope",
      reason: "grant-scope-mismatch",
      mutate({ grant, paths }) { writeJsonRecord(paths.grant, { ...grant, source_id: "private-assets" }); },
      expectsGrant: false,
    },
  ];
}

function revisionAuthorizationScenarios() {
  return [
    {
      name: "stale source revision",
      reason: "source-revision-mismatch",
      mutate({ grant, paths }) { writeJsonRecord(paths.grant, { ...grant, source_revision: grant.source_revision + 1 }); },
    },
    {
      name: "stale binding generation",
      reason: "binding-revision-mismatch",
      mutate({ grant, paths }) {
        writeJsonRecord(paths.grant, { ...grant, binding_generation: grant.binding_generation + 1 });
      },
    },
    {
      name: "portable purpose drift",
      reason: "purpose-mismatch",
      mutate({ fixture }) {
        const declarationPath = path.join(
          fixture.aiosPath,
          "projects",
          "acme-campaign",
          "sources",
          "campaign-assets.md",
        );
        const declaration = fs.readFileSync(declarationPath, "utf8")
          .replace('purpose: "Launch campaign assets"', 'purpose: "Campaign assets for a different launch"')
          .replace("revision: 1", "revision: 2");
        fs.writeFileSync(declarationPath, declaration);
      },
    },
  ];
}

test("grant and revoke mutations refuse a foreign-coordinate record without rewriting it", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { applied, grant } = await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const foreign = `${JSON.stringify({
      ...grant,
      project_id: "project-other-002",
      grant_id: "f0a1-bad",
      purpose: "WRONG_SCOPE_PRIVATE_PURPOSE",
    })}\n`;
    fs.writeFileSync(paths.grant, foreign);
    await assert.rejects(() => grantProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      purpose: "Launch campaign assets",
      expiresAt: "2099-06-01T00:00:00.000Z",
    }), { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" });
    await assert.rejects(() => revokeProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      grantId: applied.grant_id,
    }), { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" });
    assert.equal(fs.readFileSync(paths.grant, "utf8"), foreign);
  } finally {
    fixture.cleanup();
  }
});

test(
  "project and source resolution refusals keep distinct receipts with known fields only",
  assertProjectSourceResolutionRefusals,
);

async function assertProjectSourceResolutionRefusals() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    let attempts = await unresolvedProjectSourceAttempts(fixture);
    seedAmbiguousProjectSources(fixture);
    attempts = [...attempts, await retrieveCampaignSource(fixture)];
    seedDuplicateProject(fixture);
    attempts = [...attempts, await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "project-acme-001",
      task: CAMPAIGN_TASK,
    })];
    assertResolutionRefusalReceipts(fixture, attempts);
  } finally {
    fixture.cleanup();
  }
}

async function unresolvedProjectSourceAttempts(fixture) {
  const base = { aiosPath: fixture.aiosPath, homePath: fixture.homePath, task: CAMPAIGN_TASK };
  const projectRequired = await retrieveProjectSource(base);
  const projectUnknown = await retrieveProjectSource({ ...base, projectSelector: "missing-client" });
  const sourceNoMatch = await retrieveProjectSource({ ...base, projectSelector: "acme-campaign" });
  return [projectRequired, projectUnknown, sourceNoMatch];
}

function seedAmbiguousProjectSources(fixture) {
  const sourcesPath = path.join(fixture.aiosPath, "projects", "acme-campaign", "sources");
  fs.mkdirSync(sourcesPath, { recursive: true });
  for (const sourceId of ["campaign-assets", "launch-assets"]) {
    fs.writeFileSync(path.join(sourcesPath, `${sourceId}.md`), projectSourceDeclaration(sourceId));
  }
}

function seedDuplicateProject(fixture) {
  const duplicatePath = path.join(fixture.aiosPath, "projects", "duplicate-client");
  fs.mkdirSync(duplicatePath, { recursive: true });
  fs.writeFileSync(
    path.join(duplicatePath, "README.md"),
    "---\nid: project-acme-001\nproject: duplicate-client\nstatus: active\n---\n",
  );
}

function assertResolutionRefusalReceipts(fixture, attempts) {
  assert.deepEqual(attempts.map((attempt) => attempt.reason), [
    "project-required", "project-unknown", "source-no-match", "source-ambiguous", "project-ambiguous",
  ]);
  const receiptPath = path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(receipts.map((receipt) => receipt.reason), attempts.map((attempt) => attempt.reason));
  assert.equal(receipts.every((receipt) => receipt.task === CAMPAIGN_TASK), true);
  assert.equal(Object.hasOwn(receipts[0], "project_id"), false);
  assert.equal(Object.hasOwn(receipts[1], "project_id"), false);
  assert.equal(receipts[2].project_id, "project-acme-001");
  assert.equal(receipts[3].project_id, "project-acme-001");
  assert.equal(Object.hasOwn(receipts[4], "project_id"), false);
  assert.equal(receipts.every((receipt) => !Object.hasOwn(receipt, "grant")), true);
}

test("unknown future authorization state refuses without opening the source or rewriting state", async (t) => {
  await t.test("binding", () => assertUnknownFutureAuthorizationState("binding"));
  await t.test("grant", () => assertUnknownFutureAuthorizationState("grant"));
});

test("grant publication sync uncertainty poisons retrieval until exact retry forward-completes", async () => {
  await assertGrantPublicationRecovery("grant");
});

test("revoke publication sync uncertainty poisons retrieval until exact retry forward-completes", async () => {
  await assertGrantPublicationRecovery("revoke");
});

test("grant guard clear uncertainty re-poisons before releasing source authority", async (t) => {
  await t.test("guard republish succeeds", () => assertGrantClearFailure(false));
  await t.test("guard republish failure retains the source lock", () => assertGrantClearFailure(true));
});

test("exact grant retry refuses a foreign live record without reconstructing or rewriting it", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { preview, paths, apply } = await prepareGrantMutation(fixture, "grant");
    await assert.rejects(() => apply(failDirectorySyncAfterRecordOperation(
      paths.grants,
      paths.grant,
      preview.operation_id,
    )));
    const live = JSON.parse(fs.readFileSync(paths.grant, "utf8"));
    const foreignBytes = `${JSON.stringify({ ...live, project_id: "project-other-002" })}\n`;
    fs.writeFileSync(paths.grant, foreignBytes);
    await assert.rejects(() => apply(), { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" });
    assert.equal(fs.readFileSync(paths.grant, "utf8"), foreignBytes);
    assert.equal(fs.existsSync(paths.grantGuard), true);
  } finally {
    fixture.cleanup();
  }
});

test("corrupted revoke recovery guards refuse without publishing or rewriting state", async (t) => {
  await t.test("missing revocation transition", () => assertCorruptRevokeGuard("revoked_at"));
  await t.test("changed immutable field", () => assertCorruptRevokeGuard("purpose"));
  await t.test("changed grant approval timestamp", assertCorruptGrantApprovalGuard);
});

test("owned binding and grant records refuse linked, special, wrong-owner, and permissive state", async (t) => {
  for (const kind of ["binding", "grant"]) {
    for (const mutation of ["linked", "symlinked", "special", "wrong-owner", "permissive"]) {
      await t.test(`${kind} ${mutation}`, () => assertUnsafeAuthorizationRecord(kind, mutation));
    }
  }
});

test("unsafe owned authorization path components refuse without permission repair", async (t) => {
  for (const scenario of ["permissive-grants", "linked-grants", "special-grants", "wrong-owner-grants"]) {
    await t.test(scenario, () => assertUnsafeAuthorizationDirectory(scenario));
  }
  await t.test("permissive lock directory", assertUnsafeSourceLockDirectory);
});

test("source lock ownership survives replacement and reclaims PID reuse safely", async (t) => {
  await t.test("exact-owner release preserves a replacement lock", assertReplacedSourceLockRelease);
  await t.test("post-poison exact-owner release preserves a replacement lock", assertPostPoisonSourceLockReplacement);
  await t.test("release parent-sync failure restores a poisoned canonical lock", assertSourceLockReleaseSyncPoison);
  await t.test("PID reuse does not preserve stale authority", assertSourceLockPidReuse);
  await t.test("unknown lock fields refuse without rewrite", assertUnknownSourceLockField);
});

test("revocation during enumeration refuses the in-flight operation before references escape", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const canonicalSourceRoot = fs.realpathSync(fixture.sourceRoot);
    let revoked = false;
    const filesystem = Object.create(fsp);
    Object.defineProperty(filesystem, "opendir", {
      value: async (directoryPath, ...args) => {
        const directory = await fsp.opendir(directoryPath, ...args);
        if (!revoked && path.resolve(String(directoryPath)) === canonicalSourceRoot) {
          revoked = true;
          const grant = JSON.parse(fs.readFileSync(paths.grant, "utf8"));
          writeJsonRecord(paths.grant, {
            ...grant,
            revision: grant.revision + 1,
            operation_id: "a11-dead",
            plan_fingerprint: "c".repeat(64),
            revoked_at: "2026-08-10T12:00:00.000Z",
          });
        }
        return directory;
      },
    });

    const result = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem,
    });

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "authorization-changed");
    assert.deepEqual(result.references, []);
    assert.equal(revoked, true);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval snapshots authorization under the source lock before inspecting the external root", async () => {
  await assertAuthorizationSnapshotRace();
});

test("grant update and revocation serialize without lost state or stale resurrection", async (t) => {
  await t.test("concurrent writers admit one exact revision", assertConcurrentGrantWriters);
  await t.test("stale exact grant retry cannot resurrect a revocation", assertStaleGrantCannotResurrect);
});

async function assertConcurrentGrantWriters() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { applied } = await applyCampaignGrant(fixture);
    const plans = await concurrentGrantPlans(fixture, applied.grant_id);
    const outcomes = await applyConcurrentGrantPlans(fixture, applied.grant_id, plans);
    assertConcurrentGrantOutcomes(fixture, applied.grant_id, plans.update, outcomes);
  } finally {
    fixture.cleanup();
  }
}

async function concurrentGrantPlans(fixture, grantId) {
  const update = await grantProjectSource({
    ...campaignGrantOptions(fixture),
    expiresAt: "2099-06-01T00:00:00.000Z",
  });
  const revoke = await revokeProjectSource({
    ...campaignSourceOptions(fixture),
    grantId,
  });
  return Object.freeze({ update, revoke });
}

async function applyConcurrentGrantPlans(fixture, grantId, plans) {
  return Promise.allSettled([
    grantProjectSource({
      ...campaignGrantOptions(fixture),
      expiresAt: "2099-06-01T00:00:00.000Z",
      operationId: plans.update.operation_id,
      planFingerprint: plans.update.plan_fingerprint,
      apply: true,
    }),
    revokeProjectSource({
      ...campaignSourceOptions(fixture),
      grantId,
      operationId: plans.revoke.operation_id,
      planFingerprint: plans.revoke.plan_fingerprint,
      apply: true,
    }),
  ]);
}

function assertConcurrentGrantOutcomes(fixture, originalGrantId, updatePlan, outcomes) {
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(["source-busy", "stale-plan"].includes(rejected.reason?.details?.reason));
  const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
  const grant = JSON.parse(fs.readFileSync(paths.grant, "utf8"));
  assert.equal(grant.revision, 2);
  assert.equal(
    (grant.grant_id === updatePlan.operation_id && grant.revoked_at === null)
    || (grant.grant_id === originalGrantId && typeof grant.revoked_at === "string"),
    true,
  );
}

async function assertStaleGrantCannotResurrect() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { applied: original } = await applyCampaignGrant(fixture);
    const staleGrant = await grantProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      purpose: "Launch campaign assets",
      expiresAt: "2099-06-01T00:00:00.000Z",
    });
    const revoke = await revokeProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      grantId: original.grant_id,
    });
    await revokeProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      grantId: original.grant_id,
      operationId: revoke.operation_id,
      planFingerprint: revoke.plan_fingerprint,
      apply: true,
    });
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const revokedBytes = fs.readFileSync(paths.grant, "utf8");
    await assert.rejects(() => grantProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      purpose: "Launch campaign assets",
      expiresAt: "2099-06-01T00:00:00.000Z",
      operationId: staleGrant.operation_id,
      planFingerprint: staleGrant.plan_fingerprint,
      apply: true,
    }), (error) => error?.details?.reason === "stale-plan");
    assert.equal(fs.readFileSync(paths.grant, "utf8"), revokedBytes);
  } finally {
    fixture.cleanup();
  }
}

test("refused receipt publication failure stays fail-closed and path-free", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    fs.rmSync(paths.grant);
    const canonicalSourceRoot = fs.realpathSync(fixture.sourceRoot);
    const filesystem = Object.create(fsp);
    Object.defineProperties(filesystem, {
      lstat: {
        value: async (filePath, ...args) => {
          if (path.resolve(String(filePath)) === canonicalSourceRoot) {
            throw new Error("refusal reached the external root");
          }
          return fsp.lstat(filePath, ...args);
        },
      },
      open: {
        value: async (filePath, flags, ...args) => {
          if (String(filePath).endsWith("access-receipts.jsonl") && flags === "a") {
            throw new Error(`forced receipt failure at ${filePath}`);
          }
          return fsp.open(filePath, flags, ...args);
        },
      },
    });

    await assert.rejects(
      () => retrieveProjectSource({
        aiosPath: fixture.aiosPath,
        homePath: fixture.homePath,
        projectSelector: "acme-campaign",
        task: CAMPAIGN_TASK,
        filesystem,
      }),
      (error) => (
        error?.code === "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED"
        && !error.message.includes(fixture.root)
        && !error.message.includes(paths.root)
      ),
    );
    assert.equal(fs.existsSync(path.join(paths.root, "access-receipts.inflight.json")), true);
  } finally {
    fixture.cleanup();
  }
});

test(
  "binding-first source publication exposes only its operation-owned recovery token",
  assertBindingFirstRecoveryToken,
);

async function assertBindingFirstRecoveryToken() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const preview = await previewCampaignSourceAdd(fixture);
    await assert.rejects(() => applyCampaignSourceAdd(
      fixture,
      preview,
      { filesystem: portablePublicationFailureFilesystem() },
    ));
    const recovery = await previewCampaignSourceAdd(fixture);
    assert.equal(recovery.recovery, true);
    assert.equal(recovery.operation_id, preview.operation_id);
    assert.equal(recovery.plan_fingerprint, preview.plan_fingerprint);
    const applied = await applyCampaignSourceAdd(fixture, recovery);
    assert.equal(applied.applied, true);
    const replayed = await applyCampaignSourceAdd(fixture, recovery);
    assert.equal(replayed.applied, true);
    const stalePlan = { ...recovery, plan_fingerprint: "0".repeat(64) };
    await assert.rejects(() => applyCampaignSourceAdd(fixture, stalePlan));
  } finally {
    fixture.cleanup();
  }
}

function portablePublicationFailureFilesystem() {
  const filesystem = Object.create(fsp);
  filesystem.link = async (source, destination) => {
    if (String(destination).endsWith(path.join("sources", "campaign-assets.md"))) {
      throw new Error("forced portable publication barrier");
    }
    return fsp.link(source, destination);
  };
  return filesystem;
}

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

test("sixteen concurrent retrieval decisions each publish one durable receipt", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => retrieveCampaignSource(fixture)),
    );
    assert.ok(results.every((result) => ["allowed", "refused"].includes(result.decision)));
    const ledgerPath = path.join(
      fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl",
    );
    const receipts = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, results.length);
    assert.equal(new Set(receipts.map((receipt) => receipt.receipt_id)).size, results.length);
    assert.deepEqual(
      receipts.map((receipt) => receipt.receipt_id).toSorted(),
      results.map((result) => result.receipt_id).toSorted(),
    );
  } finally {
    fixture.cleanup();
  }
});

test(
  "exact source-add retry forward-completes after portable publication uncertainty",
  assertPortablePublicationRecovery,
);

async function assertPortablePublicationRecovery() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const preview = await previewCampaignSourceAdd(fixture);
    const sourcesDirectory = path.join(fixture.aiosPath, "projects", "acme-campaign", "sources");
    const filesystem = directorySyncFailureFilesystem(
      sourcesDirectory, 1, "forced portable directory sync failure",
    );
    await assert.rejects(() => applyCampaignSourceAdd(fixture, preview, { filesystem }));
    assert.equal(fs.existsSync(path.join(sourcesDirectory, "campaign-assets.md")), true);
    const completed = await applyCampaignSourceAdd(fixture, preview);
    assert.equal(completed.applied, true);
    assert.equal(completed.recovery, true);
  } finally {
    fixture.cleanup();
  }
}

test(
  "exact source-add retry succeeds after publication-marker sync uncertainty",
  assertPublicationMarkerRecovery,
);

test("guided connect exact retry resumes an interrupted publication marker", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const options = {
      ...campaignAddOptions(fixture),
      expiresAt: "2099-01-01T00:00:00.000Z",
      yes: true,
    };
    const bindingPath = projectSourceStatePaths(
      fixture.homePath, "project-acme-001", "campaign-assets",
    ).binding;
    let bindingRenames = 0;
    const filesystem = Object.create(fsp);
    filesystem.rename = async (source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(bindingPath)) {
        bindingRenames += 1;
        if (bindingRenames === 2) throw new Error("forced marker rename failure");
      }
      return fsp.rename(source, destination);
    };

    await assert.rejects(() => connectProjectSource({ ...options, filesystem }));
    assert.equal(fs.existsSync(path.join(
      fixture.aiosPath, "projects", "acme-campaign", "sources", "campaign-assets.md",
    )), true);
    assert.equal(JSON.parse(fs.readFileSync(bindingPath, "utf8")).portable_published, false);
    const completed = await connectProjectSource(options);

    assert.equal(completed.applied, true);
    assert.equal(completed.idempotent, false);
    assert.match(completed.grant_id, /^[a-f0-9-]+$/);
  } finally {
    fixture.cleanup();
  }
});

test("guided connect never grants a concurrent rebind to another folder", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const otherRoot = path.join(fixture.root, "rebound-assets");
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, "wrong-root.txt"), "WRONG_ROOT_CANARY");
    const declarationPath = path.join(
      fixture.aiosPath, "projects", "acme-campaign", "sources", "campaign-assets.md",
    );
    let declarationOpens = 0;
    let rebound = false;
    const filesystem = Object.create(fsp);
    filesystem.open = async (filePath, ...args) => {
      if (path.resolve(String(filePath)) === path.resolve(declarationPath)) {
        declarationOpens += 1;
        if (declarationOpens === 3) {
          const bindOptions = {
            ...campaignSourceOptions(fixture),
            folder: otherRoot,
          };
          const preview = await bindProjectSource(bindOptions);
          await bindProjectSource({
            ...bindOptions,
            operationId: preview.operation_id,
            planFingerprint: preview.plan_fingerprint,
            apply: true,
          });
          rebound = true;
        }
      }
      return fsp.open(filePath, ...args);
    };

    await assert.rejects(
      () => connectProjectSource({
        ...campaignAddOptions(fixture),
        expiresAt: "2099-01-01T00:00:00.000Z",
        yes: true,
        filesystem,
      }),
      (error) => error?.details?.reason === "connection-mismatch",
    );
    assert.equal(rebound, true);

    const retrieval = await retrieveCampaignSource(fixture);
    assert.equal(retrieval.decision, "refused");
    assert.deepEqual(retrieval.references, []);
    assert.doesNotMatch(JSON.stringify(retrieval), /WRONG_ROOT_CANARY/);
  } finally {
    fixture.cleanup();
  }
});

async function assertPublicationMarkerRecovery() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const preview = await previewCampaignSourceAdd(fixture);
    const bindingsDirectory = path.join(fixture.homePath, ".dotaios", "project-sources", "bindings");
    const filesystem = directorySyncFailureFilesystem(
      bindingsDirectory, 2, "forced marker directory sync failure",
    );
    await assert.rejects(() => applyCampaignSourceAdd(fixture, preview, { filesystem }));
    const completed = await applyCampaignSourceAdd(fixture, preview);
    assert.equal(completed.applied, true);
    assert.equal(completed.recovery, true);
  } finally {
    fixture.cleanup();
  }
}

function previewCampaignSourceAdd(fixture) {
  return addProjectSource(campaignAddOptions(fixture));
}

function applyCampaignSourceAdd(fixture, plan, overrides = {}) {
  return addProjectSource({
    ...campaignAddOptions(fixture),
    operationId: plan.operation_id,
    planFingerprint: plan.plan_fingerprint,
    apply: true,
    ...overrides,
  });
}

function directorySyncFailureFilesystem(targetDirectory, occurrence, message) {
  let directorySyncs = 0;
  const filesystem = Object.create(fsp);
  filesystem.open = async (filePath, flags, mode) => {
    const handle = await fsp.open(filePath, flags, mode);
    if (path.resolve(String(filePath)) !== path.resolve(targetDirectory) || flags !== "r") return handle;
    directorySyncs += 1;
    if (directorySyncs !== occurrence) return handle;
    return Object.create(handle, {
      sync: { value: async () => { throw new Error(message); } },
    });
  };
  return filesystem;
}

async function testAuthorizationRefusal({ name, reason, mutate, expectsGrant = true, grantKeys = null }) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { grant } = await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const canonicalSourceRoot = fs.realpathSync(fixture.sourceRoot);
    await mutate({ fixture, grant, paths });
    let observations = [];
    const filesystem = Object.create(fsp);
    filesystem.lstat = async (filePath, ...args) => {
      if (path.resolve(String(filePath)) === canonicalSourceRoot) {
        observations = [...observations, String(filePath)];
        throw new Error(`${name} reached the external root`);
      }
      return fsp.lstat(filePath, ...args);
    };

    const result = await retrieveProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      task: CAMPAIGN_TASK,
      filesystem,
    });

    assert.equal(result.decision, "refused", name);
    assert.equal(result.reason, reason, name);
    assert.deepEqual(result.references, [], name);
    assert.deepEqual(observations, [], name);
    const receiptPath = path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
    const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(receipts.length, 1, name);
    assert.equal(receipts[0].reason, reason, name);
    assert.equal(receipts[0].task, CAMPAIGN_TASK, name);
    assert.equal(Object.hasOwn(receipts[0], "grant"), expectsGrant, name);
    if (grantKeys) assert.deepEqual(Object.keys(receipts[0].grant).sort(), grantKeys.toSorted(), name);
    assert.deepEqual(receipts[0].references, [], name);
    const serialized = JSON.stringify({ result, receipts });
    assert.equal(serialized.includes(fixture.sourceRoot), false, name);
    assert.equal(serialized.includes("project-other-002"), false, name);
    assert.equal(serialized.includes("f0a1-bad"), false, name);
    assert.equal(serialized.includes("WRONG_SCOPE_PRIVATE_PURPOSE"), false, name);
  } finally {
    fixture.cleanup();
  }
}

async function applyCampaignGrant(fixture) {
  await applyCampaignSource(fixture);
  const grantPreview = await grantProjectSource({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "project-acme-001",
    sourceId: "campaign-assets",
    purpose: "Launch campaign assets",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const applied = await grantProjectSource({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "project-acme-001",
    sourceId: "campaign-assets",
    purpose: "Launch campaign assets",
    expiresAt: "2099-01-01T00:00:00.000Z",
    operationId: grantPreview.operation_id,
    planFingerprint: grantPreview.plan_fingerprint,
    apply: true,
  });
  const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
  return { applied, grant: JSON.parse(fs.readFileSync(paths.grant, "utf8")) };
}

async function applyCampaignSource(fixture) {
  const addPreview = await addProjectSource({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    folder: fixture.sourceRoot,
    sourceId: "campaign-assets",
    label: "Campaign assets",
    purpose: "Launch campaign assets",
  });
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
    apply: true,
  });
}

async function assertGrantPublicationRecovery(operation) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { preview, paths, apply } = await prepareGrantMutation(fixture, operation);
    await assert.rejects(() => apply(failDirectorySyncAfterRecordOperation(
      paths.grants,
      paths.grant,
      preview.operation_id,
    )));
    assert.equal(fs.existsSync(paths.grantGuard), true);
    const guardBytes = fs.readFileSync(paths.grantGuard, "utf8");
    assert.equal(guardBytes.includes(fixture.sourceRoot), false);
    assert.equal(guardBytes.includes("root_path"), false);
    await assert.rejects(
      () => apply(undefined, { operationId: "f0a1-bad" }),
      { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" },
    );
    const poisoned = await retrieveCampaignSource(fixture);
    assert.equal(poisoned.reason, "authorization-state-invalid");
    const completed = await apply();
    assert.equal(completed.applied, true);
    assert.equal(fs.existsSync(paths.grantGuard), false);
  } finally {
    fixture.cleanup();
  }
}

async function assertGrantClearFailure(failRepublish) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { preview, paths, apply } = await prepareGrantMutation(fixture, "grant");
    const filesystem = failGrantGuardClear(paths, preview.operation_id, failRepublish);
    await assert.rejects(() => apply(filesystem), { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" });
    const sourceLock = path.join(paths.locks, `${path.basename(paths.grant, ".json")}.lock`);
    if (failRepublish) {
      assert.equal(fs.existsSync(paths.grantGuard), false);
      assert.equal(fs.existsSync(sourceLock), true);
      assert.equal(JSON.parse(fs.readFileSync(sourceLock, "utf8")).poisoned, true);
    } else {
      assert.equal(fs.existsSync(paths.grantGuard), true);
    }
    const result = await retrieveCampaignSource(fixture);
    assert.equal(result.reason, "authorization-state-invalid");
  } finally {
    fixture.cleanup();
  }
}

async function assertCorruptRevokeGuard(field) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { preview, paths, apply } = await prepareGrantMutation(fixture, "revoke");
    await assert.rejects(() => apply(failDirectorySyncAfterRecordOperation(
      paths.grants,
      paths.grant,
      preview.operation_id,
    )));
    const guard = JSON.parse(fs.readFileSync(paths.grantGuard, "utf8"));
    writeJsonRecord(paths.grant, guard.previous_record);
    const corruptIntended = field === "revoked_at"
      ? { ...guard.intended_record, revoked_at: null }
      : { ...guard.intended_record, purpose: "Changed but structurally valid purpose" };
    const corruptBytes = `${JSON.stringify({ ...guard, intended_record: corruptIntended })}\n`;
    fs.writeFileSync(paths.grantGuard, corruptBytes);
    const grantBytes = fs.readFileSync(paths.grant, "utf8");
    await assert.rejects(() => apply(), { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" });
    assert.equal(fs.readFileSync(paths.grantGuard, "utf8"), corruptBytes);
    assert.equal(fs.readFileSync(paths.grant, "utf8"), grantBytes);
    const refused = await retrieveCampaignSource(fixture);
    assert.equal(refused.reason, "authorization-state-invalid");
  } finally {
    fixture.cleanup();
  }
}

async function assertCorruptGrantApprovalGuard() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { preview, paths, apply } = await prepareGrantMutation(fixture, "grant");
    await assert.rejects(() => apply(failDirectorySyncAfterRecordOperation(
      paths.grants,
      paths.grant,
      preview.operation_id,
    )));
    const guard = JSON.parse(fs.readFileSync(paths.grantGuard, "utf8"));
    fs.rmSync(paths.grant);
    const corruptBytes = `${JSON.stringify({
      ...guard,
      intended_record: { ...guard.intended_record, approved_at: "2020-01-01T00:00:00.000Z" }
    })}\n`;
    fs.writeFileSync(paths.grantGuard, corruptBytes);
    await assert.rejects(() => apply(), { code: "DOTAIOS_PROJECT_SOURCE_STATE_INVALID" });
    assert.equal(fs.readFileSync(paths.grantGuard, "utf8"), corruptBytes);
    assert.equal(fs.existsSync(paths.grant), false);
  } finally {
    fixture.cleanup();
  }
}

async function assertUnsafeAuthorizationRecord(kind, mutation) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const target = paths[kind];
    let filesystem = fsp;
    if (mutation === "linked") fs.linkSync(target, `${target}.linked`);
    if (mutation === "symlinked") {
      fs.renameSync(target, `${target}.real`);
      fs.symlinkSync(`${target}.real`, target);
    }
    if (mutation === "special") {
      fs.rmSync(target);
      fs.mkdirSync(target, { mode: 0o700 });
    }
    if (mutation === "permissive") fs.chmodSync(target, 0o644);
    if (mutation === "wrong-owner") filesystem = wrongOwnerFilesystem(target);
    const before = snapshotOwnedNode(target);
    const result = await retrieveCampaignSourceWithFilesystem(fixture, filesystem);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "authorization-state-invalid");
    assert.deepEqual(snapshotOwnedNode(target), before);
  } finally {
    fixture.cleanup();
  }
}

async function assertUnknownFutureAuthorizationState(kind) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const target = paths[kind];
    const futureBytes = fs.readFileSync(target, "utf8").replace('"version":1', '"version":2');
    fs.writeFileSync(target, futureBytes);
    const root = fs.realpathSync(fixture.sourceRoot);
    const filesystem = Object.create(fsp);
    filesystem.lstat = async (filePath, ...args) => {
      if (path.resolve(String(filePath)) === root) throw new Error("unknown state reached the external root");
      return fsp.lstat(filePath, ...args);
    };
    const result = await retrieveCampaignSourceWithFilesystem(fixture, filesystem);
    assert.equal(result.reason, "authorization-state-invalid");
    assert.deepEqual(result.references, []);
    assert.equal(fs.readFileSync(target, "utf8"), futureBytes);
  } finally {
    fixture.cleanup();
  }
}

async function assertUnsafeAuthorizationDirectory(scenario) {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const target = paths.grants;
    let filesystem = fsp;
    if (scenario === "permissive-grants") fs.chmodSync(target, 0o755);
    if (scenario === "linked-grants") {
      fs.renameSync(target, `${target}.real`);
      fs.symlinkSync(`${target}.real`, target);
    }
    if (scenario === "special-grants") {
      fs.renameSync(target, `${target}.real`);
      fs.writeFileSync(target, "unsafe", { mode: 0o600 });
    }
    if (scenario === "wrong-owner-grants") filesystem = wrongOwnerFilesystem(target);
    const before = snapshotOwnedNode(target);
    const result = await retrieveCampaignSourceWithFilesystem(fixture, filesystem);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "authorization-state-invalid");
    assert.deepEqual(snapshotOwnedNode(target), before);
  } finally {
    fixture.cleanup();
  }
}

async function assertUnsafeSourceLockDirectory() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { preview, paths, apply } = await prepareGrantMutation(fixture, "grant");
    fs.chmodSync(paths.locks, 0o755);
    await assert.rejects(() => apply(), { code: "DOTAIOS_OWNED_STATE_INVALID" });
    assert.equal(fs.statSync(paths.locks).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(paths.grant), false);
    assert.match(preview.plan_fingerprint, /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
}

async function assertReplacedSourceLockRelease() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { paths, apply } = await prepareGrantMutation(fixture, "grant");
    const lockPath = path.join(paths.locks, `${path.basename(paths.grant, ".json")}.lock`);
    const replacement = `${JSON.stringify({
      format: "dotaios-project-source-lock/v1",
      pid: process.pid,
      owner: "f0a1-bad",
      at: Date.now(),
    })}\n`;
    let replaced = false;
    const filesystem = Object.create(fsp);
    filesystem.rename = async (source, destination) => {
      if (!replaced && path.resolve(String(source)) === path.resolve(lockPath) && String(destination).includes(".release.")) {
        const staged = `${lockPath}.foreign`;
        fs.writeFileSync(staged, replacement, { mode: 0o600 });
        fs.renameSync(staged, lockPath);
        replaced = true;
      }
      return fsp.rename(source, destination);
    };
    await assert.rejects(() => apply(filesystem), { code: "DOTAIOS_OWNED_STATE_INVALID" });
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
    const refused = await retrieveCampaignSource(fixture);
    assert.equal(refused.reason, "authorization-state-invalid");
  } finally {
    fixture.cleanup();
  }
}

async function assertSourceLockPidReuse() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { paths, apply } = await prepareGrantMutation(fixture, "grant");
    const lockPath = path.join(paths.locks, `${path.basename(paths.grant, ".json")}.lock`);
    fs.writeFileSync(lockPath, `${JSON.stringify({
      format: "dotaios-project-source-lock/v1",
      pid: process.pid,
      owner: "a11-stale",
      at: Date.now(),
      process_started_at: "definitely-not-this-process",
    })}\n`, { mode: 0o600 });
    const applied = await apply();
    assert.equal(applied.applied, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fixture.cleanup();
  }
}

async function assertSourceLockReleaseSyncPoison() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { paths, apply } = await prepareGrantMutation(fixture, "grant");
    const lockPath = path.join(paths.locks, `${path.basename(paths.grant, ".json")}.lock`);
    let failed = false;
    const filesystem = Object.create(fsp);
    filesystem.open = async (filePath, flags, mode) => {
      const handle = await fsp.open(filePath, flags, mode);
      if (path.resolve(String(filePath)) !== path.resolve(paths.locks) || flags !== "r") return handle;
      return Object.create(handle, { sync: { value: async () => {
        const poisonStaged = fs.readdirSync(paths.locks).some((name) => name.includes(".release."));
        if (!failed && poisonStaged && !fs.existsSync(lockPath)) {
          failed = true;
          throw new Error("forced source lock release sync failure");
        }
        return handle.sync();
      } } });
    };
    await assert.rejects(() => apply(filesystem), { code: "DOTAIOS_PROJECT_SOURCE_APPLY_FAILED" });
    assert.equal(failed, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).poisoned, true);
    const result = await retrieveCampaignSource(fixture);
    assert.equal(result.reason, "authorization-state-invalid");
  } finally {
    fixture.cleanup();
  }
}

async function assertPostPoisonSourceLockReplacement() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { paths, apply } = await prepareGrantMutation(fixture, "grant");
    const lockPath = path.join(paths.locks, `${path.basename(paths.grant, ".json")}.lock`);
    const replacement = `${JSON.stringify({
      format: "dotaios-project-source-lock/v1",
      pid: process.pid,
      owner: "f0a1-post-poison",
      at: Date.now(),
    })}\n`;
    let replaced = false;
    const filesystem = Object.create(fsp);
    filesystem.lstat = async (target, ...args) => {
      const isCanonicalLock = path.resolve(String(target)) === path.resolve(lockPath);
      const isPoisoned = isCanonicalLock
        && fs.existsSync(lockPath)
        && JSON.parse(fs.readFileSync(lockPath, "utf8")).releasing === true;
      if (!replaced && isPoisoned) {
        const staged = `${lockPath}.foreign`;
        fs.writeFileSync(staged, replacement, { mode: 0o600 });
        fs.renameSync(staged, lockPath);
        replaced = true;
      }
      return fsp.lstat(target, ...args);
    };
    await assert.rejects(() => apply(filesystem), { code: "DOTAIOS_OWNED_STATE_INVALID" });
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  } finally {
    fixture.cleanup();
  }
}

async function assertUnknownSourceLockField() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const { paths, apply } = await prepareGrantMutation(fixture, "grant");
    const lockPath = path.join(paths.locks, `${path.basename(paths.grant, ".json")}.lock`);
    const bytes = `${JSON.stringify({
      format: "dotaios-project-source-lock/v1",
      pid: process.pid,
      owner: "a11-future",
      at: Date.now(),
      future_field: 2,
    })}\n`;
    fs.writeFileSync(lockPath, bytes, { mode: 0o600 });
    await assert.rejects(() => apply(), { code: "DOTAIOS_OWNED_STATE_INVALID" });
    assert.equal(fs.readFileSync(lockPath, "utf8"), bytes);
  } finally {
    fixture.cleanup();
  }
}

function retrieveCampaignSourceWithFilesystem(fixture, filesystem) {
  return retrieveProjectSource({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    task: CAMPAIGN_TASK,
    filesystem,
  });
}

async function assertAuthorizationSnapshotRace() {
  const fixture = createProjectSourceRetrievalFixture();
  const mutationAcquired = createDeferred();
  const releaseMutation = createDeferred();
  try {
    const { applied } = await applyCampaignGrant(fixture);
    const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
    const lockPath = sourceStateLockPath(fixture.homePath, "project-acme-001", "campaign-assets");
    const preview = await revokeProjectSource({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      projectSelector: "acme-campaign",
      sourceId: "campaign-assets",
      grantId: applied.grant_id,
    });
    const mutationFilesystem = pausingMutationFilesystem(paths.binding, mutationAcquired, releaseMutation);
    let mutationPromise = null;
    const startMutation = async () => {
      mutationPromise ||= revokeProjectSource({
        aiosPath: fixture.aiosPath,
        homePath: fixture.homePath,
        projectSelector: "acme-campaign",
        sourceId: "campaign-assets",
        grantId: applied.grant_id,
        operationId: preview.operation_id,
        planFingerprint: preview.plan_fingerprint,
        apply: true,
        filesystem: mutationFilesystem,
      });
      await mutationAcquired.promise;
    };
    const instrumentation = racingRetrievalFilesystem({
      bindingPath: paths.binding,
      lockPath,
      rootPath: fixture.sourceRoot,
      startMutation,
    });
    const result = await retrieveCampaignSourceWithFilesystem(fixture, instrumentation.filesystem);
    releaseMutation.resolve();
    await mutationPromise;
    assert.equal(result.decision, "refused");
    assert.equal(instrumentation.externalRootObservations(), 0, JSON.stringify(result));
  } finally {
    releaseMutation.resolve();
    fixture.cleanup();
  }
}

function pausingMutationFilesystem(bindingPath, acquired, release) {
  let bindingReads = 0;
  const filesystem = Object.create(fsp);
  filesystem.open = async (filePath, flags, mode) => {
    if (path.resolve(String(filePath)) === path.resolve(bindingPath) && flags === "r") {
      bindingReads += 1;
      if (bindingReads === 2) {
        acquired.resolve();
        await release.promise;
      }
    }
    return fsp.open(filePath, flags, mode);
  };
  return filesystem;
}

function racingRetrievalFilesystem({ bindingPath, lockPath, rootPath, startMutation }) {
  const filesystem = Object.create(fsp);
  const canonicalRoot = fs.realpathSync(rootPath);
  let interceptedBinding = false;
  let externalRootObservations = 0;
  const observeExternalRoot = () => { externalRootObservations += 1; };
  filesystem.lstat = async (filePath, ...args) => {
    const resolved = path.resolve(String(filePath));
    if (resolved === path.resolve(bindingPath) && !interceptedBinding) {
      interceptedBinding = true;
      await startMutation();
    }
    if (resolved === canonicalRoot) observeExternalRoot();
    return fsp.lstat(filePath, ...args);
  };
  filesystem.link = async (source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(lockPath)) await startMutation();
    return fsp.link(source, destination);
  };
  filesystem.opendir = async (directoryPath, ...args) => {
    if (path.resolve(String(directoryPath)) === canonicalRoot) observeExternalRoot();
    return fsp.opendir(directoryPath, ...args);
  };
  filesystem.open = async (filePath, flags, mode) => {
    if (path.resolve(String(filePath)) === canonicalRoot) observeExternalRoot();
    return fsp.open(filePath, flags, mode);
  };
  return Object.freeze({
    filesystem,
    externalRootObservations: () => externalRootObservations,
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return Object.freeze({ promise, resolve });
}

function wrongOwnerFilesystem(target) {
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (filePath, ...args) => {
    const stats = await fsp.lstat(filePath, ...args);
    if (path.resolve(String(filePath)) !== path.resolve(target)) return stats;
    return Object.create(stats, { uid: { value: stats.uid + 1 } });
  };
  return filesystem;
}

function snapshotOwnedNode(target) {
  const stats = fs.lstatSync(target);
  return Object.freeze({
    type: stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file",
    mode: stats.mode & 0o777,
    nlink: stats.nlink,
    ...(stats.isFile() ? { bytes: fs.readFileSync(target, "utf8") } : {}),
    ...(stats.isSymbolicLink() ? { target: fs.readlinkSync(target) } : {}),
  });
}

async function prepareGrantMutation(fixture, operation) {
  const existing = operation === "revoke"
    ? await applyCampaignGrant(fixture)
    : (await applyCampaignSource(fixture), null);
  const common = {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    sourceId: "campaign-assets",
  };
  const preview = operation === "revoke"
    ? await revokeProjectSource({ ...common, grantId: existing.applied.grant_id })
    : await grantProjectSource({
      ...common,
      purpose: "Launch campaign assets",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  const paths = projectSourceStatePaths(fixture.homePath, "project-acme-001", "campaign-assets");
  const apply = (filesystem, overrides = {}) => (operation === "revoke" ? revokeProjectSource : grantProjectSource)({
    ...common,
    ...(operation === "revoke"
      ? { grantId: existing.applied.grant_id }
      : { purpose: "Launch campaign assets", expiresAt: "2099-01-01T00:00:00.000Z" }),
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint,
    apply: true,
    ...(filesystem ? { filesystem } : {}),
    ...overrides,
  });
  return { preview, paths, apply };
}

function retrieveCampaignSource(fixture) {
  return retrieveProjectSource({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    task: CAMPAIGN_TASK,
  });
}

function replaceOnNeighborFrontmatter(evidenceReader, targetPath, linkTarget) {
  let replaced = false;
  const reader = {
    ...evidenceReader,
    async readFrontmatter(root, filePath, options) {
      if (!replaced && path.resolve(String(filePath)) === path.resolve(targetPath)) {
        fs.rmSync(targetPath);
        fs.symlinkSync(linkTarget, targetPath);
        replaced = true;
      }
      return evidenceReader.readFrontmatter(root, filePath, options);
    },
  };
  return Object.freeze({ reader: Object.freeze(reader), didReplace: () => replaced });
}

function insertCollisionAfterMissingInspection(evidenceReader, targetPath) {
  let inserted = false;
  const reader = {
    ...evidenceReader,
    async inspectEntry(root, filePath, options) {
      const entry = await evidenceReader.inspectEntry(root, filePath, options);
      if (!inserted && entry === null && path.resolve(String(filePath)) === path.resolve(targetPath)) {
        fs.writeFileSync(
          targetPath,
          "---\nid: acme-campaign\nproject: other-client\n---\n# Inserted collision\n",
        );
        inserted = true;
      }
      return entry;
    },
  };
  return Object.freeze({ reader: Object.freeze(reader), didInsert: () => inserted });
}

function failGrantGuardClear(paths, operationId, failRepublish) {
  let clearSyncFailed = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (filePath, flags, mode) => {
    if (
      failRepublish
      && clearSyncFailed
      && flags === "wx"
      && String(filePath).includes(path.basename(paths.grantGuard))
    ) throw new Error("forced guard republish failure");
    const handle = await fsp.open(filePath, flags, mode);
    if (path.resolve(String(filePath)) !== path.resolve(paths.grants) || flags !== "r") return handle;
    return Object.create(handle, {
      sync: { value: async () => {
        const record = fs.existsSync(paths.grant) ? JSON.parse(fs.readFileSync(paths.grant, "utf8")) : null;
        if (!clearSyncFailed && record?.operation_id === operationId && !fs.existsSync(paths.grantGuard)) {
          clearSyncFailed = true;
          throw new Error("forced guard-clear sync failure");
        }
        return handle.sync();
      } },
    });
  };
  return filesystem;
}

function failDirectorySyncAfterRecordOperation(directoryPath, recordPath, operationId) {
  let failed = false;
  const filesystem = Object.create(fsp);
  Object.defineProperty(filesystem, "open", {
    value: async (filePath, flags, mode) => {
      const handle = await fsp.open(filePath, flags, mode);
      if (path.resolve(String(filePath)) !== path.resolve(directoryPath) || flags !== "r") return handle;
      return Object.create(handle, {
        sync: {
          value: async () => {
            const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf8")) : null;
            if (!failed && record?.operation_id === operationId) {
              failed = true;
              throw new Error("forced post-publication directory sync failure");
            }
            return handle.sync();
          },
        },
      });
    },
  });
  return filesystem;
}

function writeJsonRecord(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function createStateOverlapFixture(relation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-state-overlap-"));
  const homePath = relation === "inside" ? path.join(root, "aios") : root;
  const stateRoot = path.join(homePath, ".dotaios", "project-sources");
  const aiosPath = relation === "equal"
    ? stateRoot
    : relation === "containing"
      ? path.join(stateRoot, "portable-aios")
      : homePath;
  const sourceRoot = path.join(root, "external-assets");
  fs.mkdirSync(path.join(aiosPath, "projects", "acme-campaign"), { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "acme-campaign", "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Acme Campaign\n",
  );
  return {
    root,
    aiosPath,
    homePath,
    sourceRoot,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function createSymlinkStateOverlapFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-state-overlap-link-"));
  const homePath = path.join(root, "home");
  const stateRoot = path.join(homePath, ".dotaios", "project-sources");
  const aiosPath = path.join(root, "portable-aios-link");
  const sourceRoot = path.join(root, "external-assets");
  fs.mkdirSync(path.join(stateRoot, "projects", "acme-campaign"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(homePath, ".dotaios"), 0o700);
  fs.chmodSync(stateRoot, 0o700);
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "projects", "acme-campaign", "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Acme Campaign\n",
  );
  fs.symlinkSync(stateRoot, aiosPath, "dir");
  return {
    root,
    aiosPath,
    homePath,
    sourceRoot,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function projectSourceDeclaration(sourceId) {
  return [
    "---",
    "version: 1",
    "project_id: project-acme-001",
    "project: acme-campaign",
    `source_id: ${sourceId}`,
    "label: Campaign assets",
    "type: local-folder",
    "purpose: Launch campaign assets",
    "revision: 1",
    "---",
    "",
  ].join("\n");
}
