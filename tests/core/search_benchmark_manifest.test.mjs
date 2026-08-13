import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  assertExactResults,
  generateFixture,
  loadManifest,
  manifestReceipt,
  runUnsafeBenchmarkOnlyRawSearchSample
} from "../../scripts/bench-search.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = path.join(repoRoot, "benchmarks", "search", "manifest.json");

test("the same manifest and seed produce the same fixture inventory and controlled order", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-benchmark-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = await loadManifest(manifestPath);
  const selection = {
    fileCount: Math.min(...manifest.corpus.fileCounts),
    layout: "shallow",
    distribution: "prose"
  };

  const first = await generateFixture({ manifest, destination: path.join(root, "first"), selection });
  const second = await generateFixture({ manifest, destination: path.join(root, "second"), selection });

  assert.equal(first.inventorySha256, second.inventorySha256);
  assert.deepEqual(first.controlledResults, second.controlledResults);
  assert.deepEqual(first.controlledResults["low-hit"], second.controlledResults["low-hit"]);
  assert.equal(manifestReceipt(manifest), first.manifestSha256);
  assert.equal(first.fileCount, selection.fileCount);
  assert.ok(first.controlledResults["low-hit"].length > 0);
});

test("any manifest corpus, query, or protocol change invalidates the receipt", async () => {
  const manifest = await loadManifest(manifestPath);
  const changedQuery = structuredClone(manifest);
  changedQuery.queries[0].text += " changed";
  const changedProtocol = structuredClone(manifest);
  changedProtocol.protocol.warmupSamples += 1;
  const changedCorpus = structuredClone(manifest);
  changedCorpus.corpus.generator.seed += 1;

  const original = manifestReceipt(manifest);
  assert.notEqual(manifestReceipt(changedQuery), original);
  assert.notEqual(manifestReceipt(changedProtocol), original);
  assert.notEqual(manifestReceipt(changedCorpus), original);
});

test("fixture generation rejects an outside path that resolves back into the repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-benchmark-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryLink = path.join(root, "repository");
  await fs.symlink(repoRoot, repositoryLink);
  const destination = path.join(repositoryLink, `.benchmark-escape-${process.pid}`);
  const manifest = await loadManifest(manifestPath);

  await assert.rejects(
    () => generateFixture({
      manifest,
      destination,
      selection: { fileCount: 500, layout: "shallow", distribution: "prose" }
    }),
    /outside the repository/i
  );
  await assert.rejects(() => fs.lstat(path.join(repoRoot, path.basename(destination))), { code: "ENOENT" });
});

test("timing validation rejects empty and misordered controlled search output", () => {
  const expected = ["vault/controlled-0001.md", "vault/controlled-0002.md"];

  assert.throws(
    () => assertExactResults([], expected, { queryId: "low-hit" }),
    /empty controlled result/i
  );
  assert.throws(
    () => assertExactResults([...expected].reverse(), expected, { queryId: "low-hit" }),
    /result mismatch/i
  );
  assert.doesNotThrow(() => assertExactResults(expected, expected, { queryId: "low-hit" }));
});

test("the CLI harness exits nonzero before timing a mismatched controlled fixture", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-benchmark-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = await loadManifest(manifestPath);
  const fixtureRoot = path.join(root, "fixture");
  const receipt = await generateFixture({
    manifest,
    destination: fixtureRoot,
    selection: { fileCount: 500, layout: "shallow", distribution: "prose" }
  });
  receipt.controlledResults["low-hit"].reverse();
  const receiptPath = path.join(root, "receipt.json");
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "bench-search.mjs"),
    "run",
    "--fixture", fixtureRoot,
    "--receipt", receiptPath
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatch/i);
});

test("the unsafe benchmark-only raw search validates exact order before accepting a sample", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-raw-search-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = await loadManifest(manifestPath);
  const fixtureRoot = path.join(root, "fixture");
  const fixtureReceipt = await generateFixture({
    manifest,
    destination: fixtureRoot,
    selection: { fileCount: 500, layout: "shallow", distribution: "prose" }
  });
  const query = manifest.queries.find(({ id }) => id === "low-hit");
  const expected = fixtureReceipt.controlledResults[query.id];

  const sample = await runUnsafeBenchmarkOnlyRawSearchSample({
    manifest,
    fixtureRoot,
    fixtureReceipt,
    query,
    expectedResults: expected
  });

  assert.deepEqual(sample.exactResults, expected);
  assert.deepEqual(sample.operations, { lstat: 0, realpath: 0, open: 500 });
  await assert.rejects(
    () => runUnsafeBenchmarkOnlyRawSearchSample({
      manifest,
      fixtureRoot,
      fixtureReceipt,
      query,
      expectedResults: [...expected].reverse()
    }),
    /result mismatch/i
  );
});
