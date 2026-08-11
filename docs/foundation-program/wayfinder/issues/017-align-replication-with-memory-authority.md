---
title: Align personal replication with memory authority
label: wayfinder:issue
status: blocked
created: 2026-08-10
blocked_by:
  - 016-make-session-store-authoritative
---

## Problem

The public mobile workflow encourages competing phone and laptop writers even
though the accepted sync research pauses that claim until divergence and
restore are proved. Replica policy also permits read-created quarantine and
operational metric artifacts that can contain sensitive memory-derived bytes.

## Acceptance

- Sync is absent from default onboarding and is labelled experimental wherever
  it remains available until a two-writer proof passes.
- The mirror policy excludes quarantine, staging, lock, recovery, metric, and
  other derived/operational artifacts by class, not by one filename.
- Doctor detects already tracked disallowed artifacts without printing their
  sensitive contents or silently rewriting history.
- A replica is explicitly a private personal transport, not canonical memory,
  collaboration, or backup.
- Re-promotion requires serialized writer authority, divergence preservation,
  and a clean-machine restore from the exact candidate artifact.

## Evidence required to close

- Public-contract tests covering every onboarding and sync claim.
- Mirror-policy corpus including legacy quarantine/session-index sidecars and
  metrics, plus tracked-artifact doctor fixtures.
- Two-clone conflict and clean restore receipts before any non-experimental
  wording can return.

## Blocked checkpoint

Issue 016 now has a SessionStore implementation in review, including exclusion
and refusal of its private `.dotaios/session-store/` journal. That narrow
consumer-foundation change does not close or unblock this replication issue.
Issue 016 still needs exact-commit CI and independent iMac validation, and this
issue still requires its own operational-artifact policy, tracked-artifact
doctor fixtures, serialized writer authority, two-clone divergence proof, and
clean restore receipts.

Until those separate acceptance checks pass, personal replication remains an
experimental private transport. It is not canonical memory, collaboration, or
backup, and no replication-closure claim follows from the SessionStore work.
