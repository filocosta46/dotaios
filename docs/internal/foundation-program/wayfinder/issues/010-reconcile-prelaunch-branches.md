---
title: Reconcile the prelaunch branches safely
label: wayfinder:task
status: open
assignee:
blocked_by:
  - Choose the first vertical slice
---

## Question

How should the remote PR branch, the iMac's six divergent commits, the Gemini preservation fix, and the selected Foundation slice be reconciled without force-push, lost commits, unreviewed scope drift, or competing writers?

## Resolution

The safe, non-rewriting sequence is documented in `docs/foundation-program/release-reconciliation-plan.md`.

PR #59 is an eight-commit descendant of `origin/main` and should be merged as a complete preserved line after the Foundation documentation checkpoint is committed.
The iMac six must first be fetched into a new local archival ref through read-only transport, then reviewed commit by commit.
Mixed or contract-breaking iMac commits are reimplemented behind failing tests; the iMac branch is never reset, rebased, force-pushed, or merged wholesale.

Planning is resolved, but execution remains blocked by the first-slice branch checkpoint and the gate-specific tests.
