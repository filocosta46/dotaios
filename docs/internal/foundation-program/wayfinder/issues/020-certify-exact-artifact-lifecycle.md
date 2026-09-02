---
title: Certify the exact packed artifact through its full lifecycle
label: wayfinder:issue
status: blocked
created: 2026-08-10
blocked_by:
  - 017-align-replication-with-memory-authority
  - 018-unify-installation-and-health
  - 019-bind-host-receipts-to-release-artifacts
---

## Problem

The release checklist executes source files and merely lists the npm package,
yet it prints that publishing is safe. It does not install the exact tarball in
a clean home, validate packed documentation links, exercise migration/update/
reinstall/removal, or bind host receipts to the candidate SHA.

## Acceptance

- One immutable tarball is produced once, hashed, installed into a disposable
  clean environment, and reused for every lifecycle and host proof.
- The gate covers install, preview, setup, doctor, skills doctor, MCP, migration,
  exact-version update/reinstall, drift recovery, disconnect/removal, and clean
  restore without using the source CLI.
- Every packed Markdown link resolves inside the package or to an allowed
  external target; package allowlists include every referenced public contract.
- The evaluator refuses an already tagged version, uncut changelog, dirty or
  mismatched SHA, incomplete receipts, unsupported platform, or failed CI.
- Publication remains a separate explicit atomic action and is never performed
  by the candidate gate.

## Evidence required to close

- Exact artifact SHA/integrity chain from pack through all disposable hosts.
- Clean and drifted lifecycle receipts, packed-doc link report, dependency tree,
  full tests, platform matrix, and independent iMac validation.
- A negative matrix proving every missing or mismatched release fact blocks the
  `publishable` verdict.
