# Pilot Scoring Rubric

The local rollup computes two go/no-go booleans: `go` (ship a controlled pilot)
and `go_public` (ship a public launch). `go_public` requires `go` plus a
stricter bar.

## Pilot gate (`go`)

- `install_success_rate >= 0.90`
- `median_first_recall_min <= 15`
- `p_at_5_avg >= 0.60`
- at least 5 valid score samples (default `--min-score-sample`)
- at least 2 distinct `scorer_id`s — single-scorer samples are blocked (`single_scorer`)
- zero invalid score rows

## Public gate (`go_public`)

All pilot gates, plus:

- `install_success_rate >= 0.95`
- at least 10 valid score samples
- at least 3 distinct `scorer_id`s

Public-only blocks appear under `public_block_reasons`.

## Required provenance for each score

Each `pilot_score` row must include:

- `scorer_id`
- `scorer_method_version`
- `scored_at` (ISO timestamp, not in the future)
- scored values: `first_recall_min`, `p_at_5`

Rows missing required provenance, carrying a future `scored_at`, or missing
scored values are excluded from quality gates and flagged as `invalid_score_rows`.

## Anti-gaming policy

- Use representative tasks, not cherry-picked easy cases.
- Scores must come from at least two independent scorers; the gate enforces this.
- Keep scorer method stable within a run; bump `scorer_method_version` when rubric changes.
- Do not backfill or mutate old score rows to force pass/fail outcomes.
- If methodology changes materially, start a fresh sample set before gate decisions.

## Interpretation

- `go = true`: pilot quality is good enough to continue a controlled rollout.
- `go_public = true`: quality holds at a larger, multi-scorer sample — safe for public launch.
- `go = false`: hold rollout and address the weakest metric first.

## Practical guidance

- Improve install success by fixing setup failures and docs clarity.
- Improve first recall by reducing time-to-first-use and search friction.
- Improve `p_at_5` by better indexing and retrieval quality.
