import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { searchMemoryDir, searchMarkdownDir } from "../../packages/core/src/search.mjs";

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
