import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  assertExactResults,
  createBenchmarkReport,
  generateFixture,
  loadManifest,
  manifestReceipt,
  runPublicSearchBenchmarkSample,
  runSafeCorpusReadBenchmarkSample,
  assertPublicSearchOperationGate,
  runUnsafeBenchmarkOnlyRawSearchSample
} from "../../scripts/bench-search.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = path.join(repoRoot, "benchmarks", "search", "manifest.json");
const benchmarkReceiptPaths = [
  path.join(repoRoot, "docs", "internal", "benchmarks", "2026-08-13-search-baseline.md"),
  path.join(repoRoot, "docs", "internal", "benchmarks", "2026-08-13-search-optimized.md"),
  path.join(repoRoot, "docs", "internal", "benchmarks", "2026-08-13-search-final.md")
];
const finalReportsDirectory = path.join(repoRoot, "docs", "internal", "benchmarks", "reports");

function declaredManifestReceipt(receiptPath, receipt) {
  const declarations = [...receipt.matchAll(/^\- Manifest SHA-256: `([^`]+)`\s*$/gmi)];
  assert.equal(
    declarations.length,
    1,
    `${path.relative(repoRoot, receiptPath)} must declare exactly one Manifest SHA-256.`
  );

  const receiptHash = declarations[0][1];
  assert.match(
    receiptHash,
    /^[a-f0-9]{64}$/,
    `${path.relative(repoRoot, receiptPath)} must declare a lowercase SHA-256 digest.`
  );
  return receiptHash;
}

function expectedReportResults(query, selection, manifest) {
  let indices;
  if (query.expectation.kind === "none") {
    indices = [];
  } else if (query.expectation.kind === "fixed-indices") {
    indices = query.expectation.fileIndices;
  } else if (query.expectation.kind === "modulo") {
    indices = [];
    for (
      let index = query.expectation.remainder;
      index < selection.fileCount;
      index += query.expectation.modulo
    ) indices.push(index);
  } else {
    throw new Error(`Unsupported query expectation kind: ${query.expectation.kind}.`);
  }
  const paths = indices.map((index) => {
    const file = `note-${String(index).padStart(5, "0")}.md`;
    if (selection.layout === "shallow") {
      return `vault/bucket-${String(index % manifest.corpus.layouts.shallow.bucketCount).padStart(2, "0")}/${file}`;
    }
    const branching = manifest.corpus.layouts.nested.branchingFactor;
    return `vault/branch-${String(Math.floor(index / (branching ** 2)) % branching).padStart(2, "0")}`
      + `/branch-${String(Math.floor(index / branching) % branching).padStart(2, "0")}`
      + `/branch-${String(index % branching).padStart(2, "0")}/${file}`;
  }).sort();
  return paths.slice(0, query.expectation.resultLimit ?? paths.length);
}

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

test("the safe benchmark sample measures complete default all-scope searchAios", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-public-search-benchmark-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = await loadManifest(manifestPath);
  assert.deepEqual(manifest.corpus.fileCounts, [500, 2500, 10000], "the formal matrix stays fixed");
  const fixtureRoot = path.join(root, "fixture");
  const fixtureReceipt = await generateFixture({
    manifest,
    destination: fixtureRoot,
    selection: { fileCount: 500, layout: "shallow", distribution: "prose" }
  });
  const query = manifest.queries.find(({ id }) => id === "low-hit");
  const highHitQuery = manifest.queries.find(({ id }) => id === "high-hit");

  const sample = await runPublicSearchBenchmarkSample({ manifest, fixtureRoot, fixtureReceipt, query });
  const highHitSample = await runPublicSearchBenchmarkSample({
    manifest,
    fixtureRoot,
    fixtureReceipt,
    query: highHitQuery
  });
  const safeControl = await runSafeCorpusReadBenchmarkSample({ manifest, fixtureRoot, fixtureReceipt });

  assert.deepEqual(sample.exactResults, fixtureReceipt.controlledResults[query.id]);
  assert.ok(sample.exactResults.length > 0, "the controlled low-hit proof cannot be vacuous");
  assert.deepEqual(highHitSample.exactResults, fixtureReceipt.controlledResults[highHitQuery.id]);
  assert.ok(highHitSample.exactResults.length > 0, "the controlled high-hit proof cannot be vacuous");
  assert.deepEqual(sample.surface, {
    entryPoint: "searchAios",
    requestedScope: "all",
    completeness: "complete",
    omissions: [],
    returnedScopes: ["sessions", "context", "memory", "vault", "decisions", "skills", "references", "plugins"]
  });
  assert.doesNotThrow(() => assertPublicSearchOperationGate(
    [
      { id: query.id, warm: { operations: sample.operations } },
      { id: highHitQuery.id, warm: { operations: highHitSample.operations } }
    ],
    { warm: { operations: safeControl.operations } }
  ));
});

test("new benchmark reports are v2 while checked-in v1 receipts remain historical", async () => {
  const manifest = await loadManifest(manifestPath);
  const operations = { lstat: 10, realpath: 2, open: 1 };
  const report = createBenchmarkReport({
    manifest,
    fixtureReceipt: {
      inventorySha256: "0".repeat(64),
      selection: { fileCount: 500, layout: "shallow", distribution: "prose" }
    },
    searches: [{ id: "low-hit", warm: { operations } }],
    rawSearchControl: [],
    rawReadControl: {},
    safeCorpusReadControl: { warm: { operations } }
  });

  assert.equal(report.schemaVersion, "dotaios-search-benchmark-result/v2");
  assert.deepEqual(report.searchSurface, {
    entryPoint: "searchAios",
    requestedScope: "all",
    completeness: "complete"
  });
  assert.equal(report.operationGate.passed, true);
});

test("the public operation gate rejects per-file containment multiplication", () => {
  const safeControl = { warm: { operations: { lstat: 2_100, realpath: 200, open: 500 } } };
  assert.doesNotThrow(() => assertPublicSearchOperationGate(
    [{ id: "optimized", warm: { operations: { lstat: 2_300, realpath: 210, open: 500 } } }],
    safeControl
  ));
  assert.throws(
    () => assertPublicSearchOperationGate(
      [{ id: "regressed", warm: { operations: { lstat: 20_000, realpath: 9_000, open: 500 } } }],
      safeControl
    ),
    /operation gate/i
  );
});

test("the public operation gate rejects malformed counters before arithmetic", () => {
  const validSearches = [{
    id: "controlled",
    warm: { operations: { lstat: 120, realpath: 30, open: 10 } }
  }];
  const validControl = { warm: { operations: { lstat: 100, realpath: 20, open: 10 } } };
  const validAllowance = { lstat: 32, realpath: 16, open: 2 };
  const invalidValues = [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, "1"];

  for (const counter of ["lstat", "realpath", "open"]) {
    for (const location of ["search", "control", "allowance"]) {
      for (const invalid of invalidValues) {
        const searches = structuredClone(validSearches);
        const control = structuredClone(validControl);
        const allowance = structuredClone(validAllowance);
        const target = location === "search"
          ? searches[0].warm.operations
          : location === "control"
            ? control.warm.operations
            : allowance;
        target[counter] = invalid;
        assert.throws(
          () => assertPublicSearchOperationGate(searches, control, allowance),
          /non-negative safe integer/i,
          `${location}.${counter} must reject ${String(invalid)}`
        );
      }

      const searches = structuredClone(validSearches);
      const control = structuredClone(validControl);
      const allowance = structuredClone(validAllowance);
      const target = location === "search"
        ? searches[0].warm.operations
        : location === "control"
          ? control.warm.operations
          : allowance;
      delete target[counter];
      assert.throws(
        () => assertPublicSearchOperationGate(searches, control, allowance),
        /non-negative safe integer/i,
        `${location}.${counter} must reject a missing value`
      );
    }
  }
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

test("checked-in benchmark receipts declare the current manifest receipt", async () => {
  const expectedManifestReceipt = manifestReceipt(await loadManifest(manifestPath));

  for (const receiptPath of benchmarkReceiptPaths) {
    const receipt = await fs.readFile(receiptPath, "utf8");
    assert.equal(declaredManifestReceipt(receiptPath, receipt), expectedManifestReceipt, receiptPath);
  }
});

test("final benchmark reports cover the frozen matrix and retain exact authority", async () => {
  const manifest = await loadManifest(manifestPath);
  const expectedManifestReceipt = manifestReceipt(manifest);
  const expectedSelections = manifest.corpus.fileCounts.flatMap((fileCount) =>
    manifest.corpus.scenarioMatrix.map(({ layout, distribution }) =>
      `${fileCount}:${layout}:${distribution}`
    )
  );
  const reportNames = (await fs.readdir(finalReportsDirectory))
    .filter((name) => name.startsWith("2026-08-13-") && name.endsWith(".report.json"))
    .sort();
  assert.equal(reportNames.length, expectedSelections.length);

  const selections = [];
  for (const reportName of reportNames) {
    const report = JSON.parse(await fs.readFile(path.join(finalReportsDirectory, reportName), "utf8"));
    assert.equal(report.schemaVersion, "dotaios-search-benchmark-result/v1");
    assert.equal(report.manifestSha256, expectedManifestReceipt);
    assert.equal(Object.hasOwn(report.runtime, "hostname"), false);
    assert.deepEqual(report.protocol, manifest.protocol);
    assert.deepEqual(report.searches.map(({ id }) => id), manifest.queries.map(({ id }) => id));
    assert.equal(report.searches.every(({ warm }) => warm.samples === manifest.protocol.measuredSamples), true);
    assert.equal(report.rawSearchControl.length, report.searches.length);
    for (const result of report.searches) {
      assert.equal(
        report.rawSearchControl.find(({ id }) => id === result.id)?.outputSha256,
        result.outputSha256,
        `${reportName}:${result.id} must preserve exact safe/unsafe output parity.`
      );
    }
    selections.push(
      `${report.selection.fileCount}:${report.selection.layout}:${report.selection.distribution}`
    );
  }

  assert.deepEqual(selections.sort(), expectedSelections.sort());
});

test("public v2 benchmark reports prove the exact six-cell product-search matrix", async () => {
  const manifest = await loadManifest(manifestPath);
  const expectedSelections = manifest.corpus.fileCounts.flatMap((fileCount) =>
    manifest.corpus.scenarioMatrix.map(({ layout, distribution }) =>
      `${fileCount}:${layout}:${distribution}`
    )
  ).sort();
  const reportNames = (await fs.readdir(finalReportsDirectory))
    .filter((name) => name.startsWith("2026-08-14-public-") && name.endsWith(".report.json"))
    .sort();
  assert.equal(reportNames.length, 6);

  const selections = [];
  for (const reportName of reportNames) {
    const report = JSON.parse(await fs.readFile(path.join(finalReportsDirectory, reportName), "utf8"));
    assert.equal(report.schemaVersion, "dotaios-search-benchmark-result/v2");
    assert.equal(report.benchmarkId, manifest.benchmarkId);
    assert.equal(report.manifestSha256, manifestReceipt(manifest));
    assert.deepEqual(report.protocol, manifest.protocol);
    assert.deepEqual(report.searchSurface, {
      entryPoint: "searchAios",
      requestedScope: "all",
      completeness: "complete"
    });
    assert.deepEqual(report.searches.map(({ id }) => id), manifest.queries.map(({ id }) => id));
    assert.deepEqual(report.rawSearchControl.map(({ id }) => id), manifest.queries.map(({ id }) => id));
    for (const [index, query] of manifest.queries.entries()) {
      const search = report.searches[index];
      const rawControl = report.rawSearchControl[index];
      const expected = expectedReportResults(query, report.selection, manifest);
      assert.deepEqual(search.surface, {
        entryPoint: "searchAios",
        requestedScope: "all",
        completeness: "complete",
        omissions: [],
        returnedScopes: ["sessions", "context", "memory", "vault", "decisions", "skills", "references", "plugins"]
      });
      assert.deepEqual(search.exactResults, expected, `${reportName}:${query.id} controlled order`);
      assert.deepEqual(rawControl.exactResults, expected, `${reportName}:${query.id} raw controlled order`);
      assert.match(search.outputSha256, /^[a-f0-9]{64}$/);
      assert.equal(rawControl.outputSha256, search.outputSha256, `${reportName}:${query.id} output hash`);
    }
    assert.equal(report.operationGate.passed, true);
    const validatedGate = assertPublicSearchOperationGate(
      report.searches,
      report.safeCorpusReadControl,
      report.operationGate.allowance
    );
    assert.equal(report.operationGate.comparison, validatedGate.comparison);
    selections.push(
      `${report.selection.fileCount}:${report.selection.layout}:${report.selection.distribution}`
    );
  }

  assert.deepEqual(selections.sort(), expectedSelections);
});

test("manifest validation rejects malformed harness sampling and scenario fields", async () => {
  const manifest = await loadManifest(manifestPath);
  for (const mutate of [
    (value) => { value.protocol.resultLimit = 0; },
    (value) => { value.protocol.rssPollIntervalMs = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.corpus.scenarioMatrix = []; },
    (value) => { value.corpus.scenarioMatrix = [{ layout: "missing", distribution: "prose" }]; },
    (value) => { value.queries[1].expectation.fileIndices = null; },
    (value) => { value.queries[1].expectation.fileIndices = [3, -1]; },
    (value) => { value.queries[2].expectation.modulo = 0; },
    (value) => { value.queries[2].expectation.modulo = Number.POSITIVE_INFINITY; },
    (value) => { value.queries[2].expectation.remainder = -1; },
    (value) => { value.queries[2].expectation.remainder = value.queries[2].expectation.modulo; }
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid);
    assert.throws(() => manifestReceipt(invalid));
  }
});

test("the public manifest receipt rejects unknown query expectation kinds", async () => {
  const manifest = await loadManifest(manifestPath);
  manifest.queries[0].expectation.kind = "future-kind";

  assert.throws(
    () => manifestReceipt(manifest),
    /unsupported query expectation kind/i
  );
});

test("benchmark commands reserve exclusive output before reading or timing fixtures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-benchmark-output-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const occupied = path.join(root, "occupied.json");
  const missingReceipt = path.join(root, "missing-receipt.json");
  await fs.writeFile(occupied, "do not replace\n");

  for (const command of ["run", "raw-search"]) {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "bench-search.mjs"),
      command,
      "--fixture", path.join(root, "missing-fixture"),
      "--receipt", missingReceipt,
      "--output", occupied
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.doesNotMatch(result.stderr, /missing-receipt/);
    assert.equal(await fs.readFile(occupied, "utf8"), "do not replace\n");
  }
});

test("fixture generation rejects a repository destination without reserving its receipt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-benchmark-preflight-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(repoRoot, `.benchmark-invalid-${process.pid}`);
  const receiptPath = path.join(root, "invalid.receipt.json");

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "bench-search.mjs"),
    "generate",
    "--output", destination,
    "--receipt", receiptPath,
    "--count", "500",
    "--layout", "shallow",
    "--distribution", "prose"
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the repository/i);
  await assert.rejects(() => fs.lstat(receiptPath), { code: "ENOENT" });
  await assert.rejects(() => fs.lstat(destination), { code: "ENOENT" });
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
