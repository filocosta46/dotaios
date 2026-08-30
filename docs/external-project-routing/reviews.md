# External Project Routing — Independent Reviews

> **Status:** All actionable findings resolved in the specification and tickets · 2026-08-30

Two bounded reviews were performed independently after the first complete specification and ticket draft. Neither reviewer edited the documents.

## Architecture and trust review

| Finding | Resolution |
| --- | --- |
| Changing directories does not make an existing Codex run rebuild its `AGENTS.md` hierarchy. | EPR-005/EPR-015 and the handoff contract now require immediate exact re-resolution followed by a fresh context rooted at the verified project. Host adapters declare supported convention kinds; unsupported combinations return `unsupported_by_host` with no route. |
| The pointer authority, corruption behavior, concurrency, recovery, and lifecycle were underspecified. | EPR-016/EPR-017 define the portable JSON envelope, bounds, strict validation, owned per-project lock, generation-and-digest compare-and-swap, atomic publication, exact owned recovery, stale/unavailable behavior, unregister guard, and orphan reporting. Storage and CLI composition are split into Tickets 02 and 03. |
| Project-native routing could accidentally change memory, skill, Google tool, location, omission, or next-action semantics. | The specification now contains a literal composition matrix. Explicit `--tool` takes precedence; implicit candidates load no project memory or skill and disclose no location; exact ready routes preserve project memory and AIOS skill behavior; external files can never create Google argv. |
| The post-catalog trust algorithm and discovery bounds were not exact enough. | Selection now uses validated registration frontmatter only, exact root identity, authoritative live `origin` or exactly one safe fallback fetch remote, canonical remote agreement, convention-presence filtering, explicit exact/implicit failure behavior, and global project/Git/metadata/convention bounds. |
| Pointer validation admitted an avoidable remote-URL security surface and left path normalization vague. | HTTPS pointers are deferred from v1. EPR-007/EPR-008 now define two local kinds, exact POSIX/NFC/length/segment rules, no-follow ancestry, target type, single-link files, label validation, and no content hashing. |

## Customer-value and language review

| Finding | Resolution |
| --- | --- |
| The first draft implied a second approval just to save the already-disclosed pointer. | EPR-006 now states that one approval covers the named action plus one constrained same-project pointer when disclosed upfront; changed project, kind, scope, or behavior requires fresh approval. |
| The “connect what I already downloaded” moment was missing. | The solution now says to keep the repository wherever it is, connect that folder once with a customer-authored purpose, and makes clear that AIOS does not download, move, or copy it. |
| Convention presence was conflated with host compatibility. | EPR-015 and the examples distinguish generic routability from adapter support; a Codex adapter does not claim support for a `CLAUDE.md`-only repository. |
| “Nominate” and capability language sounded like product endorsement. | Public wording uses “identify” and “match,” says the match comes from the customer's registration rather than an AIOS recommendation, and describes external conventions as unread before approval. |
| Success and stale-output wording did not clearly preserve ownership. | The spec now includes exact completion and stale messages saying the report remains in the source project, AIOS stored only location/label, and AIOS did not copy, index, move, or delete it. |

No unresolved review finding blocks Ticket 01. The remaining explicit boundary is host-owned fresh-context startup and proof of native convention support; it is deliberately not moved into DotAIOS core.
