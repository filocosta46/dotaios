---
title: Bound and measure progressive skill routing
label: wayfinder:issue
status: blocked
created: 2026-08-10
blocked_by:
  - 007-create-measurement-fixtures
  - 015-contain-remaining-mcp-readers
---

## Problem

Managed boot instructions load complete skill catalogs before selecting one
workflow, and the lexical router has no representative recall, false-route,
ambiguity, Unicode, shortlist-size, or latency contract. This violates the
product's progressive-disclosure premise and makes routing quality anecdotal.

## Acceptance

- Boot context points to one bounded routing surface rather than requiring full
  INDEX and RESOLVER ingestion before every task.
- The existing router returns a bounded shortlist with explicit no-match and
  ambiguity behavior; metadata input uses the contained reader from issue 015.
- A fixed public corpus of representative, adversarial, Unicode, no-match, and
  ambiguous intents measures top-1 recall, false-route rate, shortlist bytes,
  and local latency.
- Production measurement records no query-derived identifier or replicable
  private text; quality is evaluated from fixed reviewed fixtures.

## Evidence required to close

- Baseline and post-change results over at least 30 representative intents.
- Byte/latency bounds, Unicode/tokenization cases, malformed/oversize skill
  metadata, and exact no-match/ambiguity assertions.
- Bridge/public-contract tests proving progressive disclosure on every host.
