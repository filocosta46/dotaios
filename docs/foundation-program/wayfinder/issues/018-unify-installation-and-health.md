---
title: Unify onboarding, installation ownership, and truthful health
label: wayfinder:issue
status: blocked
created: 2026-08-10
blocked_by:
  - 005-define-portable-agent-contract
  - 006-choose-onboarding-contract
---

## Problem

Public guides disagree about whether onboarding is human-run or assistant-led.
Setup can call a folder ready before produced host evidence, while doctor can
print green for a detected native runtime without consuming the shared skill
health inspection. Removal is a manual multi-file procedure for the non-expert
ICP.

## Acceptance

- One human-run preview/confirm/setup/doctor journey is the sole primary public
  path; assistant help may explain that journey but cannot bypass approvals.
- One `ManagedInstallation` inventory powers preview, apply/reconcile, doctor,
  disconnect, and removal using the same ownership and collision rules.
- Preview names every global/profile/project artifact that may change, and the
  applied result cannot exceed that reviewed plan.
- Doctor distinguishes detected, configured, discoverable, invoked, and
  produced evidence; only current produced host evidence can claim ready.
- Disconnect/removal preserves user-authored bytes, refuses ambiguous ownership,
  and is independently repeatable on clean and drifted installations.

## Evidence required to close

- Cross-guide contract tests and preview-versus-apply artifact snapshots.
- Native runtime false-green fixtures through the shared health inspector.
- Clean, collision, interrupted, drifted, repeat, disconnect, and removal
  lifecycle matrices with exact backups and recovery behavior.
- Fresh non-expert/iMac execution receipt.
