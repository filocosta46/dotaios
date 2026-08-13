---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
created: 2026-08-13
plan_type: feat
---

# feat: Search index, optional hybrid retrieval, and ICP language alignment

**Target repo:** dotaios

---

## Goal Capsule

Make search fast enough to stay honest as a personal corpus grows, and make the
product's own output speak to the person its brief says it is for.

Three tracks, deliberately ordered: the index (performance, and the recurrence
guard the 2.0.3 fix did not remove), the ICP language pass (cheap, visible), and
hybrid retrieval held as an explicitly deferred option with a written trigger.

---

## Problem Frame

2.0.3 fixed search *failing*. It did not make search *scale*, and it left one
recurrence path open.

Three separate problems, often conflated:

1. **No index.** `packages/core/src/search.mjs:44` carries `TODO(L1-5)`:
   `buildCorpusStats` re-tokenizes the scanned candidate set on **every query**.
   A real folder is ~3,300 markdown files and 39 MB. Cost is linear in corpus
   size, paid per keystroke-to-answer.
2. **A guaranteed recurrence.** `memory/events-archive.jsonl` has no rotation.
   `maintainMemory` compacts `events.jsonl` to 50 entries whenever it passes 100,
   moving the rest into that archive forever, and `search.mjs:317` reads it under
   `maxFileBytes` (now 4 MiB). At ~300 B/event that is ~14,000 archived events.
   When it is crossed, search fails closed again — same wall, new file.
3. **ICP drift.** `docs/foundation-program/product-brief.md` states the user is a
   non-expert who "should not need to understand prompt engineering, context
   windows, skill routing, Git, MCP, or retrieval infrastructure." Measured on a
   clean sandbox, `setup --dry-run` names Antigravity, Kimi Code CLI, Hermes,
   "managed bridge", "managed skill links", and prints absolute paths in its
   first 20 lines. The first `brief` a new user's agent receives leaks raw YAML
   frontmatter (`source: dotaios init`, `created_at:`, `kind: context`).

### What external evidence says about the architecture

Researched 2026-08-13. This is the part that changes the plan's confidence.

**Claude Code's own auto memory is the same architecture.** Per the official
docs, it stores `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index
loaded every session, capped at **200 lines or 25 KB**, plus topic files loaded
**on demand**, in plain markdown the user can edit. Claude Code reminds the model
to shorten the index near the limit and errors when over.

That is a bounded index plus on-demand detail plus a hard budget in plain
markdown — DotAIOS's design, shipped by Anthropic. It is the strongest available
evidence that the plain-markdown-plus-derived-view bet is right, and it narrows
the defensible claim at the same time: auto memory is **per-repository,
machine-local, Claude Code only, and model-written**. DotAIOS is
**person-scoped, cross-agent, user-authored, and portable**. That difference is
the product; "we store memory in markdown" no longer is.

**Bloat is the recognized problem, and skills are the documented cure, not the
cause.** The docs are explicit: "target under 200 lines per CLAUDE.md file.
Longer files consume more context and reduce adherence", and for task-specific
instructions "use skills instead, which only load when you invoke them or when
Claude determines they're relevant." `.claude/rules/` with `paths:` frontmatter
loads only when matching files are touched. `/doctor` now proposes trims for an
oversized CLAUDE.md. Adding skills does not bloat a session; adding always-on
instruction text does. This plan does not add always-on text.

**Lexical is defensible at this corpus size, hybrid is the general standard.**
arxiv 2607.26497 finds BM25 overtakes dense retrieval at ~10M corpus tokens with
a margin approaching 20 points at full scale; a 39 MB markdown corpus is roughly
that size. The same body of work reports hybrid at ~91% recall@10 against ~65%
sparse-only. Both facts are true; they answer different questions. Hybrid stays
deferred with a written trigger rather than being pre-emptively built.

---

## Requirements

- **R1.** Search on a corpus of at least 10,000 markdown files returns results in
  well under one second on a warm index, without changing what it returns today.
- **R2.** The index is a derived view: deleting it degrades performance only, and
  never loses, hides, or authorizes deleting a canonical file. (ADR 0003.)
- **R3.** The index rebuilds incrementally — only files whose mtime or size
  changed are re-tokenized.
- **R4.** No new runtime dependency, no build step, no vector or embedding
  component. (CLAUDE.md hard rules 3, 4, 5.)
- **R5.** A corpus that grows past a read ceiling degrades with an actionable
  message rather than failing closed, and `events-archive.jsonl` no longer
  guarantees that outcome.
- **R6.** First-run output a non-expert reads — `setup --dry-run`, `doctor`, the
  first `brief` — contains no host codenames they do not use, no internal
  vocabulary, and no raw frontmatter.
- **R7.** Ranking behavior is unchanged by indexing: the same query returns the
  same ordered results with and without an index present.

---

## Key Technical Decisions

**KTD1 — A plain JSON inverted index under `~/.dotaios`, not SQLite.**
`node:sqlite` requires Node 22.5; the engine floor is `>=20`. `better-sqlite3` is
a native compile, which breaks the no-build-step rule and can fail at install
time on the exact non-technical machine the onboarding work just protected.
The index is machine-local derived state, so it belongs beside `projects.json` in
`~/.dotaios`, never inside `~/aios` where it would enter the sync mirror.

**KTD2 — Index the corpus statistics, not the ranking.**
`rankSearchHit` stays untouched. Only `buildCorpusStats` gains a cached path.
This keeps R7 provable by differential test rather than by inspection, and keeps
the blast radius inside one function.

**KTD3 — Rotate `events-archive.jsonl` by size, and skip-and-continue on an
oversized memory JSONL.** Two independent guards. Rotation stops the archive
growing without bound; skip-and-continue means one oversized file degrades that
one source instead of killing the whole search. Either alone leaves a path back
to a fail-closed search.

**KTD4 — Hybrid retrieval is deferred with a written trigger, not designed now.**
Trigger: a representative fixture where the lexical reader misses a decision that
a semantic reader finds, reproduced twice on real user material. Until that
exists, the evidence points the other way at this corpus size, and building it
would breach hard rule 5.

**KTD5 — ICP language is a copy pass over output strings, not a redesign.**
No command loses information; internal names stop appearing where a first-time
reader sees them. `--verbose` keeps the developer view.

---

## Implementation Units

### U1. Index store: read, write, invalidate

**Goal:** A machine-local inverted index with an explicit staleness contract.

**Requirements:** R2, R3, R4

**Dependencies:** none

**Files:**
- `packages/core/src/search-index.mjs` (new)
- `packages/core/src/paths.mjs` (add `searchIndexPath()`)
- `tests/core/search-index.test.mjs` (new)

**Approach:**
1. One JSON document per AIOS root, at `~/.dotaios/search-index/<hash>.json`,
   keyed by the resolved root path.
2. Record per file: relative path, mtime ms, size, and its token-frequency map.
   Record a format version and the corpus-wide document count.
3. Staleness is per file, not global: a file whose mtime and size both match is
   reused; anything else is re-tokenized.
4. A missing, unreadable, or version-mismatched index is not an error — it is a
   cold start that rebuilds.
5. Write through `writeFileSafe` with `~/.dotaios` as `boundaryRoot`, same as
   every other durable write.

**Execution note:** Test-first. The staleness contract is the whole unit; write
the reuse-and-invalidate cases before the store.

**Patterns to follow:** `packages/core/src/sessions.mjs` for lock-and-write
shape; `packages/core/src/files.mjs` `writeFileSafe` for the boundary contract.

**Test scenarios:**
- A cold start with no index file returns empty stats and does not throw.
- A file unchanged in mtime and size is reused without re-tokenizing.
- A file whose size changed but mtime did not is re-tokenized.
- A file whose mtime changed but size did not is re-tokenized.
- A deleted file is dropped from the index on the next build.
- A corrupt or truncated index JSON is discarded and rebuilt, not surfaced.
- An index written by a future format version is discarded and rebuilt.
- The index never writes inside the AIOS root.
- Two concurrent builds do not produce a torn index file.

**Verification:** The store reports which files it reused and which it
re-tokenized, and that report is assertable.

---

### U2. Wire the index into `buildCorpusStats`

**Goal:** Search consults the index and produces byte-identical results.

**Requirements:** R1, R7

**Dependencies:** U1

**Files:**
- `packages/core/src/search.mjs` (`buildCorpusStats` call sites; remove `TODO(L1-5)`)
- `tests/core/search-index-parity.test.mjs` (new)

**Approach:**
1. `buildCorpusStats` accepts an optional index. Absent, behavior is exactly
   today's.
2. On a hit, reuse the stored token map; on a miss, tokenize and record it.
3. Persist once per search invocation, after ranking, so a failed write costs
   the next query time and never the current answer.
4. An index write failure is swallowed and logged, never surfaced — a derived
   view may not break a read (R2).

**Execution note:** The parity test is the point of this unit. Write it first
and run it against the unindexed path to establish the expected values
independently.

**Test scenarios:**
- The same query over the same corpus returns identical ordered results with an
  index present and absent.
- A file edited between two searches changes its results on the second.
- A file added between two searches is findable on the second.
- A file deleted between two searches disappears from the second.
- An unwritable `~/.dotaios` degrades to the unindexed path and still returns
  results.
- The second identical query re-tokenizes zero files.
- Index writes never occur for a zero-result query on an unchanged corpus.

**Verification:** A 10,000-file fixture answers a warm query in well under a
second, and the parity test passes.

---

### U3. Stop the archive guaranteeing a fail-closed search

**Goal:** Remove the recurrence path 2.0.3 left open.

**Requirements:** R5

**Dependencies:** none (independent of U1/U2)

**Files:**
- `packages/core/src/memory.mjs` (archive rotation)
- `packages/core/src/search.mjs` (skip-and-continue on an oversized memory source)
- `tests/core/memory-archive-rotation.test.mjs` (new)
- `tests/core/search-oversized-source.test.mjs` (new)

**Approach:**
1. Rotate `events-archive.jsonl` to `events-archive-<n>.jsonl` past a size
   threshold well under `maxFileBytes`. Same for signals.
2. Search enumerates rotated shards alongside the live archive.
3. When any single memory JSONL still exceeds the per-file ceiling, skip that
   source, continue the search, and report the omission in the result envelope —
   the same omission-accounting shape `working-context.mjs` already uses.

**Execution note:** Reproduce first — grow an archive past the ceiling and watch
the whole search die — before changing either file.

**Test scenarios:**
- An archive grown past the threshold rotates, and no event is lost or
  duplicated across the rotation.
- Search returns results from both the live archive and rotated shards.
- A single oversized memory JSONL degrades that source only; other scopes still
  return results.
- The omission is reported, not silent.
- Rotation is crash-safe: an interrupted rotation loses no events.

**Verification:** A corpus with a deliberately oversized archive still answers
queries, and says what it skipped.

---

### U4. ICP language pass

**Goal:** First-run output reads as intended for the person the brief describes.

**Requirements:** R6

**Dependencies:** none

**Files:**
- `packages/cli/src/commands/setup.mjs` (`printClientPreview` and the preview banner)
- `packages/core/src/working-context.mjs` (strip frontmatter from rendered identity)
- `tests/cli/first_run_language.test.mjs` (new)

**Approach:**
1. The default preview names only detected clients by their product names, says
   what will change in one line each, and shows paths relative to home
   (`~/aios`, not the absolute path). Undetected hosts collapse to one line.
2. `--verbose` restores the current full output verbatim. No information is
   destroyed, only defaulted away.
3. The rendered brief strips YAML frontmatter from context files before
   including them.

**Execution note:** This is a copy pass. Assert on the *absence* of internal
vocabulary rather than on exact new wording, so the test does not become a
copy-editing tripwire.

**Test scenarios:**
- Default `setup --dry-run` on a sandbox with no agents installed names no host
  the user does not have.
- Default preview contains no absolute path outside a code block.
- Default preview contains none of: "managed bridge", "managed skill links",
  "symlink targets".
- `--verbose` still contains all of the above.
- A fresh `brief --compact` contains no `source:`, `created_at:`, or `kind:` line.
- A context file with no frontmatter renders unchanged.

**Verification:** A first run reads as instructions to a person, and `--verbose`
is unchanged from today.

---

## Scope Boundaries

**In scope:** the four units above.

### Deferred to Follow-Up Work

- **Hybrid retrieval.** Gated on KTD4's trigger.
- **The retrieval slice (Slice 3, TaskAwareContext).** Its dependency on
  SessionStore looks over-drawn — the falsified recall claim concerns a decision
  in `projects/<slug>/README.md`, and sessions are a separate source. Confirm
  before scheduling; the cheap half may not need PR #62.
- **PR #62's flaky CI.** Node 20 and 22 each reported both success and failure on
  the same SHA. Diagnose before landing 11k lines.
- **`status.mjs:233`** certifies a stale bridge via a loose substring check.
- **Default search omits `projects/`** — the largest part of the folder. Product
  decision, not a bug, and undecided.
- **The V8 Map ceiling.** A high-entropy corpus can exceed V8's Map size cap in
  `buildCorpusStats` and throw a raw `RangeError` that bypasses all messaging.
  Reachable only above ~64 MB of base64-like text. Cap `docFrequency` and fall
  back to a flat IDF when the trigger becomes real.

### Not in scope

- Vector or embedding retrieval (hard rule 5).
- Any new runtime dependency (hard rule 4).
- Anything inside `~/aios` gaining derived state (ADR 0003).

---

## Assumptions

Recorded rather than asked, because this plan was written while the maintainer
was asleep.

- **A1.** Warm search should target well under one second at 10,000 files. No
  latency budget is written down anywhere; this is inferred from the product
  being interactive.
- **A2.** `~/.dotaios` is the right home for the index — machine-local, already
  holds `projects.json`, already outside the sync mirror.
- **A3.** The ICP pass defaults to concise and keeps the full view behind
  `--verbose`, rather than removing information.
- **A4.** U3 ships with U1/U2 rather than separately. It is independent, but it
  closes a hole the same subsystem owns.

---

## Verification Contract

- `pnpm test` green. `pnpm run smoke` green. Baseline at plan time: 1813 pass,
  0 fail, 9 skipped.
- Every new test confirmed red against unfixed code before the fix lands.
- The parity test (U2) is the release gate for the index: no index may change
  what search returns.
- Measured warm and cold latency on a ≥10,000-file fixture, recorded in the PR.
- A real-folder check against `~/aios` before and after, inspecting output rather
  than timing a command whose result was never read.

## Definition of Done

R1–R7 hold, the four units are merged through PRs with CI green on Node 20 and
22, and `docs/architecture.md` documents the index as a derived view that may be
deleted at any time.

---

## Sources & Research

- Claude Code memory documentation — <https://code.claude.com/docs/en/memory>
  (auto memory layout, the 200-line / 25 KB index budget, on-demand topic files,
  the under-200-line CLAUDE.md guidance, skills-load-on-demand, `.claude/rules/`
  path scoping, `/doctor` trim proposals, `AGENTS.md` handling)
- "Which RAG Paradigm Wins at Scale?" — arxiv 2607.26497, via
  <https://aiweekly.co/alerts/bm25-beats-dense-retrieval-and-agents-by-20-points-at-scale>
- Hybrid retrieval reference —
  <https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026>
- Context rot — <https://www.mindstudio.ai/blog/what-is-context-rot-ai-agents>
- AGENTS.md bloat — <https://codex.danielvaughan.com/2026/03/27/agents-md-bloat-problem/>
- `jrcruciani/obsidian-memory-for-ai` — plain-markdown competitor that already
  generates deterministic lexical indexes
- In-repo: `search.mjs:44` (`TODO(L1-5)`), `search.mjs:317` (archive reads),
  `memory.mjs` compaction, ADR 0003, `product-brief.md`,
  `docs/foundation-program/evidence-ledger.md`
