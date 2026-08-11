import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { searchAios } from "../../packages/core/src/search.mjs";

async function fixture(t) {
  const aiosPath = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-memory-notes-"));
  t.after(() => fs.rm(aiosPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.2.0" })}\n`);
  await fs.mkdir(path.join(aiosPath, "memory", "daily"), { recursive: true });
  await fs.mkdir(path.join(aiosPath, "memory", "inbox"), { recursive: true });
  await fs.mkdir(path.join(aiosPath, "vault"), { recursive: true });
  return aiosPath;
}

function memoryHits(groups) {
  return groups.find((group) => group.scope === "memory")?.results ?? [];
}

test("a note only in memory/daily is findable", async (t) => {
  const aiosPath = await fixture(t);
  await fs.writeFile(
    path.join(aiosPath, "memory", "daily", "2026-08-10.md"),
    "# 2026-08-10\n\nDrafted the quote for the Racing Bulls chairs.\n"
  );

  const hits = memoryHits(await searchAios({ aiosPath, query: "Racing Bulls" }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "memory/daily/2026-08-10.md");
});

test("a note only in memory/inbox is findable", async (t) => {
  const aiosPath = await fixture(t);
  await fs.writeFile(
    path.join(aiosPath, "memory", "inbox", "phone-note.md"),
    "# Captured on the phone\n\nRemember the Muuto pendant for Fiocchi.\n"
  );

  const hits = memoryHits(await searchAios({ aiosPath, query: "pendant" }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "memory/inbox/phone-note.md");
});

test("memory notes and memory streams both answer one query", async (t) => {
  const aiosPath = await fixture(t);
  await fs.writeFile(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${JSON.stringify({ ts: "2026-08-10T09:00:00.000Z", type: "note", summary: "pendant ordered" })}\n`
  );
  await fs.writeFile(
    path.join(aiosPath, "memory", "daily", "2026-08-10.md"),
    "# 2026-08-10\n\nThe pendant arrives Thursday.\n"
  );

  const sources = memoryHits(await searchAios({ aiosPath, query: "pendant" })).map((hit) => hit.source);
  assert.ok(sources.includes("memory/events.jsonl"), `missing the stream hit: ${sources.join(", ")}`);
  assert.ok(sources.includes("memory/daily/2026-08-10.md"), `missing the note hit: ${sources.join(", ")}`);
});

test("a memory search on a fresh AIOS with no note directories still works", async (t) => {
  const aiosPath = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-search-memory-bare-"));
  t.after(() => fs.rm(aiosPath, { recursive: true, force: true }));
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.2.0" })}\n`);
  await fs.mkdir(path.join(aiosPath, "memory"), { recursive: true });

  assert.deepEqual(memoryHits(await searchAios({ aiosPath, query: "anything" })), []);
});

test("secrets dropped into memory/inbox stay out of results", async (t) => {
  const aiosPath = await fixture(t);
  await fs.writeFile(path.join(aiosPath, "memory", "inbox", "credentials.md"), "# creds\n\nhunter2 swordfish\n");
  await fs.writeFile(path.join(aiosPath, "memory", "inbox", "safe.md"), "# safe\n\nnothing secret, swordfish free\n");

  const sources = memoryHits(await searchAios({ aiosPath, query: "swordfish" })).map((hit) => hit.source);
  assert.deepEqual(sources, ["memory/inbox/safe.md"]);
});
