# Packaging & Release-Hygiene Audit — dotaios@1.17.0

**Audit date:** 2026-05-29  
**Branch:** audit/overnight-2026-05-28  
**Auditor:** overnight subagent (read-only)

---

## npm pack --dry-run Summary

| Metric | Value |
|---|---|
| Total files in tarball | 124 |
| package source files (packages/*) | 75 |
| Skills | 22 |
| Templates | 14 |
| Docs | 16 (13 markdown + INSTALL.md + README.md + LICENSE) |
| Package size (compressed) | 145.7 kB |
| Unpacked size | 531.8 kB |
| Surprising inclusions | None |
| Surprising omissions | See findings below |

All runtime source files present. No tests, website, scripts/, `.vercel`, or `node_modules` leaked into the tarball. The `files[]` whitelist is the primary guard (no `.npmignore`).

---

## Findings

| ID | Severity | Effort | File:Line | Finding | Fix Sketch |
|---|---|---|---|---|---|
| F1 | P2 | S | `packages/mcp/package.json:9` | `engines: ">=18"` in the MCP sub-package conflicts with root `engines: ">=20"`. Not shipped to users (private sub-package JSON excluded from tarball), but misleads contributors and CI if they read the wrong file. | Update `packages/mcp/package.json` engines to `">=20"` to match root. |
| F2 | P2 | S | `skills/process-inbox/` | `skills/process-inbox/` ships only `SKILL.md` — no `LICENSE` file, unlike all 10 other skills which each include a `LICENSE`. Inconsistent; could matter for downstream consumers. | Add `skills/process-inbox/LICENSE` matching the MIT text used in sibling skills. |
| F3 | P2 | S | `package.json` | `CHANGELOG.md` exists at repo root but is absent from `files[]` and therefore not shipped. npm does NOT auto-include `CHANGELOG.md` by name (only `CHANGELOG`, `CHANGES`, `HISTORY` with no extension or specific casing patterns). Users and programmatic consumers cannot read the changelog post-install. | Add `"CHANGELOG.md"` to `files[]`. |
| F4 | P3 | S | `packages/core/package.json:3` | Sub-package version (`1.7.0`) and `packages/cli/package.json:3` (`1.8.0`) are far behind the root `1.17.0`. These are private packages so npm consumers are unaffected, but the drift makes it hard to cross-reference release history with git blame. | Keep sub-package versions in sync with root, or add a note in contributing docs that sub-package semver is intentionally independent. |
| F5 | P3 | S | `package.json` | No `main` or `exports` field in root `package.json`. This is correct for a bin-only package, but `require("dotaios")` or `import "dotaios"` from another package will fail with no clear error. Non-issue for `npx dotaios` users; minor gotcha for developers who might try to import programmatically. | Optional: add `"exports": null` to signal "not for import" explicitly. |
| F6 | P3 | M | `packages/core/src/licenses.mjs:92` | `globalThis.fetch` is used unconditionally with a runtime guard that throws if missing. Root `engines: ">=20"` ensures it's available (stable since Node 18+). However, the guard error message says "upgrade to Node 20+" which is slightly wrong — `fetch` is stable from Node 18. Low impact but confusing. | Correct error message: "fetch requires Node 18+; you are running Node " + process.version. |

---

## Detailed Analysis

### files[] completeness
All 16 entries in `files[]` resolve to real paths. No dead references. The `"packages/cli/src"`, `"packages/core/src"`, `"packages/mcp/src"` glob entries correctly capture all sub-directories (adapters, commands, ingest, lib, sync) as confirmed by the pack output containing 75 packages/* files vs 78 total source files (the 3 missing are private sub-package `package.json` files, intentionally excluded — no runtime code reads them).

### bin entries
Both `dotaios` / `aios` → `packages/cli/src/index.mjs` and `dotaios-mcp` → `packages/mcp/src/server.mjs` resolve to real files with correct `#!/usr/bin/env node` shebangs. Files are executable (`-rwxr-xr-x`). No issues.

### version string consistency
| Source | Value |
|---|---|
| `package.json` | 1.17.0 |
| `CHANGELOG.md` (top) | `[1.17.0] - 2026-05-28` |
| README version badge | Dynamic (`img.shields.io/npm/v/dotaios`) |
| `--version` output | reads `package.json` at runtime via `readFileSync` |

All consistent. The `readFileSync(new URL("../../../package.json", import.meta.url), ...)` path correctly resolves to the root `package.json` both in dev and post-install (from `node_modules/dotaios/packages/cli/src/index.mjs`, `../../..` = `node_modules/dotaios/`).

### engines
Root `package.json` declares `node: ">=20"`. Code uses `globalThis.fetch` (stable Node 18+), standard `fs/promises`, `readline/promises`, and no Node 22+ APIs found. The `>=20` floor is slightly conservative but not wrong — it aligns with Node LTS and avoids the Node 18 `fetch` experimental flag. INSTALL.md correctly instructs users to install `v20.x.x` or later.

### type: module consistency
Root `type: "module"` declared. All source files use `.mjs` extension explicitly, so the `type` field has no material effect on resolution. All three sub-packages also declare `type: "module"`. No `.cjs` files present. Clean.

### dependencies
All 5 declared dependencies are actively used:

| Package | Used in |
|---|---|
| `@mozilla/readability` | `packages/cli/src/ingest/web.mjs` (dynamic import) |
| `cheerio` | `packages/cli/src/ingest/web.mjs` (dynamic import) |
| `linkedom` | `packages/cli/src/ingest/web.mjs` (dynamic import) |
| `turndown` | `packages/cli/src/ingest/web.mjs` (dynamic import) |
| `unpdf` | `packages/cli/src/ingest/pdf.mjs` (dynamic import) |

All four web-ingest deps are loaded lazily (dynamic `import()` inside the ingest path). This means `npx dotaios setup` for a non-technical user who never runs `ingest` will not even load these packages. Good design.

No missing dependencies found. No external npm package imports outside the declared 5 + Node built-ins.

### pnpm vs npm compatibility
Monorepo uses `pnpm-workspace.yaml` + `pnpm-lock.yaml` (lockfileVersion 9.0). Root `package.json` has no `workspaces` field, so `npm install dotaios` from the registry installs a flat package with no workspace machinery. The pnpm lockfile is a dev artifact and not shipped. End-user `npm i -g dotaios` or `npx dotaios` will resolve the 5 deps via npm's own resolver cleanly.

Cross-package relative imports (e.g., `../../core/src/memory.mjs` from `packages/cli/src/`) work post-install because the full `packages/` tree is preserved in the tarball under `node_modules/dotaios/`.

### MCP server and templates/skills
- `packages/mcp/src/server.mjs` ships and has a correct shebang.
- All 11 skills directories ship (audit, closeday, import-context, ingest, plan-today, privacy-brief, process-inbox, save-session, summarize-source, today, weekly-review).
- All template files (`.hbs`, `.template`) ship in `templates/` including subdirectories.
- Skills are loadable post-install: the `skills/` path is resolved at runtime relative to the package root via `import.meta.url` or path utilities.

### Cruft check
Not shipped (correctly excluded): `tests/`, `scripts/`, `website/`, `.vercel`, `node_modules/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `CHANGELOG.md`, sub-package `package.json` files.
