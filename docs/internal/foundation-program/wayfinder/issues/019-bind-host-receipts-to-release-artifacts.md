---
title: Bind host receipts to the exact release artifact
label: wayfinder:issue
status: blocked
created: 2026-08-10
blocked_by:
  - 007-create-measurement-fixtures
  - 018-unify-installation-and-health
---

## Problem

Host receipt v1 proves a client/skill observation but does not identify the
DotAIOS version, Git commit, tarball integrity, configured surface, dependency
tree, Node runtime, or operating system. It cannot certify the release artifact
that users would install.

## Acceptance

- Host receipt v2 binds DotAIOS version, candidate Git SHA, tarball integrity,
  dependency-lock identity, Node/OS/architecture, client version, configured
  surface hash, skill identity, and evidence level.
- Configuration, discoverability, invocation, and produced result remain
  distinct; absence or stale identity cannot be promoted into a stronger tier.
- Receipt validation is pure, bounded, path-safe, and refuses missing,
  conflicting, replayed, or cross-artifact evidence.
- Public support claims are generated from current matching receipts rather
  than maintained as freehand prose.

## Evidence required to close

- v1 migration/staleness tests and v2 tamper matrix.
- Same-client different-artifact, different-OS, different-config, and stale
  receipt refusal fixtures.
- At least one fresh produced-result receipt for the exact candidate tarball on
  each claimed host/OS tier.
