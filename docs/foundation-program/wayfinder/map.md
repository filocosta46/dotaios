---
title: Foundation reliability specification and release-candidate slice
label: wayfinder:map
status: open
created: 2026-08-09
---

## Destination

An approved, testable Foundation reliability specification for the defined knowledge-worker ICP, including one smallest release-candidate slice whose cross-agent or second-device value is measured and independently validated.

## Notes

- Work covers the free, local-first, host-neutral Foundation; the Consultant Pack, checkout, publishing, and commercial operations are excluded.
- Use repository evidence and primary sources. Treat historical audits and the iMac branch as hypotheses until independently verified.
- Consult `research`, `ce-pov`, `ce-brainstorm`, `domain-modeling`, `improve-codebase-architecture`, `ce-plan`, `tdd`, and `code-review` at their owning stages.
- The mission explicitly carries execution beyond the map after specification and planning gates pass. Product-code writing stays on the MacBook worktree; the iMac is review and clean-host validation only.
- Every claimed improvement needs a fixture, baseline, pass/fail criterion, provenance, and a recovery or failure-path check where relevant.

## Decisions so far

- [Retrieval/context research](issues/003-research-retrieval-context.md): deepen task-aware composition around the existing lexical reader; import provenance, progressive disclosure, and deterministic evidence, not a new graph/vector platform.
- [Sync/recovery research](issues/004-research-sync-recovery.md): call the scope personal replication, serialize writers, fail closed on divergence, preserve both sides, and stage verified restore; do not imply collaboration or backup.
- [Prelaunch reconciliation](issues/010-reconcile-prelaunch-branches.md): preserve the full green PR #59 line, archive the iMac head through read-only transport, review its six commits individually, and reimplement mixed changes behind failing tests instead of merging the iMac branch wholesale.
- [Hermes support contract](issues/011-resolve-hermes-support-contract.md): retain the global configuration adapter, remove the inert project target, and require an owned runtime selector plus a safe produced-result receipt before project support can return.
- [Gemini connection safety](issues/012-harden-gemini-connection.md): treat
  `settings.json` as the activation point, guard all three artifacts, preserve
  proven ownership boundaries, and pin the runtime command so an opened project
  cannot shadow DotAIOS.
- [Working-context maintenance envelope](issues/013-unify-working-context-maintenance-envelope.md):
  inspect migration state without traversing memory, then expose the same
  actionable facts through compact CLI text, hook JSON, and MCP without changing
  the canonical working-context projection or its budget.
- [Working-context read boundary](issues/014-make-working-context-read-only-and-contained.md):
  block envelope closure until corrupt input is non-mutating, every projected
  source is contained inside AIOS, MCP errors are path-free, and non-projection
  metadata is explicitly bounded.

## Not yet specified

- Whether the first proof targets cross-agent continuity on one device or cross-device continuity after replication.
- Which non-Hermes supported-host tiers can honestly be claimed after current official documentation and fresh-host probes are reconciled.
- Whether a derived lexical index or metadata view earns its cost after baseline measurements; no vector, graph, or cloud store is assumed.
- Which independent prelaunch gate follows the Gemini connection correction.

## Out of scope

- Paid Consultant Pack readiness, checkout, Gumroad, customer terms, entitlements, and commercial website work.
- npm publication, GitHub Release publication, branch-protection changes, credentials, and payment systems.
- Enterprise teams, roles, ACLs, hosted company memory, or a company operating system.
- A new vector database, graph database, cloud memory service, or opaque canonical index without measured evidence that the plain-file baseline fails.
- Copying, embedding, or forking AGPL or otherwise license-incompatible competitor code without a separate explicit license decision.
