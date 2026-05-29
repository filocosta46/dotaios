---
description: Run the pre-publish release checklist (tests, smoke, changelog, pack, clean tree, branch).
allowed-tools: Bash(npm run release:check)
---

Run `npm run release:check` from the repo root and report the results. This is a
read-only gate — it never publishes, tags, or pushes. Summarize which checks
passed/failed and, if any failed, what the maintainer needs to fix before
`npm publish`.
