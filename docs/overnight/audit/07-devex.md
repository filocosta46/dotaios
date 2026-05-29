# Dev-Ex / Harness Audit — Wave 1 Report

**Branch:** `audit/overnight-2026-05-28`
**Version:** 1.17.0
**Date:** 2026-05-29

---

## Executive Summary

The repo's dev-ex baseline is thin but clean. No repo CLAUDE.md, no pre-commit hook, `.claude/` is essentially empty (just `worktrees/`), and CI only runs on `main`. All four of these are low-hanging fruit. Proposals below are strictly KISS+additive; nothing changes existing behavior.

---

## Findings & Proposals

### 1. Missing repo CLAUDE.md — P1 / Effort S

**Finding:** There is no CLAUDE.md at repo root. AI agents landing in this repo have no machine-readable architecture map, no test/smoke commands, no rules. The maintainer's own `~/aios/CLAUDE.md` (written by DotAIOS itself) is a user-context file, not a repo-contributor guide. Without a repo CLAUDE.md, every agent session starts cold and must rediscover how to run tests, what the ESM constraint means, where modules live, and what gotchas exist.

**Proposal:** Create `/Users/filo/Brain/dotaios/CLAUDE.md` — see full draft below.

---

### 2. No pre-commit / pre-push hook — P2 / Effort S

**Finding:** No git hooks exist (`scripts/hooks/` does not exist, `git config core.hooksPath` is not set). Nothing stops a developer (or AI agent) from committing code that breaks `pnpm test`. The CI gate only fires after a push to `main` or a PR targeting `main`, which is too late.

**Proposal:** A tracked `scripts/hooks/pre-push` shell script + one-line install instruction. Pre-push (not pre-commit) is chosen because the test suite takes a few seconds to run and pre-commit would fire on every `git commit`, including WIP commits. Pre-push fires only before a push, which is the right gate.

Note: no Husky, no lint-staged, no heavy dep. Plain POSIX shell. Install method: `git config core.hooksPath scripts/hooks` (one command, tracked in repo, no external tooling). Smoke test is excluded from the hook (it's slower and has external side-effects like temp dirs) — CI already catches smoke failures before merge.

---

### 3. CI only triggers on `main` — P1 / Effort S

**Finding:** `ci.yml` triggers only on `push: branches: [main]` and `pull_request: branches: [main]`. Feature branches and draft PRs get no CI feedback until they target main. Agents working on feature branches (like `audit/overnight-2026-05-28`) get no automatic test signal.

**Additional CI gaps noted:**
- No Node 24 in matrix. The stated minimum is `>=20` and current matrix is `[20, 22]`. Node 24 became LTS-eligible in 2025 and is the next recommended upgrade target. Adding it is a one-line additive change. [KISS-RISK: low — but flag for maintainer to consciously opt in]
- `npm pack --dry-run` runs only in the root `test` job but correctly verifies `files[]`. Fine as-is.
- No dedicated lint step — consistent with the repo philosophy (no linter configured). This is intentional, not a gap.

**Proposal:** Change `ci.yml` `on:` block to run on all branches. See full draft below.

---

### 4. Useful repo scripts — P3 / Effort S

**Finding:** The `package.json` scripts are clean. However there is no quick "what changed since last release" helper and no release-checklist script. Given this is a solo project with frequent releases (v1.17.0 already), both would reduce cognitive overhead.

**Proposal:** Two lightweight additions to `package.json` scripts:
- `"changelog": "git log --oneline $(git describe --tags --abbrev=0)..HEAD"` — shows commits since last tag, zero new files
- A `scripts/release-checklist.mjs` — simple, prints a human checklist before `npm publish`. See draft below.

---

### 5. `isoDate` inconsistency — P2 / Effort S (noted for Wave 2 backlog, not a harness issue)

**Note from PLAN.md (already documented in Wave 0):** `memory.isoDate()` uses local time (`getDate()`/`getMonth()`/`getFullYear()`) while `placement.todayStamp()` uses UTC (`toISOString().slice(0, 10)`). Near local-midnight these can disagree by one day. The test fix in `cb2fcb2` already guards the test suite. This is a correctness item for Wave 2/3, not a harness item. Mentioned here for completeness so the CLAUDE.md draft includes it as a documented gotcha.

---

## Draft File Contents

All content below is ready to lift verbatim. No editing needed.

---

### Draft 1: `/CLAUDE.md` (repo root)

```markdown
# DotAIOS — Agent Working Guide

> This file is for AI agents and contributors working **inside this repo**.
> The user-facing product guide is `docs/architecture.md` and `README.md`.

## What this repo is

DotAIOS is a local-first CLI + conventions package (`npx dotaios`) that bridges
a user's `~/aios/` personal context folder into global agent memory files
(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.).

**ICP:** Non-technical founders and knowledge workers. Keep language and UX
simple. No jargon, no cloud requirements, no heavy dependencies.

## Monorepo layout

```
packages/
  cli/      # All CLI commands. Entry: packages/cli/src/index.mjs
  core/     # Shared helpers: memory, paths, render, schema, search, sessions, etc.
  mcp/      # Local MCP server (single file: packages/mcp/src/server.mjs)
scripts/
  smoke.mjs # End-to-end smoke test (spawns the CLI in a temp dir)
tests/
  cli/      # Unit tests for CLI commands and lib
  core/     # Unit tests for core helpers
  mcp/      # Unit tests for MCP server
  fixtures/ # Static test fixtures
templates/  # Handlebars templates rendered during `dotaios init` / `dotaios activate`
skills/     # Bundled skill markdown files (shipped inside the npm package)
docs/       # Architecture, user docs, overnight audit reports
```

## Hard rules (never violate)

1. **ESM only.** All source files are `.mjs`. `"type": "module"` in every `package.json`. No `.cjs`, no CommonJS `require()`.
2. **Node >= 20.** No syntax or APIs that require Node 21+. (MCP package says `>=18` — keep compatible with both.)
3. **No build step.** Source is shipped directly. Do not add Babel, esbuild, tsc, or any transpiler.
4. **KISS.** No new heavy dependencies (no linters, formatters, bundlers, ORMs, cloud SDKs) unless trivially small and clearly worth it.
5. **No semantic/vector search.** The search is intentional TF term-frequency. Do not add embeddings or vector DB.
6. **Local-first.** No calls to external APIs from core logic. Network calls belong in optional adapters/plugins, never in `packages/core`.
7. **Conventional commits.** Format: `type(scope): message`. Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `release`. Keep commits small and single-concern.
8. **Keep tests green.** Never commit without running `pnpm test`. CI runs on push/PR to main.

## How to run things

```bash
# Install dependencies (pnpm workspaces)
pnpm install

# Run all unit tests (362 tests as of v1.17.0)
pnpm test
# Equivalent: node --test tests/**/*.test.mjs

# Run the end-to-end smoke test (spawns CLI in a temp dir, no side effects on ~/aios)
pnpm run smoke

# Verify the CLI help output (sanity check that the CLI loads)
pnpm run check

# Verify npm pack contents (dry run — checks files[] in package.json)
npm pack --dry-run

# Run the CLI locally
pnpm run cli -- <command> [options]
# e.g.: pnpm run cli -- status --path /tmp/test-aios
```

## Key modules in `packages/core/src/`

| File | What it does |
|---|---|
| `paths.mjs` | Default paths: `~/aios`, `~/.dotaios`, `syncConfigPath()`, etc. |
| `memory.mjs` | Read/write events, signals, daily notes. Exports `isoDate()` (local time). |
| `sessions.mjs` | Session index read/write with `withIndexLock()` advisory locking. |
| `search.mjs` | TF text-match search across vault/memory/context/skills. |
| `render.mjs` | Handlebars template rendering for context files. |
| `schema.mjs` | `aios.json` schema validation and defaults. |
| `manifest.mjs` | Plugin `manifest.json` validation. |
| `digest.mjs` | Builds the daily brief digest from signals + events. |
| `sections.mjs` | Markdown section helpers (read/write named sections). |

## Key CLI commands in `packages/cli/src/commands/`

Notable non-obvious ones: `connect.mjs` (Google Workspace + Gemini hook script generation),
`sync.mjs` (cross-device sync to a private GitHub repo via `packages/cli/src/sync/`),
`capture.mjs` (save/import AI conversations via `packages/cli/src/adapters/`).

## Known gotchas

### Date helper inconsistency (near-midnight edge case)
`memory.isoDate(date)` uses **local time** (`getFullYear/Month/Date`).
`placement.todayStamp()` and `cleanup.isoDate()` use **UTC** (`toISOString().slice(0,10)`).
Near local midnight these can disagree by one day. Always use `memory.isoDate(new Date())`
for filenames and date keys that must match what memory writes. Do not use
`new Date().toISOString().slice(0,10)` for anything that touches signal or daily-note paths.

### Sessions index locking
`withIndexLock()` in `sessions.mjs` uses a file-based advisory lock with a 10-second
stale mtime check. It does not embed a PID. Under concurrent agents, a slow holder
(>10 s) can have its lock stolen. This is a known accepted limitation.

### MCP package Node engine field
`packages/mcp/package.json` declares `"node": ">=18"` while the rest of the repo uses `>=20`.
The MCP server itself only uses Node 20+ APIs indirectly (via core), so this is cosmetically
inconsistent but functionally fine. Do not tighten it without testing on Node 18 explicitly.

### Smoke test temp dir
`scripts/smoke.mjs` creates a temp dir under `os.tmpdir()`. It does not clean up on failure
(by design — leaving the dir helps debugging). On CI the runner is ephemeral; locally you may
accumulate `dotaios-smoke-*` dirs in `/tmp`.

### `npm pack --dry-run` vs `pnpm pack`
The `pack:check` script uses `npm pack --dry-run` (not `pnpm pack`) intentionally — npm's
pack respects `files[]` in `package.json` and the output is easier to eyeball. pnpm's behavior
differs. Keep it as `npm pack`.

## Commit checklist (for agents)

Before committing:
1. `pnpm test` — all tests pass (362 tests, 1 intentional skip on non-Windows)
2. `pnpm run check` — CLI loads without error
3. No `~/aios`, `~/.claude`, `~/.codex`, `~/.gemini`, `.env`, or credential files touched
4. Commit message follows conventional commits format
5. Change is additive/KISS — no new heavy deps without explicit maintainer approval
```

---

### Draft 2: `scripts/hooks/pre-push`

**File:** `scripts/hooks/pre-push`
**Install:** `git config core.hooksPath scripts/hooks` (run once in the repo, tracked in git)

```sh
#!/bin/sh
# DotAIOS pre-push hook.
# Runs the unit test suite before any push. Blocks the push on failure.
# Install: git config core.hooksPath scripts/hooks
# To skip once (emergency only): git push --no-verify

set -e

echo "Running pnpm test before push..."
pnpm test

echo "Tests passed. Proceeding with push."
```

**Notes:**
- Plain POSIX `sh`, no dependencies.
- Does NOT run `pnpm run smoke` — smoke is slower (~3–5 s extra) and the test suite alone catches regressions. Smoke runs in CI.
- The `--no-verify` escape hatch is documented in the file comment for emergency use.
- Tracked at `scripts/hooks/pre-push` so it version-controls with the repo. Each developer runs one command to activate: `git config core.hooksPath scripts/hooks`. This can be added to `CONTRIBUTING.md`.

---

### Draft 3: CI trigger fix — `.github/workflows/ci.yml` (additive edit)

Replace the `on:` block:

```yaml
# BEFORE (current):
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# AFTER (proposed):
on:
  push:
    branches: ['**']
  pull_request:
    branches: ['**']
```

This makes CI run on every branch and every PR, not just those targeting `main`. Additive — no jobs removed or changed.

Optionally also add Node 24 to the matrix (one-line addition, conservative change):
```yaml
        node: [20, 22, 24]
```

---

### Draft 4: `package.json` changelog helper (additive script entry)

```json
"changelog": "git log --oneline $(git describe --tags --abbrev=0)..HEAD"
```

Usage: `pnpm run changelog` — prints all commits since the last git tag (last release). No new files, no deps. Useful before bumping version.

---

### Draft 5: `scripts/release-checklist.mjs`

A lightweight checklist printer for the maintainer to run before `npm publish`. Zero dependencies, pure Node, ESM.

```mjs
#!/usr/bin/env node
// Release checklist for DotAIOS.
// Run: node scripts/release-checklist.mjs
// Or add to package.json: "release:check": "node scripts/release-checklist.mjs"

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

console.log(`\nDotAIOS Release Checklist — v${pkg.version}\n`);
console.log("Work through each item before running npm publish.\n");

const items = [
  {
    label: "Tests pass",
    check: () => {
      try { execSync("pnpm test", { stdio: "pipe" }); return true; }
      catch { return false; }
    }
  },
  {
    label: "Smoke passes",
    check: () => {
      try { execSync("pnpm run smoke", { stdio: "pipe" }); return true; }
      catch { return false; }
    }
  },
  {
    label: "CLI help loads",
    check: () => {
      try { execSync("pnpm run check", { stdio: "pipe" }); return true; }
      catch { return false; }
    }
  },
  {
    label: "package.json version matches CHANGELOG.md top entry",
    check: () => {
      if (!existsSync("CHANGELOG.md")) return null; // skip if no changelog
      const changelog = readFileSync("CHANGELOG.md", "utf8");
      return changelog.includes(`## ${pkg.version}`) || changelog.includes(`[${pkg.version}]`);
    }
  },
  {
    label: "npm pack --dry-run shows expected files",
    check: () => {
      try {
        const out = execSync("npm pack --dry-run 2>&1", { encoding: "utf8" });
        // Just check it doesn't error and includes the main entry point
        return out.includes("packages/cli/src/index.mjs");
      } catch { return false; }
    }
  },
  {
    label: "Working tree is clean (no uncommitted changes)",
    check: () => {
      const out = execSync("git status --porcelain", { encoding: "utf8" });
      return out.trim() === "";
    }
  },
  {
    label: "On main branch",
    check: () => {
      const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
      return branch === "main";
    }
  },
];

let allPass = true;
for (const item of items) {
  let result;
  try { result = item.check(); } catch { result = false; }
  const icon = result === true ? "✓" : result === null ? "–" : "✗";
  const status = result === true ? "PASS" : result === null ? "SKIP" : "FAIL";
  if (result === false) allPass = false;
  console.log(`  ${icon}  [${status}]  ${item.label}`);
}

console.log("");
if (allPass) {
  console.log("All checks passed. Safe to: npm publish");
} else {
  console.log("One or more checks failed. Fix before publishing.");
  process.exitCode = 1;
}
console.log("");
```

---

## Priority Summary

| # | Proposal | Priority | Effort | File(s) |
|---|---|---|---|---|
| 1 | Repo CLAUDE.md with architecture map, rules, gotchas | P1 | S | `CLAUDE.md` |
| 2 | CI triggers on all branches (not just main) | P1 | S | `.github/workflows/ci.yml` |
| 3 | Pre-push git hook blocking on test failure | P2 | S | `scripts/hooks/pre-push`, one-line `CONTRIBUTING.md` update |
| 4 | Release checklist script | P3 | S | `scripts/release-checklist.mjs`, optional `package.json` entry |

**Not proposed (KISS guard):**
- No Husky / lint-staged — unnecessary complexity for a solo repo
- No ESLint / Prettier — no linter configured by design; adding one would be [KISS-RISK: M]
- No Node 24 in CI matrix (flagged as optional) — the `>=20` engine constraint is the stated intent; adding 24 is a one-line change but the maintainer should consciously opt in
- No semantic search — explicitly out of scope per PLAN.md

## CI review: existing `ci.yml`

The current `ci.yml` is clean. No issues found other than the `on:` scope. Specific observations:

1. `fail-fast: false` on the matrix is correct — lets you see failures on both Node versions.
2. `pnpm/action-setup@v4` with explicit `version: 10.33.4` is good (deterministic).
3. `npm pack --dry-run` step is correct and intentionally uses `npm` not `pnpm` (consistent with `pack:check` script).
4. No `cache: npm` mismatch — uses `cache: pnpm` with `setup-node`, correct.
5. `release-installers.yml` is `workflow_dispatch` only — this is correct per the file comment (Windows MSI is an optional future path, not a release gate).

One minor note on `release-installers.yml`: the `Attach to GitHub Release` step runs `if: startsWith(github.ref, 'refs/tags/v')` but the workflow is `workflow_dispatch` only (not triggered by tag push). This condition will never be true in practice. It's harmless dead code — the step is silently skipped. Not worth changing now unless the workflow is extended to also trigger on tag push.
