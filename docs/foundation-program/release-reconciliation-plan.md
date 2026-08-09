# Prelaunch Release Reconciliation Plan

Date: 2026-08-09
Authority: planning only; no merge, fetch from the iMac, version bump, push, or publication is authorized by this document

## Verified topology

- `origin/main` and the Foundation worktree base are `f0d72f7`.
- Live PR #59 is open, mergeable, and green at `fa08b69` with four successful Node 20/22 checks.
- `f0d72f7` is the merge base and direct ancestor of `fa08b69`; the PR line is eight commits ahead and zero behind main.
- The iMac checkout is clean at `40e4170` and has six local commits after `219d6cf`.
- The PR line also contains `219d6cf`, then adds the remote-only Gemini preservation commit `fa08b69`.
- The iMac six and `fa08b69` diverge after `219d6cf`; the iMac tracking ref is stale.

## Non-rewriting sequence

1. Commit the reviewed Foundation documentation checkpoint before importing another line.
2. Reverify the live PR head, mergeability, and checks. Stop if the head is not `fa08b69`.
3. Merge the complete PR #59 line into `codex/foundation-reliability` with an explicit merge commit. Preserve all eight existing commit identities; do not rebase or squash them.
4. Run the four Gemini preservation tests and the full suite immediately after the merge.
5. Fetch the iMac head into a new local archival ref through read-only SSH transport. Verify that the fetched object is exactly `40e4170`; do not move or update the iMac branch.
6. Review each iMac commit against the merged Foundation branch. Import only isolated behavior that still survives a failing regression test and review.
7. Create replacement commits for mixed or contract-breaking iMac changes. Do not cherry-pick a mixed commit merely to preserve its message.
8. Generate release metadata and version changes last, from the reconciled contents. Do not import the iMac's premature version bump.

## Commit disposition

| Commit | Disposition | Reason |
|---|---|---|
| `fa08b69` | Preserve through the full PR #59 merge | Prevents `connect gemini` from destroying a user-authored `GEMINI.md` and carries four regressions. |
| `98aade8` | Reimplement as smaller reviewed commits | Mixes useful relative links and cleanup with incomplete Hermes equivalence behavior. |
| `dd13cce` | Candidate for isolated cherry-pick after focused review | Flow-style project frontmatter export is independent of continuity and release gates. |
| `547af90` | Do not import without a separate product decision | `ingest --force` adds optional behavior outside current launch gates. |
| `86188e0` | Reject | Premature version bump and release prose do not resolve onboarding. |
| `d517d63` | Reimplement | CLI-only migration notices violate the canonical CLI/MCP projection claim. |
| `40e4170` | No standalone import | Comment-only correction; carry its accurate rationale into the replacement tests. |

## Gate-specific implementation contracts

### Gemini preservation

- First preserve PR #59 behavior and tests unchanged.
- Add a later hardening cycle for malformed markers, symlink or non-regular targets, and byte-exact preservation outside the managed block.
- Do not weaken the four remote regression cases.

### Hermes project skills

- Normalize a foreign entry, a legacy absolute project-skills entry, and `./skills` to exactly one preferred managed relative entry while preserving foreign entries.
- Use the same `./skills` plus project `baseDir` semantics in production attachment and the probe.
- Repeated activation and probing must be idempotent.
- Keep Hermes below produced support until a bounded real invocation receipt exists.

### Migration projection parity

- Build one shared operational envelope around the canonical digest for migration state.
- Make compact CLI, JSON hook, and MCP expose equivalent stale, current, and interrupted facts without changing digest selection or budget semantics.
- Prove zero writes and record latency on each access path.

### Onboarding

- Treat the primary journey as decision-blocked until the user chooses assistant-led ask-first setup or human-run preview-first setup.
- After the decision, update `README.md`, `INSTALL.md`, `docs/friend-setup.md`, and `docs/getting-started.md` together.
- Strengthen contract tests so the complete document corpus cannot contradict the selected journey.

### Windows evidence

- Preserve relative-link behavior, but do not claim Windows runtime support from Linux assertions.
- Require real same-drive and cross-drive Windows fixtures that inspect `lstat`, raw `readlink`, Git index mode, and the stored Git object.
- Keep the gate open until the receipt exists and is independently reviewed.

## Verification before any release merge

- Focused regression tests for every imported or reimplemented gate.
- Full test suite on Node 20 and Node 22.
- Repository smoke test and packed-artifact/public-contract checks.
- Windows runtime receipt.
- Hermes produced-result receipt or an explicit public-support demotion.
- Isolated iMac validation of the relevant continuity and host paths.
- No publish, version bump, GitHub Release, npm action, or public-claim expansion before every applicable receipt passes.
