---
title: Unify working-context migration state across CLI, hooks, and MCP
label: wayfinder:issue
status: complete
created: 2026-08-09
blocked_by:
  - 014-make-working-context-read-only-and-contained
---

## Problem

DotAIOS promises one canonical bounded working-context projection, but the
discarded iMac patch added schema notices only to CLI output. Copying that patch
would also run the full migration preview on every session start, recursively
reading and hashing the protected memory shelves of the stale users who most
need the notice.

## Acceptance

- Build one shared read-only operational envelope around the unchanged canonical
  working-context projection.
- Inspect only `aios.json` and owned migration transaction metadata; never walk
  `context/`, `projects/`, `memory/`, or `vault/` for a session-start notice.
- Represent `current`, `schema_outdated`, `transaction_present`, and
  `inspection_failed` state
  without leaking an absolute local path or taking down a valid projection.
- Expose equivalent actionable facts in compact CLI text, Gemini hook JSON, and
  MCP `read_working_context` while keeping projection selection and budget semantics
  unchanged.
- Keep lean and daily-brief behavior outside this adapter-parity correction.
- Keep the projection budget unchanged. Cap each rendered operational notice and
  all non-`markdown` MCP metadata at 1,024 characters. JSON escaping and
  protocol framing are representation costs outside this measurement and must
  never cause a valid bounded projection to fail.
- Prove zero writes and bounded local latency for every state and access path.

## Evidence required to close

- Focused core, CLI, JSON-hook, and MCP tests for the complete state matrix.
- Byte snapshots proving each access path is read-only.
- A zero-spawn check proving read-only CLI modes cannot schedule the sync hook.
- Deterministic file/byte/entry limits plus a local access-path timing receipt.
- Complete suite, syntax, package, smoke, and diff checks.
- Independent exact-commit validation after implementation review.

## Completion

Implemented at `f804957`. The branch working tree was independently validated
on the iMac with Node v22.22.3: 1,345 passed, 0 failed, 1 intentionally skipped.
