---
title: ManagedSkillStore Independent Architecture Review
date: 2026-08-11
base_commit: c86d1f94ff88df7ac27580dace80817edd91b65e
reviewed_design: docs/managed-skill-store-design.md
verdict: approved-with-documented-portability-boundary
---

# ManagedSkillStore Independent Architecture Review

## Verdict

Approved for test-first implementation after one reject-and-correct cycle. The implemented seam was then independently challenged against recovery, deletion authority, bounded state, and exact-retry behavior; the in-scope P0/P1 findings were corrected before release gates.

## First-pass findings and disposition

| Priority | Finding | Disposition |
|---|---|---|
| P1 | Portable Node could not support the design's original race-free removal claim and removal lacked a dedicated journal. | Corrected to a cooperative-writer observation boundary, same-filesystem whole-root rename linearization point, immediate archive verification, explicit `needs_attention` retention under uncooperative races, platform refusal, and a full removal state machine. |
| P1 | Direct canonical/catalog/projection writers could bypass the facade. | Added an exhaustive writer-closure map covering trigger edits, catalog exports, raw/plugin install/remove, activation, project-local separation, bootstrap, Google connect, interview edits, and read-only surfaces. |
| P1 | Multi-skill plugin install had no aggregate atomic/recovery contract. | Removed package copying and sequential skill exposure from this release. Exactly one reviewed Agent Skill bundle may use ordinary adoption; multi-skill/plugin-package installation refuses before mutation pending a separately reviewed aggregate package contract. |
| P2 | Metadata-only UTF-8 classification was ambiguous. | Version 1 decodes exactly the root `SKILL.md`; every other regular file is byte-opaque. Script/type hints are deterministic and non-authoritative; derived junk refusal is explicit. |
| P2 | Guarded catalog publication was insufficient while independent publishers remained. | Catalog renderers become pure; only the store publishes a generation, and every catalog-consuming mutation recovers under the same lock first. |
| P3 | Current locale-sensitive ordering could undermine cross-host determinism. | All owned names, paths, manifests, collisions, projections, and catalog rows use unsigned UTF-8 byte ordering. |

## Implementation review and disposition

| Priority | Implementation finding | Final disposition |
|---|---|---|
| P0 | A forged journal or receipt could supply an out-of-root projection coordinate to unlink. | Receipts/journals now use strict versioned schemas; every coordinate is recomputed or containment-checked against configured roots before mutation. Forged traversal fixtures preserve their victims. |
| P1 | Exact idempotence ran before locked recovery, allowing an interrupted receipt publication to be reported as complete. | Recovery and the exact-existing check now run under the single store lock; a real process-exit fixture proves retry recovers before success. |
| P1 | Adoption/removal rollback could clear uncertain state when canonical or archived roots were missing, replaced, or both present. | Journals distinguish pre-existing from operation-published roots and enforce an exact archive/live state matrix. Missing identity or any mismatch becomes `needs_attention`. |
| P1 | Staged and newly created projection bytes lacked write-ahead identity evidence at early crash points. | Root identity and mutation intent are persisted before the corresponding checkpoint; absence of recorded evidence refuses cleanup rather than guessing ownership. |
| P1 | A process exit between stage creation/copy and identity publication could leave bytes that rollback treated as operation-owned. | The stage parent and empty bundle inode are durably recorded before any bundle byte is copied. Existing stage bytes with missing/mismatched evidence retain `needs_attention`; a simulated pre-evidence journal proves no cleanup. |
| P1 | Projection rollback could unlink from a poisoned journal without link identity, or silently clear a mismatched projection/recovery tree. | Every published projection requires exact link text plus inode evidence; missing/mismatched evidence and recovery cleanup failure retain the journal and bytes as `needs_attention`. |
| P1 | Activation still performed retired-link, alias, and stale-link deletion outside the store lock. | All global activation cleanup paths are zero-write previews. Explicit real global alias pruning refuses with proof-first guidance; project-local lifecycle remains separate authority. |
| P1 | A custom target added by reconcile could later disappear from configuration without leaving retirement evidence. | Committed reconcile forward-publishes refusal-only local target history before clearing its journal. Historical coordinates can block removal but never authorize unlink; explicit retirement remains deferred. |
| P1 | Existing-store `init`, plugin manifests, or permissive host-registry reads could bypass the one bounded lifecycle seam. | `init --force/--overwrite` refuses live stores; compatibility manifests and custom `agents.json` use bounded fatal-UTF-8 single-link reads; host fields, targets, and proof cardinality are bounded before expansion. |
| P1 | Staged data and newly created operation/recovery directories were not durably synced before canonical or removal renames. | Every staged file is synced after chmod, directories are synced bottom-up, new directories sync themselves and their parents, and unsupported directory sync fails closed before destructive commit. |
| P1 | Long removal windows and early destination checks could overwrite an archive collision or commit after live-path recreation. | Every no-replace move performs an immediate destination check and moved-inode verification; removal revalidates the exact archive and absent live coordinate at each authority boundary through the final pre-commit check. Persistent collisions/recreations retain journaled `needs_attention` evidence. |
| P1 | Receipt source/replacement forms were not mutually bound. | Source kinds, coordinates, identities, saved replacements, and their evidence are validated as one strict authority record before remove/recovery. |
| P1 | Bounded bundle policy did not extend to registry, receipt, and journal reads. | Owned state is now read through handle-based byte limits before decoding; unknown, oversized, linked, or permissive state fails closed. |
| P2 | Successful removal retained archive bytes but discarded their only inventory. | A separate bounded machine-local recovery record is published before journal cleanup and exposed as non-routable `retained_recovery`. |
| P2 | Registry-only managed rows could survive reconcile, while a missing row could not be rebuilt. | Receipts carry the exact portable row; reconcile enumerates strict receipts, re-inspects canonical digest/root identity, rebuilds missing rows, and drops drifted pairs. `_registry.json` remains install inventory, never catalog or deletion authority. |

## Accepted conservative boundaries

- Portable Node lacks descriptor-relative rename/symlink primitives. Parent chains and leaves are recorded and revalidated around every path-based mutation, and all DotAIOS writers cooperate through one lock; the implementation does not claim safety against a transient uncooperative same-user ancestor swap.
- A custom projection target added later can be reconciled under a fresh proof and leaves refusal-only local history. Removing that target from configuration intentionally refuses automatic retirement: historical receipt/history coordinates are insufficient deletion authority. The later ManagedInstallation slice must add an explicit target-retirement proof.
- Successful removal retains exact non-routable recovery bytes and an inventory record. Physical garbage collection is deferred until a separately reviewed conditional-identity contract exists.

## Approved boundaries

- Real immediate AIOS skill directories remain routing authority.
- Registries, receipts, journals, catalogs, and native paths remain derived evidence and never grant deletion authority.
- Binary assets are preserved exactly and never decoded or executed during adoption.
- Whole-root removal never degrades to partial live-tree deletion; uncertain archives remain recoverable.
- MCP remains read-only with exactly three tools.
- PR61 project/source domains remain separate.
- No remote acquisition, marketplace, hosted store, vector database, or cloud-sync scope was added.

## Removal-seam challenge

The final design does not delete live leaves. It revalidates the immediate canonical parent and exact receipt-bound root under the cooperative store lock, verifies same-device recovery, renames the whole root, and then re-inspects the archived manifest. A recreated live path, changed archive, cross-device condition, or cleanup uncertainty preserves the recovery tree and journal as `needs_attention`. This is the strongest portable Node observation boundary available; it deliberately does not claim protection from an uncooperative same-user path swap between the final observation and `rename(2)`.
