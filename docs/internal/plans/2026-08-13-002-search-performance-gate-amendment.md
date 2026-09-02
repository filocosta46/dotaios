# Search performance gate amendment — 2026-08-13

**Status:** Accepted implementation amendment; final measurements remain subject
to the verification contract below.

**Amends:**
[`2026-08-13-001-feat-search-index-and-icp-alignment-plan.md`](./2026-08-13-001-feat-search-index-and-icp-alignment-plan.md)

## Decision

The original plan remains authoritative except for these two clauses:

1. U5's test scenario requiring safe bulk read plus final validation p95 to be
   no more than bytes-only `raw-read` p95 plus 150 ms.
2. U6's test scenario requiring 10,000-file safe canonical search to remain
   within 1.5x of the bytes-only `raw-read` control.

Those clauses are superseded by the gates below. No safety property, output
parity requirement, resource ceiling, operation-scaling invariant, fixture, or
sample-validation rule is relaxed.

## Why the comparator changes

The frozen `raw-read` control opens and reads fixture bytes. It deliberately
omits recursive traversal, lexical and canonical containment, no-follow and
handle/path identity binding, UTF-8 validation, root/directory/ancestor
observation, final generation revalidation, matching, snippets, corpus
statistics, ranking, and result validation. These are mandatory parts of R2 and
R3, not removable overhead.

The measured safe-corpus delta therefore describes the cost of required work,
not a regression that can be eliminated without changing the contract. Making
the bytes-only proxy authoritative would reward weakening containment or
skipping canonical search behavior.

The fixed-protocol full unsafe canonical-search control is the appropriate
relative diagnostic. It retains the canonical matcher, snippets, full-document
corpus statistics, ranking, result validation, fixture inventory, queries, and
sample protocol while omitting containment only. It does not become a release
limit: the end-to-end R1 threshold remains the primary latency gate.

## Amended performance contract

A final benchmark run is accepted only when all of the following hold:

- **End-to-end latency:** all no-hit, low-hit, and high-hit safe-search cells on
  both 10,000-file frozen fixtures have warm p95 below 1,000 ms across at least
  20 validated measured samples after warm-up.
- **Exact parity:** every accepted safe sample has the exact ordered result hash
  recorded by the frozen U8 authority and matches the fixed-protocol full
  unsafe canonical-search control.
- **Safety:** all R3 containment, handle binding, mutation, final-generation,
  and fail-closed tests pass. Performance work may amortize repeated validation
  but may not remove it.
- **Small-corpus regression:** every 500-file safe-search cell remains within
  the larger of 20% or 50 ms of its frozen contained baseline.
- **Scaling:** the original U6 operation-count and no-directory-scan-inside-the-
  mapper invariants remain in force across 500, 2,500, and 10,000 files.
- **Relative diagnostic:** the receipt reports safe/full-unsafe canonical-search
  p95 ratios for every cell. Exceptions require explanation but cannot override
  a failed R1, parity, safety, regression, or scaling gate.
- **Bytes-only diagnostic:** `raw-read` remains in the report as an explicitly
  informational lower bound. Its delta and ratio are recorded but are not
  release gates.
- **Runtime coverage:** the differential, race, budget, archive, CLI, and MCP
  suites pass on supported Node 20 and Node 22 runtimes.

The benchmark matrix, immutable manifest SHA-256, environment, result hashes,
latency distributions, peak RSS, and file-operation counts are recorded in the
durable optimized receipt after the implementation and review fixes settle.

## Scope and consequences

- R1-R9, AE1-AE4, the Goal Capsule, and the original stop condition remain in
  force.
- Persistent indexing remains deferred. It is reconsidered only if the final
  request-scoped implementation misses R1 or measured product needs justify a
  separate retrieval design.
- The original plan body is preserved as the historical implementation
  authority; this document makes the performance decision auditable without
  rewriting its prior evidence.
- A passing R1 result does not authorize a release when parity, safety,
  deterministic partial-result allocation, archive integrity, packaging, or CI
  is failing.

