# DotAIOS — Triaged Backlog (Wave 2 synthesis)

Merged from the 7 Wave-1 audit reports in `docs/overnight/audit/`. Filtered for KISS + the non-technical/agent-led/zero-terminal ICP. Items that would add heavy deps, cloud/semantic search, terminal burden, or owned infra are **dropped** (listed at the bottom with reason). Severity P0 (broken / hurts users) → P3 (trivia). Effort S (<30min) / M (hours) / L (big).

Legend: ✅ = build this run · ⏭ = deferred (listed for human) · ❌ = dropped (guardrail/ICP)

## P0 / P1 — build this run

| ID | Sev/Eff | Area | Item | File | Plan |
|----|---------|------|------|------|------|
| B1 | P1/S | correctness | `search.mjs readJsonl` throws on one corrupt JSONL line → crashes `search_memory`, session digest, and the **Gemini/OpenCode SessionStart hook** (1.17.0 headline). | `core/src/search.mjs:386` | ✅ Skip+warn bad lines (tolerant parse like memory.mjs). TDD. |
| B2 | P0(cov)/S | tests | Connect malformed-JSON guard untested (= open item **a**). Guard already exists (`connect.mjs:425`). | `tests/cli/` | ✅ Add unit test: corrupt gemini/opencode settings → throws, no partial install. |
| B3 | P1/S | security | Gemini/OpenCode hook script interpolates `aiosPath` into bash unescaped → shell injection if path has `"`/`$`/backtick (= open item **b**, S-01). | `connect.mjs:408` (+ opencode) | ✅ Single-quote-escape path in generated script. TDD. |
| B4 | P1/S | security | `install --subdir` path traversal: `../../../x` from a malicious market entry escapes clone dir into the synced vault (S-04). | `cli/src/commands/install.mjs:43` | ✅ Reject `..` segments / absolute. TDD. |
| B5 | P1/S-M | correctness | `withIndexLock`: (a) past 5s deadline runs `fn()` **unlocked** → concurrent writers lose index entries; (b) steals lock on 10s mtime with no liveness check → robs a slow-but-alive holder (= open item **c**, C01/C02). | `core/src/sessions.mjs:253-281` | ✅ PID in lockfile + liveness-gated steal; never run unlocked; owner-checked release. TDD (concurrent writers + dead-PID steal). |
| B6 | P1/S | perf | `searchMarkdownDir` reads files sequentially; `searchAios` awaits scopes serially. ~44% faster search via bounded `Promise.all`. Becomes user-perceptible >2500 files. | `core/src/search.mjs:29,145` | ✅ Batched parallel reads, identical results/order. Verify scoring unchanged. |
| B7 | P1/S | security | MCP `gwsBin` lets a client point Google tools at an arbitrary binary that gets spawned (S-02). | `mcp/src/server.mjs:282` | ✅ Verify threat → drop `gwsBin` from MCP schema or allowlist. (verify first) |
| B8 | P0/S | docs/ICP | CHANGELOG missing `[1.15.0]` ("agent-carried onboarding") — core ICP feature, tag exists, entry absent. | `CHANGELOG.md` | ✅ Add entry. |
| B9 | P0/M | docs/ICP | 1.17.0 headline features (`read_session_digest` MCP tool, `connect gemini` SessionStart hook) undocumented in `docs/mcp.md` + `docs/adapters.md`. | `docs/` | ✅ Document both. |
| B10 | P1/S | docs/ICP | `docs/getting-started.md` opens with raw `npx` and never mentions the agent-led path; non-technical readers get lost. | `docs/getting-started.md` | ✅ Add agent-led callout at top. |

## P2 — build if cheap this run, else defer
| ID | Sev/Eff | Area | Item | Plan |
|----|---------|------|------|------|
| B11 | P2/S | packaging | `CHANGELOG.md` not in `files[]` → not shipped to npm users. | ✅ Add to `files[]`. |
| B12 | P2/S | packaging | `packages/mcp/package.json` engines `>=18` vs root `>=20`. | ✅ Align to `>=20`. |
| B13 | P2/S | packaging | `skills/process-inbox/` missing `LICENSE` (every other skill has one). | ✅ Add (copy sibling). |
| B14 | P2/S | dev-ex | No repo `CLAUDE.md` (architecture map + hard rules for agents). | ✅ Wave 4. |
| B15 | P2/S | dev-ex | CI triggers only on `main`; feature branches get no signal. | ✅ Wave 4 — widen `on:` to `**` (additive). |
| B16 | P2/S | dev-ex | No pre-push test gate. | ✅ Wave 4 — tracked `scripts/hooks/pre-push`, opt-in via `core.hooksPath` (do not force-enable). |

## ⏭ Deferred (listed for human, with effort)
| ID | Sev/Eff | Item | Why deferred |
|----|---------|------|--------------|
| D1 | P2/M | `appendIndexEntry` true-append instead of full read+rewrite under lock (perf at 1000+ sessions). | Interacts with the B5 lock + dedup logic; keep B5 clean/reviewable first. Cheap follow-up. |
| D2 | P3/S | Sub-package versions drift (`@dotaios/cli@1.8.0`, `core@1.7.0`) vs root 1.17.0. | Private, no user impact. Cosmetic. |
| D3 | P3/S | No `exports`/`main` field (`import "dotaios"` fails). | Bin-only package; no consumer imports it. |
| D4 | P3/S | `licenses.mjs:92` "upgrade to Node 20+" msg (fetch is fine on 18). | Cosmetic wording. |
| D5 | P2-P3 | Remaining P2/P3 docs polish (dead links, cross-doc consistency) — see `04-docs-icp.md`. | Lower leverage; batch later. |
| D6 | P3/S | `scripts/release-checklist.mjs` helper. | Nice-to-have; add in Wave 4 if time. |

## ⏭ Pre-existing security items (found by the branch self-review; NOT introduced here)
These were surfaced reviewing the delta but live in code this branch didn't change, so they're left for a follow-up rather than scope-creeping the hardening branch. All are low-to-moderate and assume a prompt-injected local agent.
| ID | Sev/Eff | Item | File | Fix sketch |
|----|---------|------|------|-----------|
| S1 | P2/S | MCP `google_calendar_agenda` pushes raw `args.calendar` after `--calendar`; a value like `--foo` could be option-confused by `gws` (argv injection; no shell). | `mcp/src/server.mjs` (calendar push) | Reject a `calendar` value starting with `-`. |
| S2 | P2/S | MCP `read_context` blocks `..` but follows a symlink inside `context/` out of the folder. | `mcp/src/server.mjs` `safeRelativePath`/readContext | After resolve, assert path stays under `contextDir`. |
| S3 | P3/S | `log_event` caps `data` (10 KB) but not `type`/`summary`/`project`/`domain`/`source`. | `mcp/src/server.mjs` logEvent | Cap those fields (~2 KB). |
| S4 | P3/S | `writeOpenCodeSkillStubs` interpolates `entry.name`/`aiosPath` into stub markdown unsanitized (local markdown prompt-injection via a malicious skill dir name). | `cli/src/commands/connect.mjs` | Strip backticks/newlines from `entry.name`. |
| S5 | P3/S | `assertSafeSubdir` is string-based; add defense-in-depth resolved-path containment check. | `cli/src/commands/install.mjs` | After join, assert resolved path starts with the source root. |

## ❌ Dropped (guardrail / ICP / scope)
- Any semantic/vector/embedding search — explicitly out of scope (KISS + ICP). 
- Index daemon / background watcher for search — owned-infra-ish, over-engineered for personal scale.
- Heavy tooling (husky, eslint/prettier framework, bundler for the site) — friction without clear payoff for a solo non-technical maintainer.
