# DotAIOS Overnight Audit + Hardening — Plan

> **Run:** autonomous overnight fleet, started 2026-05-29 (local), branch `audit/overnight-2026-05-28`.
> **Mandate:** Take 1.17.0 → "best-in-class, ship-ready" via full audit + highest-leverage fixes + dev-ex + a new ICP-aligned website. Leave `main` untouched. Preview deploys only. KISS. Non-technical ICP.
> **This file is the durable tracker** — it survives context resets. The morning deliverable is `docs/overnight/REPORT.md`.

## Guardrails (never violate)
1. Work only on this branch. No push to main, no `npm publish`, no Vercel prod promote, no `gh release`. Preview deploys only.
2. Never touch `~/aios`, `~/.claude`, `~/.codex`, `~/.gemini`, or any user config/data. Repo only.
3. Every change keeps `npm test` + `npm run smoke` green. Unverifiable → revert.
4. KISS. No heavy deps, no cloud DB, no Rust, no vector/semantic search, no owned infra. >2 files of new abstraction → flag for human.
5. Small, reviewable commits. One concern each.
6. No deletion without grep-proof it's unreferenced + green tests.

## Repo facts (Wave 0 recon)
- Monorepo (pnpm workspaces): `packages/cli`, `packages/core`, `packages/mcp`. ESM `.mjs`. Node ≥20. Deps: readability, cheerio, linkedom, turndown, unpdf (all ingest-related). No build step.
- Tests: `node --test tests/**/*.test.mjs` → **362 tests, 361 pass, 1 skip** (Windows-only `lightpanda.exe` path test, correct on macOS). Smoke: `node scripts/smoke.mjs` green.
- Website: **static** — `website/index.html` + React 18 UMD + Babel-standalone over `.jsx` files (`app/graph/marketplace/tweaks-panel`), `styles.css`, `plugins.js`, `registry.json`. No bundler, no Next.js. Deployed at dotaios.vercel.app.
- CI (`.github/workflows/ci.yml`): on push/PR to `main`, Node 20/22 matrix, pnpm, `test` + `smoke` + `check` + `npm pack --dry-run`. Plus `release-installers.yml`.
- No repo `CLAUDE.md`. `.claude/` only has empty `worktrees/`.

## Known open items (from brief)
- (a) No unit test for the connect malformed-JSON guard — `connect.mjs:209/423/507` parse + `:367` "no partial install" comment.
- (b) connect-gemini hook script interpolates `aiosPath` into bash (own-path, low risk) — `connect.mjs:345-374`.
- (c) `withIndexLock` >10s slow-holder edge — `packages/core/src/sessions.mjs:253-291`, stale check at `:266` uses 10s mtime, no PID in lockfile.
- (d) Search ceiling is term-frequency text match — **semantic/vector deferred by design. DO NOT build it.**

## Baseline fix already landed
- `cb2fcb2 test(ingest): make signal-date assertion deterministic` — the suite was red on arrival (1 fail) due to a UTC-vs-local date mismatch in the signal-routing test (test used `toISOString()`/UTC; product writes with local `isoDate`). Fixed the test to use the product's date convention. **Latent product bug noted for backlog:** three inconsistent date helpers — `memory.isoDate` (local, used by writes/reads) vs `placement.todayStamp` + `cleanup.isoDate` (both UTC). Near local-midnight the displayed signal target / cleanup cutoff can drift a day from where notes are actually written.

## Waves
- **Wave 0 — Recon & plan.** ✅ Done (this file + green baseline restored).
- **Wave 1 — Parallel audit (read-only, no fixes).** 7 agents, each writes `docs/overnight/audit/NN-*.md`:
  1. correctness / code-review (logic bugs, CLI + core)
  2. security (secrets, path traversal, shell injection in connect hooks, sync token handling)
  3. test coverage + gaps
  4. docs + ICP alignment + onboarding clarity
  5. packaging / release hygiene (`files[]`, pack contents, bin, engines)
  6. CLI startup + search performance (TF search on large vaults)
  7. dev-ex / harness (CLAUDE.md, slash commands, pre-commit hook, CI)
- **Wave 2 — Synthesize.** Merge into `docs/overnight/BACKLOG.md`: KISS+ICP-filtered, severity-ranked (P0–P3), effort (S/M/L). Drop guardrail/ICP violations with reason.
- **Wave 3 — Build.** TDD, one item at a time, test each, small commits. Include open items (a) and (c) if cheap.
- **Wave 4 — Harness.** Additive only: repo `CLAUDE.md`, useful slash commands, pre-commit/test hook, CI on PR (test+smoke).
- **Wave 5 — Website.** Rebuild `website/` cleaner/faster/ICP-aligned ("one folder every agent reads", agent-led install front and center, non-technical tone). Preview deploy only; capture URL. (design.md reference cloned to `/tmp/designmd-ref`.)
- **Wave 6 — Verify & report.** Full test+smoke, code-review + security-review the branch delta, write `docs/overnight/REPORT.md`.

## Progress log
- 2026-05-29 — Wave 0 complete. Baseline green restored (`cb2fcb2`). Dispatching Wave 1 audits.
