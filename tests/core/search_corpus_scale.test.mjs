import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { searchAios } from "../../packages/core/src/search.mjs";
import { createEvidenceReader, DEFAULT_EVIDENCE_READ_LIMITS } from "../../packages/core/src/evidence-reader.mjs";

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

// The first two fixtures only cross the file and byte ceilings. Entries and
// per-directory entries are separate dimensions, and the real folder that
// triggered this traversed ~53,000 entries — so without a fixture past those,
// both could silently regress to the projection's 4,096 / 1,024 and the suite
// would stay green.
test("a corpus past the old entry and per-directory ceilings still returns results", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-corpus-entries-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "context"), { recursive: true });
  const bulk = path.join(root, "vault", "raw");
  await fs.mkdir(bulk, { recursive: true });
  await fs.writeFile(
    path.join(root, "context", "work.md"),
    "# Work\n\nWe chose the peregrine routing strategy for the billing rewrite.\n"
  );
  // >1024 files in ONE directory, and >4096 entries traversed overall.
  await Promise.all(
    Array.from({ length: 1200 }, (_, i) =>
      fs.writeFile(path.join(bulk, `flat-${i}.md`), `# Flat ${i}\n\nunrelated filler body\n`)
    )
  );
  for (let d = 0; d < 40; d += 1) {
    const dir = path.join(root, "vault", `shelf-${d}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        fs.writeFile(path.join(dir, `n-${i}.md`), `# N ${d}-${i}\n\nunrelated filler body\n`)
      )
    );
  }

  const found = hits(await searchAios({ aiosPath: root, query: "peregrine routing" }));

  assert.ok(found.length > 0, "entry and per-directory ceilings must clear a real corpus too");
});

// Raising the ceilings must not become removing them. Setting any of these to
// Infinity or MAX_SAFE_INTEGER would make every test above pass while deleting
// the runaway guard entirely.
test("the shipped budget is a real ceiling, not an unbounded read", () => {
  for (const [name, value] of Object.entries(DEFAULT_EVIDENCE_READ_LIMITS)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a finite positive ceiling`);
  }
  assert.ok(DEFAULT_EVIDENCE_READ_LIMITS.maxBytes <= 1024 * 1024 * 1024, "maxBytes must stay under 1 GiB");
  assert.ok(DEFAULT_EVIDENCE_READ_LIMITS.maxFiles <= 1_000_000, "maxFiles must stay bounded");
  assert.ok(DEFAULT_EVIDENCE_READ_LIMITS.maxEntries <= 5_000_000, "maxEntries must stay bounded");
});

// The budget still exists, but a search-isolatable ceiling now omits the whole
// logical corpus instead of returning partial-corpus ranking or failing a
// request that may have other unaffected scopes.
test("exhausting the read budget returns one actionable whole-scope omission", async (t) => {
  const root = await makeCorpus(t, { fillerFiles: 20 });
  const reader = createEvidenceReader({
    roots: [root],
    limits: { maxBytes: 512, maxFiles: 2, maxEntries: 2, maxFileBytes: 512 }
  });

  const groups = await searchAios({ aiosPath: root, query: "peregrine routing", evidenceReader: reader });

  assert.equal(
    groups.some((group) => group.scope === groups.omissions[0].scope),
    false,
    "the omitted logical scope returns no partial-corpus ranking"
  );
  assert.match(JSON.stringify(groups), /peregrine routing/, "unaffected admitted scopes still return valid results");
  assert.equal(groups.omissions.length, 1);
  assert.ok(["file_count_exceeded", "entry_count_exceeded"].includes(groups.omissions[0].reason));
  assert.match(groups.omissions[0].recovery.message, /\b(move|archive|narrow)\b/i);
  assert.doesNotMatch(
    JSON.stringify(groups.omissions),
    new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "omissions stay path-free"
  );
});

test("public search preflight amortizes containment work across a deep corpus", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-public-search-operations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const corpus = path.join(root, "vault", "deep", "nested", "notes");
  await fs.mkdir(corpus, { recursive: true });
  const fileCount = 64;
  await Promise.all(Array.from({ length: fileCount }, (_, index) =>
    fs.writeFile(path.join(corpus, `${index}.md`), `# Note ${index}\n\npublic operation canary\n`)
  ));

  const operations = { lstat: 0, realpath: 0, open: 0 };
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(operations, property)) {
        return async (...args) => {
          operations[property] += 1;
          return target[property](...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const reader = createEvidenceReader({ roots: [root], filesystem });

  const groups = await searchAios({
    aiosPath: root,
    query: "public operation canary",
    scope: "vault",
    evidenceReader: reader
  });

  assert.equal(groups[0].results.length, 20, "the operation receipt must cover real ranked hits");
  assert.equal(operations.open, fileCount, "every accepted file remains handle-bound");
  assert.ok(
    operations.lstat <= fileCount * 10 + 120,
    `public preflight repeated containment work per ancestor: ${JSON.stringify(operations)}`
  );
  assert.ok(
    operations.realpath <= fileCount + 120,
    `public preflight repeated canonicalization work per phase: ${JSON.stringify(operations)}`
  );
});
