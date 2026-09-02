# Fixture Contract — Project Decision Recall

Date: 2026-08-09
Status: baseline reproduced; acceptance test not yet implemented

## User job

A fresh supported agent receives the normal bounded packet for `acme-launch` and must answer:

> Prepare Acme's kickoff email. What package and timeline did we already decide, and what must I not promise?

The authoritative project README contains five synthetic decisions. The decisive fifth entry is below enough harmless project history to sit beyond the current 1,200-character project excerpt:

```text
projects/acme-launch/README.md:25-27
DECISION_ACME_KICKOFF_7DAY: Use the seven-day async kickoff package; do not promise a discovery call.
```

An unrelated project contains `SECRET_OTHER_CLIENT_42`, and the target project's frontmatter contains `/Users/alice/Clients/Acme`. Both are privacy canaries that must never appear.

## Production-shaped invocation

```js
const result = await buildWorkingContext(
  aiosPath,
  { project: "acme-launch", visibleCharacterBudget: 6000 },
  { clock: fixedClock },
);
```

The task text is evaluator input, not a current API option. This first fixture asks whether structured high-signal project decisions survive the default bounded projection; it does not yet introduce task-query ranking.

## Baseline characterization

| Metric | Current | First-slice acceptance |
|---|---:|---:|
| Offered decisions | 5 | 5 |
| Admitted decisions | 4 | 5, or target admitted with explicit reasons for other omissions |
| Omitted decisions | 1 | 0 for this small corpus |
| Target recall | 0 | 1 |
| Visible provenance | 0 | 1 |
| Character budget | pass | pass, `<= 6000` |
| Cross-project canary absent | pass | pass |
| Absolute-path canary absent | pass | pass |
| Deterministic output | pass | pass |

Baseline receipt from 25 measured local builds on 2026-08-09:

```json
{
  "offered": 5,
  "admitted": 4,
  "omitted": 1,
  "bytes": 1341,
  "characters": 1336,
  "recall": 0,
  "provenance": 0,
  "median_ms": 0.514,
  "p95_ms": 1.164,
  "bounded": true,
  "deterministic": true,
  "absolute_path_absent": true,
  "cross_project_absent": true,
  "full_source_loaded": true
}
```

The executable diagnostic is retained outside the repository at `/tmp/dotaios-foundation-baseline-20260809/decision-recall-baseline.mjs` so the release branch contains the contract, not an unapproved implementation test.

The current failure is structural:

- the catalog retains the full README;
- a separate project excerpt truncates at 1,200 characters;
- working context renders the description/excerpt, not structured decisions or their source lines;
- the budget layer sees only already-truncated candidates, so its `truncated` bit cannot report this omission.

The existing lexical reader is already strong enough for the same synthetic task. A scoped search for `kickoff package discovery call` returns one result containing the target decision, repo-relative source `projects/acme-launch/README.md`, and match range `25-27`. The missing capability is therefore not proven to be a better retrieval algorithm; it is the production composition that connects task intent, scoped retrieval evidence, budget admission, rendering, and the portable host contract.

## Measurement contract

- Record `offered`, `admitted`, `omitted`, UTF-8 bytes, character count, target recall, visible provenance, and omission reason.
- Use one warm-up plus 25 measured builds for a same-host median and p95 latency receipt; do not put a tight wall-clock assertion in the unit test.
- Preserve the current character-budget assertion and require no more than 2x the same-host baseline in the implementation receipt.
- Snapshot fixture files before and after; the projection has no write effects.
- Repeat the same acceptance on the MCP adapter and the independent iMac host.

## Smallest credible seam

Preserve line-addressable project decision candidates while reading the selected project README, render them before the generic excerpt, and attach repo-relative provenance. The README remains canonical; the packet is a bounded read projection.

This slice requires no vector store, graph, embeddings, model call, network service, new durable index, or automatic memory write. If representative projects later prove that all structured decisions cannot fit, task-aware ranking becomes a separate measured slice.

## Pressure-test result

The heading-based seam is an implementation hypothesis, not yet the product answer. Repository documentation says a project README contains decisions, but a read-only scan of the owner's eight current top-level project records found only one with a `## Decisions` or `### Decisions` heading.

Therefore this fixture proves the current upstream truncation/provenance failure, but it does not by itself prove that parsing one heading serves representative project records. Before the Product Contract is settled, choose between:

- task-aware retrieval over ordinary project prose; or
- an explicit project-record decision schema plus migration, onboarding, and agent-maintenance behavior.

A heading-only patch without that product choice would optimize the fixture rather than the ICP job.
