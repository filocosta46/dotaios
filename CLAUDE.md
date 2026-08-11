# DotAIOS — Agent Working Guide

> This file is for AI agents and contributors working **inside this repo**.
> The user-facing product guide is `README.md` and `docs/architecture.md`.

## What this repo is

DotAIOS is a local-first CLI + conventions package (`npx dotaios`) that creates a
user's `~/aios/` personal-context folder and bridges it into the global memory
files of AI agents (Claude Code, Codex, Cursor, Gemini, OpenCode). Plain text,
no hosted server, no cloud DB. Optional manual private GitHub sync. Search is
term-frequency text match (not semantic).

**ICP and message:** People who want one simple personal context layer across
Claude Code, Codex, Cursor, Gemini, and other assistants. Lead public copy with
the user outcome, not developer terminology. The current setup still needs
Node/`npx` or a local assistant that can run it, so do not claim zero-setup
consumer onboarding until a simpler installer exists. Keep language direct. No
cloud requirements, no heavy deps, no vector DB.

## Monorepo layout

```
packages/
  cli/      # All CLI commands. Entry: packages/cli/src/index.mjs
  core/     # Shared helpers: memory, paths, render, schema, search, sessions, digest, ...
  mcp/      # Optional read-only MCP adapter (single file: packages/mcp/src/server.mjs)
scripts/
  smoke.mjs            # End-to-end smoke test (spawns the CLI in a temp dir)
  release-checklist.mjs # Pre-publish checklist (node scripts/release-checklist.mjs)
  hooks/pre-push       # Optional test gate (see "Git hooks" below)
tests/
  cli/  core/  mcp/    # Unit tests (node --test)
  fixtures/            # Static test fixtures
templates/  # Templates rendered during `dotaios init` / `dotaios activate`
skills/     # Bundled skill markdown (shipped inside the npm package)
docs/       # Architecture and user docs
```

The commercial website and its deployment configuration are maintained outside
this public repository. Do not add storefront source, offer copy, or deployment
secrets here.

## Architecture boundaries

- **Portable projects, local paths.** `projects/<slug>/README.md` is the synced
  record (stable ID, name, status, domain, repo URL). Repositories may live in
  the root-ignored `workspaces/<slug>/` shelf or at an external path; each keeps
  its own Git history and remote. `~/.dotaios/projects.json` maps IDs to checkout
  paths on one machine. Never put absolute paths in portable metadata or working
  context, and never track anything under `workspaces/` in the AIOS mirror.
- **Promotion is preview-first.** Captured sessions are evidence. `dotaios memory
  promote` plans and previews by default; only explicit `--apply` may append to a
  signal, context, project, vault, or skill, or record `session-only`. Apply
  rechecks source/destination state and appends a receipt to `memory/events.jsonl`.
- **One working-context selector.** `working-context.mjs` owns deterministic,
  bounded selection and applies one project filter to projects, sessions,
  signals, and events. CLI, MCP, briefs, and bridge instructions must consume
  that policy rather than recreate memory windows.
- **Sync is optional, manual, and fail-closed.** `dotaios sync setup` is an
  explicit opt-in; `dotaios sync now` is the reconciliation boundary. It runs
  only from the expected `main` checkout under a lock; conflicts abort without
  a push, reset, or recovery branch.
- **MCP is optional and read-only.** It exposes only `read_working_context`,
  `search_aios`, and `resolve_skill`. It does not write AIOS or client config,
  and it does not execute external commands.
- **Optional GWS adapter.** Google Workspace stays outside the beginner core
  and MCP. The explicit `dotaios connect google` / `dotaios google` adapters
  may expose only read-first Gmail, Calendar, and Drive workflows, keep auth in
  the local `gws` CLI, and never accept custom scopes or expose Google tools to
  MCP. Existing OAuth grant scopes are not inferred from `gws auth status`.

## Hard rules (never violate)

1. **ESM only.** All source is `.mjs`, `"type": "module"`. No CommonJS `require()`.
2. **Node >= 20.** Both the root and the `mcp` package declare `>=20`. Don't use APIs that need a newer floor without bumping `engines` deliberately.
3. **No build step.** Source under `packages/` ships directly.
4. **KISS.** No new heavy dependencies (linters, formatters, bundlers, ORMs,
   cloud SDKs, vector DBs). Four runtime dependencies serve ingest; `yaml`
   validates portable project frontmatter.
5. **No semantic/vector search.** Search is lexical TF/IDF + recency decay. Do not add embeddings or a disk IDF cache unless measured.
6. **Local-first.** Core logic makes no external network calls. Network belongs in ingest/adapters/plugins, never in `packages/core`.
7. **Conventional commits**, single concern each: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `release`; use `merge` only for an explicit reviewed branch reconciliation.
8. **Keep tests green.** Run `npm test` + `npm run smoke` before every commit. Never leave the branch red.

## How to run things

```bash
npm test            # all unit tests — node --test tests/**/*.test.mjs
npm run smoke       # end-to-end smoke (temp dir; no effect on real ~/aios)
npm run check       # CLI --help loads (sanity that the CLI imports)
npm pack --dry-run  # verify shipped files match package.json "files"
npm run cli -- <command> [options]   # run the CLI locally
```

Tests are pure `node:test` (no framework). One test is intentionally skipped off
Windows (`lightpanda.exe` path).

## Key modules in `packages/core/src/`

| File | What it does |
|---|---|
| `paths.mjs` | Default paths (`~/aios`, `~/.dotaios`), vault/sync path resolution |
| `projects.mjs` | Portable project records plus machine-local checkout mapping and diagnostics |
| `memory.mjs` | Read/write events + signals (JSONL). Exports `isoDate()` (**local** date), tolerant `readJsonl()` |
| `session-store.mjs` | Four-operation session authority: capture, reconcile, bounded search, and exact delete; canonical Markdown plus a rebuildable index projection |
| `sessions.mjs` | Compatibility facade and pure helper re-exports; durable work delegates to `SessionStore` |
| `operation-lock.mjs` | Shared cross-process lock primitive, including strict owned-state publication for `SessionStore` |
| `promotion.mjs` | Preview/apply memory promotion with shelf containment, drift checks, and receipts |
| `working-context.mjs` | Canonical bounded, deterministic, project-filtered context selection and rendering |
| `search.mjs` | TF text-match search across memory/vault/context/skills/...; reads files in bounded-concurrency batches |
| `digest.mjs` | Compatibility wrapper over the canonical working-context projection |
| `render.mjs` / `sections.mjs` | Template rendering / named-section markdown helpers |
| `schema.mjs` / `manifest.mjs` | `aios.json` and plugin `manifest.json` validation |

Notable CLI commands: `project.mjs` (portable catalog + local checkout mapping),
`memory.mjs` (preview-first promotion), `brief.mjs` (working-context consumer),
`sync/` (manual private-GitHub reconciliation), `capture.mjs` + `adapters/`
(session evidence), and `install.mjs` (plugins/skills).

## Known gotchas

### Date handling
Date-based memory paths use `memory.isoDate(date)` and local time consistently.
Do not reintroduce `new Date().toISOString().slice(0,10)` for signal, brief, or
cleanup paths: UTC dates can disagree with the user's local day near midnight.

### SessionStore authority and operation lock
Session Markdown is canonical user memory; `memory/sessions/index.jsonl` is only
a rebuildable projection. Route capture, reconcile, search metadata, and exact
delete through `SessionStore`. Its mutating operations use the shared operation
lock in strict owned-state mode, with atomically published owner transitions,
bounded waiting, and fail-closed recovery. Never add an unlocked fallback or
write the projection as an independent authority. Current session code does not
use `withIndexLock()`; if a downstream compatibility branch still retains it,
that path is legacy compatibility only, never session authority. `sessions.mjs`
delegates its durable work to `SessionStore`.

### MCP capability boundary
The MCP server is an optional read adapter, not a command or memory authority.
Keep its tool list allowlisted and read-only. Never add durable writes, shell or
third-party command execution, credential handling, or Google Workspace tools.

### Smoke temp dirs
`scripts/smoke.mjs` creates `os.tmpdir()/dotaios-smoke-*` and intentionally
leaves them on failure for debugging.

## Git hooks (optional, opt-in)

A tracked pre-push hook runs the tests before any push:

```bash
git config core.hooksPath scripts/hooks   # enable once
git push --no-verify                        # emergency bypass
```

## Commit checklist

1. `npm test` green, `npm run smoke` green.
2. No `~/aios`, `~/.claude`, `~/.codex`, `~/.gemini`, `.env`, or credential files touched.
3. Conventional-commit message, single concern.
4. Additive/KISS — no new heavy deps without explicit maintainer approval.
