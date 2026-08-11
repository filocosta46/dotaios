---
title: Research local-first sync and recovery
label: wayfinder:research
status: closed
assignee:
blocked_by: []
---

## Question

Which single-writer or small-team replication, conflict, restore, and provenance patterns can support a truthful second-device promise without letting Git, MCP, or a derived index become the user's memory authority?

## Resolution

Keep the first claim to personal replicas with serialized writers. Treat replication, history, and backup as separate jobs; fail closed on divergence; preserve both sides; stage restore; and expose actionable receipts. Team collaboration, bundled background sync, backup integration, CRDTs, and a shared replication abstraction remain deferred.

Evidence: `../../research/2026-08-09-sync-recovery-patterns.md`, `../../audits/2026-08-09-imac-independent-audit.md`.
