# DotAIOS — Agent Working Guide

> This file is for AI agents and contributors working **inside this repo**.
> The user-facing product guide is `README.md` and `docs/architecture.md`.

## What this repo is

DotAIOS is a local-first CLI + conventions package (`npx dotaios`) that creates a
user's `~/aios/` personal-context folder and bridges it into the global memory
files of AI agents (Claude Code, Codex, Cursor, Gemini, OpenCode). Plain text,
no server, no cloud DB. Optional private GitHub sync. Search is term-frequency
text match (not semantic).

**ICP:** Non-technical users, agent-led onboarding, minimal/zero terminal. Keep
language and UX simple. No jargon, no cloud requirements, no heavy dependencies.

## Monorepo layout

```
packages/
  cli/      # All CLI commands. Entry: packages/cli/src/index.mjs
  core/     # Shared helpers: memory, paths, render, schema, search, sessions, digest, ...
  mcp/      # Local MCP server (single file: packages/mcp/src/server.mjs)
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
website/    # Static marketing site (index.html + styles.css, no bundler)
```

## Hard rules (never violate)

1. **ESM only.** All source is `.mjs`, `"type": "module"`. No CommonJS `require()`.
2. **Node >= 20.** Both the root and the `mcp` package declare `>=20`. Don't use APIs that need a newer floor without bumping `engines` deliberately.
3. **No build step.** Source ships directly. Do not add Babel, esbuild, tsc, or any transpiler.
4. **KISS.** No new heavy dependencies (linters, formatters, bundlers, ORMs, cloud SDKs, vector DBs). The 5 runtime deps all serve ingest (readability, cheerio, linkedom, turndown, unpdf).
5. **No semantic/vector search.** Search is intentionally TF term-frequency. Do not add embeddings.
6. **Local-first.** Core logic makes no external network calls. Network belongs in ingest/adapters/plugins, never in `packages/core`.
7. **Conventional commits**, single concern each: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `release`.
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
| `memory.mjs` | Read/write events + signals (JSONL). Exports `isoDate()` (**local** date), tolerant `readJsonl()` |
| `sessions.mjs` | Session index read/write under `withIndexLock()` (cross-process file lock) |
| `search.mjs` | TF text-match search across memory/vault/context/skills/...; reads files in bounded-concurrency batches |
| `digest.mjs` | Builds the compact working-memory digest (today/carry-over/signals/sessions) |
| `render.mjs` / `sections.mjs` | Template rendering / named-section markdown helpers |
| `schema.mjs` / `manifest.mjs` | `aios.json` and plugin `manifest.json` validation |

Notable CLI commands: `connect.mjs` (Gemini SessionStart hook + OpenCode MCP + Google Workspace),
`sync/` (private-GitHub cross-device sync), `capture.mjs` + `adapters/` (save/import AI conversations),
`install.mjs` + `market.mjs` (plugins/skills).

## Known gotchas

### Date helper inconsistency (near-midnight edge)
`memory.isoDate(date)` uses **local** time. `placement.todayStamp()` and
`cleanup.isoDate()` still use **UTC** (`toISOString().slice(0,10)`). Near local
midnight they disagree by a day. For anything that must match where signals/notes
are actually written, use `memory.isoDate(new Date())` — never
`new Date().toISOString().slice(0,10)`. (Unifying these is a known cleanup item.)

### Sessions index lock
`withIndexLock()` (`sessions.mjs`) records the holder PID in the lock file. A
crashed holder is reclaimed via a liveness check; a live holder is waited on
(bounded by `LOCK_WAIT_MS`, then it errors rather than running unlocked); release
only removes the lock if it's still ours. Don't reintroduce an unlocked
best-effort fallback — that corrupts the index under concurrency.

### MCP gws binary
The MCP server resolves the `gws` binary only from its environment
(`DOTAIOS_GWS_BIN`) or `PATH`, never from a tool argument. Do not add a `gwsBin`
tool parameter back — it would let a client make the server execute an arbitrary
binary.

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
