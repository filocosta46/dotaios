---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: Search Scale, Resilience, and ICP Alignment - Plan
type: perf
date: 2026-08-13
deepened: 2026-08-13
---

# Search Scale, Resilience, and ICP Alignment - Plan

> **Amended by:**
> [`2026-08-13-002-search-performance-gate-amendment.md`](./2026-08-13-002-search-performance-gate-amendment.md),
> which governs and supersedes the withdrawn U5/U6 bytes-only `raw-read`
> performance clauses. All other requirements in this plan remain in force.

## Goal Capsule

Make end-to-end search fast and predictably degradable as a personal corpus
grows, without weakening the evidence-containment boundary or changing results;
then remove first-run language that exposes implementation details to the
non-expert user described by the product brief.

- **Authority:** repository safety rules and ADRs outrank this plan; this Product
  Contract outranks implementation convenience; measured output parity outranks
  latency alone.
- **Stop conditions:** stop and re-plan if the latency target requires removing
  a containment, identity, race, UTF-8, or budget guarantee; if optimized safe
  scanning misses the performance gate; or if result ordering differs from the
  current implementation.
- **Execution profile:** four independently reviewable slices: safe search
  performance, honest ceiling behavior, bounded archive lifecycle, and first-run
  language. The performance slice does not deliver predictable degradation;
  that behavior is complete only when U3 lands. U4 and the archive-runway
  evidence may proceed in parallel while U8/U5/U6 remain the search critical
  path.
- **Release boundary:** these slices are supporting hardening, not the
  Foundation launch proof. Foundation release readiness remains blocked on the
  task-aware continuity outcome and host receipt owned by
  `docs/plans/2026-08-09-001-feat-foundation-continuity-plan.md`; completing this
  plan cannot by itself authorize a launch claim.
- **Tail ownership:** `ce-work` owns test-first implementation, review, commits,
  CI, and PR landing; this plan remains a decision artifact.

---

## Product Contract

### Summary

The first performance slice should optimize the operation the profiler proved
expensive: repeated containment validation for every file in one search
request. A persistent index is not part of this implementation unless a later
measurement gate proves the optimized safe scan insufficient. Resource ceilings
must return bounded, honest omissions when the affected source can be skipped,
while integrity violations continue to fail the whole request.

### Problem Frame

2.0.3 fixed one search failure. It did not make the safe search path scale, and
it left both resource-ceiling and archive-growth recurrence paths.

Four separate problems, often conflated:

1. **The measured bottleneck is safe file access, not corpus statistics.** A
   controlled 10,000-file search takes about 3.9-4.1 seconds and performs about
   67 `lstat` and 16 `realpath` calls per file. The same traversal, matching,
   tokenization, and ranking with containment isolated takes about 0.5 seconds
   and returns identical hits. `buildCorpusStats` is material within that raw
   logic but only about 7% of current wall time. Scaling from 500 to 10,000 files
   is approximately linear; the earlier superlinear claim compared unlike
   corpora.
2. **Resource ceilings currently erase unrelated results.** A directory over
   the entry ceiling or one oversized JSONL rejects a shared request and aborts
   parallel scopes, even when another scope contains a valid hit. The command
   can also exit successfully after returning an empty result, creating false
   completeness.
3. **Archives still grow without a lifecycle.** `memory/events-archive.jsonl`
   has no rotation.
   `maintainMemory` compacts `events.jsonl` to 50 entries whenever it passes 100,
   moving the rest into that archive forever, and `search.mjs:317` reads it under
   `maxFileBytes`. Rotation alone postpones the next aggregate byte/entry limit,
   so lifecycle and explicit omission reporting must be designed together.
4. **ICP drift.** `docs/foundation-program/product-brief.md` states the user is a
   non-expert who "should not need to understand prompt engineering, context
   windows, skill routing, Git, MCP, or retrieval infrastructure." Measured on a
   clean sandbox, `setup --dry-run` names Antigravity, Kimi Code CLI, Hermes,
   "managed bridge", "managed skill links", and prints absolute paths in its
   first 20 lines. The first `brief` a new user's agent receives leaks raw YAML
   frontmatter (`source: dotaios init`, `created_at:`, `kind: context`).

### Actors

- A1. A person using local agents who needs continuity without learning the
  retrieval and host-projection internals.
- A2. A CLI caller who needs useful results plus actionable warnings.
- A3. An MCP host that must retain read-only canonical-data behavior and receive
  the same result/omission semantics as the CLI.

### Flows

- F1. A caller searches an authorized corpus; DotAIOS safely enumerates and
  reads eligible files, ranks exact current content, and returns the same order
  as the existing implementation within the latency budget.
- F2. A skippable resource ceiling affects one source; DotAIOS returns results
  from unaffected sources and a bounded omission. An integrity or authorization
  failure still rejects the whole request.
- F3. A first-time user previews setup or receives a brief; the default output
  describes outcomes in product language, while an explicit verbose mode keeps
  the operator detail.

### Requirements

#### Search performance and parity

- R1. End-to-end safe search over the controlled 10,000-file fixture returns
  validated results with p95 wall latency under one second on the benchmark
  machine, after warm-up and across at least 20 measured runs. The PR records
  hardware, Node version, median, p95, peak RSS, and file-operation counts.
- R2. Search returns the same ordered results as the pre-optimization path for
  substring, inflection, phrase, frontmatter, path/title, recency, scope, and tie
  behavior.
- R3. The optimization may amortize request-redundant validation but may not
  weaken authorization, lexical and canonical containment, no-follow file
  opening, handle/path identity binding, ancestor/directory race detection,
  UTF-8 validation, or byte/file/entry ceilings.
- R4. No runtime dependency, build step, vector, embedding, graph, daemon, or
  database is introduced.

#### Honest degradation and lifecycle

- R5. Skippable resource ceilings return available results plus a bounded,
  non-path-leaking omission envelope across core, CLI, and MCP. Observed unsafe
  paths, symlinks, evidence mutation, unauthorized roots, and invalid
  configuration remain request-fatal. An over-ceiling directory is explicitly
  **uninspected** beyond its observation boundary; the result may never imply
  that unvisited children were security-validated. Every omission carries a
  closed reason code and a path-safe, reason-specific recovery action.
- R6. Budget allocation and omission order are deterministic and starvation
  resistant across scopes. A bounded preflight gives every requested logical
  scope a fair-share reservation before unused capacity is redistributed in
  declared order; a fast parallel scope cannot consume another scope's safety
  budget by winning a race.
- R7. Event and signal archives rotate crash-safely before the per-file ceiling,
  remain searchable without loss or duplication, and report any later aggregate
  ceiling rather than claiming complete results.

#### First-run language

- R8. Default setup and doctor output names only detected clients and user
  actions, uses home-relative paths where a path helps, and hides internal
  projection terms. The `brief --compact` and MCP `read_working_context`
  projections strip raw frontmatter from rendered identity context.
- R9. Verbose/operator output retains the diagnostic information removed from
  the default view.

### Acceptance Examples

- AE1. On the 10,000-file fixture, the optimized safe path finds the same four
  controlled needles in the same order and meets R1; a timed failure or empty
  result never counts as a performance pass.
- AE2. One scope contains a directory above its entry ceiling while another
  contains the query. Search returns the valid hit, marks the skipped logical
  source as uninspected without an absolute path, and gives a reason-specific
  next action for obtaining a complete result with equivalent meaning through
  CLI and MCP. Replacing the directory root with an unsafe symlink rejects the
  request; an unsafe child beyond the ceiling remains part of the uninspected
  omission and can never be represented as complete.
- AE3. A fresh default setup preview names the detected client, explains the
  user-visible outcome, and gives the next action without naming absent hosts or
  managed projection vocabulary. Doctor does the same for healthy, warning, and
  blocking states. A fresh compact brief and MCP working-context response retain
  visible identity content but contain no YAML metadata; setup/doctor verbose
  output still exposes the supported operator view.
- AE4. Rotation at a shard boundary followed by interruption and retry leaves
  every event searchable exactly once. A concurrent search returns either the
  complete pre-rotation generation or the complete post-rotation generation;
  an unsafe target or an archive line above the read ceiling fails before source
  removal.

### Success Criteria

- Safe search meets R1 with exact output parity and a bounded file-operation
  profile, not merely a faster unsuccessful code path.
- All interfaces distinguish complete, partially omitted/uninspected, and
  rejected search.
- The first-run copy assertions pass without making verbose diagnostics poorer.

### Scope Boundaries

**In scope:** request-scoped containment amortization; search integration and
benchmarking; typed resource-ceiling omissions across core/CLI/MCP; archive
rotation and discovery; the first-run language pass.

**Separate release-critical dependency:** the Foundation continuity plan owns
the end-to-end proof that a fresh agent receives the smallest relevant project
evidence with provenance and can continue without retelling. It may execute in
parallel, but it must be approved, implemented, and evidenced before Foundation
launch readiness can be claimed.

**Deferred to follow-up work:**

- A persistent index. Reconsider only if the optimized safe scan misses R1 on
  representative prose, or a materially larger real corpus demonstrates a
  repeated-query win that justifies persistent derived state. The candidate must
  prove exact candidate-superset behavior, logical-corpus isolation, safe
  invalidation, CLI/MCP write posture, parse p95 at most 150 ms, peak heap delta
  at most 64 MiB, and serialized size at most 1.5x indexed source bytes with an
  explicit hard ceiling. Object-per-token frequency-map JSON is rejected by the
  current measurement: 17.79 MiB and about 1.38 seconds to parse on the fixture.
- Hybrid, vector, embedding, or graph retrieval. Revisit only after a repeated
  representative lexical miss, not from generic retrieval benchmarks.
- Default inclusion of every project in unscoped search; that is a product
  decision, not a performance correction.
- PR #62 CI diagnosis, the loose bridge-certification check, and the high-entropy
  V8 `Map` ceiling.
- Managed-skill CLI hardening discovered in the Sonnet session. The reported
  `npx` defect was a wrapper dropping the required `sha256:` prefix and ignoring
  exit status; a clean exact-fingerprint `npx` flow succeeds. A separate small
  change may validate the prefix earlier, improve the error/help text, and add a
  packaged-`npx` acceptance test.

**Not in scope:** derived state inside the canonical AIOS folder; weakening any
evidence-reader security guarantee; hosted storage or model-written fact
extraction.

### External Architecture and Product Evidence

Researched 2026-08-13. This is the part that changes the plan's confidence.

Claude Code validates bounded, on-demand plain-text context: auto memory is
repository-scoped and machine-local, and only the first 200 lines or 25 KB of
`MEMORY.md` load at startup; excess is silently omitted. Claude and Codex both
recommend moving procedures out of always-on instruction files into skills.
Skill bodies load progressively, but metadata still consumes bounded recurring
context, so “skills are free” is not a defensible claim.

OpenAI's current Codex guidance similarly bounds the combined `AGENTS.md` chain
at 32 KiB by default and exposes only a bounded initial skills catalog. Codex
also now has generated local memory, so DotAIOS should differentiate on
canonical user-owned knowledge, deterministic routing, inspectability, and
cross-host portability rather than claiming other agents have no memory.

The current RAG paper supports lexical-first evaluation, not this index design:
at 601M tokens its enterprise exact-fact workload reports BM25 50.5, raw
file-system agent 30.7, and dense retrieval 29.9. It does not contain the old
plan's hybrid recall claim, and its roughly 10M-token crossover compares BM25
with iterative raw-file exploration, not BM25 with dense retrieval.

Basic Memory and GBrain already combine canonical Markdown, rebuildable local
indexes, MCP, and cross-agent use; GBrain also makes Git part of the explicit
workflow. OpenMemory and Supermemory market one memory across tools. The
defensible product wedge is therefore the lighter contract: no account, daemon,
database, mandatory model, or opaque extracted-fact store.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Optimize containment at an evidence-reader-owned transaction seam, not
  inside the generic single-file primitive. The caller performs matching inside
  the transaction; it cannot obtain a successful result until final root,
  ancestor, and directory-generation validation completes. Each file retains
  lexical checking, no-follow handle binding, identity validation, canonical
  containment, and a comparison with the enumerated parent identity at handle
  validation. This localizes the performance change without weakening unrelated
  consumers or relying on the caller to remember a commit check.
- KTD2. Measure before indexing. The prior index proposal cached work after
  every canonical file had already been opened and scanned, and its literal
  JSON shape misses R1 on parse time alone. If U5/U6 miss R1 while satisfying
  R2/R3, execution stops for a new candidate-retrieval design; it does not add a
  cache opportunistically.
- KTD3. Classify failures by meaning. Resource exhaustion that can be isolated
  becomes a typed bounded omission; integrity, authorization, configuration,
  and observed-mutation failures remain request-fatal. This prevents false
  completeness without turning security failures into warnings.
- KTD4. Use a two-phase fair-share reservation. A bounded metadata preflight
  captures each requested logical scope's demand and generation independently.
  Half of each request-wide file, byte, and entry ceiling is divided equally as
  a protected minimum tranche across requested scopes; the other half and any
  unused protected capacity are allocated in declared order. Scopes that still
  cannot be completed release their capacity for one deterministic second pass.
  A scope is searched only when its full preflight demand fits its final
  reservation; otherwise it becomes one omission. Bounded concurrency remains
  within an admitted scope. This prevents timing races and protects later scopes
  from one large early scope without pretending partial-corpus ranking is
  equivalent to complete ranking.
- KTD5. Keep the unsuffixed archive as the active append target and rotate full
  content into immutable, zero-padded numbered shards under the existing memory
  lock. Search reads numbered shards in ascending order followed by the active
  archive. The transition supports legacy unsuffixed archives in place, uses the
  existing pending batch as recovery authority, and never overwrites a preexisting
  shard. Rotation prevents a single-file recurrence; R5/R7 handle eventual
  aggregate limits honestly.
- KTD6. Keep the ICP change as a default-copy pass. No command loses operator
  information; verbose output retains it.
- KTD7. Keep lexical retrieval and canonical Markdown. External evidence
  validates progressive disclosure and lexical-first testing but does not prove
  DotAIOS needs persistent indexing at this corpus size. Competitive positioning
  rests on a database-free, daemon-free, model-optional ownership contract.
- KTD8. Preserve the core search return shape by adding frozen `omissions`
  metadata beside the existing `scope` metadata on the iterable result. CLI
  keeps results on stdout, sends the omission/recovery warning to stderr, and
  sets exit code 2 for every partial/uninspected result; exit 0 means a complete
  search even when no hits exist, and exit 1 remains fatal. MCP returns valid
  results plus structured `complete: false` and the same logical omissions
  without marking the tool call failed. The closed omission schema contains
  logical scope, reason code, bounded observed counts, inspection state, and a
  path-safe recovery code/message. It exposes at most 32 entries plus one
  aggregate remainder and never a machine path. Search currently has no JSON CLI
  mode; adding one is outside this plan, and any future machine-readable surface
  must reuse this schema rather than infer completeness from exit text.
- KTD9. Make the operator surface explicit. `setup --verbose` and
  `doctor --verbose` augment the concise default with the diagnostic detail
  those commands currently expose and are documented in help. Compact working
  context has no raw-metadata mode: `brief --compact` and MCP
  `read_working_context` both suppress frontmatter, while `brief --json` changes
  only the transport envelope. Unknown options continue to fail.

### High-Level Technical Design

The existing request flow remains authoritative for matching and ranking:

1. Search resolves the same authorized logical scopes and inclusion predicates.
2. The evidence reader opens a transaction-owned corpus snapshot from safe
   traversal, recording the authorized root, eligible regular files, and the
   observed directory/ancestor generation.
3. Bulk reads reuse invariant validation while keeping per-file no-follow open,
   handle/path identity, byte, UTF-8, and mutation checks.
4. Search performs the existing canonical-content match, snippet, corpus-stat,
   and ranking logic unchanged.
5. After matching/ranking and before the transaction resolves, the evidence
   reader revalidates root identity and the observed ancestor/directory
   generation. Any mismatch rejects the whole request.
6. Skippable resource failures enter the bounded omission collector; fatal
   failures bypass it. CLI and MCP render the same logical fields and recovery
   meaning on their native transports.

No persistent derived search state or MCP write path is added. U3 adds only
canonical archive shards through the existing memory-maintenance write boundary.

### System-Wide Impact

- **Core boundary:** `evidence-reader.mjs` gains the bulk request abstraction;
  `contained-read.mjs` supplies reusable snapshot checks without relaxing its
  generic contract; `search.mjs` adopts the bulk path and omission envelope.
- **Interface parity:** CLI and MCP must both expose complete/partial/rejected
  outcomes. Machine paths stay out of omissions; logical scope and reason are
  sufficient.
- **Concurrency:** scope scheduling follows KTD4. Search does not acquire the
  writer lock; atomic archive publication plus the evidence-reader generation
  transaction means it observes a stable generation or fails with source-changed
  and can be retried, never a partly published shard.
- **Canonical data:** search remains read-only. Archive rotation is an existing
  memory-maintenance write concern, not a side effect of search.
- **Security:** performance is proven with adversarial ancestor, directory,
  enumerated-parent, file-replacement, symlink, hard-link, and evidence-change
  tests, not inferred from a happy-path benchmark. This preserves the repo's
  observation-boundary threat model; portable Node does not claim immunity to an
  unobserved same-user swap-and-restore entirely between validation barriers.

### Assumptions

- The controlled 10,000-file fixture and the current machine are the reproducible
  performance reference; the PR records their characteristics so later runs are
  comparable.
- The handle-bound prototype's roughly 0.55-0.65 second result demonstrates that
  R1 is plausible, not that its abbreviated checks are production-ready.
- R1 is an engineering responsiveness gate, not evidence of user retention or
  reduced abandonment; the separate continuity proof owns the product-outcome
  measurement.
- Default output is concise for the product user; verbose output is the supported
  operator surface.

### Risks and Mitigations

- **Security regression disguised as speed:** require per-barrier race tests and
  end-of-request generation validation before accepting any latency result.
- **Benchmark-only optimization:** cover shallow/nested, prose/high-entropy, and
  no/low/high-hit fixtures; validate real returned evidence before timing.
- **Partial results mistaken for complete:** make omissions structured and
  bounded in core, cap explicit entries at 32 plus one aggregate remainder, keep
  CLI results/warnings on stable channels, and assert equivalent rendering,
  recovery meaning, and completion state in CLI and MCP.
- **Archive rotation creates loss or reordering:** publish under the memory lock,
  preserve stable chronology, and test interruption/concurrency with exact event
  sets rather than counts alone.
- **Scope creep back into indexing:** KTD2 and the Goal Capsule stop condition
  require a plan revision with new measurements before persistent state work.

### Sequencing and Landing

1. U4 may begin immediately and land first as the independent first-run polish
   PR; its positive plain-language assertions must pass alongside the absence
   checks.
2. U8 freezes the benchmark authority and pre-change receipt before production
   performance code begins. U5 and U6 then form the performance PR. U5 must pass
   its safety and preliminary 10,000-file gates before U6 integration. Do not
   begin persistent-index work if the full gate fails; stop and revise this plan
   with the new measurements.
3. U3 follows the stabilized traversal seam and forms the ceiling-resilience PR.
   Until it lands, search remains fail-closed on resource ceilings; release notes
   must not claim predictable degradation after the performance PR alone.
4. U7 is independent of U5/U6 and has its own archive-lifecycle PR. Record the
   archive runway before scheduling it. The 2026-08-13 user-corpus snapshot
   measured events at 199,021 bytes (725 lines, 4.7% of 4 MiB) and signals at
   66,177 bytes (203 lines, 1.6%). Git-visible growth since the 2026-07-27 archive
   creation was about 30 event lines/day and 10 signal lines/day; at the current
   average line sizes, the coarse per-file runways are about 480 and 1,240 days.
   Re-measure at execution time, but this evidence does not justify placing U7
   ahead of U3 or the release-critical continuity proof.

---

## Implementation Units

### U8. Freeze benchmark authority and pre-change receipt

**Goal:** Make the performance decision reproducible and falsifiable before the
optimization changes the target.

**Requirements:** R1, R2, R4; F1; AE1

**Dependencies:** none

**Files:**
- `benchmarks/search/manifest.json`
- `scripts/bench-search.mjs`
- `docs/benchmarks/2026-08-13-search-baseline.md`
- `tests/core/search_benchmark_manifest.test.mjs`

**Approach:**
1. Check in a manifest that fixes the reference machine identifier and power
   profile, Node version, fixture-generator version and seed, file counts,
   shallow/nested layouts, file-size/token/frontmatter distributions, query and
   expected-hit sets, warm-up/sample protocol, and raw-read control.
2. Generate fixtures outside the repository from that manifest; do not commit a
   10,000-file corpus. Hash the generated corpus inventory so a changed fixture
   invalidates comparison with the recorded baseline.
3. Record the pre-change contained path, raw control, cold/warm median and p95,
   peak RSS, exact ordered results, and `lstat`/`realpath`/`open` counts before U5
   production changes begin.

**Test scenarios:**
- The same seed produces the same inventory hash, needles, and expected order on
  Node 20 and 22.
- Changing any corpus/query/protocol field changes the manifest receipt and
  cannot reuse the old baseline.
- The harness validates output before accepting a timing sample and exits nonzero
  on an error, empty controlled result, or order mismatch.

**Verification:** The checked-in manifest, deterministic-generator test, and
pre-change receipt exist and agree; U5 may not start until this gate is green.

### U5. Request-scoped safe corpus snapshot

**Goal:** Amortize redundant containment work across one corpus scan while
preserving every security property in R3.

**Requirements:** R3, R4; F1; AE1

**Dependencies:** U8

**Files:**
- `packages/core/src/evidence-reader.mjs`
- `packages/core/src/contained-read.mjs`
- `tests/core/evidence-reader.test.mjs`
- `tests/core/search-safety.test.mjs`

**Approach:**
1. Add an opaque transaction-owned snapshot/bulk-read capability at the evidence
   reader boundary. Matching/ranking executes within its callback/lifetime, and
   successful results cannot escape until final validation completes. Keep the
   existing single-file contained read unchanged for other consumers.
2. Safely enumerate eligible regular files once, bind the snapshot to the
   authorized root and observed directory/ancestor generation, and bound every
   collection before expansion.
3. Retain per-file lexical containment, no-follow open, handle/path identity,
   canonical containment, byte, UTF-8, and before/after mutation checks. At
   handle validation, bind each file to the identity of the parent directory
   recorded during enumeration; if portable Node 20 primitives cannot establish
   that binding within R1, stop rather than weaken R3.
4. After the callback finishes matching/ranking, revalidate root identity and
   every observed directory/ancestor generation before resolving the
   transaction. A changed generation fails closed and returns no partial result.

**Test scenarios:**
- Static shallow, nested, external-vault, and selector-scoped corpora return the
  same bytes and paths as ordinary contained reads.
- Root, ancestor, enumerated parent, directory, or file replacement at every
  observation barrier rejects the batch; synchronized swap/restore attempts
  spanning a barrier fail, and symlinks/non-regular files remain ineligible.
- Invalid UTF-8 and each configured resource ceiling retain their current safe
  classification until U3 deliberately adds skippable handling.
- Operation counters show at most four `lstat`, two `realpath`, and one `open`
  per accepted file, plus request-level traversal/final validation proportional
  to observed directories and root depth—never files multiplied by observed
  directories.
- On the U8 fixture, bulk read plus final validation p95 is no more than raw-read
  control p95 plus 150 ms, and that p95 plus the recorded unchanged
  match/tokenize/rank p95 is below 900 ms. A miss stops U6 integration.

**Verification:** The bulk reader passes the existing safety suite plus the new
race matrix, canonical output equality against individual reads, and the
preliminary performance gate.

### U6. Integrate safe bulk search and enforce the performance gate

**Goal:** Meet R1 without changing search semantics or persisting derived state.

**Requirements:** R1-R4; F1; AE1

**Dependencies:** U5

**Files:**
- `packages/core/src/search.mjs`
- `docs/architecture.md`
- `tests/core/search-ranking.test.mjs`
- `tests/core/search_corpus_scale.test.mjs`
- `tests/core/search-safety.test.mjs`

**Approach:**
1. Route `searchMarkdownDir` through U5 while preserving source predicates,
   canonical-content matching, snippets, corpus-stat boundaries, ranking, and
   stable merge order. Ranking runs inside the transaction and its result becomes
   observable only after U5's final generation validation.
2. Establish a differential oracle for substring and inflection matches, phrases
   across punctuation/lines, frontmatter descriptions, path/title boosts,
   recency/ties, memory sub-corpora, plugins, projects, and external vaults.
3. Benchmark 500, 2,500, and 10,000 files across shallow/nested and representative
   prose/high-entropy corpora, including no-hit, low-hit, and high-hit queries.
   Validate results before recording duration.
4. Record cold and warm latency, median/p95, peak RSS, and file operations. Keep
   latency out of brittle general CI while enforcing deterministic operation
   counts and output parity in CI.
5. Document the request-scoped safety/performance seam and the deliberate absence
   of persistent derived search state.

**Test scenarios:**
- Every parity fixture produces exactly the existing ordered results and snippets.
- A timed empty/error path is rejected as a benchmark sample.
- The 10,000-file warm benchmark meets R1 and remains within 1.5x of the raw-read
  control while retaining R3.
- The 500-file fixture p95 regresses by no more than the larger of 20% or 50 ms
  from the U8 contained baseline.
- At fixed directory topology, operation totals scale no worse than 2.1x when
  file count doubles, per-file operation counts at 2,500 and 10,000 files stay
  within 10%, and no observed-directory scan occurs inside the per-file loop.
- Added, deleted, and modified files are visible on the next request because the
  optimization is request-scoped, not a stale cross-request cache.

**Verification:** R1's measurement record and the differential suite pass. If
R1 fails, stop at the Goal Capsule condition and revise the plan before adding
any index.

### U3. Honest resource ceilings

**Goal:** Make skippable corpus ceilings partial-but-explicit rather than
request-wide false failures.

**Requirements:** R5, R6; F2; AE2

**Dependencies:** U5, U6

**Files:**
- `packages/core/src/evidence-reader.mjs`
- `packages/core/src/search.mjs`
- `packages/cli/src/commands/search.mjs`
- `packages/mcp/src/server.mjs`
- `docs/architecture.md`
- `docs/mcp.md`
- `tests/core/evidence-reader.test.mjs`
- `tests/core/search-safety.test.mjs`
- `tests/cli/search-safety.test.mjs`
- `tests/mcp/server.test.mjs`

**Approach:**
1. Define the closed omission contract in KTD8, including reason-specific,
   path-safe recovery for per-file size, directory entries, aggregate bytes,
   file count, and entry count. Freeze the envelope before exposing it.
2. Preflight requested logical scopes and reserve budget according to KTD4. Omit
   an unadmitted scope as a whole so its IDF/ranking never masquerades as a
   complete corpus. Pin each omitted directory's observed identity at the skip
   decision and include it in final transaction revalidation.
3. Serialize the same logical fields through core, CLI, and MCP. CLI leaves
   valid results on stdout, writes the warning/recovery guidance to stderr, and
   exits 2; MCP returns the results with `complete: false`. Both still fail on
   unsafe observed evidence.
4. Document completion states, reason/recovery codes, CLI channels/exit status,
   and MCP representation.

**Test scenarios:**
- Oversized JSONL, directory-entry, per-file, aggregate-byte, file-count, and
  entry-count limits produce the intended bounded omission while unaffected
  scopes still return controlled hits.
- Unsafe symlink/path, changed evidence, unauthorized root, and invalid config
  remain request-fatal through core, CLI, and MCP.
- Concurrent scope timing does not change which source is searched or omitted.
- Omissions never contain an absolute home path and never allow a partial result
  to be represented as complete; each reason gives one safe route to a complete
  retry, and more than 32 omissions collapse into one counted remainder.

**Verification:** Cross-interface golden fixtures prove identical result and
omission semantics, while the adversarial safety suite proves fatal boundaries
did not become warnings.

### U7. Bounded archive lifecycle

**Goal:** Prevent event and signal archives from crossing the per-file search
ceiling without coupling canonical-write safety to the search-performance gate.

**Requirements:** R7; F2; AE4

**Dependencies:** none; schedule after the runway receipt in Sequencing and
Landing, and integrate with U3 omission semantics when both are present

**Files:**
- `packages/core/src/memory.mjs`
- `packages/core/src/search.mjs`
- `packages/core/src/owned-state.mjs`
- `docs/architecture.md`
- `docs/advanced-memory.md`
- `tests/core/memory.test.mjs`
- `tests/core/search-safety.test.mjs`

**Approach:**
1. Keep the unsuffixed archive as the active append target and rotate at 2 MiB
   on JSONL line boundaries into immutable zero-padded numbered shards. A single
   valid line above 2 MiB but within the 4 MiB read ceiling occupies its own
   shard; a line above 4 MiB fails maintenance before committing source removal.
2. Under the existing memory lock, verify the active archive and next shard are
   owned regular files with safe link counts; create with exclusive 0600 mode,
   fsync file and directory, and atomically publish without overwriting an
   existing shard. Reuse owned-state publication patterns rather than raw
   pathname writes.
3. Preserve the pending batch as recovery authority across interruption. Support
   legacy unsuffixed archives, discover numbered shards in numeric order followed
   by the active file, and deduplicate exact events across retry boundaries.
4. Search takes one archive-generation snapshot and revalidates it before result
   commit. Concurrent rotation yields the old complete generation, the new
   complete generation, or a fatal source-changed retry—never a mixture. Once U3
   exists, later aggregate exhaustion becomes its bounded omission.

**Test scenarios:**
- Normal, boundary-size, concurrent, and every injected interruption point lose
  and duplicate zero events; re-running recovery is idempotent.
- Preexisting targets, symlinks, hard links, ownership/mode violations, and
  active-file replacement fail before publication or source deletion.
- Live plus rotated archives remain searchable in stable chronology, including a
  legacy archive upgraded in place and a search racing rotation.

**Verification:** Lifecycle fixtures compare exact event identities and order,
not counts alone; security tests prove link-safe publication and the generation
contract, and the recorded archive runway accompanies the PR.

### U4. ICP language pass

**Goal:** Make first-run output read as intended for the person the brief
describes, with the full operator view still available.

**Requirements:** R8, R9; F3; AE3

**Dependencies:** none

**Files:**
- `packages/cli/src/commands/setup.mjs`
- `packages/cli/src/commands/doctor.mjs`
- `packages/cli/src/commands/brief.mjs`
- `packages/core/src/working-context.mjs`
- `tests/cli/first_run_language.test.mjs`
- `tests/core/working-context.test.mjs`
- `tests/mcp/server.test.mjs`

**Approach:**
1. Default setup and doctor output name only detected clients by product name,
   state the user outcome, give one safe next action for healthy/warning/blocking
   states, and use home-relative paths where useful. Preserve non-color status
   markers so meaning does not depend on color.
2. Add and document `--verbose` for setup and doctor; it augments the concise
   default with the current diagnostic detail. Reject unknown options. Do not add
   a raw-metadata mode to compact brief or MCP working context.
3. Strip YAML frontmatter from context files before rendering identity into a
   brief; source files remain byte-unchanged, and CLI/MCP use the same core
   rendered content.

**Test scenarios:**
- A clean sandbox names no absent host and contains none of the internal managed
  projection vocabulary enumerated by AE3. Detected-client, no-client, warning,
  and blocking fixtures each state status, outcome, and one safe next action
  without asserting exact prose.
- Default paths are home-relative where exposed; verbose output retains the full
  setup/doctor diagnostic view, help names the option, and unknown options fail.
- A fresh compact brief contains no frontmatter keys, while a context file with
  no frontmatter renders unchanged. The MCP `read_working_context` fixture
  preserves the same visible identity/priorities content without YAML, and source
  hashes remain unchanged.

**Verification:** Positive semantic and absence-focused assertions protect the
user outcome and vocabulary without turning exact copy into a brittle API; CLI
and MCP frontmatter fixtures prove shared rendering.

---

## Verification Contract

- **Repository gates:** `npm run syntax-check`, `npm test`, `npm run smoke`, and
  `npm run check` pass locally; CI passes on Node 20 and 22. Packaging-affecting
  changes additionally pass `npm run pack:check`.
- **Test-first gate:** each behavioral or safety regression is observed failing
  against the pre-change code before its implementation passes.
- **Parity gate:** U6's differential matrix proves exact ordered result/snippet
  equality; U3's core/CLI/MCP fixtures prove identical complete/partial/rejected
  semantics and recovery meaning on stable CLI channels.
- **Safety gate:** the existing containment suite plus the U5/U3 race and
  ceiling matrices remain green. No resource omission can suppress an integrity
  failure.
- **Performance gate:** after warm-up, at least 20 validated samples on the
  10,000-file fixture meet R1. The PR records cold and warm results for 500,
  2,500, and 10,000 files, representative prose and adversarial high-entropy
  content, no/low/high-hit queries, median, p95, peak RSS, and operation counts.
  The 500-file regression bound and U5 preliminary budget also pass. At fixed
  topology, operation scaling meets U6's 2.1x/10% invariants and never performs
  per-file multiplication by observed directories.
- **Real-folder gate:** compare current and optimized searches against the actual
  AIOS folder, inspect returned evidence before accepting timing, record median
  and p95 as informational evidence, and record the fact that unscoped search
  does not include projects without a selector. The `ce-work` implementer owns
  producing and attaching this receipt to the performance PR.
- **Lifecycle gate:** U7 records current size, observed growth window, and
  estimated per-file runway, then proves exact event identity/order across
  rotation, recovery, concurrency, and link-safety fixtures.
- **Documentation gate:** the implementation unit that changes a contract owns
  the matching documentation edit and testable examples; documentation cannot
  be deferred to an unowned tail task.
- **Behavioral skill gate:** no additional skill evaluation is required; this
  work changes product code, not skill triggering or instructions.

## Definition of Done

- R1-R9 and AE1-AE4 hold with CI green on Node 20 and 22. Foundation launch
  readiness is still prohibited until the separate continuity plan's approved
  end-to-end outcome and host receipt are complete.
- U8 is done when the immutable benchmark manifest, deterministic fixture
  receipt, and pre-change baseline are checked in before U5 production edits.
- U5 is done when the bulk evidence path is output-equivalent to individual safe
  reads, passes every static/adversarial snapshot test, and meets its preliminary
  U8-relative budget.
- U6 is done when exact search parity, R1, the 500-file regression bound, and the
  explicit operation-scaling invariants pass without persistent state; a miss
  invokes the stop condition instead of silently expanding scope.
- U3 is done when all three interfaces distinguish complete, partial, and fatal
  outcomes, expose the bounded reason/recovery contract, preserve stable CLI
  channels and exit status, and do not starve later scopes behind timing or one
  large early scope.
- U7 is done when archive rollover/search proves zero loss and duplication across
  interrupted and concurrent maintenance, link-safe publication, and the
  old/new-generation search contract.
- U4 is done when default output meets positive outcome/next-action and absence
  assertions, setup/doctor verbose mode preserves operator diagnostics, and CLI
  plus MCP working context omit raw YAML without changing source bytes.
- `docs/architecture.md`, `docs/advanced-memory.md`, and user-facing search/MCP
  documentation describe the request-scoped performance seam, omission
  semantics, archive lifecycle, and supported operator-output boundary.
- No abandoned index experiment, compatibility branch, temporary benchmark
  fixture, debug instrumentation, or dead-end code remains in the final diffs.
- The four implementation slices are independently reviewable and land through
  green PRs with their measurement/safety evidence attached.

---

## Appendix

### Sources & Research

**Primary vendor and standards sources**

- Claude Code memory — <https://code.claude.com/docs/en/memory>
- Claude Code skills — <https://code.claude.com/docs/en/skills>
- Codex `AGENTS.md` — <https://developers.openai.com/codex/guides/agents-md>
- Codex skills — <https://developers.openai.com/codex/skills>
- Codex generated memories —
  <https://learn.chatgpt.com/codex/customization/memories>
- OpenAI harness engineering — <https://openai.com/index/harness-engineering/>
- Node filesystem API — <https://nodejs.org/api/fs.html>
- Node SQLite API and version floor — <https://nodejs.org/api/sqlite.html>

**Research and prior art**

- *BM25 Wins at Scale* — <https://arxiv.org/abs/2607.26497>
- Basic Memory — <https://github.com/basicmachines-co/basic-memory>
- GBrain — <https://github.com/garrytan/gbrain>
- OpenMemory — <https://mem0.ai/blog/introducing-openmemory-mcp>
- Supermemory — <https://github.com/supermemoryai/supermemory>
- Letta context hierarchy —
  <https://docs.letta.com/guides/core-concepts/memory/context-hierarchy>

**Repository evidence**

- `packages/core/src/search.mjs`
- `packages/core/src/evidence-reader.mjs`
- `packages/core/src/contained-read.mjs`
- `packages/core/src/memory.mjs`
- `docs/adr/0003-keep-canonical-memory-separate-from-derived-views.md`
- `docs/foundation-program/product-brief.md`
- `docs/foundation-program/evidence-ledger.md`
