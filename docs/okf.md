# OKF export

DotAIOS can project your knowledge into an
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog)
(OKF v0.1) bundle — the vendor-neutral, git-based spec for human- and
agent-readable knowledge (plain markdown + YAML frontmatter, no central
registry, no required tooling).

```bash
dotaios export-okf
```

## Why this exists

DotAIOS is already shaped like OKF — a folder of markdown files any agent can
read. The format is commodity plumbing, so DotAIOS adopts it fully and defends
nothing: the bundle is a portable, conformant **projection** of your knowledge,
not a new home for it. Your `~/aios` stays DotAIOS-native; the export is
disposable and re-runnable.

## What it does

- Walks `context/`, `vault/`, `projects/`, `decisions/`, `connections/`.
  Operational logs (`memory/*.jsonl`) and `skills/` workflows are intentionally
  excluded — OKF is for knowledge concepts, not runtime state.
- Injects the OKF-required `type` field **at export** (inferred from your
  existing frontmatter or the file's location). Source files are never modified.
- Generates a progressive-disclosure `index.md` in every directory, plus a
  bundle-root `index.md` declaring `okf_version: "0.1"`.
- Rewrites resolvable `[[wikilinks]]` to absolute `/path.md` links; unresolved
  links are left as-is (OKF treats them as not-yet-written knowledge).

## Options

| Flag          | Default                   | Description                          |
|---------------|---------------------------|--------------------------------------|
| `--out <dir>` | `<aios>/build/okf-export` | Where to write the bundle.           |
| `--path <dir>`| `~/aios`                  | Use a non-default AIOS folder.       |

## The live folder is OKF-native too

The export is no longer the only OKF surface. The live folder maintains itself:

- **Per-shelf and per-project `index.md`** — `memory/`, `projects/`, and every
  `projects/<slug>/` keep a generated `index.md` listing each doc with its
  `type` and `description`. Regeneration is deterministic and write-if-changed:
  a no-op run produces zero diff. The renderer is the same one the export uses,
  so the live tree and the bundle can never drift in format.
- **Per-project `log.md`** — the reserved changelog, projected from
  `memory/events.jsonl` (promotion/decision lifecycle entries for that project,
  newest first). An agent answers "what changed in project X" by reading it
  instead of re-scanning the event log. It refreshes on project-tagged event
  writes and during daily memory maintenance.
- **Frontmatter convention** — memory-folder documents carry OKF-style
  frontmatter: `type` (required at export, recommended live) plus `title`,
  `description`, `tags`, and a timestamp. The `description` field is the same
  one search and the index generators read — write it once, every surface uses it.
- **Decisions are searchable** — `decisions/` is a first-class search scope
  (`dotaios search --scope decisions`, included in `all`), and the working-context
  projection carries the most recent decision titles so agents returning days
  later still see them.

## Local only

The bundle is produced on your machine and nothing is published, committed, or
shared. Sharing it — handing it to a tool, a person, or a repo — is your
decision. The output is portable: open it in any OKF viewer, an Obsidian vault,
or a static site, or hand it to another agent.
