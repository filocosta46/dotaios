# iMac Independent Audit — Foundation Prelaunch

Date: 2026-08-09
Mode: read-only inspection; the iMac did not write product code, change refs, run installers, or modify host configuration

## Branch topology correction

The iMac checkout was clean at `40e417087afd8d92db9da7ff2b6186591bf57cb5` on `launch/2026-08-08-prelaunch-fixes`. Its stale local tracking ref made it appear six commits ahead and zero behind.

Live remote inspection showed `fa08b6933ac61d7d071ed15c8ae155d0ab5ccdd8`. Both are distinct children of common base `219d6cf`:

- iMac: six local commits ending at `40e4170`;
- live remote: one distinct commit, `fa08b69`, which fixes Gemini bridge preservation.

The iMac branch is therefore divergent, not a strict superset. It must not be merged or force-pushed wholesale.

## Verified findings

### Hermes equivalent paths — confirmed defect

`packages/core/src/hermes-config.mjs:112-124` rewrites an equivalent legacy absolute path to `./skills` before checking whether `./skills` already exists. A configuration containing both forms retains two identical entries. Current tests do not cover this dual-form/base-directory scenario.

Production attach and the probe also disagree:

- production writes `./skills` with a project `baseDir` in `packages/cli/src/commands/activate.mjs:562-575`;
- the probe writes/checks an absolute path with no `baseDir` in `packages/cli/src/lib/skill-invocation-probe.mjs:323-367`.

Hermes remains explicitly non-runnable in the bounded probe and has no invocation receipt.

### CLI/MCP projection parity — confirmed defect

Migration notice logic wraps only CLI compact output in `packages/cli/src/commands/brief.mjs:39-69,83-107`. MCP calls the bare digest at `packages/mcp/src/server.mjs:119-135`, despite the tool and documentation claiming the same working-context projection. Existing CLI tests cover stale/current behavior; MCP tests do not.

### Onboarding — confirmed contract contradiction

- `README.md:32-38` and `INSTALL.md:3-28` present assistant-led installation.
- `docs/friend-setup.md:3-4,59-60` says not to paste an install prompt into the friend's AI chat and treats assistant refusal as expected.

Both cannot be the primary first-run contract.

### Gemini preservation — confirmed remote-only fix

The iMac version of `writeGeminiBridge()` unconditionally overwrites `GEMINI.md`. Remote commit `fa08b69` fixes substantive-content preservation and adds four regression cases. The fix still normalizes trailing whitespace with `trimEnd()` and does not test malformed managed markers or non-regular targets.

## Narrowed, not proven

### Windows junction behavior

Current code passes a relative target and selects `junction` on Windows. Five tests assert a non-absolute `readlink`, but CI is Ubuntu-only and the independent iMac had neither a Windows runtime nor Node available over the audit shell. Actual same-drive and cross-drive Windows/Git behavior remains unverified.

## Release reconciliation constraints

1. Preserve `fa08b69`'s Gemini behavior and tests, or replace them only with demonstrably stronger equivalents.
2. Review the six iMac commits as individual candidate patches; do not reset, rebase, merge, or force-push the iMac branch.
3. Fix Hermes equivalent-path idempotence and align the probe with production semantics before claiming support.
4. Choose whether migration notices belong inside or alongside the canonical projection, then make CLI, MCP, tests, and docs agree.
5. Choose one primary onboarding journey and make every public instruction conform to it.
6. Do not claim Windows runtime support from Linux-only tests.

## Independent validation fixtures required

- Windows: temporary user profile; same-drive and cross-drive attach; inspect `lstat`, `readlink`, index mode, and stored Git object.
- Hermes: foreign entry plus legacy absolute entry plus `./skills`; assert exactly one managed relative entry and repeated-run idempotence; then obtain a real bounded invocation receipt.
- Migration: stale and interrupted fixtures; compare compact CLI, JSON hook, and MCP results, budgets, latency, and file write effects.
- Onboarding: a disposable account follows only the chosen documented route and records prompts, approvals, refusal points, and resulting files.
- Gemini: user-authored file, absent file, stale block, malformed block, symlink/non-regular target, repeated connect, and live client loading.

## Post-audit disposition

Later runtime inspection invalidated the audit's proposed project-path repair.
Hermes reads the config selected through `HERMES_HOME`; DotAIOS did not own that
selector, so aligning two checkout-file spellings would only make production
and the probe consistently wrong. The accepted disposition is an explicit
project-support demotion with global-only configuration support. See
`../decisions/2026-08-09-hermes-support-boundary.md`. The historical findings
above remain unchanged as the evidence that triggered the deeper check.

## Exact-commit validation receipt

The accepted Hermes correction was independently validated on the iMac at
exact commit `8a2a49dd4cad8b8e0123f0c7c8585e8d25a2b8fa`. A local archive and the iMac
copy had matching SHA-256 `08a168e44619baf287ad35abaa96c24f140dfb841dee2b5a2c08ee88fdf79d8e`,
and `git get-tar-commit-id` returned the exact commit. Because the public
contract suite intentionally calls `git ls-files`, the validator also cloned
an exact-ref bundle only inside a disposable `/tmp` directory and verified its
HEAD before and after execution.

On Node v22.22.3 and npm 10.9.8:

- syntax-check passed for 105 source files;
- `npm run check` passed;
- the focused Hermes/regression selection passed 166/166;
- the complete suite passed 1,213 tests with zero failures and one intentional
  skip.

The original iMac checkout, refs, credentials, commits, and remote were not
changed. Both local and remote disposable validation directories were removed.
