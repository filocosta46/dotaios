# Independent iMac Gemini Validation

Date: 2026-08-09
Result: pass
Implementation commit: `78313d8476e6da7b568b10fbb1d815f6c8956fc9`

## Identity and isolation

- Host: independent iMac validation host, macOS 26.4
- Node: v22.22.3
- npm: 10.9.8
- Complete-history bundle SHA-256:
  `b77037bc39b54f480a1f08615bdd869dc1efb8e976067fc9373b3136c4036a9e`
- `git bundle list-heads`, the disposable clone's initial HEAD, and its final
  HEAD all matched the full implementation commit.
- Dependencies were reused only through a disposable symlink after both hosts
  matched the lockfile SHA-256. No install or product write ran in the original
  iMac checkout.

## Results

- `npm run syntax-check`: 106 source files clean.
- `npm run check`: pass.
- `node --test tests/cli/connect.test.mjs tests/cli/connect_gemini_bridge.test.mjs`:
  53 passed, zero failed or skipped.
- `npm test`: 1,240 passed, zero failed, one intentional skip; 1,241 total
  tests across seven suites in 26.659 seconds.
- The executed exact-version project-local shadow regression passed, as did the
  fail-closed malformed, unsafe-path, concurrent-edit, foreign-hook, disabled
  hook, and incompatible-settings cases.

An initial archive-only full run had one harness failure because the public
contract test intentionally calls `git ls-files`. Repeating from the exact
bundle clone supplied `.git` and passed the complete suite; this was not a
product failure.

## Cleanup proof

- The disposable validation clone was clean after removing its dependency
  symlink, then deleted.
- The local transfer tree was removed through Trash.
- The iMac product checkout remained clean and unchanged at
  `40e417087afd8d92db9da7ff2b6186591bf57cb5` before and after validation.
- No refs, credentials, commits, remotes, or product files changed on the iMac.
