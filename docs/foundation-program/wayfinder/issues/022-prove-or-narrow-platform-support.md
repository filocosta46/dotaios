---
title: Prove or narrow the supported platform contract
label: wayfinder:issue
status: blocked
created: 2026-08-10
blocked_by:
  - 020-certify-exact-artifact-lifecycle
---

## Problem

CI covers Ubuntu/Node 20 and 22, independent testing covers macOS, and actual
Windows junction/lifecycle behavior remains unproved. Public implementation and
shell wording can imply a broader platform contract than the evidence supports.

## Acceptance

- Every public platform/Node claim maps to an exact-artifact lifecycle receipt
  for that platform, version, filesystem mode, and architecture.
- Windows support includes real same-drive and cross-drive junction behavior,
  path-with-spaces, clean install, update, doctor, disconnect, and removal; if
  that evidence is unavailable, launch wording narrows to the tested matrix.
- CI and the release evaluator enforce the same supported matrix and never infer
  support from source-level unit tests alone.

## Evidence required to close

- Clean exact-tarball lifecycle receipts on every claimed matrix entry.
- Windows same/cross-drive junction and path edge cases, or an explicit public
  macOS/Linux-only boundary with contract tests.
- CI/release negative tests for unproved platform claims.
