---
title: Make session memory an authoritative transactional store
label: wayfinder:issue
status: open
created: 2026-08-10
blocked_by:
  - 002-define-memory-domains-authority
---

## Problem

Session Markdown and its JSONL index do not share one transaction boundary.
Same-source writers can race, a crash can leave orphan or invisible memory, and
tampered index paths are joined directly for search, update, and delete. A
traversal or linked entry can therefore escape the AIOS root.

## Acceptance

- Session Markdown is declared canonical evidence and the index is a validated,
  rebuildable derivative; one `SessionStore` owns capture, search, delete, and
  reconcile semantics.
- Same-source capture is serialized from observation through publication, and
  every crash boundary has a deterministic idempotent recovery result.
- Index records reject malformed, conflicting, duplicate, absolute, traversal,
  linked, special, changed, or outside paths before bytes or deletes occur.
- Search and delete are contained and non-mutating outside the exact authorized
  session artifact; update cannot unlink a path it did not prove it owns.
- Reconciliation inventories orphaned Markdown and stale index rows without
  silently deleting user evidence.

## Evidence required to close

- Same-source concurrent-growth and process-crash matrix.
- Orphan rebuild, stale-index, duplicate-source, traversal, symlink, hardlink,
  special-file, swap, and delete-refusal fixtures with outside canaries.
- Whole-tree byte snapshots and recovery receipts proving no lost or duplicated
  captured turns.
- Full local and independent exact-commit validation.
