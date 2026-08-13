import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";
import { searchAios, searchMemoryDir, searchMarkdownDir } from "../../packages/core/src/search.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-rank-test-"));
}

function isoAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function writeEvents(memoryDir, entries) {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "events.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
}

function genericContainedCorpusReader(roots) {
  const baseReader = createEvidenceReader({ roots: Array.isArray(roots) ? roots : [roots] });
  return {
    ...baseReader,
    async withTextCorpus(transactionRoot, directoryPath, options, callback) {
      const files = await baseReader.listFiles(transactionRoot, directoryPath, options);
      return callback(Object.freeze({
        async mapFiles(mapper) {
          return Promise.all(files.map(async (filePath) => {
            const observed = await baseReader.readText(transactionRoot, filePath, { returnSnapshot: true });
            return mapper(Object.freeze({
              filePath,
              content: observed.content,
              mtimeMs: observed.stats.mtimeMs
            }));
          }));
        }
      }));
    }
  };
}

// (a) Recency decay: a fresh hit must beat a stale hit of comparable lexical
// relevance — and raw term frequency must not drown recency.

test("fresh hit outranks a 6-month-old hit of equal lexical relevance", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  writeEvents(memoryDir, [
    { ts: isoAgo(180), type: "note", summary: "release deploy checklist finalized" },
    { ts: isoAgo(0), type: "note", summary: "release deploy checklist finalized" }
  ]);
  const results = await searchMemoryDir(memoryDir, "deploy checklist", { limit: 5 });
  assert.equal(results.length, 2);
  assert.equal(results[0].ts.slice(0, 10), isoAgo(0).slice(0, 10), "fresh entry must rank first");
});

test("repeating the phrase in a stale entry does not outrank a fresh single mention", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  writeEvents(memoryDir, [
    { ts: isoAgo(180), type: "note", summary: "deploy checklist, deploy checklist, deploy checklist" },
    { ts: isoAgo(0), type: "note", summary: "deploy checklist reviewed" }
  ]);
  const results = await searchMemoryDir(memoryDir, "deploy checklist", { limit: 5 });
  assert.equal(results.length, 2);
  assert.equal(results[0].ts.slice(0, 10), isoAgo(0).slice(0, 10), "recency must beat term frequency");
});

// (b) Term rarity: a rare token (error string, flag name) must outrank filler,
// including when an entry matches only part of the query.

test("a rare-token match outranks common-token matches", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push({ ts: isoAgo(1), type: "note", summary: `thanks for the update ${i}` });
  }
  entries.push({ ts: isoAgo(10), type: "note", summary: "worker crashed with EPIPE-4712 during sync" });
  writeEvents(memoryDir, entries);

  const results = await searchMemoryDir(memoryDir, "EPIPE-4712 thanks", { limit: 5 });
  assert.ok(results.length >= 1, "partial term matches must be rankable, not dropped");
  assert.match(results[0].summary, /EPIPE-4712/, "rare token must beat ubiquitous filler despite being older");
});

// (c) Filler scores near zero: the IDF weight of a term present in every
// document vanishes, so an all-filler match contributes almost nothing.

test("an all-filler match scores near zero within its tier", async () => {
  const search = await import("../../packages/core/src/search.mjs");
  assert.equal(typeof search.rankSearchHit, "function", "the one shared ranking function must be exported");
  assert.equal(typeof search.buildCorpusStats, "function", "corpus stats builder must be exported (L1-5 cache seam)");
  assert.equal(typeof search.RECENCY_HALF_LIFE_DAYS, "number", "half-life must be a named constant");

  const docs = [];
  for (let i = 0; i < 20; i++) docs.push(`sounds good, thanks! ${i}`);
  docs.push("panic: EPIPE-4712 unexpected hangup");
  const corpus = search.buildCorpusStats(docs);

  const filler = search.rankSearchHit({ kind: "partial", matchedTerms: ["thanks"], corpus, ageMs: 0 });
  const rare = search.rankSearchHit({ kind: "partial", matchedTerms: ["epipe-4712"], corpus, ageMs: 0 });
  const fillerWithin = filler - Math.floor(filler / 1_000_000) * 1_000_000;
  const rareWithin = rare - Math.floor(rare / 1_000_000) * 1_000_000;
  assert.ok(fillerWithin < 0.2, `filler contribution must be near zero, got ${fillerWithin}`);
  assert.ok(rareWithin > 5 * fillerWithin, "rare token must dwarf filler");
});

// (d) Exact match stays the strongest signal: a literal error string beats a
// fresh paraphrase no matter how old the literal hit is.

test("a stale literal error string still beats a fresh paraphrase", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  writeEvents(memoryDir, [
    { ts: isoAgo(180), type: "error", summary: "EBADF stream closed" },
    { ts: isoAgo(0), type: "note", summary: "the stream closed early with EBADF somewhere" }
  ]);
  const results = await searchMemoryDir(memoryDir, "EBADF stream closed", { limit: 5 });
  assert.equal(results.length, 2);
  assert.equal(results[0].summary, "EBADF stream closed", "literal phrase must sit in a tier no decay can cross");
});

// Markdown path: file mtime drives decay through the same ranking function.

test("a fresh vault file outranks a stale one with the same phrase hit", async () => {
  const dir = tmpDir();
  const vaultDir = path.join(dir, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  // Named so the stale file wins the current alphabetical tiebreak.
  fs.writeFileSync(path.join(vaultDir, "a-stale.md"), "# Old note\n\nquarterly pricing review notes\n");
  fs.writeFileSync(path.join(vaultDir, "b-fresh.md"), "# New note\n\nquarterly pricing review notes\n");
  const old = new Date(Date.now() - 90 * 86_400_000);
  fs.utimesSync(path.join(vaultDir, "a-stale.md"), old, old);

  const results = await searchMarkdownDir(vaultDir, "quarterly pricing review", { limit: 5, sourcePrefix: "vault" });
  assert.equal(results.length, 2);
  assert.equal(results[0].file, "b-fresh.md", "newer file must rank first at equal relevance");
});

// Guard rails: determinism and unchanged result shape.

test("ranking is deterministic and leaks no internal fields", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  writeEvents(memoryDir, [
    { ts: isoAgo(2), type: "note", summary: "alpha budget sync" },
    { ts: isoAgo(1), type: "note", summary: "alpha budget review" },
    { ts: isoAgo(0), type: "note", summary: "alpha budget final" }
  ]);
  const first = await searchMemoryDir(memoryDir, "alpha budget", { limit: 5 });
  const second = await searchMemoryDir(memoryDir, "alpha budget", { limit: 5 });
  assert.deepEqual(first, second, "same query must produce identical ordering");
  assert.ok(first.length > 0);
  for (const result of first) {
    assert.ok(result.source, "result shape must keep source");
    assert.ok(result.match && typeof result.match.kind === "string", "result shape must keep match.kind");
    assert.ok(!("__rank" in result), "internal rank must not leak into consumer shape");
  }
});

test("bulk search is exactly equal to the generic contained-read oracle across canonical scopes", async () => {
  const root = tmpDir();
  const externalVault = tmpDir();
  const write = (relativePath, content) => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const old = new Date(Date.now() - 90 * 86_400_000);
  const stale = write("context/a-stale.md", "# Launch plan\n\nExact launch plan body.\n");
  fs.utimesSync(stale, old, old);
  write("context/b-punctuation.md", "# Notes\n\nThe launch, plan uses punctuation.\n");
  write("context/c-lines.md", "# Notes\n\nlaunch\nplan on the next line\n");
  write("context/d-description.md", "---\ndescription: Launch plan in frontmatter\n---\n# Other\n");
  write("context/launch-plan/e-path.md", "# Other\n\nlaunch plan in a boosted path\n");
  write("context/f-inflection.md", "# Delivery\n\nThe team launched plans yesterday.\n");
  write("context/g-substring.md", "# Substring\n\nA prelaunch planner keeps the substring behavior.\n");
  write("context/z-tie.md", "# Notes\n\nExact launch plan body.\n");
  write("context/.env.md", "launch plan secret\n");

  write("memory/events.jsonl", `${JSON.stringify({ ts: isoAgo(1), type: "note", summary: "launch plan stream" })}\n`);
  write("memory/daily/2026-08-13.md", "# Daily\n\nlaunch plan daily note\n");
  write("memory/inbox/capture.md", "# Inbox\n\nlaunch plan inbox note\n");
  write("plugins/demo/manifest.json", "{\n  \"description\": \"launch plan plugin\"\n}\n");
  write("plugins/demo/package.json", "{\n  \"description\": \"launch plan must stay omitted\"\n}\n");
  write("projects/acme/README.md", "---\nid: project-acme-001\nproject: acme\n---\n# Acme\n\nlaunch plan selected project\n");
  write("projects/other/README.md", "---\nid: project-other-002\nproject: other\n---\n# Other\n\nlaunch plan unselected project\n");
  fs.writeFileSync(path.join(externalVault, "external.md"), "# External\n\nlaunch plan external vault\n");

  const safeReader = createEvidenceReader({ roots: [root, externalVault] });
  const genericReader = genericContainedCorpusReader([root, externalVault]);
  const requests = [
    { aiosPath: root, vaultPath: externalVault, query: "launch plan", scope: "all", projectSelector: "acme" },
    { aiosPath: root, vaultPath: externalVault, query: "launch plan", scope: "context" },
    { aiosPath: root, vaultPath: externalVault, query: "launch plan", scope: "memory" },
    { aiosPath: root, vaultPath: externalVault, query: "launch plan", scope: "plugins" },
    { aiosPath: root, vaultPath: externalVault, query: "launch plan", scope: "projects", projectSelector: "project-acme-001" },
    { aiosPath: root, vaultPath: externalVault, query: "launch plan", scope: "vault" }
  ];

  for (const request of requests) {
    const safe = await searchAios({ ...request, evidenceReader: safeReader });
    const generic = await searchAios({ ...request, evidenceReader: genericReader });
    assert.deepEqual(safe, generic, `safe transaction changed ${request.scope} output`);
  }

  const context = await searchMarkdownDir(path.join(root, "context"), "launch plan", {
    sourcePrefix: "context",
    reader: createEvidenceReader({ roots: [root] }),
    root
  });
  assert.deepEqual(context.map(({ file }) => file), [
    "d-description.md",
    "launch-plan/e-path.md",
    "g-substring.md",
    "z-tie.md",
    "a-stale.md",
    "b-punctuation.md",
    "c-lines.md",
    "f-inflection.md"
  ]);
  assert.deepEqual(context.find(({ file }) => file === "c-lines.md").matches, [
    { line: 2, lineEnd: 4, content: "launch / plan on the next line", match: "partial", area: "body" },
    { line: 3, lineEnd: 5, content: "launch / plan on the next line", match: "partial", area: "body" }
  ]);

  const all = await searchAios({
    aiosPath: root,
    vaultPath: externalVault,
    query: "launch plan",
    projectSelector: "acme",
    evidenceReader: createEvidenceReader({ roots: [root, externalVault] })
  });
  const serialized = JSON.stringify(all);
  assert.match(serialized, /memory\/daily\/2026-08-13\.md/);
  assert.match(serialized, /memory\/inbox\/capture\.md/);
  assert.match(serialized, /plugins\/demo\/manifest\.json/);
  assert.match(serialized, /projects\/acme\/README\.md/);
  assert.match(serialized, /vault\/external\.md/);
  assert.doesNotMatch(serialized, /package\.json|projects\/other|\.env\.md/);
});
