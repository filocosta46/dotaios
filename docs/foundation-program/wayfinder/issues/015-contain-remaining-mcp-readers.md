---
title: Contain and bound the remaining MCP readers
label: wayfinder:issue
status: blocked
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
