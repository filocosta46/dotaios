---
title: Make the canonical working-context projection read-only and contained
label: wayfinder:issue
status: in_progress
created: 2026-08-09
---

## Problem

Adversarial validation falsified three public projection claims. Corrupt signal
JSONL can create quarantine sidecars during `read_working_context`; direct
context reads can follow a symlink outside the AIOS root; and unbounded project
input can inflate an MCP response far beyond its context budget. Internal MCP
errors can also expose absolute machine paths.

## Acceptance

- Compact CLI, hook JSON, and MCP working-context reads never create, rename,
  append, chmod, or quarantine a file, including on corrupt JSONL input.
- Every projected source remains inside the resolved AIOS boundary; unsafe
  links and special files fail closed without returning outside bytes.
- Source work is capped at 16 MiB, 512 opened files, and fixed per-shelf file,
  project-directory, signal-directory, and current-window signal-file limits.
  Oversize state fails closed without silently truncating or reordering input.
- Project filters and operational metadata have explicit fixed bounds. Rendered
  operational notices and non-`markdown` MCP metadata are capped at 1,024
  characters; JSON representation cost is measured separately and cannot reject
  valid bounded Markdown.
- Internal MCP failures return one path-free protocol error; input errors remain
  specific and safe.
- Project-scoped rows treat only absent/null `project` and `project_id` fields as
  global. Present attribution must resolve consistently through the catalog;
  malformed, conflicting, differently attributed, or ambiguous alias-only rows
  fail closed.
- Existing projection selection, ordering, and visible-character budget semantics
  remain unchanged for valid input.

## Evidence required to close

- Corrupt-input before/after tree snapshots and stderr assertions.
- Outside-canary fixtures for every projected shelf.
- Minimum/default/maximum budget and oversized-input tests.
- Ancestor-swap, source-disappearance, incomplete-filesystem, aggregate-byte,
  configured-authority, initially-missing nested-source, per-file,
  project-directory, signal-directory, and signal-file bound tests.
- Cross-channel project slug/id, conflicting-field, malformed-field, and
  ambiguous-alias attribution tests.
- Complete local and independent exact-commit validation.
