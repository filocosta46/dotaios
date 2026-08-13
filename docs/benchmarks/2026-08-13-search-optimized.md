# Search benchmark optimized receipt — 2026-08-13

This is the U6 measurement receipt for request-scoped safe bulk search. It uses
the frozen U8 authority unchanged and records both passing gates and observed
exceptions; an empty, reordered, unstable, errored, or inventory-mismatched
sample was rejected by the harness.

## Authority and protocol

- Manifest: `benchmarks/search/manifest.json`
- Manifest SHA-256: `b6c38cb5920f91b0a84c66be8181f6c14f7a1c73360fa4f07993b32a7704d55a`
- Fixtures and receipts: `/tmp/dotaios-search-baseline-20260813.yA3y7M`
- Full optimized JSON reports: `/tmp/dotaios-search-u6-final-*.report.json`
- Machine: `Mac16,1`, Apple M4, 10 cores, 16 GiB; macOS 26.6.1 build
  25G76 / Darwin 25.6.0; Node 22.22.3 arm64.
- Power: battery, Low Power Mode disabled; 44%, discharging when recorded after
  the matrix. The harness ran on the frozen reference machine and profile.
- Each operation used 3 cold samples, 3 warm-up samples, and 20 measured warm
  samples. A fresh request-scoped reader was used for each safe sample.
- Peak RSS is the largest absolute process RSS in the cold or warm samples.
- Every safe and unsafe canonical-search sample validated the exact ordered
  result before its duration was accepted. The fixture inventory was hashed
  before and after the matrix. The bytes-only and safe-corpus controls validated
  exact file count and byte total before accepting a sample.

The `raw-search` rows are the full unsafe U8 comparison: they run canonical
matching, snippets, corpus statistics, and ranking, omitting containment only.
The `raw-read` rows are the deliberately unlike bytes-only informational lower
bound. `safe-corpus` measures U5 enumeration, safe UTF-8 reads, callback
consumption, and final generation validation without canonical search work.

## End-to-end safe search

Times are milliseconds.

| Fixture | Query | Cold median | Cold p95 | Warm median | Warm p95 | RSS MiB | lstat | realpath | open |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | no-hit | 34.91 | 41.29 | 27.23 | 28.07 | 110.97 | 1,020 | 506 | 500 |
| 500 / shallow / prose | low-hit | 28.98 | 29.16 | 27.70 | 28.86 | 122.25 | 1,020 | 506 | 500 |
| 500 / shallow / prose | high-hit | 26.75 | 26.79 | 27.79 | 28.64 | 122.75 | 1,020 | 506 | 500 |
| 500 / nested / high-entropy | no-hit | 112.25 | 125.21 | 102.72 | 105.07 | 129.73 | 3,865 | 1,075 | 500 |
| 500 / nested / high-entropy | low-hit | 106.10 | 107.34 | 103.75 | 106.67 | 129.73 | 3,865 | 1,075 | 500 |
| 500 / nested / high-entropy | high-hit | 104.16 | 104.32 | 103.63 | 106.94 | 129.94 | 3,865 | 1,075 | 500 |
| 2,500 / shallow / prose | no-hit | 140.24 | 157.01 | 131.74 | 139.05 | 137.48 | 5,020 | 2,506 | 2,500 |
| 2,500 / shallow / prose | low-hit | 135.67 | 137.60 | 134.73 | 137.85 | 137.81 | 5,020 | 2,506 | 2,500 |
| 2,500 / shallow / prose | high-hit | 136.15 | 136.66 | 136.02 | 138.47 | 137.83 | 5,020 | 2,506 | 2,500 |
| 2,500 / nested / high-entropy | no-hit | 240.05 | 257.38 | 226.09 | 238.91 | 229.88 | 7,930 | 3,088 | 2,500 |
| 2,500 / nested / high-entropy | low-hit | 232.49 | 235.30 | 228.82 | 232.74 | 201.55 | 7,930 | 3,088 | 2,500 |
| 2,500 / nested / high-entropy | high-hit | 229.98 | 230.15 | 228.73 | 231.46 | 201.83 | 7,930 | 3,088 | 2,500 |
| 10,000 / shallow / prose | no-hit | 626.94 | 716.81 | 544.71 | 568.40 | 196.44 | 20,020 | 10,006 | 10,000 |
| 10,000 / shallow / prose | low-hit | 576.57 | 598.39 | 557.53 | 566.00 | 196.52 | 20,020 | 10,006 | 10,000 |
| 10,000 / shallow / prose | high-hit | 562.01 | 564.11 | 555.19 | 569.29 | 201.88 | 20,020 | 10,006 | 10,000 |
| 10,000 / nested / high-entropy | no-hit | 757.91 | 785.28 | 748.63 | 767.48 | 433.78 | 22,930 | 10,588 | 10,000 |
| 10,000 / nested / high-entropy | low-hit | 770.44 | 778.80 | 755.23 | 766.35 | 434.28 | 22,930 | 10,588 | 10,000 |
| 10,000 / nested / high-entropy | high-hit | 758.90 | 793.22 | 771.03 | 818.54 | 434.48 | 22,930 | 10,588 | 10,000 |

## Full unsafe canonical-search control

Each row performed exactly one `open` per file and zero `lstat`/`realpath`.

| Fixture | Query | Cold median | Cold p95 | Warm median | Warm p95 | RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | no-hit | 19.75 | 19.88 | 19.25 | 19.62 | 137.27 |
| 500 / shallow / prose | low-hit | 19.67 | 19.90 | 19.87 | 21.42 | 145.67 |
| 500 / shallow / prose | high-hit | 20.01 | 20.47 | 19.86 | 20.31 | 145.73 |
| 500 / nested / high-entropy | no-hit | 20.07 | 20.12 | 19.43 | 20.51 | 132.86 |
| 500 / nested / high-entropy | low-hit | 20.42 | 20.63 | 20.75 | 25.10 | 132.64 |
| 500 / nested / high-entropy | high-hit | 20.50 | 23.25 | 20.55 | 30.53 | 146.59 |
| 2,500 / shallow / prose | no-hit | 97.91 | 98.85 | 95.41 | 104.64 | 138.31 |
| 2,500 / shallow / prose | low-hit | 96.15 | 105.91 | 98.11 | 99.95 | 138.31 |
| 2,500 / shallow / prose | high-hit | 99.72 | 101.05 | 98.65 | 99.64 | 138.38 |
| 2,500 / nested / high-entropy | no-hit | 105.99 | 108.27 | 105.50 | 110.82 | 202.70 |
| 2,500 / nested / high-entropy | low-hit | 108.56 | 112.78 | 109.91 | 111.79 | 200.94 |
| 2,500 / nested / high-entropy | high-hit | 108.37 | 110.64 | 111.41 | 133.47 | 200.94 |
| 10,000 / shallow / prose | no-hit | 391.11 | 398.40 | 387.39 | 391.05 | 203.86 |
| 10,000 / shallow / prose | low-hit | 399.36 | 400.90 | 399.90 | 404.18 | 203.86 |
| 10,000 / shallow / prose | high-hit | 403.78 | 406.80 | 402.17 | 423.49 | 203.86 |
| 10,000 / nested / high-entropy | no-hit | 497.36 | 503.57 | 493.99 | 504.41 | 489.48 |
| 10,000 / nested / high-entropy | low-hit | 514.03 | 514.49 | 509.24 | 517.55 | 447.09 |
| 10,000 / nested / high-entropy | high-hit | 511.83 | 516.43 | 508.93 | 522.15 | 495.97 |

## Safe-corpus and bytes-only controls

Times are milliseconds. Safe-corpus rows include the same safe operation totals
as end-to-end search. Raw-read rows have zero `lstat`/`realpath` and one `open`
per file.

| Fixture | Control | Cold median | Cold p95 | Warm median | Warm p95 | RSS MiB | lstat | realpath | open |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | safe-corpus | 20.39 | 20.45 | 18.59 | 19.07 | 148.17 | 1,020 | 506 | 500 |
| 500 / shallow / prose | raw-read | 7.65 | 8.10 | 7.15 | 7.46 | 147.91 | 0 | 0 | 500 |
| 500 / nested / high-entropy | safe-corpus | 94.26 | 95.39 | 93.69 | 98.96 | 138.56 | 3,865 | 1,075 | 500 |
| 500 / nested / high-entropy | raw-read | 7.99 | 8.59 | 7.32 | 7.64 | 138.50 | 0 | 0 | 500 |
| 2,500 / shallow / prose | safe-corpus | 91.17 | 93.45 | 90.61 | 91.62 | 141.25 | 5,020 | 2,506 | 2,500 |
| 2,500 / shallow / prose | raw-read | 36.28 | 36.75 | 35.11 | 35.74 | 140.69 | 0 | 0 | 2,500 |
| 2,500 / nested / high-entropy | safe-corpus | 204.14 | 211.85 | 188.74 | 205.08 | 189.67 | 7,930 | 3,088 | 2,500 |
| 2,500 / nested / high-entropy | raw-read | 40.36 | 41.97 | 37.78 | 43.28 | 189.52 | 0 | 0 | 2,500 |
| 10,000 / shallow / prose | safe-corpus | 373.26 | 379.31 | 374.75 | 394.82 | 205.00 | 20,020 | 10,006 | 10,000 |
| 10,000 / shallow / prose | raw-read | 145.70 | 169.20 | 145.97 | 151.01 | 204.50 | 0 | 0 | 10,000 |
| 10,000 / nested / high-entropy | safe-corpus | 471.01 | 478.09 | 473.22 | 500.71 | 419.91 | 22,930 | 10,588 | 10,000 |
| 10,000 / nested / high-entropy | raw-read | 150.03 | 163.63 | 149.04 | 151.78 | 356.63 | 0 | 0 | 10,000 |

## Exact results and operation scaling

Every cold, warm-up, measured, safe, and raw-search sample returned the same
ordered sources and result hash. At 10,000 files:

- `no-hit`: exactly `[]`.
- Shallow `low-hit`: `vault/bucket-01/note-00003.md`,
  `vault/bucket-01/note-00017.md`, `vault/bucket-01/note-00101.md`,
  `vault/bucket-01/note-00307.md`.
- Nested `low-hit`: `vault/branch-00/branch-00/branch-03/note-00003.md`,
  `vault/branch-00/branch-02/branch-01/note-00017.md`,
  `vault/branch-01/branch-04/branch-05/note-00101.md`,
  `vault/branch-04/branch-06/branch-03/note-00307.md`.
- `high-hit`: exactly the first 20 generated paths in lexical order whose file
  index is divisible by 25, as embedded in the immutable fixture receipt. The
  10k result hashes are `9b3d7e484ca325f107d3363721ce8b99b038149f4b79a4f23c25e52c393bfe3f`
  (shallow) and `0bcab7da3781ba39e4bdcbc5e04bb5f2bc293ad8dbc75d19f43ee4fca5c0da58`
  (nested). Low-hit hashes are `6bc96a7e535089d0f1232a6aa21cf6cf2b255f9d1ddccfe2dea5b098ff0c98b5`
  and `3426468c469ccf3a134e93a71f6dea6f3a21d3e622918668af97a098bee9b3fd`;
  no-hit is `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

The harness attributes accepted-file paths separately: every cell has exactly
one `lstat`, one `realpath`, and one `open` on each accepted file path. Other
containment-path counts remain separately visible. Between 2,500 and 10,000,
both fixed topologies have exact total-operation slopes of 2 `lstat`, 1
`realpath`, and 1 `open` per added file; the nested fixed overhead is unchanged
at 2,930 `lstat` and 588 `realpath`, and shallow fixed overhead is unchanged at
20/6. Therefore accepted-file-path per-file counts differ by 0%, and a fixed-topology
doubling is bounded by 2.0x (below 2.1x). Enumeration occurs once before file
mapping and final observed-directory validation occurs once after ranking; no
directory scan is inside the per-file mapper. If the strict per-file comparison
is instead calculated by dividing request-level aggregate totals by file count,
shallow stays within 1%, while
nested `lstat` falls from 3.172 to 2.293 per file (27.7%) and nested `realpath`
from 1.2352 to 1.0588 (14.3%) as the same fixed 512-leaf topology overhead is
amortized. Those derived aggregate ratios exceed 10%, but they are not per-file
operations: the harness records fixed containment-path work separately from the
accepted-file-path work that the invariant is intended to constrain.

## Real AIOS folder check

The product CLI searched the configured `/Users/filo/aios` vault for
`indexing`, limited to five results. The returned output was inspected and
contained five substantive research records about source handling, retrieval,
competitive systems, and web discoverability. The pre-change and optimized
commands produced the same visible output SHA-256
`8eecbb5f4b4c1faa8f8a2e679d7f8be6a932f7807743bc4b22e7d018b7f25b06`.

After two warm-up runs, five measured fresh-process samples produced:

| Path | Median | p95 | Stable output |
| --- | ---: | ---: | --- |
| Pre-change `9815261` | 476.99 ms | 553.04 ms | yes |
| Optimized working tree | 254.07 ms | 259.19 ms | yes |

This is informational evidence, not a replacement for the frozen fixture. An
unscoped product search also printed `Project corpus omitted because no
--project selector was supplied.`, confirming that projects are not silently
included without a selector.

## Gate verdicts

- **R1 / AE1: PASS.** All six 10,000-file warmed p95 values are below 1,000
  ms. Worst observed is 818.54 ms (nested/high-entropy/high-hit), with 20
  measured samples and exact 20-hit order.
- **Parity / safety / request scope: PASS.** The differential suite covers
  substring, inflection, punctuation and line-spanning terms, frontmatter
  descriptions, title/path boosts, recency/ties, memory streams/daily/inbox,
  plugin manifest predicate, project selector, external vault, omitted secret,
  plugin, and project sources. A changed final generation rejects ranked
  callback output; added, modified, and deleted files appear next request.
- **500 regression: PASS.** Worst safe warm p95 is 28.86 ms shallow and
  106.94 ms nested, versus baselines of 107.91–111.40 ms and 942.54–958.66 ms;
  every query is below baseline plus the larger of 20% or 50 ms.
- **Operation scaling: PASS.** Accepted-file-path counts are exactly 1/1/1 and
  their 2,500-to-10,000 per-file difference is 0%; total-operation slopes are
  2/1/1 per added file, fixed-topology doubling is no worse than 2.0x, and
  there is no file-by-directory multiplication. Request-level directory work
  is reported separately; dividing that fixed overhead by changing file counts
  produces the transparent 27.7%/14.3% nested aggregate ratios above but does
  not change the per-file operation invariant.
- **10k safe/full-unsafe target: PASS for shallow, EXCEPTION for nested.**
  Shallow ratios are 1.45x, 1.40x, and 1.34x. Nested ratios are 1.52x, 1.48x,
  and 1.57x. The no-hit and high-hit nested samples exceed the 1.5x target by
  0.02x and 0.07x while still passing R1.
- **Bytes-only raw-read: informational only.** It deliberately omits matching,
  snippets, corpus statistics, ranking, and all containment and is not the U6
  relative authority.
- **U5 raw-read +150 ms preliminary gate: EXCEPTION in this matrix.** Safe
  corpus-read minus raw-read warm p95 is +11.61 ms (500 shallow), +91.32 ms
  (500 nested), +55.88 ms (2,500 shallow), +161.81 ms (2,500 nested), +243.81
  ms (10,000 shallow), and +348.92 ms (10,000 nested). This supplemental U6
  measurement does not satisfy that preliminary gate at 2,500 nested or either
  10,000 cell. The implementation and frozen protocol were not weakened or
  moved to conceal the miss.

The U5 preliminary comparison is a conservative proxy whose bytes-only control
omits the canonical matching/ranking work that U6 must perform. Execution
proceeded because the actual end-to-end U6 authority is stronger and passed:
all six safe 10k searches are below R1's one-second limit, the worst is below
the plan's 900 ms combined target, exact parity and safety pass, and the real
folder result improved. Removing per-file canonical or identity validation to
force the unlike bytes-only proxy green would violate R3; no such weakening was
accepted. Persistent indexing therefore remains deferred under KTD2.

No dependency, build step, persistent index/cache, vector, embedding, graph,
daemon, or database was introduced.
