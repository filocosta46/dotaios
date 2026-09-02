---
description: Run the pre-publish release checklist (admission receipts plus the exact tarball about to be published).
allowed-tools: Bash(npm run release:check), Bash(npm run release:check -- --artifact *), Bash(npm run release:check -- --admission * --artifact *)
---

Run the checklist from the repo root against the artifact the admission firewall
built, not against the working tree:

```sh
npm run release:check -- --admission <admission.json> --artifact <admitted.tgz>
```

The admitted tarball is the one `npm run pack:admission` produced and CI uploaded
(`.artifacts/dotaios-*.tgz`). The checklist reads its exact bytes and refuses the
shapes a repo-root pack produces: a bundled dependency's `jquery-1.9.1.js` or
`html5lib-tests.json`, or a package that lost `npm-shrinkwrap.json`.

This is a read-only gate — it never publishes, tags, or pushes. Summarize which
checks passed/failed and, if any failed, what the maintainer needs to fix.

Publication is `npm publish <admitted.tgz>` — the exact tarball this gate read.
Never `npm publish` from the repo root: that re-packs whatever `node_modules`
currently holds, which reintroduces the bundled dependency junk that
`pruneBundledDependencyJunk` strips only inside the admission build.
