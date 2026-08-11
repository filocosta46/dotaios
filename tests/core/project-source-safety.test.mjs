import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  addProjectSource,
  grantProjectSource,
  retrieveProjectSource
} from "../../packages/core/src/project-sources.mjs";
import {
  CAMPAIGN_TASK,
  createProjectSourceRetrievalFixture,
  snapshotTree
} from "../fixtures/project-source-retrieval.mjs";

test("retrieval refuses a hardlinked source entry without partial references or content reads", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const outsideCanary = "SIBLING_CONTENT_MUST_NOT_ESCAPE";
  const outsidePath = path.join(fixture.root, "sibling-canary.txt");
  const linkedPath = path.join(fixture.sourceRoot, "linked-campaign.txt");
  try {
    fs.writeFileSync(outsidePath, outsideCanary);
    fs.linkSync(outsidePath, linkedPath);
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const instrumentation = contentReadGuard(fixture, outsidePath);

    const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-unsafe-entry");
    assert.deepEqual(result.references, []);
    assert.deepEqual(instrumentation.observations(), []);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, outsideCanary);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval requires reconnect when the bound source root is missing", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const movedRoot = `${fixture.sourceRoot}.moved`;
  try {
    await authorizeCampaignSource(fixture);
    const portableBefore = snapshotTree(fixture.aiosPath);
    fs.renameSync(fixture.sourceRoot, movedRoot);

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "reconnect-required");
    assert.deepEqual(result.references, []);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
  } finally {
    if (fs.existsSync(movedRoot) && !fs.existsSync(fixture.sourceRoot)) {
      fs.renameSync(movedRoot, fixture.sourceRoot);
    }
    fixture.cleanup();
  }
});

test("retrieval requires reconnect when the bound source root becomes inaccessible", async (t) => {
  const fixture = createProjectSourceRetrievalFixture();
  const originalMode = fs.statSync(fixture.sourceRoot).mode & 0o777;
  try {
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    fs.chmodSync(fixture.sourceRoot, 0o000);
    try {
      fs.readdirSync(fixture.sourceRoot);
      t.skip("directory permission denial is not enforceable for this process");
      return;
    } catch (error) {
      if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
    }

    const result = await retrieveCampaignSource(fixture);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "reconnect-required");
    assert.deepEqual(result.references, []);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
    fs.chmodSync(fixture.sourceRoot, originalMode);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  } finally {
    fs.chmodSync(fixture.sourceRoot, originalMode);
    fixture.cleanup();
  }
});

test("retrieval requires reconnect when root directory open returns EACCES", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaignSource(fixture);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const filesystem = rootDirectoryAccessDeniedFilesystem(fixture);

    const result = await retrieveCampaignSource(fixture, filesystem);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "reconnect-required");
    assert.deepEqual(result.references, []);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses a source root replaced at the directory-open observation boundary", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const originalRoot = `${fixture.sourceRoot}.original`;
  const replacement = rootReplacementAtDirectoryOpen(fixture, originalRoot);
  try {
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const result = await retrieveCampaignSource(fixture, replacement.filesystem);

    assert.equal(replacement.wasReplaced(), true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    assert.equal(replacement.contentReads(), 0);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "REPLACEMENT_CANARY");
    restoreFixtureRoot(fixture, originalRoot);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  } finally {
    restoreFixtureRoot(fixture, originalRoot);
    fixture.cleanup();
  }
});

test("retrieval requires reconnect for replaced non-directory, linked, special, or new-identity roots", async (t) => {
  for (const scenario of rootReplacementScenarios()) {
    await t.test(scenario.name, { skip: scenario.unsupported || false }, (subtest) => (
      assertReconnectForRootScenario(scenario, subtest)
    ));
  }
});

test("retrieval normalizes final unavailable or unsafe root observations to reconnect required", async (t) => {
  const calibration = createProjectSourceRetrievalFixture();
  let finalRootObservation;
  try {
    await authorizeCampaignSource(calibration);
    const counter = countedRootIdentityFilesystem(calibration);
    const result = await retrieveCampaignSource(calibration, counter.filesystem);
    assert.equal(result.decision, "allowed");
    finalRootObservation = counter.observations();
    assert.ok(finalRootObservation > 1);
  } finally {
    calibration.cleanup();
  }

  for (const { scenario, reason } of [
    { scenario: "removed", reason: "reconnect-required" },
    { scenario: "access denied", reason: "reconnect-required" },
    { scenario: "unsafe replacement", reason: "reconnect-required" },
    { scenario: "new directory identity", reason: "source-changed" }
  ]) {
    await t.test(scenario, async () => {
      const fixture = createProjectSourceRetrievalFixture();
      const finalFailure = finalRootFailureFilesystem(fixture, finalRootObservation, scenario);
      try {
        await authorizeCampaignSource(fixture);
        const portableBefore = snapshotTree(fixture.aiosPath);

        const result = await retrieveCampaignSource(fixture, finalFailure.filesystem);

        assert.equal(finalFailure.wasTriggered(), true);
        assert.equal(result.decision, "refused");
        assert.equal(result.reason, reason);
        assert.deepEqual(result.references, []);
        assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
        assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
      } finally {
        finalFailure.restore();
        fixture.cleanup();
      }
    });
  }
});

test("retrieval refuses a nested escaping link before sibling content can be read", async (t) => {
  const linkKinds = process.platform === "win32"
    ? [{ name: "junction", type: "junction" }]
    : [
      { name: "symbolic link", type: "dir" },
      { name: "junction", skip: "directory junctions are a Windows-only fixture" }
    ];
  for (const linkKind of linkKinds) {
    await t.test(linkKind.name, { skip: linkKind.skip || false }, async () => {
      const fixture = createProjectSourceRetrievalFixture();
      const siblingRoot = path.join(fixture.root, "sibling-private");
      const siblingCanary = "SIBLING_EXPANSION_CANARY";
      try {
        fs.mkdirSync(siblingRoot);
        fs.writeFileSync(path.join(siblingRoot, "private.txt"), siblingCanary);
        fs.symlinkSync(siblingRoot, path.join(fixture.sourceRoot, "expanded-sibling"), linkKind.type);
        await authorizeCampaignSource(fixture);
        const sourceBefore = snapshotTree(fixture.sourceRoot);
        const portableBefore = snapshotTree(fixture.aiosPath);
        const instrumentation = contentReadGuard(fixture, siblingRoot);

        const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

        assert.equal(result.decision, "refused");
        assert.equal(result.reason, "source-unsafe-entry");
        assert.deepEqual(result.references, []);
        assert.deepEqual(instrumentation.observations(), []);
        assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
        assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
        assertSingleSafeRefusal(fixture, result, siblingCanary);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("retrieval refuses supported special source entries", async (t) => {
  await t.test("FIFO entry", {
    skip: process.platform === "win32" ? "FIFO entries are unavailable on Windows" : false
  }, async (subtest) => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      const fifoPath = path.join(fixture.sourceRoot, "campaign.pipe");
      const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
      if (created.status !== 0) {
        subtest.skip(`FIFO fixture unsupported: ${created.stderr.trim() || "mkfifo failed"}`);
        return;
      }
      await assertUnsafeSpecialEntry(fixture, "FIFO_CONTENT_CANARY");
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("Unix socket entry", {
    skip: process.platform === "win32" ? "Unix-domain socket entries are unavailable on Windows" : false
  }, async (subtest) => {
    const fixture = createProjectSourceRetrievalFixture({
      temporaryDirectory: "/tmp",
      prefix: "d61-socket-"
    });
    const server = net.createServer();
    try {
      const socketPath = path.join(fixture.sourceRoot, "campaign.sock");
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
      } catch (error) {
        if (["EAFNOSUPPORT", "EPROTONOSUPPORT", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
          subtest.skip(`Unix-domain socket fixture unsupported: ${error.code}`);
          return;
        }
        throw error;
      }
      const socketStats = fs.lstatSync(socketPath);
      assert.equal(socketStats.isSocket(), true, "fixture must create the exact requested socket path");
      await assertUnsafeSpecialEntry(fixture, "SOCKET_CONTENT_CANARY");
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
      fixture.cleanup();
    }
  });

  await t.test("device entry", {
    skip: "creating a device node requires unsupported elevated platform authority"
  }, () => {});
});

test("retrieval compares directory identities as BigInts at replacement observation boundaries", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const replacement = bigIntDirectoryReplacementFilesystem(fixture);
  try {
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const result = await retrieveCampaignSource(fixture, replacement.filesystem);

    assert.equal(replacement.identityChanged(), true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    assert.equal(replacement.contentReads(), 0);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses a directory changed only within one millisecond", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const mutation = nanosecondDirectoryMutationFilesystem(fixture);
  try {
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);

    const result = await retrieveCampaignSource(fixture, mutation.filesystem);

    assert.equal(mutation.wasMutated(), true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    assert.equal(mutation.contentReads(), 0);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses a nested directory replaced at its open observation boundary", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const nestedDirectory = path.join(fixture.sourceRoot, "visual assets");
  const canonicalDirectory = fs.realpathSync(nestedDirectory);
  const originalDirectory = `${nestedDirectory}.original`;
  let replaced = false;
  try {
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const filesystem = Object.create(fsp);
    filesystem.opendir = async (directoryPath, ...args) => {
      if (!replaced && path.resolve(String(directoryPath)) === canonicalDirectory) {
        fs.renameSync(nestedDirectory, originalDirectory);
        fs.mkdirSync(nestedDirectory);
        fs.writeFileSync(path.join(nestedDirectory, "nested-replacement.txt"), "NESTED_REPLACEMENT_CANARY");
        replaced = true;
      }
      return fsp.opendir(directoryPath, ...args);
    };

    const result = await retrieveCampaignSource(fixture, filesystem);

    assert.equal(replaced, true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "NESTED_REPLACEMENT_CANARY");
    fs.rmSync(nestedDirectory, { recursive: true, force: true });
    fs.renameSync(originalDirectory, nestedDirectory);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  } finally {
    if (fs.existsSync(originalDirectory)) {
      fs.rmSync(nestedDirectory, { recursive: true, force: true });
      fs.renameSync(originalDirectory, nestedDirectory);
    }
    fixture.cleanup();
  }
});

test("retrieval refuses a file replaced between metadata observations", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  const targetFile = path.join(fixture.sourceRoot, "brief.txt");
  const canonicalFile = fs.realpathSync(targetFile);
  const originalFile = `${targetFile}.original`;
  let replaced = false;
  try {
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const filesystem = Object.create(fsp);
    filesystem.lstat = async (filePath, options) => {
      const stats = await fsp.lstat(filePath, options);
      if (
        !replaced
        && options?.bigint === true
        && path.resolve(String(filePath)) === canonicalFile
      ) {
        fs.renameSync(targetFile, originalFile);
        fs.writeFileSync(targetFile, "FILE_REPLACEMENT_CANARY");
        replaced = true;
      }
      return stats;
    };

    const result = await retrieveCampaignSource(fixture, filesystem);

    assert.equal(replaced, true);
    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-changed");
    assert.deepEqual(result.references, []);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "FILE_REPLACEMENT_CANARY");
    fs.rmSync(targetFile, { force: true });
    fs.renameSync(originalFile, targetFile);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  } finally {
    if (fs.existsSync(originalFile)) {
      fs.rmSync(targetFile, { force: true });
      fs.renameSync(originalFile, targetFile);
    }
    fixture.cleanup();
  }
});

test("retrieval refuses an invalid UTF-8 source filename without decoding or reading it", async (t) => {
  if (process.platform === "win32") {
    t.skip("raw invalid UTF-8 filename bytes are unavailable through Windows path APIs");
    return;
  }
  const fixture = createProjectSourceRetrievalFixture();
  const invalidPath = Buffer.concat([
    Buffer.from(`${fixture.sourceRoot}${path.sep}`),
    Buffer.from([0x66, 0x6f, 0x80, 0x2e, 0x74, 0x78, 0x74])
  ]);
  let invalidCreated = false;
  try {
    try {
      fs.writeFileSync(invalidPath, "INVALID_UTF8_CONTENT_CANARY");
      invalidCreated = true;
    } catch (error) {
      if (error?.code === "EILSEQ" || error?.code === "EINVAL") {
        t.skip(`filesystem rejects invalid UTF-8 filename bytes (${error.code})`);
        return;
      }
      throw error;
    }
    const invalidBefore = fs.readFileSync(invalidPath);
    const invalidStatsBefore = statFingerprint(fs.lstatSync(invalidPath, { bigint: true }));
    await authorizeCampaignSource(fixture);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

    const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-name-invalid");
    assert.deepEqual(result.references, []);
    assert.deepEqual(instrumentation.observations(), []);
    assert.deepEqual(fs.readFileSync(invalidPath), invalidBefore);
    assert.deepEqual(statFingerprint(fs.lstatSync(invalidPath, { bigint: true })), invalidStatsBefore);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "INVALID_UTF8_CONTENT_CANARY");
  } finally {
    if (invalidCreated) fs.rmSync(invalidPath, { force: true });
    fixture.cleanup();
  }
});

test("retrieval refuses supported control and traversal-shaped filename segments", async (t) => {
  const scenarios = [
    { name: "control character", filename: "campaign\nsecret.txt", canary: "CONTROL_NAME_CANARY" },
    {
      name: "backslash traversal shape",
      filename: "..\\sibling-secret.txt",
      canary: "TRAVERSAL_NAME_CANARY",
      skip: process.platform === "win32" ? "backslash is a path separator, not a raw segment, on Windows" : false
    }
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, { skip: scenario.skip || false }, async () => {
      const fixture = createProjectSourceRetrievalFixture();
      try {
        fs.writeFileSync(path.join(fixture.sourceRoot, scenario.filename), scenario.canary);
        await authorizeCampaignSource(fixture);
        const sourceBefore = snapshotTree(fixture.sourceRoot);
        const portableBefore = snapshotTree(fixture.aiosPath);
        const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

        const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

        assert.equal(result.decision, "refused");
        assert.equal(result.reason, "source-name-invalid");
        assert.deepEqual(result.references, []);
        assert.deepEqual(instrumentation.observations(), []);
        assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
        assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
        assertSingleSafeRefusal(fixture, result, scenario.canary);
      } finally {
        fixture.cleanup();
      }
    });
  }

  await t.test("NUL segment", {
    skip: "Node path APIs reject NUL before a filesystem entry can be created"
  }, () => {});
  await t.test("empty, dot, dot-dot, or slash segment", {
    skip: "filesystems do not expose empty, dot, dot-dot, or slash as raw directory-entry segments"
  }, () => {});
});

test("retrieval preserves awkward UTF-8 and keeps NFC and NFD filenames distinct", async (t) => {
  const fixture = createProjectSourceRetrievalFixture();
  const nfcName = "é-normalization.txt";
  const nfdName = "é-normalization.txt";
  try {
    fs.writeFileSync(path.join(fixture.sourceRoot, nfcName), "NFC_CONTENT_CANARY");
    fs.writeFileSync(path.join(fixture.sourceRoot, nfdName), "NFD_CONTENT_CANARY");
    const observedNames = fs.readdirSync(fixture.sourceRoot);
    if (!observedNames.includes(nfcName) || !observedNames.includes(nfdName)) {
      t.skip("filesystem does not preserve NFC and NFD as distinct filename entries");
      return;
    }
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

    const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

    assert.equal(result.decision, "allowed");
    assert.equal(result.references.some((reference) => reference.path === nfcName), true);
    assert.equal(result.references.some((reference) => reference.path === nfdName), true);
    assert.equal(nfcName.normalize("NFD"), nfdName);
    assert.equal(Buffer.from(nfcName).equals(Buffer.from(nfdName)), false);
    assert.deepEqual(instrumentation.observations(), []);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assert.deepEqual(snapshotNonReceiptLocalState(fixture), fixture.localStateBeforeRetrieval);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("NFC_CONTENT_CANARY"), false);
    assert.equal(serialized.includes("NFD_CONTENT_CANARY"), false);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses the 4,097th observed source entry without partial output", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await runInBatches(4_093, (index) => (
      fsp.mkdir(path.join(fixture.sourceRoot, `empty-${String(index).padStart(4, "0")}`))
    ));
    await authorizeCampaignSource(fixture);
    const sourceBefore = snapshotTree(fixture.sourceRoot);
    const portableBefore = snapshotTree(fixture.aiosPath);
    const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

    const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

    assert.equal(result.decision, "refused");
    assert.equal(result.reason, "source-bound-exceeded");
    assert.deepEqual(result.references, []);
    assert.deepEqual(instrumentation.observations(), []);
    assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
  } finally {
    fixture.cleanup();
  }
});

test("retrieval allows exactly 4,096 observed source entries", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await runInBatches(4_092, (index) => (
      fsp.mkdir(path.join(fixture.sourceRoot, `maximum-${String(index).padStart(4, "0")}`))
    ));
    await assertAllowedRetrieval(fixture, { expectedReferences: 3 });
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses source depth 17 without partial output", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    let directory = fixture.sourceRoot;
    for (let depth = 1; depth <= 17; depth += 1) {
      directory = path.join(directory, `depth-${String(depth).padStart(2, "0")}`);
      fs.mkdirSync(directory);
    }
    await assertBoundRefusal(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval allows source depth 16", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    let directory = fixture.sourceRoot;
    for (let depth = 1; depth <= 16; depth += 1) {
      directory = path.join(directory, `maximum-depth-${String(depth).padStart(2, "0")}`);
      fs.mkdirSync(directory);
    }
    await assertAllowedRetrieval(fixture, { expectedReferences: 3 });
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses the 257th regular file without partial output", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await addEmptyFiles(fixture, 254, "asset");
    await assertBoundRefusal(fixture);
  } finally {
    fixture.cleanup();
  }
});

test("retrieval admits exactly 256 regular files before the independent receipt bound", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await addEmptyFiles(fixture, 253, "maximum-file");
    await assertBoundRefusal(fixture, { reason: "result-too-large" });
  } finally {
    fixture.cleanup();
  }
});

test("retrieval refuses a 1,025-byte source-relative path", async (t) => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    let directory = fixture.sourceRoot;
    try {
      for (let index = 0; index < 4; index += 1) {
        directory = path.join(directory, String(index).repeat(200));
        fs.mkdirSync(directory);
      }
      const target = path.join(directory, `${"x".repeat(217)}.txt`);
      const relativePath = path.relative(fixture.sourceRoot, target).split(path.sep).join("/");
      assert.equal(Buffer.byteLength(relativePath, "utf8"), 1_025);
      fs.writeFileSync(target, "PATH_BOUND_CONTENT_CANARY");
    } catch (error) {
      if (error?.code === "ENAMETOOLONG" || error?.code === "EINVAL") {
        t.skip(`filesystem path ceiling prevents a 1,025-byte relative fixture (${error.code})`);
        return;
      }
      throw error;
    }
    await assertBoundRefusal(fixture, { canary: "PATH_BOUND_CONTENT_CANARY" });
  } finally {
    fixture.cleanup();
  }
});

test("retrieval allows a 1,024-byte source-relative path where the filesystem supports it", async (t) => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    let directory = fixture.sourceRoot;
    try {
      for (let index = 0; index < 4; index += 1) {
        directory = path.join(directory, String(index).repeat(200));
        fs.mkdirSync(directory);
      }
      const target = path.join(directory, `${"x".repeat(216)}.txt`);
      const relativePath = path.relative(fixture.sourceRoot, target).split(path.sep).join("/");
      assert.equal(Buffer.byteLength(relativePath, "utf8"), 1_024);
      fs.writeFileSync(target, "PATH_MAXIMUM_CONTENT_CANARY");
    } catch (error) {
      if (error?.code === "ENAMETOOLONG" || error?.code === "EINVAL") {
        t.skip(`filesystem path ceiling prevents a 1,024-byte relative fixture (${error.code})`);
        return;
      }
      throw error;
    }
    await assertAllowedRetrieval(fixture, {
      expectedReferences: 4,
      canary: "PATH_MAXIMUM_CONTENT_CANARY"
    });
  } finally {
    fixture.cleanup();
  }
});

test("retrieval replaces a 32,001-character allowed result with one bounded refusal", async () => {
  const calibration = createProjectSourceRetrievalFixture();
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await Promise.all([
      addEmptyFiles(calibration, 80, "output"),
      addEmptyFiles(fixture, 80, "output")
    ]);
    await authorizeCampaignSource(calibration);
    const template = await retrieveCampaignSource(calibration, fsp, { createId: () => "a" });
    assert.equal(template.decision, "allowed");
    const baseLength = JSON.stringify(template).length;
    const remaining = 32_001 - baseLength;
    assert.ok(remaining > 0, `fixture baseline ${baseLength} must remain below the output ceiling`);
    const repeatedIdOccurrences = template.references.length + 1;
    const extraIdCharacters = Math.floor(remaining / repeatedIdOccurrences);
    const pathPadding = remaining % repeatedIdOccurrences;
    const receiptId = "a".repeat(extraIdCharacters + 1);
    assert.ok(receiptId.length <= 256);
    if (pathPadding > 0) {
      fs.renameSync(
        path.join(fixture.sourceRoot, "output-000.txt"),
        path.join(fixture.sourceRoot, `output-000${"x".repeat(pathPadding)}.txt`)
      );
    }
    assert.equal(projectAllowedTemplate(template, receiptId, pathPadding).length, 32_001);

    await assertBoundRefusal(fixture, {
      reason: "result-too-large",
      retrievalOptions: { createId: () => receiptId }
    });
  } finally {
    calibration.cleanup();
    fixture.cleanup();
  }
});

test("retrieval publishes one refusal when an allowed result fits but its receipt does not", async () => {
  const calibration = createProjectSourceRetrievalFixture();
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await Promise.all([
      addEmptyFiles(calibration, 80, "receipt"),
      addEmptyFiles(fixture, 80, "receipt")
    ]);
    await authorizeCampaignSource(calibration);
    const template = await retrieveCampaignSource(calibration, fsp, { createId: () => "a" });
    assert.equal(template.decision, "allowed");
    const targetLength = 31_626;
    const remaining = targetLength - JSON.stringify(template).length;
    const repeatedIdOccurrences = template.references.length + 1;
    const extraIdCharacters = Math.floor(remaining / repeatedIdOccurrences);
    const pathPadding = remaining % repeatedIdOccurrences;
    const receiptId = "a".repeat(extraIdCharacters + 1);
    if (pathPadding > 0) {
      fs.renameSync(
        path.join(fixture.sourceRoot, "receipt-000.txt"),
        path.join(fixture.sourceRoot, `receipt-000${"x".repeat(pathPadding)}.txt`)
      );
    }
    assert.equal(projectAllowedTemplate(template, receiptId, pathPadding, "receipt-000.txt").length, targetLength);
    assert.ok(targetLength <= 32_000);

    await assertBoundRefusal(fixture, {
      reason: "result-too-large",
      retrievalOptions: { createId: () => receiptId }
    });
  } finally {
    calibration.cleanup();
    fixture.cleanup();
  }
});

test("allowed receipt publication faults remain audit failures", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await authorizeCampaignSource(fixture);
    const filesystem = Object.create(fsp);
    filesystem.open = async (filePath, flags, ...args) => {
      if (String(filePath).endsWith("access-receipts.jsonl") && flags === "a") {
        throw new Error("forced allowed receipt publication failure");
      }
      return fsp.open(filePath, flags, ...args);
    };

    await assert.rejects(
      () => retrieveCampaignSource(fixture, filesystem),
      { code: "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED" }
    );
  } finally {
    fixture.cleanup();
  }
});

test("retrieval allows the largest calibrated result whose complete receipt is exactly 32,000 bytes", async () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    await addEmptyFiles(fixture, 80, "maximum-output");
    await authorizeCampaignSource(fixture);
    const template = await retrieveCampaignSource(fixture, fsp, { createId: () => "a" });
    assert.equal(template.decision, "allowed");
    const receiptPath = accessReceiptPath(fixture);
    const baselineLine = fs.readFileSync(receiptPath, "utf8");
    const receiptOnlyBytes = Buffer.byteLength(baselineLine) - JSON.stringify(template).length;
    const targetLength = 32_000 - receiptOnlyBytes;
    const remaining = targetLength - JSON.stringify(template).length;
    const repeatedIdOccurrences = template.references.length + 1;
    const extraIdCharacters = Math.floor(remaining / repeatedIdOccurrences);
    const pathPadding = remaining % repeatedIdOccurrences;
    const receiptId = "a".repeat(extraIdCharacters + 1);
    if (pathPadding > 0) {
      fs.renameSync(
        path.join(fixture.sourceRoot, "maximum-output-000.txt"),
        path.join(fixture.sourceRoot, `maximum-output-000${"x".repeat(pathPadding)}.txt`)
      );
    }
    assert.equal(
      projectAllowedTemplate(template, receiptId, pathPadding, "maximum-output-000.txt").length,
      targetLength
    );

    const result = await retrieveCampaignSource(fixture, fsp, { createId: () => receiptId });

    assert.equal(result.decision, "allowed");
    assert.equal(JSON.stringify(result).length, targetLength);
    const receiptLines = fs.readFileSync(receiptPath, "utf8").trimEnd().split("\n");
    assert.equal(Buffer.byteLength(`${receiptLines.at(-1)}\n`), 32_000);
  } finally {
    fixture.cleanup();
  }
});

function rootReplacementAtDirectoryOpen(fixture, originalRoot) {
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  let replaced = false;
  let contentReads = 0;
  const filesystem = Object.create(fsp);
  const guardContent = (filePath) => {
    if (!path.resolve(String(filePath)).startsWith(`${canonicalRoot}${path.sep}`)) return;
    contentReads += 1;
    throw new Error("source content must not be opened");
  };
  filesystem.open = async (filePath, ...args) => {
    guardContent(filePath);
    return fsp.open(filePath, ...args);
  };
  filesystem.readFile = async (filePath, ...args) => {
    guardContent(filePath);
    return fsp.readFile(filePath, ...args);
  };
  filesystem.opendir = async (directoryPath, ...args) => {
    if (!replaced && path.resolve(String(directoryPath)) === canonicalRoot) {
      fs.renameSync(fixture.sourceRoot, originalRoot);
      fs.mkdirSync(fixture.sourceRoot);
      fs.writeFileSync(path.join(fixture.sourceRoot, "replacement-canary.txt"), "REPLACEMENT_CANARY");
      replaced = true;
    }
    return fsp.opendir(directoryPath, ...args);
  };
  return Object.freeze({
    filesystem,
    wasReplaced: () => replaced,
    contentReads: () => contentReads
  });
}

function rootDirectoryAccessDeniedFilesystem(fixture) {
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  const filesystem = Object.create(fsp);
  filesystem.opendir = async (directoryPath, ...args) => {
    if (path.resolve(String(directoryPath)) === canonicalRoot) {
      const error = new Error("forced root directory access denial");
      error.code = "EACCES";
      throw error;
    }
    return fsp.opendir(directoryPath, ...args);
  };
  return filesystem;
}

function restoreFixtureRoot(fixture, originalRoot) {
  if (!fs.existsSync(originalRoot)) return;
  fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  fs.renameSync(originalRoot, fixture.sourceRoot);
}

function rootReplacementScenarios() {
  return [
    { name: "non-directory root", replace(root) { fs.writeFileSync(root, "not a directory"); } },
    { name: "symlinked root", replace(root, original) { fs.symlinkSync(original, root, "dir"); } },
    { name: "new directory identity", replace(root) { fs.mkdirSync(root); } },
    {
      name: "FIFO root",
      unsupported: process.platform === "win32" ? "FIFO roots are unavailable on Windows" : null,
      replace: createFifoRoot
    }
  ];
}

function countedRootIdentityFilesystem(fixture) {
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  let observations = 0;
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (filePath, options) => {
    if (path.resolve(String(filePath)) === canonicalRoot && options?.bigint === true) observations += 1;
    return fsp.lstat(filePath, options);
  };
  return Object.freeze({ filesystem, observations: () => observations });
}

function finalRootFailureFilesystem(fixture, targetObservation, scenario) {
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  const originalRoot = `${fixture.sourceRoot}.final-observation-original`;
  let observations = 0;
  let triggered = false;
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (filePath, options) => {
    const isRootIdentity = path.resolve(String(filePath)) === canonicalRoot && options?.bigint === true;
    if (isRootIdentity && ++observations === targetObservation) {
      triggered = true;
      if (scenario === "access denied") {
        const error = new Error("forced root access denial");
        error.code = "EACCES";
        throw error;
      }
      fs.renameSync(fixture.sourceRoot, originalRoot);
      if (scenario === "unsafe replacement") fs.writeFileSync(fixture.sourceRoot, "UNSAFE_ROOT_CANARY");
      if (scenario === "new directory identity") fs.mkdirSync(fixture.sourceRoot);
    }
    return fsp.lstat(filePath, options);
  };
  return Object.freeze({
    filesystem,
    wasTriggered: () => triggered,
    restore() {
      if (!fs.existsSync(originalRoot)) return;
      fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
      fs.renameSync(originalRoot, fixture.sourceRoot);
    }
  });
}

function createFifoRoot(root) {
  const created = spawnSync("mkfifo", [root], { encoding: "utf8" });
  if (created.status === 0) return;
  const error = new Error(created.stderr || created.error?.message || "mkfifo failed");
  error.fixtureUnsupported = true;
  throw error;
}

async function assertReconnectForRootScenario(scenario, subtest) {
  const fixture = createProjectSourceRetrievalFixture();
  const originalRoot = `${fixture.sourceRoot}.original`;
  try {
    await authorizeCampaignSource(fixture);
    const portableBefore = snapshotTree(fixture.aiosPath);
    fs.renameSync(fixture.sourceRoot, originalRoot);
    try {
      scenario.replace(fixture.sourceRoot, originalRoot);
    } catch (error) {
      if (!error.fixtureUnsupported) throw error;
      subtest.skip(`FIFO root fixture unsupported: ${error.message.trim()}`);
      return;
    }
    const result = await retrieveCampaignSource(fixture);
    assert.equal(result.decision, "refused", scenario.name);
    assert.equal(result.reason, "reconnect-required", scenario.name);
    assert.deepEqual(result.references, [], scenario.name);
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore, scenario.name);
    assertSingleSafeRefusal(fixture, result, "CONTENT_READ_CANARY");
  } finally {
    restoreFixtureRoot(fixture, originalRoot);
    fixture.cleanup();
  }
}

function bigIntDirectoryReplacementFilesystem(fixture) {
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  const targetDirectory = path.join(canonicalRoot, "visual assets");
  let changed = false;
  let contentReads = 0;
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (filePath, options) => {
    const stats = await fsp.lstat(filePath, options);
    if (path.resolve(String(filePath)) !== targetDirectory) return stats;
    const identity = changed ? 9_007_199_254_740_993n : 9_007_199_254_740_992n;
    return statsWithIdentity(stats, options?.bigint === true ? identity : Number(identity));
  };
  filesystem.opendir = async (directoryPath, ...args) => {
    if (path.resolve(String(directoryPath)) === targetDirectory) changed = true;
    return fsp.opendir(directoryPath, ...args);
  };
  const guardContent = (filePath) => {
    if (!path.resolve(String(filePath)).startsWith(`${canonicalRoot}${path.sep}`)) return;
    contentReads += 1;
    throw new Error("source content must not be opened");
  };
  filesystem.open = async (filePath, ...args) => {
    guardContent(filePath);
    return fsp.open(filePath, ...args);
  };
  filesystem.readFile = async (filePath, ...args) => {
    guardContent(filePath);
    return fsp.readFile(filePath, ...args);
  };
  return Object.freeze({
    filesystem,
    identityChanged: () => changed,
    contentReads: () => contentReads
  });
}

function nanosecondDirectoryMutationFilesystem(fixture) {
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  const targetDirectory = path.join(canonicalRoot, "visual assets");
  let changed = false;
  let contentReads = 0;
  const filesystem = Object.create(fsp);
  filesystem.lstat = async (filePath, options) => {
    const stats = await fsp.lstat(filePath, options);
    if (path.resolve(String(filePath)) !== targetDirectory || options?.bigint !== true) return stats;
    const mtimeNs = stats.mtimeNs + (changed ? 1n : 0n);
    return new Proxy(stats, {
      get(target, property) {
        if (property === "mtimeNs") return mtimeNs;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };
  filesystem.opendir = async (directoryPath, ...args) => {
    if (path.resolve(String(directoryPath)) === targetDirectory) changed = true;
    return fsp.opendir(directoryPath, ...args);
  };
  const guardContent = (filePath) => {
    if (!path.resolve(String(filePath)).startsWith(`${canonicalRoot}${path.sep}`)) return;
    contentReads += 1;
    throw new Error("source content must not be opened");
  };
  filesystem.open = async (filePath, ...args) => {
    guardContent(filePath);
    return fsp.open(filePath, ...args);
  };
  filesystem.readFile = async (filePath, ...args) => {
    guardContent(filePath);
    return fsp.readFile(filePath, ...args);
  };
  return Object.freeze({
    filesystem,
    wasMutated: () => changed,
    contentReads: () => contentReads
  });
}

async function authorizeCampaignSource(fixture) {
  fixture.canonicalFixtureRoot = fs.realpathSync(fixture.root);
  fixture.canonicalSourceRoot = fs.realpathSync(fixture.sourceRoot);
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
  await grantProjectSource({
    ...grantOptions,
    operationId: grantPreview.operation_id,
    planFingerprint: grantPreview.plan_fingerprint,
    apply: true
  });
  fixture.localStateBeforeRetrieval = snapshotNonReceiptLocalState(fixture);
}

async function assertUnsafeSpecialEntry(fixture, canary) {
  await authorizeCampaignSource(fixture);
  const sourceBefore = snapshotTree(fixture.sourceRoot);
  const portableBefore = snapshotTree(fixture.aiosPath);
  const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

  const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

  assert.equal(result.decision, "refused");
  assert.equal(result.reason, "source-unsafe-entry");
  assert.deepEqual(result.references, []);
  assert.deepEqual(instrumentation.observations(), []);
  assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
  assertSingleSafeRefusal(fixture, result, canary);
}

async function assertBoundRefusal(fixture, options = {}) {
  await authorizeCampaignSource(fixture);
  const sourceBefore = snapshotTree(fixture.sourceRoot);
  const portableBefore = snapshotTree(fixture.aiosPath);
  const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

  const result = await retrieveCampaignSource(
    fixture,
    instrumentation.filesystem,
    options.retrievalOptions
  );

  assert.equal(result.decision, "refused");
  assert.equal(result.reason, options.reason || "source-bound-exceeded");
  assert.deepEqual(result.references, []);
  assert.deepEqual(instrumentation.observations(), []);
  assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
  assertSingleSafeRefusal(fixture, result, options.canary || "CONTENT_READ_CANARY");
  return result;
}

async function assertAllowedRetrieval(fixture, options = {}) {
  await authorizeCampaignSource(fixture);
  const sourceBefore = snapshotTree(fixture.sourceRoot);
  const portableBefore = snapshotTree(fixture.aiosPath);
  const instrumentation = contentReadGuard(fixture, path.join(fixture.root, "never-read"));

  const result = await retrieveCampaignSource(fixture, instrumentation.filesystem);

  assert.equal(result.decision, "allowed");
  assert.equal(result.references.length, options.expectedReferences);
  assert.deepEqual(instrumentation.observations(), []);
  assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
  assert.deepEqual(snapshotNonReceiptLocalState(fixture), fixture.localStateBeforeRetrieval);
  const receipts = fs.readFileSync(accessReceiptPath(fixture), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].decision, "allowed");
  assert.deepEqual(receipts[0].references, result.references);
  const serialized = JSON.stringify({ result, receipts });
  for (const absoluteRoot of [fixture.root, fixture.canonicalFixtureRoot, fixture.sourceRoot, fixture.canonicalSourceRoot]) {
    assert.equal(serialized.includes(absoluteRoot), false);
  }
  assert.equal(serialized.includes(options.canary || "CONTENT_READ_CANARY"), false);
  return result;
}

function retrieveCampaignSource(fixture, filesystem = fsp, overrides = {}) {
  return retrieveProjectSource({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectSelector: "acme-campaign",
    task: CAMPAIGN_TASK,
    createId: () => "a11-safe-receipt",
    now: () => new Date("2098-01-01T00:00:00.000Z"),
    filesystem,
    ...overrides
  });
}

function contentReadGuard(fixture, outsidePath) {
  let observations = [];
  const canonicalRoot = fs.realpathSync(fixture.sourceRoot);
  const canonicalOutside = canonicalPathOrResolved(outsidePath);
  const filesystem = Object.create(fsp);
  const isOutside = (candidate) => (
    candidate === canonicalOutside || candidate.startsWith(`${canonicalOutside}${path.sep}`)
  );
  const guard = (filePath, operation) => {
    const candidate = path.resolve(String(filePath));
    if (
      isOutside(candidate)
      || candidate.startsWith(`${canonicalRoot}${path.sep}`)
    ) {
      observations = [...observations, `${operation}:${candidate}`];
      throw new Error("source content must not be opened");
    }
  };
  filesystem.readFile = async (filePath, ...args) => {
    guard(filePath, "readFile");
    return fsp.readFile(filePath, ...args);
  };
  filesystem.open = async (filePath, ...args) => {
    guard(filePath, "open");
    return fsp.open(filePath, ...args);
  };
  filesystem.lstat = async (filePath, ...args) => {
    const candidate = path.resolve(String(filePath));
    if (isOutside(candidate)) {
      observations = [...observations, `lstat:${candidate}`];
      throw new Error("sibling metadata must not be observed");
    }
    return fsp.lstat(filePath, ...args);
  };
  filesystem.realpath = async (filePath, ...args) => {
    const resolved = await fsp.realpath(filePath, ...args);
    const candidate = path.resolve(String(resolved));
    if (isOutside(candidate)) {
      observations = [...observations, `realpath:${candidate}`];
      throw new Error("sibling target must not be resolved");
    }
    return resolved;
  };
  return Object.freeze({ filesystem, observations: () => observations });
}

function statsWithIdentity(stats, identity) {
  return new Proxy(stats, {
    get(target, property) {
      if (property === "dev" || property === "ino") return identity;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function statFingerprint(stats) {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: stats.mode.toString(),
    nlink: stats.nlink.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString()
  };
}

function projectAllowedTemplate(template, receiptId, pathPadding, paddedPath = "output-000.txt") {
  const references = template.references.map((reference) => ({
    ...reference,
    path: reference.path === paddedPath
      ? `${paddedPath.slice(0, -4)}${"x".repeat(pathPadding)}.txt`
      : reference.path,
    receipt_id: receiptId
  }));
  return JSON.stringify({ ...template, receipt_id: receiptId, references });
}

async function addEmptyFiles(fixture, count, prefix) {
  await runInBatches(count, (index) => (
    fsp.writeFile(
      path.join(fixture.sourceRoot, `${prefix}-${String(index).padStart(3, "0")}.txt`),
      ""
    )
  ));
}

async function runInBatches(count, operation, batchSize = 128) {
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => operation(start + offset)));
  }
}

function canonicalPathOrResolved(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return path.resolve(candidate);
    throw error;
  }
}

function assertSingleSafeRefusal(fixture, result, canary) {
  const receiptPath = accessReceiptPath(fixture);
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].decision, "refused");
  assert.equal(receipts[0].reason, result.reason);
  assert.deepEqual(receipts[0].references, []);
  assert.deepEqual(snapshotNonReceiptLocalState(fixture), fixture.localStateBeforeRetrieval);
  assert.equal(fs.existsSync(path.join(path.dirname(receiptPath), "access-receipts.inflight.json")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(receiptPath), "access-receipts.lock")), false);
  const serialized = JSON.stringify({ result, receipts });
  for (const absoluteRoot of [fixture.root, fixture.canonicalFixtureRoot, fixture.sourceRoot, fixture.canonicalSourceRoot]) {
    assert.equal(serialized.includes(absoluteRoot), false);
  }
  assert.equal(serialized.includes(canary), false);
}

function accessReceiptPath(fixture) {
  return path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
}

function snapshotNonReceiptLocalState(fixture) {
  const localRoot = path.join(fixture.homePath, ".dotaios");
  return snapshotTree(localRoot)
    .filter((entry) => (
      entry.path !== "project-sources"
      && !entry.path.startsWith("project-sources/access-receipts")
    ))
    .map((entry) => (
      entry.type === "directory"
        ? { path: entry.path, type: entry.type }
        : { path: entry.path, type: entry.type, mode: entry.mode, bytes: entry.bytes }
    ));
}
