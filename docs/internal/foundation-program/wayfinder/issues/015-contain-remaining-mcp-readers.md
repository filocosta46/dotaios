---
title: Contain and bound the remaining MCP readers
label: wayfinder:issue
status: resolved
created: 2026-08-10
blocked_by:
  - 014-make-working-context-read-only-and-contained
---

## Problem

`read_working_context` now has a contained, bounded, non-mutating read boundary,
but `search_aios` and `resolve_skill` still traverse path-based corpora without
aggregate input budgets. Corrupt JSONL can create quarantine sidecars during a
supposedly read-only search, diagnostics can disclose machine paths, and skill
resolution reads every complete `SKILL.md` before returning unbounded metadata.

## Acceptance

- Both remaining MCP tools use one reusable bounded evidence-reader seam with
  explicit authorized roots, aggregate file/byte/entry limits, strict UTF-8,
  contained final components, and path-free failure codes.
- Search over corrupt events, signals, or session indexes never creates a
  quarantine, changes bytes or mtimes, or emits a machine path.
- Skill discovery reads only bounded metadata required for routing; oversize,
  malformed, linked, changed, or excessive skill corpora fail closed.
- Existing scope, ordering, ranking, and valid-result semantics remain stable.
- Response budgets are separate from source-work budgets and cover every field
  returned to the client.

## Evidence required to close

- Before/after tree hashes for corrupt JSONL across CLI and MCP search.
- Traversal, outside/in-bound symlink, special-file, invalid-UTF-8, replacement,
  aggregate-byte, 513th-file, entry-overflow, and oversized-skill fixtures.
- Minimum/default/maximum response-budget tests and path-free stderr/protocol
  assertions.
- Full local suite, exact packed-content check, and independent exact-commit
  iMac validation.

## Implementation checkpoint

Exact commit `beb76f80ef2c01bbe996eb1eaceeb85f9ac45359` contains the reviewed
implementation and passed the complete local gate plus the final independent
adversarial replay.

- `search_aios` and `resolve_skill` share one request evidence reader. The
  search authority config is itself contained, strict UTF-8, per-file bounded,
  and charged before its configured external vault root is authorized on the
  same aggregate ledger.
- Enumeration snapshots bind later file and frontmatter reads to the directory
  identities that produced their paths. Real-directory replacement, final-file
  replacement, links, special files, invalid encoding, and excessive corpora
  fail closed with path-free codes.
- Session index paths are validated against `memory/sessions`, including
  metadata-only matches, before any result is returned.
- Exact MCP response budgets cover every result field and remain valid for
  astral Unicode without splitting a surrogate pair. The public MCP contract
  now documents the `resolve_skill` budget.
- Corrupt JSONL remains byte- and metadata-unchanged through CLI and MCP
  search. The observer's redundant publication check and Git-less test-suite
  portability defects are also fixed in this candidate.
- CLI search and skill lookup surfaces are classified read-only for the legacy
  sync hook. CLI search contains `aios.json` before authorizing a configured
  vault. Plain Markdown skills retain the public fallback without bypassing
  strict UTF-8. Ineligible symlink entries are skipped without touching their
  targets; eligible linked evidence still fails closed.

Local evidence: 78 focused checks pass with zero failures; syntax, CLI check,
smoke, packed-content dry run, public packed-content policy, and diff checks
pass. The complete current suite reports 1,388 pass, zero failures, and one
intentional skip.

Independent iMac closure evidence: exact tree
`bdb083def465dc815a84074d49fa4208c837a747` was transferred in a complete
history bundle with SHA-256
`df37ce3e298b1af56921e42a61078fffc197449efff5b43ac270cc01910a3703`.
The disposable clone passed 78/78 focused checks, 1,388/0/1 complete tests,
syntax over 109 source files, CLI check, smoke, 8/8 public-contract checks, and
an npm pack dry run with 172 files. Live CLI/MCP probes preserved corrupt JSONL,
authorized the configured external vault, refused an escaping Markdown link
with path-free errors, produced no quarantine, and left read-only fixture hashes
unchanged. The protected iMac checkout stayed byte-identical and no disposable
residue remained. Issue 015 is resolved at this exact commit.
