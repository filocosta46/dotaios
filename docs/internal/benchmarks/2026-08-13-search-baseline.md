# Search benchmark baseline — 2026-08-13

This is the pre-optimization receipt for the current safe, contained Markdown
search path. It is a comparison authority for U5/U6, not a performance pass:
the 10,000-file baseline misses the under-one-second R1 gate while returning the
exact controlled results.

## Authority and protocol

- Manifest: `benchmarks/search/manifest.json`
- Manifest SHA-256: `b6c38cb5920f91b0a84c66be8181f6c14f7a1c73360fa4f07993b32a7704d55a`
- Generator: `dotaios-search-fixture-v1`, seed `20260813`, fixed mtime
  `2026-08-13T00:00:00.000Z`
- Reference machine: `mac16-1-m4-10c-16gb` (`Mac16,1`, Apple M4, 10 cores,
  16 GiB RAM), macOS 26.6.1 build 25G76 / Darwin 25.6.0
- Runtime: Node 22.22.3, arm64. The manifest and deterministic test also fix
  Node 20/22 as the supported comparison majors.
- Power profile: battery, no Low Power Mode, idle-machine requirement. The
  battery was at 69%, discharging, with no AC charger at the start.
- Per operation: 3 pre-warm-up samples, 3 warm-up samples, then 20 measured
  samples. The warm median/p95 are the decision statistics; the cold columns
  describe the three fresh-reader pre-warm-up observations (their p95 is the
  maximum of three), not a replacement for R1's 20-sample warmed gate.
- “Cold” means a fresh request-scoped evidence reader before harness warm-up;
  operating-system file cache state is intentionally uncontrolled. “Warm” uses
  a fresh reader after warm-up in the same Node process.
- Peak RSS is the maximum absolute process RSS observed for any sample in that
  row, not a heap delta. Operation counts are deterministic per sample.
- Every timed search sample was accepted only after exact ordered source
  equality. The raw control opened and read every inventory file and validated
  the exact file count and byte total. After timing, the harness re-hashed the
  actual fixture inventory before returning the report.
- A supplemental `raw-search-control-v1` uses the same frozen sampling fields
  without adding a manifest field or changing its receipt. That control is
  fixed by the harness schema as
  `harness-schema-v1-reusing-frozen-manifest-sampling`: it uses the existing
  3 cold / 3 warm-up / 20 measured protocol for each query. It was measured in
  a later control-only pass on the same machine, Node, battery power source, and
  disabled Low Power Mode (battery 56% at the start). No safe contained sample
  or bytes-only raw-read sample was rerun.
- The fixture and raw baseline reports used for this document were generated
  in an external temporary directory outside the repository. The committed
  reports under `docs/benchmarks/reports/` are separate repository artifacts.

The nested topology is a bounded, shared three-level tree with branching factor
8 (at most 512 leaf directory chains), rather than a unique ancestor chain per
file. The shallow topology uses two shared buckets. The matrix pairs
shallow/prose and nested/high-entropy at 500, 2,500, and 10,000 files.

## Immutable fixture receipts

| Fixture | Source bytes | Inventory SHA-256 |
| --- | ---: | --- |
| 500 / shallow / prose | 543,978 | `db6ab0454118d7cd1e2c54c3519db2018fddcba75e124105f13f1345dc525306` |
| 500 / nested / high-entropy | 519,370 | `16d7f2dc55c48230a2a65d71e93453245cd4bfd6b562701cd5c5cc95c3a5fe19` |
| 2,500 / shallow / prose | 2,731,459 | `229da6c47d147660684099dacb22af3362a3467b2e607a6823dd7d8bc582a910` |
| 2,500 / nested / high-entropy | 2,582,784 | `42178a1a3d649a5223662730f7373ce1505289feefbb88dd2afad3918194e537` |
| 10,000 / shallow / prose | 10,886,041 | `50a3e8026807256715a8f7ea5ffcb8d35c8a074d04c08badbf4e27c6119008c6` |
| 10,000 / nested / high-entropy | 10,319,743 | `cc818211f579b4c54fcacfaa42ed195be052d156c5161c1ccdf2f23cdd1bf9a8` |

Changing a corpus, query, machine, runtime, or sampling field changes the
manifest receipt. Regenerating a file, path, byte, or fixed mtime changes its
inventory receipt. An old row must not be compared after either hash changes.

## Timings and file operations

Times are milliseconds. `RSS MiB` is the maximum across cold and warm samples.

| Fixture | Operation | Cold median | Cold p95 | Warm median | Warm p95 | RSS MiB | lstat | realpath | open |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | no-hit | 115.45 | 138.57 | 105.74 | 111.40 | 111.7 | 18,554 | 6,018 | 500 |
| 500 / shallow / prose | low-hit | 106.16 | 107.50 | 106.48 | 109.07 | 112.5 | 18,554 | 6,018 | 500 |
| 500 / shallow / prose | high-hit | 106.52 | 107.03 | 106.58 | 107.91 | 112.8 | 18,554 | 6,018 | 500 |
| 500 / shallow / prose | raw-read | 7.24 | 7.40 | 6.85 | 7.32 | 115.1 | 0 | 0 | 500 |
| 500 / nested / high-entropy | no-hit | 938.10 | 969.52 | 932.91 | 942.54 | 115.4 | 56,174 | 13,432 | 500 |
| 500 / nested / high-entropy | low-hit | 936.43 | 937.50 | 944.89 | 958.30 | 114.9 | 56,174 | 13,432 | 500 |
| 500 / nested / high-entropy | high-hit | 950.66 | 951.17 | 952.01 | 958.66 | 115.1 | 56,174 | 13,432 | 500 |
| 500 / nested / high-entropy | raw-read | 8.25 | 9.53 | 6.94 | 7.48 | 115.5 | 0 | 0 | 500 |
| 2,500 / shallow / prose | no-hit | 539.00 | 548.46 | 525.63 | 560.88 | 114.5 | 92,554 | 30,018 | 2,500 |
| 2,500 / shallow / prose | low-hit | 529.74 | 531.23 | 526.73 | 535.64 | 114.4 | 92,554 | 30,018 | 2,500 |
| 2,500 / shallow / prose | high-hit | 528.83 | 532.53 | 522.84 | 528.05 | 114.5 | 92,554 | 30,018 | 2,500 |
| 2,500 / shallow / prose | raw-read | 33.97 | 34.82 | 32.40 | 32.97 | 117.2 | 0 | 0 | 2,500 |
| 2,500 / nested / high-entropy | no-hit | 4,362.47 | 4,364.22 | 4,357.28 | 4,415.01 | 133.0 | 214,558 | 53,510 | 2,500 |
| 2,500 / nested / high-entropy | low-hit | 4,412.81 | 4,435.83 | 4,424.79 | 4,473.72 | 134.0 | 214,558 | 53,510 | 2,500 |
| 2,500 / nested / high-entropy | high-hit | 4,448.70 | 4,464.04 | 4,423.31 | 4,467.79 | 134.3 | 214,558 | 53,510 | 2,500 |
| 2,500 / nested / high-entropy | raw-read | 35.63 | 37.20 | 33.95 | 34.25 | 131.6 | 0 | 0 | 2,500 |
| 10,000 / shallow / prose | no-hit | 2,090.84 | 2,097.96 | 2,069.22 | 2,089.91 | 124.6 | 370,054 | 120,018 | 10,000 |
| 10,000 / shallow / prose | low-hit | 2,109.78 | 2,118.19 | 2,086.30 | 2,103.04 | 123.9 | 370,054 | 120,018 | 10,000 |
| 10,000 / shallow / prose | high-hit | 2,089.16 | 2,096.40 | 2,090.27 | 2,109.22 | 124.2 | 370,054 | 120,018 | 10,000 |
| 10,000 / shallow / prose | raw-read | 133.07 | 138.83 | 132.52 | 135.39 | 126.4 | 0 | 0 | 10,000 |
| 10,000 / nested / high-entropy | no-hit | 15,102.39 | 15,229.67 | 15,151.46 | 15,219.07 | 390.0 | 807,058 | 203,510 | 10,000 |
| 10,000 / nested / high-entropy | low-hit | 15,025.84 | 15,169.58 | 15,126.71 | 15,253.17 | 391.6 | 807,058 | 203,510 | 10,000 |
| 10,000 / nested / high-entropy | high-hit | 15,043.19 | 15,272.44 | 15,213.70 | 15,588.76 | 392.4 | 807,058 | 203,510 | 10,000 |
| 10,000 / nested / high-entropy | raw-read | 139.18 | 145.01 | 138.47 | 161.99 | 346.0 | 0 | 0 | 10,000 |

## Unsafe benchmark-only raw-search control

This is the residual-logic comparison for U5/U6. It is deliberately unsafe and
benchmark-only: `searchMarkdownDir` still runs the canonical matching,
snippet-building, corpus-statistics, and ranking code unchanged, but its reader
does not perform containment, ancestor, directory-generation, or budget
validation. `listFiles` returns only paths from the immutable receipt inventory;
`readText(..., { returnSnapshot: true })` uses an `O_NOFOLLOW` open, handle read,
and `fstat`, then returns the file content and mtime to canonical search. The harness
verifies the fixture inventory before and after the matrix and validates exact
ordered results before accepting every sample. This reader lives only in
`scripts/bench-search.mjs`; it is not a production reader or a safe design
candidate.

Times are milliseconds. `RSS MiB` is the maximum across cold and warm samples.
Every row reports zero `lstat` and `realpath` operations; `open` is exactly one
per fixture file.

| Fixture | Query | Cold median | Cold p95 | Warm median | Warm p95 | RSS MiB | open |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 / shallow / prose | no-hit | 21.10 | 22.04 | 17.66 | 18.59 | 104.7 | 500 |
| 500 / shallow / prose | low-hit | 19.01 | 19.16 | 18.17 | 18.68 | 105.1 | 500 |
| 500 / shallow / prose | high-hit | 18.32 | 18.92 | 18.18 | 18.80 | 115.4 | 500 |
| 500 / nested / high-entropy | no-hit | 21.48 | 22.42 | 17.82 | 19.37 | 118.1 | 500 |
| 500 / nested / high-entropy | low-hit | 19.41 | 19.89 | 18.50 | 19.38 | 121.0 | 500 |
| 500 / nested / high-entropy | high-hit | 18.51 | 19.58 | 18.66 | 19.58 | 121.3 | 500 |
| 2,500 / shallow / prose | no-hit | 91.97 | 101.71 | 89.06 | 90.88 | 127.1 | 2,500 |
| 2,500 / shallow / prose | low-hit | 92.91 | 94.24 | 92.44 | 93.98 | 127.3 | 2,500 |
| 2,500 / shallow / prose | high-hit | 92.16 | 92.69 | 92.38 | 93.94 | 127.0 | 2,500 |
| 2,500 / nested / high-entropy | no-hit | 99.30 | 107.37 | 94.65 | 98.34 | 138.6 | 2,500 |
| 2,500 / nested / high-entropy | low-hit | 98.16 | 99.65 | 97.61 | 98.91 | 139.3 | 2,500 |
| 2,500 / nested / high-entropy | high-hit | 98.12 | 99.28 | 98.45 | 107.01 | 139.3 | 2,500 |
| 10,000 / shallow / prose | no-hit | 361.55 | 373.33 | 360.98 | 364.56 | 179.4 | 10,000 |
| 10,000 / shallow / prose | low-hit | 377.75 | 380.63 | 372.26 | 374.39 | 179.4 | 10,000 |
| 10,000 / shallow / prose | high-hit | 374.41 | 375.01 | 373.03 | 375.67 | 180.2 | 10,000 |
| 10,000 / nested / high-entropy | no-hit | 433.46 | 436.53 | 421.78 | 433.64 | 407.6 | 10,000 |
| 10,000 / nested / high-entropy | low-hit | 436.42 | 447.08 | 436.25 | 446.53 | 356.6 | 10,000 |
| 10,000 / nested / high-entropy | high-hit | 437.22 | 447.55 | 439.98 | 455.68 | 397.9 | 10,000 |

## Exact controlled results

Every fixture returned these expectations on every cold, warm-up, and measured
sample:

- `no-hit` (`zqxj-unfindable-20260813`): exactly `[]`.
- `low-hit` (`controlled-peregrine-benchmark-needle`): exactly four sources,
  ordered lexically by their generated path. At 10,000 files the shallow order
  is `vault/bucket-01/note-00003.md`, `vault/bucket-01/note-00017.md`,
  `vault/bucket-01/note-00101.md`, `vault/bucket-01/note-00307.md`. The nested
  order is `vault/branch-00/branch-00/branch-03/note-00003.md`,
  `vault/branch-00/branch-02/branch-01/note-00017.md`,
  `vault/branch-01/branch-04/branch-05/note-00101.md`,
  `vault/branch-04/branch-06/branch-03/note-00307.md`.
- `high-hit` (`common-benchmark-marker-needle`): exactly the first 20 ordered
  sources whose numeric file index is divisible by 25. This produces 20
  validated results at every count/topology without allowing a truncated or
  empty run to pass.

The full exact paths are reproducible from the manifest and are embedded in
each external fixture receipt. Their order is also covered by the deterministic
generator test; changing a query expectation invalidates the manifest receipt.

## Decision

The pre-change safe path fails R1 at 10,000 files in both representative matrix
cells: warm p95 is about 2.11 seconds for shallow/prose and 15.59 seconds for
nested/high-entropy. Raw-read warm p95 is 135.39 ms and 161.99 ms respectively.
Unsafe raw-search warm p95 is 364.56–375.67 ms and 433.64–455.68 ms
respectively, so canonical matching, snippets, corpus statistics, and ranking
remain below R1 when isolated from containment. This control is explanatory
only: its unsafe reader can never count as the optimized safe result.
The gap is accompanied by 370,054/120,018 and 807,058/203,510
`lstat`/`realpath` calls for 10,000 safe reads, while `open` remains exactly one
per file. This makes containment/path-validation multiplication, not raw source
reading or result validation, the falsifiable optimization target. U5/U6 must
preserve the exact outputs and safety contract while reducing that overhead;
an empty result, reordered result, or changed receipt is a failed benchmark.

## Reproduction

Use an empty destination outside the repository. Example:

```bash
node scripts/bench-search.mjs receipt
node scripts/bench-search.mjs generate \
  --output /tmp/dotaios-search-10000-shallow-prose \
  --receipt /tmp/dotaios-search-10000-shallow-prose.receipt.json \
  --count 10000 --layout shallow --distribution prose
node scripts/bench-search.mjs run \
  --fixture /tmp/dotaios-search-10000-shallow-prose \
  --receipt /tmp/dotaios-search-10000-shallow-prose.receipt.json \
  --output /tmp/dotaios-search-10000-shallow-prose.report.json
node scripts/bench-search.mjs raw-search \
  --fixture /tmp/dotaios-search-10000-shallow-prose \
  --receipt /tmp/dotaios-search-10000-shallow-prose.receipt.json \
  --output /tmp/dotaios-search-10000-shallow-prose.raw-search.report.json
```

Repeat with `--layout nested --distribution high-entropy` and with counts 500
and 2500. The harness exits nonzero on manifest/fixture receipt mismatch,
unsafe or changed inventory, search error, empty controlled output, exact-order
mismatch, unstable sample output, or raw-read file/byte mismatch.
The `raw-search` command runs only the unsafe benchmark-only residual control;
it does not rerun the contained or bytes-only controls.
