import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { searchAios } from "../../packages/core/src/search.mjs";
import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";

// Search read through the same budget the bounded startup projection uses —
// 512 files, 4096 entries, 16 MiB — and its error code still says so
// (DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED). Those numbers are right for a
// packet that must stay small on every launch. They are wrong for the one
// operation whose whole job is to read the corpus the person accumulated.
//
// The result: on any lived-in folder, every query failed identically, including
// queries that should have matched nothing. Not slow, not partial — closed.
// `search_aios` over MCP and the project-source reader share the same default,
// so an agent asking about the person's own notes got the same wall.

async function makeCorpus(t, { fillerFiles }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-corpus-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, "context"), { recursive: true });
  await fs.mkdir(path.join(root, "vault", "raw"), { recursive: true });
  await fs.writeFile(
    path.join(root, "context", "work.md"),
    "# Work\n\nWe chose the peregrine routing strategy for the billing rewrite.\n"
  );

  // Filler the query must never match, so a hit proves retrieval and not luck.
  await Promise.all(
    Array.from({ length: fillerFiles }, (_, i) =>
      fs.writeFile(path.join(root, "vault", "raw", `note-${i}.md`), `# Note ${i}\n\nunrelated filler body\n`)
    )
  );
  return root;
}

function hits(groups) {
  return (groups || []).flatMap((group) => group.hits || group.results || []);
}

test("a small corpus returns the matching note", async (t) => {
  const root = await makeCorpus(t, { fillerFiles: 5 });

  const found = hits(await searchAios({ aiosPath: root, query: "peregrine routing" }));

  assert.ok(found.length > 0, "the note is findable when the corpus is small");
});

// The exact shape reported from a real folder: identical setup, more files.
test("the same note is still found once the corpus outgrows the old 512-file budget", async (t) => {
  const root = await makeCorpus(t, { fillerFiles: 600 });

  const found = hits(await searchAios({ aiosPath: root, query: "peregrine routing" }));

  assert.ok(found.length > 0, "a corpus over the old cap must still return results, not fail closed");
});

// Bytes were the second wall behind file count: a real folder was 39 MB of
// markdown against a 16 MiB ceiling, so raising the file cap alone would have
// moved the failure rather than removed it.
test("a corpus larger than the old 16 MiB byte budget still returns results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-corpus-bytes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "context"), { recursive: true });
  await fs.mkdir(path.join(root, "vault", "raw"), { recursive: true });
  await fs.writeFile(
    path.join(root, "context", "work.md"),
    "# Work\n\nWe chose the peregrine routing strategy for the billing rewrite.\n"
  );
  const padding = `${"unrelated filler body ".repeat(3000)}\n`; // ~64 KiB each
  await Promise.all(
    Array.from({ length: 320 }, (_, i) =>
      fs.writeFile(path.join(root, "vault", "raw", `bulk-${i}.md`), `# Bulk ${i}\n\n${padding}`)
    )
  );

  const found = hits(await searchAios({ aiosPath: root, query: "peregrine routing" }));

  assert.ok(found.length > 0, "~20 MiB of corpus must not exhaust the search budget");
});

// The budget still exists, and hitting it is still an error. What changed is
// that the error has to be actionable: the old text named no limit, no cause,
// and no next step, so a person had no way to tell a real containment refusal
// from simply owning too many notes.
test("exhausting the read budget explains the limit and what to do", async (t) => {
  const root = await makeCorpus(t, { fillerFiles: 20 });
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 512, maxFiles: 2, maxEntries: 2, maxFileBytes: 512 }
  });

  const error = await searchAios({ aiosPath: root, query: "peregrine routing", evidenceReader: reader })
    .then(() => null, (thrown) => thrown);

  assert.ok(error, "an exhausted budget still fails rather than silently returning a partial corpus");
  assert.match(error.message, /budget|limit/i, "the message must name the limit it hit");
  assert.match(error.message, /--scope|--project|cleanup/, "the message must name something the person can do");
  assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "errors stay path-free");
});
