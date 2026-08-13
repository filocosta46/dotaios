# Public `searchAios` release receipt — 2026-08-14

This receipt closes the benchmark blind spot discovered before PR #80 merged.
The earlier harness measured the internal `searchMarkdownDir` primitive, while
the CLI and MCP call the request-wide `searchAios` entry point. The primitive
optimization was real, but repeated preflight and final containment validation
made the public path take roughly 10–12 seconds on 10,000 files.

The v2 harness now calls the default all-scope `searchAios` operation. Every
sample must be complete, contain no omissions, return the exact controlled
results, and stay within a fixed operation allowance over a safe request-scoped
corpus-read control. Vacuous low-hit or high-hit samples are rejected.

## Authority and protocol

- Code authority: `5160f23` (public-path optimization: `c6bf99c`).
- Manifest: `benchmarks/search/manifest.json`.
- Manifest SHA-256:
  `b6c38cb5920f91b0a84c66be8181f6c14f7a1c73360fa4f07993b32a7704d55a`.
- Full v2 reports: [`reports/`](./reports/), named
  `2026-08-14-public-<count>-<layout>-<distribution>.report.json`.
- Machine: Apple M4, 10 cores, 16 GiB; macOS/Darwin arm64; Node 22.22.3.
- Each query used 3 cold samples, 3 warm-up samples, and 20 measured warm
  samples with a fresh request-scoped reader for every safe sample.
- Search surface in every report: `entryPoint=searchAios`,
  `requestedScope=all`, `completeness=complete`.

## End-to-end public search

Times are warm p95 milliseconds. Every cell returned 0, 4, and 20 exact hits
for the no-hit, low-hit, and high-hit queries respectively.

| Fixture | No hit | Low hit | High hit | lstat | realpath | open |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | 39.96 | 39.51 | 38.88 | 1,808 | 61 | 500 |
| 500 / nested / high-entropy | 192.88 | 195.38 | 192.26 | 10,762 | 1,768 | 500 |
| 2,500 / shallow / prose | 173.25 | 176.34 | 177.22 | 7,808 | 61 | 2,500 |
| 2,500 / nested / high-entropy | 347.99 | 357.03 | 348.90 | 16,968 | 1,807 | 2,500 |
| 10,000 / shallow / prose | 675.50 | 689.51 | 689.64 | 30,308 | 61 | 10,000 |
| 10,000 / nested / high-entropy | 937.58 | 954.16 | 954.99 | 39,468 | 1,807 | 10,000 |

## Gate verdicts

- **Public entry point: PASS.** Every production sample executed default
  all-scope `searchAios`; none fell back to the directory primitive.
- **R1 latency: PASS.** All six 10,000-file warm p95 values are below 1,000 ms.
  Worst is 954.99 ms on the adversarial nested/high-entropy/high-hit cell.
- **Completeness and exact parity: PASS.** All 18 measured query cells were
  complete, reported zero omissions, and matched the immutable fixture receipt.
- **Operation gate: PASS.** Every report stayed within the safe preflight
  corpus-read control plus the fixed allowance of 512 `lstat`, 256 `realpath`,
  and 16 `open` calls. The 10,000-file public path is no longer allowed to
  repeat a full containment walk for every file and phase.
- **Safety: PASS.** Focused containment, search, ranking, scaling, and benchmark
  suites passed 162/162 before integration; the integrated full repository
  suite passed 1,949 tests with zero failures (9 platform/fixture skips).
- **Persistent index: DEFERRED.** The real public search meets the release goal
  without introducing a database, vector store, daemon, or second memory
  authority.

The [2026-08-13 final receipt](./2026-08-13-search-final.md) remains useful
historical evidence for the internal safe-search primitive. This receipt is the
release authority for the public search surface.
