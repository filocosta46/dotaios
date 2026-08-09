---
title: Harden Gemini connection as a guarded three-artifact activation
label: wayfinder:issue
status: closed
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

## Closure evidence

- Exact implementation commit: `78313d8476e6da7b568b10fbb1d815f6c8956fc9`.
- Local focused suite: 53/53; complete suite: 1,240 passed, zero failed,
  one intentional skip; syntax, check, smoke, package dry-run, and diff checks
  passed.
- Adversarial validation covered 409 Unicode/CRLF/mode/marker fixtures,
  guarded-write races, invalid UTF-8, malformed JSON and ownership, exact
  recovery bytes/modes, missing-file contention, disabled hooks, and a matching
  project-local package shadow. No reproducible launch blocker remained.
- Independent iMac exact-bundle validation passed syntax/check, 53/53 focused
  tests, and the complete 1,240/0/1 suite. The product checkout remained clean
  and unchanged at `40e417087afd8d92db9da7ff2b6186591bf57cb5`.
- Receipt: `../../audits/2026-08-09-imac-gemini-validation.md`.
