---
description: Check the exact tarball before candidate publication or final latest promotion.
allowed-tools: Bash(npm run release:check), Bash(npm run release:check -- --artifact *), Bash(npm run release:check -- --admission * --artifact *), Bash(npm run release:check -- --candidate-publish --admission * --artifact *)
---

After source and package admission plus explicit maintainer authority, check the
candidate from the repo root:

```sh
npm run release:check -- --candidate-publish --admission <admission.json> --artifact <admitted.tgz>
```

Use the tarball that `npm run pack:admission` produced and CI uploaded. The gate
binds its SHA-256 to the package receipt and prints the exact candidate publish
command, `npm publish <admitted.tgz> --tag candidate`, only on GO.

After the registry, native-client, evidence-commit, and non-founder receipts are
also present, run the full public-release check:

```sh
npm run release:check -- --admission <admission.json> --artifact <admitted.tgz>
```

On full GO it prints the exact `npm dist-tag add dotaios@<version> latest`
command. This promotes the same bytes without republishing them.

The gate is read-only. Never publish from the repo root; that repacks the
working tree instead of using the admitted bytes.
