---
description: Run the unit tests and the smoke test, and report whether the branch is green.
allowed-tools: Bash(npm test), Bash(npm run smoke)
---

Run `npm test` then `npm run smoke` from the repo root. Report a one-line
pass/fail summary for each (test counts, smoke OK/fail). If anything fails, show
the failing output. Do not change any files.
