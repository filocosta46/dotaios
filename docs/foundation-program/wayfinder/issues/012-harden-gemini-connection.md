---
title: Harden Gemini connection as a guarded three-artifact activation
label: wayfinder:issue
status: in_progress
created: 2026-08-09
---

## Problem

The reconciled Gemini bridge preserved ordinary user content, but direct writes
could still follow unsafe paths, lose trailing bytes, overwrite concurrent
edits, activate settings before the hook existed, and silently accept malformed
ownership. The generated SessionStart command also allowed an opened project's
local `dotaios` binary to shadow the intended package.

## Acceptance

- Preflight `GEMINI.md`, the managed hook, and `settings.json` before writes.
- Preserve every byte outside one complete managed bridge block.
- Refuse malformed markers, foreign scripts, unsafe paths, invalid encoding or
  JSON, ambiguous managed entries, and incompatible hook shapes.
- Use guarded create/replace operations with exact recovery bytes and modes;
  surface concurrent edits without overwriting them.
- Publish the hook and bridge before settings, which is the activation point.
- Invoke the exact shipped DotAIOS package, quote the hook path, surface runtime
  failures, and never resolve an untrusted project-local binary.
- Preserve the four reconciled `fa08b69` regressions and add failure-path tests.

## Evidence required to close

- Focused bridge/settings/hook tests and adversarial race/path/encoding fuzzing.
- Complete local suite, syntax, package, and diff checks.
- Independent exact-commit validation on the iMac without modifying its product
  checkout.
