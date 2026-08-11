---
title: Resolve the Hermes support contract
label: wayfinder:task
status: closed
assignee:
blocked_by: []
---

## Question

Can DotAIOS truthfully expose checkout-owned skills to Hermes without owning
the runtime configuration selector, version semantics, or a safe invocation
receipt?

## Resolution

No. The bundled project target is removed and the probe no longer stages or
blesses `<project>/.hermes/config.yaml`. Global `~/.hermes/config.yaml`
registration remains supported as configuration evidence, with a fail-closed
semantic YAML editor. Project support can return only through the re-entry
gates in `../../decisions/2026-08-09-hermes-support-boundary.md`.

Evidence: installed Hermes v0.18.2 runtime/source smoke, three independent
adversarial reviews, focused regression tests, and the public-contract test.
