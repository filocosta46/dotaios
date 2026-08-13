#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createEvidenceReader } from "../packages/core/src/evidence-reader.mjs";
import { searchMarkdownDir } from "../packages/core/src/search.mjs";

const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const defaultManifestPath = path.join(repoRoot, "benchmarks", "search", "manifest.json");
const PROSE_WORDS = [
  "account", "action", "agent", "archive", "brief", "campaign", "client", "context",
  "decision", "delivery", "evidence", "experiment", "feedback", "handoff", "identity", "insight",
  "launch", "market", "memory", "metric", "note", "outcome", "owner", "pipeline",
  "plan", "priority", "project", "proposal", "question", "receipt", "research", "review",
  "roadmap", "scope", "search", "session", "signal", "source", "strategy", "summary",
  "task", "timeline", "update", "validation", "workflow", "workspace", "writer", "year"
];

export async function loadManifest(filePath = defaultManifestPath) {
  const manifest = JSON.parse(await fs.readFile(filePath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

export function manifestReceipt(manifest) {
  validateManifest(manifest);
  return sha256(canonicalJson(manifest));
}

export async function generateFixture({ manifest, destination, selection }) {
  validateManifest(manifest);
  validateSelection(manifest, selection);
  const fixtureRoot = path.resolve(destination);
  assertOutsideRepository(fixtureRoot);
  await ensureEmptyDirectory(fixtureRoot);

  const expectedByQuery = Object.fromEntries(manifest.queries.map(({ id }) => [id, []]));
  const inventory = [];
  const concurrency = Math.max(1, Math.min(64, manifest.protocol.concurrency));
  const fixedMtime = new Date(manifest.corpus.generator.fixedMtime);

  for (let start = 0; start < selection.fileCount; start += concurrency) {
    const generated = await Promise.all(
      Array.from({ length: Math.min(concurrency, selection.fileCount - start) }, async (_, offset) => {
        const index = start + offset;
        const relativePath = fixtureRelativePath(index, selection, manifest);
        const content = fixtureContent(index, selection, manifest);
        const absolutePath = path.join(fixtureRoot, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, { flag: "wx" });
        await fs.utimes(absolutePath, fixedMtime, fixedMtime);
        return {
          path: relativePath,
          bytes: Buffer.byteLength(content),
          sha256: sha256(content),
          mtime: manifest.corpus.generator.fixedMtime
        };
      })
    );
    inventory.push(...generated);
  }

  inventory.sort((left, right) => left.path.localeCompare(right.path));
  for (const query of manifest.queries) {
    expectedByQuery[query.id] = expectedFilesForQuery(query, inventory)
      .map((relativePath) => `vault/${relativePath}`);
  }
  const inventorySha256 = sha256(canonicalJson(inventory));
  const totalBytes = inventory.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    schemaVersion: "dotaios-search-fixture-receipt/v1",
    manifestSha256: manifestReceipt(manifest),
    generator: { ...manifest.corpus.generator },
    selection: { ...selection },
    fileCount: inventory.length,
    totalBytes,
    inventorySha256,
    controlledResults: expectedByQuery,
    inventory
  };
}

export function assertExactResults(actual, expected, { queryId = "controlled" } = {}) {
  if (expected.length > 0 && actual.length === 0) {
    throw new Error(`Benchmark rejected empty controlled result for ${queryId}.`);
  }
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(
      `Benchmark result mismatch for ${queryId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`
    );
  }
}

export async function runBenchmark({ manifest, fixtureRoot, fixtureReceipt }) {
  validateManifest(manifest);
  validateFixtureReceipt(manifest, fixtureRoot, fixtureReceipt);
  validateRuntime(manifest);
  await verifyFixtureInventory(fixtureRoot, fixtureReceipt);

  const searches = [];
  for (const query of manifest.queries) {
    searches.push(await measureOperation({
      id: query.id,
      manifest,
      operation: () => runContainedSearch({ manifest, fixtureRoot, fixtureReceipt, query })
    }));
  }
  const rawSearchControl = await measureRawSearchControl({ manifest, fixtureRoot, fixtureReceipt });
  const rawReadControl = await measureOperation({
    id: "raw-read-control",
    manifest,
    operation: () => runRawReadControl({ manifest, fixtureRoot, fixtureReceipt })
  });
  await verifyFixtureInventory(fixtureRoot, fixtureReceipt);

  return {
    schemaVersion: "dotaios-search-benchmark-result/v1",
    benchmarkId: manifest.benchmarkId,
    manifestSha256: manifestReceipt(manifest),
    inventorySha256: fixtureReceipt.inventorySha256,
    selection: fixtureReceipt.selection,
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      hostname: os.hostname()
    },
    protocol: { ...manifest.protocol },
    searches,
    rawSearchControl,
    rawReadControl
  };
}

/**
 * Measure only the residual canonical search logic over an immutable fixture.
 *
 * UNSAFE BENCHMARK-ONLY CONTROL: this deliberately omits lexical/canonical
 * containment, ancestor validation, directory-generation checks, and the
 * request budget. It must never move into packages/core or a product caller.
 */
export async function runRawSearchBenchmark({ manifest, fixtureRoot, fixtureReceipt }) {
  validateManifest(manifest);
  validateFixtureReceipt(manifest, fixtureRoot, fixtureReceipt);
  validateRuntime(manifest);
  await verifyFixtureInventory(fixtureRoot, fixtureReceipt);
  const rawSearchControl = await measureRawSearchControl({ manifest, fixtureRoot, fixtureReceipt });
  await verifyFixtureInventory(fixtureRoot, fixtureReceipt);
  return {
    schemaVersion: "dotaios-search-raw-search-control-result/v1",
    benchmarkId: manifest.benchmarkId,
    control: Object.freeze({
      id: "raw-search-control-v1",
      safety: "unsafe-benchmark-only",
      protocolAuthority: "harness-schema-v1-reusing-frozen-manifest-sampling"
    }),
    manifestSha256: manifestReceipt(manifest),
    inventorySha256: fixtureReceipt.inventorySha256,
    selection: fixtureReceipt.selection,
    runtime: runtimeReceipt(),
    protocol: { ...manifest.protocol },
    rawSearchControl
  };
}

export async function verifyFixtureInventory(fixtureRoot, fixtureReceipt) {
  const actual = [];
  const pending = [path.resolve(fixtureRoot)];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`Fixture inventory contains an unsafe entry: ${path.relative(fixtureRoot, absolutePath)}.`);
      }
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      const stats = await fs.lstat(absolutePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Fixture inventory changed while validating: ${path.relative(fixtureRoot, absolutePath)}.`);
      }
      const bytes = await fs.readFile(absolutePath);
      actual.push({
        path: path.relative(fixtureRoot, absolutePath).split(path.sep).join("/"),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        mtime: stats.mtime.toISOString()
      });
    }
  }
  actual.sort((left, right) => left.path.localeCompare(right.path));
  const actualHash = sha256(canonicalJson(actual));
  if (actualHash !== fixtureReceipt.inventorySha256) {
    throw new Error(
      `Fixture inventory mismatch: expected ${fixtureReceipt.inventorySha256}, got ${actualHash}.`
    );
  }
  return actualHash;
}

async function runContainedSearch({ manifest, fixtureRoot, fixtureReceipt, query }) {
  const { filesystem, counts } = countingFilesystem();
  const reader = createEvidenceReader({ roots: [fixtureRoot], filesystem });
  const rss = monitorRss(manifest.protocol.rssPollIntervalMs);
  const started = process.hrtime.bigint();
  try {
    const results = await searchMarkdownDir(fixtureRoot, query.text, {
      limit: query.expectation.resultLimit ?? manifest.protocol.resultLimit,
      sourcePrefix: "vault",
      reader,
      root: fixtureRoot
    });
    const sources = results.map(({ source }) => source);
    assertExactResults(sources, fixtureReceipt.controlledResults[query.id], { queryId: query.id });
    return {
      durationMs: elapsedMs(started),
      peakRssBytes: rss.stop(),
      operations: { ...counts },
      readBudget: reader.snapshot(),
      exactResults: sources,
      outputSha256: sha256(canonicalJson(results))
    };
  } catch (error) {
    rss.stop();
    throw error;
  }
}

async function measureRawSearchControl({ manifest, fixtureRoot, fixtureReceipt }) {
  const controls = [];
  for (const query of manifest.queries) {
    const measurement = await measureOperation({
      id: query.id,
      manifest,
      operation: () => runUnsafeBenchmarkOnlyRawSearchSample({
        manifest,
        fixtureRoot,
        fixtureReceipt,
        query,
        expectedResults: fixtureReceipt.controlledResults[query.id]
      })
    });
    controls.push({ safety: "unsafe-benchmark-only", ...measurement });
  }
  return controls;
}

/**
 * Run one deliberately unsafe benchmark-only raw-search sample.
 *
 * This export exists only so the benchmark regression test can prove that the
 * control rejects wrong output before a duration is accepted. Product code
 * must use createEvidenceReader instead.
 */
export async function runUnsafeBenchmarkOnlyRawSearchSample({
  manifest,
  fixtureRoot,
  fixtureReceipt,
  query,
  expectedResults = fixtureReceipt.controlledResults[query.id]
}) {
  const reader = createUnsafeBenchmarkOnlyRawSearchReader({ fixtureRoot, fixtureReceipt });
  const rss = monitorRss(manifest.protocol.rssPollIntervalMs);
  const started = process.hrtime.bigint();
  try {
    const results = await searchMarkdownDir(fixtureRoot, query.text, {
      limit: query.expectation.resultLimit ?? manifest.protocol.resultLimit,
      sourcePrefix: "vault",
      reader,
      root: fixtureRoot
    });
    const sources = results.map(({ source }) => source);
    assertExactResults(sources, expectedResults, { queryId: `raw-search-control:${query.id}` });
    return {
      durationMs: elapsedMs(started),
      peakRssBytes: rss.stop(),
      operations: reader.operations(),
      readBudget: reader.snapshot(),
      exactResults: sources,
      outputSha256: sha256(canonicalJson(results))
    };
  } catch (error) {
    rss.stop();
    throw error;
  }
}

function createUnsafeBenchmarkOnlyRawSearchReader({ fixtureRoot, fixtureReceipt }) {
  const resolvedRoot = path.resolve(fixtureRoot);
  const inventoryByPath = new Map(fixtureReceipt.inventory.map((entry) => {
    const absolutePath = path.join(resolvedRoot, ...entry.path.split("/"));
    return [absolutePath, entry];
  }));
  const files = [...inventoryByPath.keys()];
  let openedFiles = 0;
  let openedBytes = 0;

  function assertFixtureRequest(root, requestedPath) {
    if (path.resolve(root) !== resolvedRoot || path.resolve(requestedPath) !== resolvedRoot) {
      throw new Error("Unsafe raw-search control may read only its immutable fixture root.");
    }
  }

  return Object.freeze({
    async listFiles(root, directoryPath) {
      assertFixtureRequest(root, directoryPath);
      return [...files];
    },
    async readText(root, filePath, options = {}) {
      if (path.resolve(root) !== resolvedRoot) {
        throw new Error("Unsafe raw-search control may read only its immutable fixture root.");
      }
      const absolutePath = path.resolve(filePath);
      const inventoryEntry = inventoryByPath.get(absolutePath);
      if (!inventoryEntry) throw new Error("Unsafe raw-search control refused a path outside its receipt inventory.");
      const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      openedFiles += 1;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== inventoryEntry.bytes) {
          throw new Error(`Raw-search fixture entry changed before read: ${inventoryEntry.path}.`);
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (
          after.dev !== before.dev
          || after.ino !== before.ino
          || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs
          || bytes.byteLength !== inventoryEntry.bytes
        ) {
          throw new Error(`Raw-search fixture entry changed during read: ${inventoryEntry.path}.`);
        }
        openedBytes += bytes.byteLength;
        const content = decodeBenchmarkUtf8(bytes, inventoryEntry.path);
        return options.returnSnapshot === true ? { content, stats: after } : content;
      } finally {
        await handle.close();
      }
    },
    snapshot() {
      return Object.freeze({ files: openedFiles, bytes: openedBytes, entries: 0 });
    },
    operations() {
      return Object.freeze({ lstat: 0, realpath: 0, open: openedFiles });
    }
  });
}

function decodeBenchmarkUtf8(bytes, relativePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Raw-search fixture is not valid UTF-8: ${relativePath}.`);
  }
}

async function runRawReadControl({ manifest, fixtureRoot, fixtureReceipt }) {
  const rss = monitorRss(manifest.protocol.rssPollIntervalMs);
  const started = process.hrtime.bigint();
  let fileCount = 0;
  let totalBytes = 0;
  const concurrency = manifest.protocol.rawReadControl.concurrency;
  try {
    for (let start = 0; start < fixtureReceipt.inventory.length; start += concurrency) {
      const batch = await Promise.all(
        fixtureReceipt.inventory.slice(start, start + concurrency).map(async (entry) => {
          const filePath = path.join(fixtureRoot, ...entry.path.split("/"));
          const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            return (await handle.readFile()).byteLength;
          } finally {
            await handle.close();
          }
        })
      );
      fileCount += batch.length;
      totalBytes += batch.reduce((sum, bytes) => sum + bytes, 0);
    }
    if (fileCount !== fixtureReceipt.fileCount || totalBytes !== fixtureReceipt.totalBytes) {
      throw new Error(
        `Raw-read control mismatch: expected ${fixtureReceipt.fileCount} files/${fixtureReceipt.totalBytes} bytes, `
        + `got ${fileCount} files/${totalBytes} bytes.`
      );
    }
    return {
      durationMs: elapsedMs(started),
      peakRssBytes: rss.stop(),
      operations: { lstat: 0, realpath: 0, open: fileCount },
      readBudget: { files: fileCount, bytes: totalBytes, entries: 0 },
      exactResults: { fileCount, totalBytes },
      outputSha256: sha256(`${fileCount}\0${totalBytes}`)
    };
  } catch (error) {
    rss.stop();
    throw error;
  }
}

async function measureOperation({ id, manifest, operation }) {
  const cold = [];
  for (let index = 0; index < manifest.protocol.coldSamples; index += 1) cold.push(await operation());
  for (let index = 0; index < manifest.protocol.warmupSamples; index += 1) await operation();
  const warm = [];
  for (let index = 0; index < manifest.protocol.measuredSamples; index += 1) warm.push(await operation());

  assertStableSamples(id, cold);
  assertStableSamples(id, warm);
  if (cold[0].outputSha256 !== warm[0].outputSha256) {
    throw new Error(`Benchmark ${id} output changed between cold and warm samples.`);
  }
  return {
    id,
    cold: summarizeSamples(cold),
    warm: summarizeSamples(warm),
    exactResults: warm[0].exactResults,
    outputSha256: warm[0].outputSha256
  };
}

function summarizeSamples(samples) {
  const durations = samples.map(({ durationMs }) => durationMs).sort((left, right) => left - right);
  return {
    samples: samples.length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    peakRssBytes: Math.max(...samples.map(({ peakRssBytes }) => peakRssBytes)),
    operations: summarizeOperationCounts(samples.map(({ operations }) => operations)),
    readBudget: samples[0].readBudget
  };
}

function summarizeOperationCounts(counts) {
  return Object.fromEntries(["lstat", "realpath", "open"].map((name) => {
    const values = counts.map((entry) => entry[name]);
    if (values.some((value) => value !== values[0])) {
      throw new Error(`Benchmark operation count changed between samples for ${name}: ${values.join(", ")}.`);
    }
    return [name, values[0]];
  }));
}

function assertStableSamples(id, samples) {
  if (samples.length === 0) throw new Error(`Benchmark ${id} produced no timing samples.`);
  const expectedHash = samples[0].outputSha256;
  for (const sample of samples) {
    if (sample.outputSha256 !== expectedHash) {
      throw new Error(`Benchmark ${id} output changed between timing samples.`);
    }
  }
}

function expectedFilesForQuery(query, inventory) {
  if (query.expectation.kind === "none") return [];
  let indices;
  if (query.expectation.kind === "fixed-indices") {
    indices = new Set(query.expectation.fileIndices);
  } else {
    indices = new Set();
    for (let index = query.expectation.remainder; index < inventory.length; index += query.expectation.modulo) {
      indices.add(index);
    }
  }
  const selected = inventory.filter((entry) => indices.has(fileIndex(entry.path)));
  selected.sort((left, right) => left.path.localeCompare(right.path));
  return selected.slice(0, query.expectation.resultLimit ?? selected.length).map(({ path: relativePath }) => relativePath);
}

function fixtureRelativePath(index, selection, manifest) {
  const file = `note-${String(index).padStart(5, "0")}.md`;
  if (selection.layout === "shallow") {
    const buckets = manifest.corpus.layouts.shallow.bucketCount;
    return `bucket-${String(index % buckets).padStart(2, "0")}/${file}`;
  }
  const branching = manifest.corpus.layouts.nested.branchingFactor;
  const first = index % branching;
  const second = Math.floor(index / branching) % branching;
  const third = Math.floor(index / (branching ** 2)) % branching;
  return `branch-${String(third).padStart(2, "0")}/branch-${String(second).padStart(2, "0")}/branch-${String(first).padStart(2, "0")}/${file}`;
}

function fixtureContent(index, selection, manifest) {
  const distribution = manifest.corpus.distributions[selection.distribution];
  const random = seededRandom(`${manifest.corpus.generator.version}:${manifest.corpus.generator.seed}:${selection.layout}:${selection.distribution}:${index}`);
  const targetBytes = distribution.targetBytes.min
    + Math.floor(random() * (distribution.targetBytes.max - distribution.targetBytes.min + 1));
  const frontmatter = index % distribution.frontmatterEvery === 0
    ? `---\ntitle: Fixture note ${String(index).padStart(5, "0")}\ncategory: benchmark\n---\n`
    : "";
  const controlled = manifest.queries.flatMap((query) => queryAppliesToIndex(query, index) ? [query.text] : []);
  let content = `${frontmatter}# Fixture note ${String(index).padStart(5, "0")}\n\n`;
  if (controlled.length > 0) content += `${controlled.join("\n")}\n\n`;

  let tokenIndex = 0;
  while (Buffer.byteLength(content) < targetBytes) {
    if (selection.distribution === "prose") {
      const words = Array.from({ length: 14 }, () => {
        const vocabularyIndex = Math.floor(random() * distribution.vocabularySize);
        const word = PROSE_WORDS[vocabularyIndex % PROSE_WORDS.length];
        return vocabularyIndex < PROSE_WORDS.length ? word : `${word}-${Math.floor(vocabularyIndex / PROSE_WORDS.length)}`;
      });
      content += `${words.join(" ")}.\n`;
    } else {
      const token = sha256(`${index}:${tokenIndex}:${random()}`).slice(0, distribution.tokenLength);
      content += `${token} `;
      if (tokenIndex % 8 === 7) content += "\n";
    }
    tokenIndex += 1;
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

function queryAppliesToIndex(query, index) {
  if (query.expectation.kind === "none") return false;
  if (query.expectation.kind === "fixed-indices") return query.expectation.fileIndices.includes(index);
  return index % query.expectation.modulo === query.expectation.remainder;
}

function fileIndex(relativePath) {
  const match = /note-(\d+)\.md$/.exec(relativePath);
  if (!match) throw new Error(`Unexpected fixture path: ${relativePath}`);
  return Number(match[1]);
}

function countingFilesystem() {
  const counts = { lstat: 0, realpath: 0, open: 0 };
  const filesystem = new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (Object.hasOwn(counts, property)) {
        return (...args) => {
          counts[property] += 1;
          return value(...args);
        };
      }
      return value.bind(target);
    }
  });
  return { filesystem, counts };
}

function monitorRss(intervalMs) {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, process.memoryUsage.rss());
    }
  };
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== "dotaios-search-benchmark/v1") {
    throw new Error("Unsupported search benchmark manifest schema.");
  }
  if (!manifest.referenceMachine?.identifier || !manifest.referenceMachine?.powerProfile?.source) {
    throw new Error("Manifest must fix a reference machine identifier and power profile.");
  }
  if (!Array.isArray(manifest.runtime?.supportedNodeMajors) || !manifest.runtime.supportedNodeMajors.includes(20) || !manifest.runtime.supportedNodeMajors.includes(22)) {
    throw new Error("Manifest must support Node 20 and 22.");
  }
  if (!manifest.corpus?.generator?.version || !Number.isSafeInteger(manifest.corpus?.generator?.seed)) {
    throw new Error("Manifest must fix a generator version and integer seed.");
  }
  if (canonicalJson(manifest.corpus.fileCounts) !== canonicalJson([500, 2500, 10000])) {
    throw new Error("Manifest file counts must be exactly 500, 2500, and 10000.");
  }
  for (const name of ["shallow", "nested"]) if (!manifest.corpus.layouts?.[name]) throw new Error(`Missing ${name} layout.`);
  for (const name of ["prose", "high-entropy"]) if (!manifest.corpus.distributions?.[name]) throw new Error(`Missing ${name} distribution.`);
  const queryIds = new Set((manifest.queries || []).map(({ id }) => id));
  for (const id of ["no-hit", "low-hit", "high-hit"]) if (!queryIds.has(id)) throw new Error(`Missing ${id} query.`);
  if (!Number.isSafeInteger(manifest.protocol?.coldSamples) || manifest.protocol.coldSamples < 1) throw new Error("Cold samples must be positive.");
  if (!Number.isSafeInteger(manifest.protocol?.warmupSamples) || manifest.protocol.warmupSamples < 1) throw new Error("Warm-up samples must be positive.");
  if (!Number.isSafeInteger(manifest.protocol?.measuredSamples) || manifest.protocol.measuredSamples < 20) throw new Error("Measured samples must be at least 20.");
  if (!Number.isSafeInteger(manifest.protocol?.concurrency) || manifest.protocol.concurrency < 1) throw new Error("Fixture concurrency must be positive.");
  if (!manifest.protocol?.rawReadControl?.enabled) throw new Error("Raw-read control must be enabled.");
  if (!Number.isSafeInteger(manifest.protocol.rawReadControl.concurrency) || manifest.protocol.rawReadControl.concurrency < 1) {
    throw new Error("Raw-read control concurrency must be positive.");
  }
}

function validateRuntime(manifest) {
  const runtimeMajor = Number(process.versions.node.split(".")[0]);
  if (!manifest.runtime.supportedNodeMajors.includes(runtimeMajor)) {
    throw new Error(`Node ${process.versions.node} is outside the manifest's supported major versions.`);
  }
}

function runtimeReceipt() {
  return {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    hostname: os.hostname()
  };
}

function validateSelection(manifest, selection) {
  if (!manifest.corpus.fileCounts.includes(selection.fileCount)) throw new Error(`Unsupported file count: ${selection.fileCount}.`);
  if (!manifest.corpus.layouts[selection.layout]) throw new Error(`Unsupported layout: ${selection.layout}.`);
  if (!manifest.corpus.distributions[selection.distribution]) throw new Error(`Unsupported distribution: ${selection.distribution}.`);
}

function validateFixtureReceipt(manifest, fixtureRoot, receipt) {
  const resolved = path.resolve(fixtureRoot);
  assertOutsideRepository(resolved);
  if (receipt.schemaVersion !== "dotaios-search-fixture-receipt/v1") throw new Error("Invalid fixture receipt schema.");
  if (receipt.manifestSha256 !== manifestReceipt(manifest)) throw new Error("Fixture receipt does not match the benchmark manifest.");
  if (canonicalJson(receipt.generator) !== canonicalJson(manifest.corpus.generator)) {
    throw new Error("Fixture receipt generator does not match the benchmark manifest.");
  }
  validateSelection(manifest, receipt.selection);
  if (receipt.fileCount !== receipt.selection.fileCount || receipt.inventory.length !== receipt.fileCount) {
    throw new Error("Fixture receipt file count is invalid.");
  }
  const seenPaths = new Set();
  let totalBytes = 0;
  for (const entry of receipt.inventory) {
    const normalized = typeof entry.path === "string" ? path.posix.normalize(entry.path) : null;
    if (
      normalized !== entry.path
      || path.posix.isAbsolute(entry.path)
      || entry.path === ".."
      || entry.path.startsWith("../")
      || !entry.path.endsWith(".md")
      || seenPaths.has(entry.path)
    ) {
      throw new Error("Fixture inventory contains an invalid or duplicate path.");
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Fixture inventory metadata is invalid for ${entry.path}.`);
    }
    if (entry.mtime !== manifest.corpus.generator.fixedMtime) {
      throw new Error(`Fixture inventory mtime is invalid for ${entry.path}.`);
    }
    seenPaths.add(entry.path);
    totalBytes += entry.bytes;
  }
  if (totalBytes !== receipt.totalBytes) throw new Error("Fixture receipt byte total is invalid.");
  if (sha256(canonicalJson(receipt.inventory)) !== receipt.inventorySha256) throw new Error("Fixture inventory hash is invalid.");
  for (const query of manifest.queries) {
    if (!Array.isArray(receipt.controlledResults?.[query.id])) throw new Error(`Fixture receipt lacks ${query.id} expectations.`);
    if (query.expectation.kind !== "none" && receipt.controlledResults[query.id].length === 0) {
      throw new Error(`Fixture receipt has an empty controlled result for ${query.id}.`);
    }
    const derived = expectedFilesForQuery(query, receipt.inventory).map((relativePath) => `vault/${relativePath}`);
    if (
      derived.length !== receipt.controlledResults[query.id].length
      || derived.some((value, index) => value !== receipt.controlledResults[query.id][index])
    ) {
      throw new Error(`Fixture controlled-result receipt mismatch for ${query.id}.`);
    }
  }
}

function assertOutsideRepository(destination) {
  let existingAncestor = path.resolve(destination);
  const missingSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalDestination = path.join(realpathSync(existingAncestor), ...missingSegments);
  const relative = path.relative(repoRoot, canonicalDestination);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`Benchmark fixtures must stay outside the repository: ${canonicalDestination}`);
  }
}

async function ensureEmptyDirectory(destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(destination);
  if (entries.length > 0) throw new Error(`Fixture destination must be empty: ${destination}`);
}

function seededRandom(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function readOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

async function main(args) {
  const command = args[0];
  const manifestPath = path.resolve(readOption(args, "--manifest", defaultManifestPath));
  const manifest = await loadManifest(manifestPath);
  if (command === "receipt") {
    process.stdout.write(`${manifestReceipt(manifest)}\n`);
    return;
  }
  if (command === "generate") {
    const destination = readOption(args, "--output");
    if (!destination) throw new Error("generate requires --output outside the repository.");
    const receiptPath = path.resolve(readOption(args, "--receipt", `${destination}.receipt.json`));
    const receipt = await generateFixture({
      manifest,
      destination,
      selection: {
        fileCount: Number(readOption(args, "--count")),
        layout: readOption(args, "--layout"),
        distribution: readOption(args, "--distribution")
      }
    });
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ fixtureRoot: path.resolve(destination), receiptPath, ...receipt, inventory: undefined }, null, 2)}\n`);
    return;
  }
  if (command === "run") {
    const fixtureRoot = readOption(args, "--fixture");
    const receiptPath = readOption(args, "--receipt");
    const outputPath = readOption(args, "--output");
    if (!fixtureRoot || !receiptPath) throw new Error("run requires --fixture and --receipt.");
    const fixtureReceipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    const report = await runBenchmark({ manifest, fixtureRoot: path.resolve(fixtureRoot), fixtureReceipt });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) await fs.writeFile(path.resolve(outputPath), output, { flag: "wx" });
    process.stdout.write(output);
    return;
  }
  if (command === "raw-search") {
    const fixtureRoot = readOption(args, "--fixture");
    const receiptPath = readOption(args, "--receipt");
    const outputPath = readOption(args, "--output");
    if (!fixtureRoot || !receiptPath) throw new Error("raw-search requires --fixture and --receipt.");
    const fixtureReceipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    const report = await runRawSearchBenchmark({
      manifest,
      fixtureRoot: path.resolve(fixtureRoot),
      fixtureReceipt
    });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) await fs.writeFile(path.resolve(outputPath), output, { flag: "wx" });
    process.stdout.write(output);
    return;
  }
  throw new Error(
    "Usage: bench-search.mjs receipt | generate --output <outside-repo-dir> --count <500|2500|10000> "
    + "--layout <shallow|nested> --distribution <prose|high-entropy> [--receipt <path>] | "
    + "run --fixture <dir> --receipt <path> [--output <path>] | "
    + "raw-search --fixture <dir> --receipt <path> [--output <path>]"
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`search benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
}
