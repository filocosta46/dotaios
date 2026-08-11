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

## Implementation checkpoint

Implementation is in review. The current candidate routes capture,
reconciliation, bounded search metadata, and exact deletion through one
`SessionStore`; treats schema-1 Markdown as canonical and `index.jsonl` as a
rebuildable projection; and journals capture, projection rebuild, and deletion
for idempotent forward recovery.

The candidate serializes source observation through publication. Strict
same-source growth extends one record, an older prefix is a no-op, and
non-prefix versions are preserved as conflicts. Reconciliation reports orphan
Markdown; stale, malformed, or unsafe rows; invalid Markdown; duplicate IDs,
paths, or sources; conflicts; missing projection state; and operational poison
without silently deleting evidence. Stored paths and canonical artifacts are
validated before read, update, or delete; unsafe, linked, special, hardlinked, replaced,
duplicate, absolute, traversing, and outside cases refuse.

CLI, working-context, promotion, and MCP session consumers use the read-only
store boundary without adding tools or returning absolute machine paths. The
save-session skill submits bounded prepared Markdown to
`dotaios capture import prepared` on standard input. Private operational state
under `.dotaios/session-store/` is excluded from managed mirrors and refused by
mirror content validation.

This checkpoint is not closure evidence. Replace these placeholders only after
the reviewed candidate is fixed and the receipts exist:

- Exact candidate commit: `PENDING_EXACT_COMMIT_AFTER_REVIEW`
- Ready pull request: `PENDING_READY_PR`
- Candidate CI result: `PENDING_CI`
- Independent exact-commit iMac validation: `PENDING_IMAC_VALIDATION`

Issue 016 remains open until the complete local gate, exact packed-content
check, CI, and independent iMac replay pass against that same commit.
