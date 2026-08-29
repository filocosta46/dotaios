---
name: export-okf
triggers: export to okf, export my knowledge, make an okf bundle, open knowledge format, export my context, share my vault
description: Use when the user wants to export their DotAIOS knowledge into an Open Knowledge Format (OKF) bundle, or asks to produce, share, or hand off a portable copy of their context/vault/projects. Gates any external sharing behind the user's own decision.
when_to_use: export to okf · export my knowledge · make an okf bundle · open knowledge format · export my context · share my vault
---

# export-okf

Export your DotAIOS knowledge (context, vault, projects, decisions, connections)
into an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog)
(OKF v0.1) bundle — plain markdown + YAML frontmatter, git-shaped, readable by
any OKF tool. OKF is treated as **plumbing**: the bundle is a disposable
projection, not a migration. Your source files are never modified.

## How to run

Use only the current host-managed `candidate_invocation`: launch its
`executable` with its `argv_prefix` followed by one of these argument arrays,
without a shell. Stop if the object is absent.

```json
["export-okf"]
["export-okf","--out","<output-folder>"]
["export-okf","--path","<aios-folder>"]
```

It injects the OKF-required `type` field at export, generates `index.md` per
directory plus a bundle-root `index.md` declaring `okf_version: "0.1"`, and
rewrites resolvable `[[wikilinks]]` to absolute `/path.md` links.

## The one rule

The bundle is produced **locally only**. Producing it is not publishing it.
Sharing it, committing it, hosting it, or handing it to someone else is the
user's explicit decision — never do it automatically. Review first:

```bash
open <aios>/build/okf-export/index.md
```

## When NOT to use

- To "convert" your AIOS to OKF in place. Don't — export is read-only by design;
  your folder stays DotAIOS-native.
- To build storage, serving, or auth on top of OKF. Out of scope (OKF non-goals).
