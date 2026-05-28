# DotAIOS Pilot Metrics

Pilot metrics are stored under `~/aios/memory/metrics` as JSONL events.
Primary stream for rollup is `pilot.jsonl`.

## Event sources

- `dotaios setup`: emits `install_start` and `install_end`
- `dotaios setup`: also emits funnel phase events `setup_phase_start` / `setup_phase_end` for `init`, `activate`, and `reveal` with a stable `run_id` for each setup run
- `dotaios search`: emits `search_run`
- `dotaios capture`: emits `capture_saved` and `capture_deleted`
- `dotaios pilot-score`: emits `pilot_score` with required provenance fields

Notes:

- Search telemetry stores `query_hash` (not raw query text).
- `first_recall_min` and `p_at_5` are scoring fields and are expected to come from pilot scoring workflow, not automatic search result counts.
- Required `pilot_score` provenance fields:
  - `scorer_id` (who scored)
  - `scorer_method_version` (scoring rubric/method version)
  - `scored_at` (ISO timestamp for when scoring happened)
- Anti-gaming policy: score from blinded or representative tasks only, do not cherry-pick easiest prompts, and never rewrite historical metric rows after scoring.

## Weekly rollup

Run:

`node scripts/pilot-rollup.mjs --path ~/aios`

or via CLI:

`dotaios pilot-report --path ~/aios`

The script reads local metric files and computes:

- `install_success_rate`
- `median_first_recall_min`
- `p_at_5_avg`
- `distinct_scorers`
- `go` (pilot gate) and `go_public` (stricter public gate)
- `incomplete`, `block_reasons`, and `public_block_reasons`

See `scoring-rubric.md` for the exact pilot vs public thresholds and the
anti-gaming rules the rollup enforces (multi-scorer requirement, future-dated
score rejection).

It prints JSON to stdout and writes `pilot-rollup.json` into `memory/metrics`.
