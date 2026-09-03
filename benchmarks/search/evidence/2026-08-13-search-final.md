# Search benchmark final receipt — 2026-08-13

This is the post-review release receipt for request-scoped safe search. It
supersedes the earlier U6 implementation receipt after the request-wide budget,
final file-generation, and archive retry-provenance fixes. Every measured
sample was accepted only after inventory and exact ordered-result validation.

## Authority and protocol

- Manifest: `benchmarks/search/manifest.json`
- Manifest SHA-256: `b6c38cb5920f91b0a84c66be8181f6c14f7a1c73360fa4f07993b32a7704d55a`
- Full reports: [`reports/`](./reports/), named
  `2026-08-13-<count>-<layout>-<distribution>.report.json`
- Machine: `Mac16,1`, Apple M4, 10 cores, 16 GiB; macOS 26.6.1 / Darwin
  25.6.0; Node 22.22.3 arm64.
- Each operation used 3 cold samples, 3 warm-up samples, and 20 measured warm
  samples with a fresh request-scoped reader for every safe sample.
- Safe and full unsafe canonical-search samples validated exact ordered paths
  and output SHA-256 before their duration was accepted. Safe-corpus and
  bytes-only samples validated exact file count and byte total. Fixture
  inventories were hashed before and after each run.

The full unsafe canonical-search control retains matching, snippets, corpus
statistics, ranking, fixture selection, queries, limits, and result validation;
it omits containment only. The bytes-only `raw-read` control remains an
informational lower bound because it also omits traversal, containment,
generation validation, decoding, and canonical search work.

## End-to-end safe search

Times are milliseconds. RSS is the largest cold or warm process RSS observed
for that query.

| Fixture | Query | Cold median | Cold p95 | Warm median | Warm p95 | RSS MiB | lstat | realpath | open |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | no-hit | 41.56 | 45.73 | 27.86 | 33.00 | 112.25 | 1,032 | 510 | 500 |
| 500 / shallow / prose | low-hit | 29.56 | 30.09 | 27.24 | 32.69 | 117.95 | 1,032 | 510 | 500 |
| 500 / shallow / prose | high-hit | 28.54 | 29.10 | 27.91 | 29.80 | 137.39 | 1,032 | 510 | 500 |
| 500 / nested / high-entropy | no-hit | 189.14 | 209.63 | 177.98 | 181.80 | 138.95 | 9,417 | 2,217 | 500 |
| 500 / nested / high-entropy | low-hit | 181.27 | 181.72 | 178.69 | 181.22 | 140.88 | 9,417 | 2,217 | 500 |
| 500 / nested / high-entropy | high-hit | 178.02 | 179.70 | 179.38 | 181.11 | 141.47 | 9,417 | 2,217 | 500 |
| 2,500 / shallow / prose | no-hit | 139.81 | 159.15 | 133.15 | 135.46 | 138.06 | 5,032 | 2,510 | 2,500 |
| 2,500 / shallow / prose | low-hit | 145.44 | 154.89 | 135.89 | 138.63 | 138.23 | 5,032 | 2,510 | 2,500 |
| 2,500 / shallow / prose | high-hit | 136.34 | 138.19 | 135.23 | 139.36 | 138.45 | 5,032 | 2,510 | 2,500 |
| 2,500 / nested / high-entropy | no-hit | 328.41 | 338.79 | 303.40 | 310.75 | 252.30 | 13,610 | 4,256 | 2,500 |
| 2,500 / nested / high-entropy | low-hit | 306.03 | 310.97 | 306.56 | 337.06 | 218.78 | 13,610 | 4,256 | 2,500 |
| 2,500 / nested / high-entropy | high-hit | 310.97 | 323.86 | 307.03 | 313.11 | 219.69 | 13,610 | 4,256 | 2,500 |
| 10,000 / shallow / prose | no-hit | 536.22 | 560.91 | 533.65 | 551.29 | 196.23 | 20,032 | 10,010 | 10,000 |
| 10,000 / shallow / prose | low-hit | 544.01 | 545.65 | 544.50 | 553.32 | 202.69 | 20,032 | 10,010 | 10,000 |
| 10,000 / shallow / prose | high-hit | 544.93 | 612.68 | 546.44 | 556.88 | 203.58 | 20,032 | 10,010 | 10,000 |
| 10,000 / nested / high-entropy | no-hit | 816.74 | 846.10 | 805.27 | 820.61 | 448.63 | 28,610 | 11,756 | 10,000 |
| 10,000 / nested / high-entropy | low-hit | 832.96 | 901.37 | 813.54 | 844.55 | 446.73 | 28,610 | 11,756 | 10,000 |
| 10,000 / nested / high-entropy | high-hit | 817.33 | 893.53 | 817.52 | 835.11 | 450.06 | 28,610 | 11,756 | 10,000 |

## Relative and informational controls

| Fixture | Safe warm p95, no/low/high | Full unsafe warm p95, no/low/high | Safe/unsafe ratio, no/low/high | Safe-corpus p95 | Raw-read p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | 33.00 / 32.69 / 29.80 | 19.93 / 20.11 / 20.48 | 1.66 / 1.63 / 1.45 | 21.43 | 8.00 |
| 500 / nested / high-entropy | 181.80 / 181.22 / 181.11 | 20.65 / 24.04 / 21.24 | 8.80 / 7.54 / 8.53 | 173.31 | 7.91 |
| 2,500 / shallow / prose | 135.46 / 138.63 / 139.36 | 101.63 / 105.10 / 102.95 | 1.33 / 1.32 / 1.35 | 93.24 | 37.68 |
| 2,500 / nested / high-entropy | 310.75 / 337.06 / 313.11 | 109.65 / 111.84 / 123.48 | 2.83 / 3.01 / 2.54 | 254.32 | 38.00 |
| 10,000 / shallow / prose | 551.29 / 553.32 / 556.88 | 391.06 / 404.83 / 416.80 | 1.41 / 1.37 / 1.34 | 406.20 | 145.45 |
| 10,000 / nested / high-entropy | 820.61 / 844.55 / 835.11 | 493.24 / 506.84 / 523.92 | 1.66 / 1.67 / 1.59 | 551.26 | 149.60 |

The relative gap is topology-sensitive because the safe path revalidates roots,
ancestors, directories, and prepared file generations while the unsafe control
does none of that. It is recorded as a diagnostic; it does not replace R1,
parity, safety, regression, or scaling gates.

## Gate verdicts

- **R1 / AE1: PASS.** All six 10,000-file warm p95 values are below 1,000 ms.
  Worst is 844.55 ms with 155.45 ms headroom.
- **Exact parity: PASS.** Every safe result SHA-256 equals both the frozen U8
  authority and the corresponding full unsafe canonical-search control.
- **500-file regression: PASS.** Worst shallow p95 is 33.00 ms and worst nested
  p95 is 181.80 ms. Both remain below the frozen contained
  [500-file baselines](./2026-08-13-search-baseline.md): shallow
  111.40 / 109.07 / 107.91 ms and nested 942.54 / 958.30 / 958.66 ms for
  no-hit / low-hit / high-hit, plus the larger of 20% or 50 ms.
- **Relative diagnostic: EXCEPTION.** The 10,000-file nested safe/full-unsafe
  ratios are 1.66x / 1.67x / 1.59x for no-hit / low-hit / high-hit. This
  comparator is diagnostic because the nested safe path performs the required
  containment and final-generation validation omitted by the full unsafe
  control, while R1, parity, safety, regression, and scaling all pass.
- **U5 bytes-only diagnostic: EXCEPTION.** On the 10,000-file nested fixture,
  safe-corpus p95 minus raw-read p95 is +401.66 ms (551.26 - 149.60), above the
  original raw-read-plus-150 ms proxy. The same amendment supersedes that clause
  because raw-read is a bytes-only lower bound that omits traversal,
  containment, generation validation, decoding, and canonical search work; it
  is informational and is not a release gate.
- **Operation scaling: PASS.** Accepted file paths remain exactly one `lstat`,
  one `realpath`, and one `open` per file. Between 2,500 and 10,000 at fixed
  topology, totals add exactly two `lstat`, one `realpath`, and one `open` per
  additional file. Shallow request overhead stays 32 `lstat` / 10 `realpath`;
  saturated nested request overhead stays 8,610 / 1,756. No observed-directory
  scan occurs inside the per-file mapper.
- **Safety and request scope: PASS.** Differential and adversarial tests cover
  final file mutation, directory/root generation, path and link safety,
  deterministic fair discovery, reader closure on every exit, session
  query/filter/limit replay, and whole-scope ceiling omissions.
- **Persistent index: DEFERRED.** The request-scoped safe scan meets R1 without
  adding a cache, database, embedding, vector, graph, daemon, or derived search
  authority.
