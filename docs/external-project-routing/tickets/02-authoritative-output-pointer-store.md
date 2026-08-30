# 02 — Authoritative output-pointer store

**What to build:** Add the bounded project-scoped JSON authority that can retain a minimal locator and label without ingesting output content. This PR owns schema validation, normalization, deduplication, availability, concurrency, atomic publication, corruption behavior, and pointer lifecycle. It does not add public CLI commands or change intent-resolution composition.

**Blocked by:** 01 — Generic project-native routing, whose exact project/root verification is reused here.

**Status:** ready-for-agent

**Requirements:** EPR-007, EPR-008, EPR-009, EPR-010, EPR-011, EPR-014, EPR-016, EPR-017.

**Cold context:** The authority is `projects/<slug>/output-pointers.json`, adjacent to the registered-project README but structurally outside every Markdown content reader. Reuse the existing strict owned-operation lock and process-identity semantics. A target remains owned by its source project; only the pointer collection is DotAIOS-managed metadata.

**Likely seams:** add one deep core module beside `packages/core/src/projects.mjs`; reuse `packages/core/src/operation-lock.mjs`, owned-state publication helpers, process identity, and exact project/root verification rather than cloning them; add focused core store/lifecycle tests plus reader-closure tests. Do not add a CLI command in this PR.

- [ ] Read/write one exact `dotaios.output-pointers/v1` envelope containing `schema`, exact `project_id`, non-negative `generation`, and `pointers`; reject unknown/missing keys, malformed JSON, wrong identity, invalid values, duplicates, more than 128 records, or more than 256 KiB without repair or partial results.
- [ ] Each record contains exactly `id`, `kind`, `locator`, `label`, and `recorded_at`; v1 kinds are only `project-file` and `project-directory`. Storage order is pointer ID; list order is timestamp descending then ID.
- [ ] Labels trim and NFC-normalize to 1–160 Unicode code points and reject controls/unpaired surrogates. Locators meet EPR-008 exactly and revalidate the verified root, no-symlink ancestry, declared file/directory type, and single-link regular-file rule.
- [ ] Project ID + kind + normalized locator deduplicates records. Exact repeat is byte/generation-idempotent; label update preserves ID, advances `recorded_at`, and increments generation once.
- [ ] A preview captures operation ID, plan fingerprint, expected generation, SHA-256 of the exact collection bytes, and exact next bytes. The SHA-256 never covers output content.
- [ ] Apply uses `~/.dotaios/output-pointers/locks/<encoded-project-id>.lock`, compare-and-swaps generation and digest, revalidates root/target, and publishes with owner-marked sibling temp, file sync, atomic rename, and directory sync.
- [ ] Crash tests prove either the old or new collection survives. Recovery removes only the exact dead temp owned by the retrying operation while canonical bytes still match; changed stores, live/foreign locks, foreign temps, and ambiguous outcomes refuse.
- [ ] Availability is computed as `available`, `missing`, `unsafe`, or `project_unavailable`; no status is persisted and no stale pointer is auto-deleted or redirected.
- [ ] Pointer removal can modify valid portable metadata while the project root is unavailable and never opens or mutates the target. Future official unregister is guarded by a non-empty collection; doctor reports manually orphaned collections without deleting or re-parenting them.
- [ ] Reader-closure tests prove working context, Shared/project memory, global/project search, generated indexes, embeddings, and all three MCP tools cannot return pointer records or output content.
