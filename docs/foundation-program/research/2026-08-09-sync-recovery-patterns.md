# Sync and Recovery Pattern Study — Foundation Relevance

Date: 2026-08-09
Status: primary-source research synthesis for product decisions; not an adoption plan

## Research receipt

The bounded six-lane report is preserved at:

`<aios>/vault/research/deep/2026-08-09-as-of-august-2026-what-primary-source-patterns-should-a-loca.md`

It covers Git, Syncthing, Obsidian Sync, restic, Automerge/local-first CRDTs, and a smallest-pattern synthesis. The report's tool-adoption suggestions are hypotheses; accepted DotAIOS decisions and current failure evidence remain the product authority.

## Patterns that survive Foundation's boundary

| Pattern | Product meaning for Foundation | Release implication |
|---|---|---|
| Canonical files and derived state stay separate. | Portable plain files may replicate; machine paths, provider configuration, credentials, locks, caches, and rebuildable indexes do not become shared truth. | Keep the allowlist narrow and test both included and excluded canaries. |
| Sync is not backup. | A replica can propagate deletion or corruption. Git history and local reflogs also have retention and locality limits. | Never market replication as full backup; a restore claim needs a separately verified recovery source and procedure. |
| Concurrent writers are not automatically safe. | Git exposes unmerged stages; Syncthing and Obsidian preserve conflicted copies; CRDT convergence can still produce semantically surprising winners. | Foundation's first claim remains personal replication with serialized writers. On divergence, fail closed and preserve both sides for review. |
| Conflict must be visible. | A conflict is a user-facing object, not a log line hidden behind a success message. | Receipts must name the affected canonical path, both source versions, topology/base, and the action still required. |
| Restore must be staged. | In-place restore can partially overwrite live state or propagate damage. | Stop writers, preserve the broken tree, restore into owned staging, verify identity/integrity, preview the diff, then apply or publish narrowly. |
| Watcher events are hints. | Reliable source-folder handling combines notifications with scans and content hashes. | Any later live folder adapter must expose scan freshness, watcher health, stable source identity, and hash drift; Foundation need not ship a watcher in the first slice. |
| CRDTs need an owned application data model. | A binary operation history is not the same product as a user-owned plain-file tree. | Do not blanket-CRDT the AIOS folder. Reconsider only for a future structured collaborative document with explicit conflict UI. |

## What this does not authorize

The report identifies Syncthing, Unison, restic, rsync, and rclone patterns. That is not evidence that Foundation should bundle or depend on those tools now.

- Automatic background multi-device convergence adds an operational surface that the current ICP should not have to understand.
- Restic is a credible backup pattern, but bundling encrypted-repository lifecycle, credentials, retention, and verification would expand the product beyond the current release spine.
- A team collaboration promise would require identity, permissions, writer authority, semantic conflict UX, and stronger support evidence.
- A shared “replication abstraction” remains unjustified until two real supported adapters exist.

## Current DotAIOS consequence

Cross-device continuity is important but should not be the first value slice. Current evidence already shows unresolved live divergence and a stale remote-tracking ref on the independent iMac. The smallest safe next state is:

1. call the feature a **personal replica**, not collaboration or backup;
2. compare live remote topology rather than trusting a stale tracking ref;
3. serialize writers and refuse ambiguous divergence;
4. preserve current and incoming states before reconciliation;
5. stage and verify restore before publishing;
6. emit a receipt a nonexpert can act on.

These are release-hardening requirements, but they do not replace the first proof of daily user value: a fresh agent continuing from the right project decision.

## Primary sources

- Git: [data model](https://git-scm.com/docs/gitdatamodel), [status](https://git-scm.com/docs/git-status), [merge recovery](https://git-scm.com/docs/git-merge), [reflog](https://git-scm.com/docs/git-reflog), [fsck](https://git-scm.com/docs/git-fsck), [restore](https://git-scm.com/docs/git-restore)
- Syncthing: [sync behavior](https://docs.syncthing.net/users/syncing.html), [versioning](https://docs.syncthing.net/users/versioning.html), [folder types](https://docs.syncthing.net/users/foldertypes.html), [ignore rules](https://docs.syncthing.net/users/ignoring.html)
- Obsidian: [conflicts](https://obsidian.md/help/sync/troubleshoot), [version history](https://obsidian.md/help/sync/version-history), [data storage](https://obsidian.md/help/data-storage)
- restic: [backup](https://restic.readthedocs.io/en/stable/040_backup.html), [repository checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html), [restore](https://restic.readthedocs.io/en/stable/050_restore.html)
- Automerge/local-first: [merge rules](https://automerge.org/docs/reference/under-the-hood/merge-rules/), [storage](https://automerge.org/docs/reference/under-the-hood/storage/), [local-first paper](https://www.inkandswitch.com/essay/local-first/)
