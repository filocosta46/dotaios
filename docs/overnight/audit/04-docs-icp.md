# Docs & ICP-Alignment Audit — v1.17.0
**Branch:** audit/overnight-2026-05-28  
**Date:** 2026-05-29  
**Auditor:** overnight subagent  
**Scope:** README.md, INSTALL.md, CHANGELOG.md, CONTRIBUTING.md, docs/*.md

---

## Findings Table

| # | Severity | Effort | File:Section | Finding | Fix Sketch |
|---|---|---|---|---|---|
| 1 | **P0** | S | CHANGELOG.md | v1.15.0 entry is completely absent. A git tag `v1.15.0` ("agent-carried onboarding") exists and introduced the primary ICP feature (INSTALL.md + paste-one-sentence flow), but the CHANGELOG jumps from 1.16.0 straight to 1.14.0. | Add `## [1.15.0] - 2026-05-23` entry covering agent-carried onboarding, INSTALL.md authorship, and the README rewrite. |
| 2 | **P0** | S | README.md:Commands table | `dotaios search` description omits **sessions** scope (added 1.14.0): "Searches across memory, vault, context, projects, skills, references, and plugins" — `sessions` is missing. Also missing from table: `dotaios connect gemini` and `dotaios connect opencode` (both shipped in 1.17.0). | Add sessions to search description; add two rows for `connect gemini` and `connect opencode`. |
| 3 | **P0** | S | docs/mcp.md:Tools | MCP tool list is stale post-1.17.0: `read_session_digest` and `list_skills` are both implemented in `packages/mcp/src/server.mjs` but not documented. Users and agents querying the docs cannot discover the primary 1.17.0 cross-agent continuity feature. | Add bullet entries: `read_session_digest` — compact working-memory digest for session start; `list_skills` — list installed skills. |
| 4 | **P1** | S | README.md:What's inside folder tree | `north star.md` (with space, line 160) should be `north-star.md` (hyphen). Actual template is `templates/context/north-star.md.hbs`. A user who looks for the file will not find it by the displayed name on macOS. | Change `north star.md` to `north-star.md` in the folder tree. |
| 5 | **P1** | S | README.md:Commands table | `dotaios setup` is described as "One-shot: init + activate + reveal (best for first-time users)" but `setup.mjs` does significantly more: it prompts for GitHub sync, daily brief schedule, session memory auto-save, and downloads Lightpanda. The description undersells the command and creates a surprise experience. | Describe setup as: "Full onboarding wizard: creates folder, connects tools, opens it, and asks about sync, daily brief, and session saving." |
| 6 | **P1** | M | docs/adapters.md | Entirely missing 1.17.0 content: `dotaios connect gemini` now installs a SessionStart hook that auto-injects context at every Gemini session — this changes Gemini's capability level from "paste/import only" to "session-start auto-inject." OpenCode is also new. | Add Gemini hook section ("auto-inject via SessionStart hook — enable with `dotaios connect gemini`"); add OpenCode section. |
| 7 | **P1** | M | docs/getting-started.md | Starts directly with `npx dotaios init / npx dotaios activate` — two raw terminal commands with no mention of the agent-led onboarding path at all. For the ICP (non-technical users), this is the wrong entry point. The README correctly leads with "paste one sentence into your agent," but getting-started.md contradicts that framing entirely. [ICP-RISK] | Add a one-paragraph callout at the top: "If you have an AI agent open, see INSTALL.md — paste one sentence and the agent does everything below for you." Keep the CLI path for power users beneath it. |
| 8 | **P1** | S | docs/beta-testing.md:line 3 | The guide opens with "This guide covers onboarding terminal-comfortable testers" and the Beta Script goes straight to `npx dotaios setup`. The ICP is non-technical users; this doc defines a contradicting audience and could anchor internal thinking in the wrong direction. [ICP-RISK] | Reframe opening: distinguish two beta tracks — (A) agent-led / non-technical (paste INSTALL.md sentence) and (B) terminal-comfortable testers. |
| 9 | **P1** | S | docs/mcp.md (entire) | Zero mention of `dotaios brief --compact` which is the primary way `read_session_digest` is populated and which enables the 1.17.0 cross-agent continuity story. No doc connects the dots for agents or users: "run brief --compact to feed the session digest." | Add a "Session Digest" section: brief --compact produces the digest; read_session_digest reads it; agents should call it at session start. |
| 10 | **P2** | S | README.md:Skills table | `process-inbox` skill is installed by `init` (listed in `skills/_registry.json`) and ships in `skills/process-inbox/` but is absent from the README skills table. It is mentioned in the phone-sync prose (line 125) but not in the discoverable skill list. | Add row: `process-inbox` — files inbox notes from phone/remote agents into the right context folders. |
| 11 | **P2** | S | CHANGELOG.md:version gaps | Versions 1.15.x (see finding #1), 1.3.x, and 1.1.x are absent. While older gaps may be intentional, 1.15 is a tagged release less than a week before the audit version. | At minimum add 1.15.0; for 1.3 and 1.1, add placeholder entries or a note if they were internal-only. |
| 12 | **P2** | S | README.md:folder tree | Folder tree shows `CLAUDE.md ← Claude Code entrypoint` inside `~/aios/`, which is technically correct (it exists there) but potentially misleading. The *actual* Claude Code entrypoint DotAIOS manages is `~/.claude/CLAUDE.md` (outside `~/aios/`). The in-folder `CLAUDE.md` is a local copy/pointer. Non-technical users might edit the wrong file. | Add a one-line parenthetical: "Claude Code reads this via `~/.claude/CLAUDE.md` — created by `dotaios activate`." |
| 13 | **P2** | S | INSTALL.md:Step 5 optional extras | Mentions `npx dotaios schedule install --dry-run` but the actual command requires a `--target` flag (`launchd`, `cron`, or `task-scheduler`) to produce useful output. Without `--target`, the command is incomplete. [ICP-RISK] | Change to: `npx dotaios schedule install --dry-run --target launchd` (Mac) and add brief note for Windows (`task-scheduler`). |
| 14 | **P2** | M | docs/adapters.md | Codex session-capture capability is not documented. The doc covers Claude Code, Gemini, and Cursor, but Codex is listed as a supported tool everywhere else. Users with Codex don't know what to expect. | Add Codex section: "paste/import only — Codex does not store transcripts in a format DotAIOS can read automatically." |
| 15 | **P3** | S | CONTRIBUTING.md | Only 5 lines; missing any mention of the conventional commit style used throughout git history (`fix:`, `feat:`, `chore:`), the `pnpm` requirement, or the smoke test (`pnpm smoke`). A new contributor following CONTRIBUTING.md would not know about the smoke test. | Add: "Use conventional commits (`feat:`, `fix:`, `chore:`). Run `pnpm smoke` before pushing." |
| 16 | **P3** | S | docs/schedules.md | References `dotaios schedule doctor` and `dotaios schedule install --target` but gives no example of actually enabling the daily brief on macOS end-to-end. For non-technical users who want the morning brief to run automatically, there's no usable recipe. [ICP-RISK] | Add a 3-line macOS recipe: `npx dotaios schedule install --dry-run --target launchd` → review output → `npx dotaios schedule install --target launchd --yes`. |
| 17 | **P3** | S | README.md:Prefer the terminal section | Comment "The agent-led path asks 3 quick questions; the terminal `init` asks 5" is accurate (confirmed: init.mjs `promptAnswers()` has exactly 5 `ask()` calls). However the agent-led INSTALL.md path does ask 3 conversational questions (identity, work, priorities) — the "ai_tools" question is skipped. This is correct but could be called out more clearly for users choosing between paths. | No change required — accurate as written. |

---

## ICP Onboarding Walkthrough

**Persona:** Alex, a non-technical founder. Has Claude Code installed. Never opened a terminal voluntarily.

### Step 1 — Discovery

Alex lands on the README. The headline ("One folder on your computer. Every AI agent reads from it.") is clear and resonant. The "What it is" section immediately names Claude Code as the first tool. So far, so good.

**Potential stumble:** The "Before you start" section lists four AI apps to install. A non-technical user may not know whether they "have" any of these or what the difference is. Claude Code link goes to claude.com/download which is fine. The list does its job.

### Step 2 — The "install in 60 seconds" path

Alex reads "You will not type a single terminal command. Your AI agent does the whole install for you." This is the right promise for the ICP.

Alex opens Claude Code and pastes: `Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.`

Claude Code fetches INSTALL.md. INSTALL.md is well-structured and written for agents, not humans — which is exactly right. The agent handles Node.js install if missing, runs `npx dotaios init --yes`, then `npx dotaios activate`, then asks the three questions one at a time.

**No stumble here** — this is the strongest part of the docs.

### Step 3 — What happens next

INSTALL.md Step 5 shows Alex a list of what they now have, including skills. The briefing script is warm and natural. Alex is told about `npx dotaios brief`, sync, and capture as optional extras. Good.

**Stumble:** If Alex wants to set up a daily brief to run automatically, INSTALL.md mentions `npx dotaios schedule install --dry-run` with no `--target`. If Alex (or their agent) actually runs this, the output is unhelpful without the target flag. Finding #13.

### Step 4 — Curiosity → Getting Started doc

Alex clicks "getting-started" in the README "More docs" links. The doc immediately hits them with:

```
npx dotaios init
npx dotaios activate
```

No mention of the agent-led path. Alex thinks: "But I just told the AI to do this — do I need to do it again?" This is disorienting. **Finding #7.**

### Step 5 — Search

Alex asks Claude Code: "What am I working on?" — works correctly. Later Alex asks: "Search for our launch discussion." The search uses term-frequency matching (not semantic), which is accurate per the CHANGELOG. However no doc mentions this caveat, so if search fails to find something Alex said, they won't know to try different keywords.

### Step 6 — Context changes

Alex's priorities shift. INSTALL.md tells them to say "`npx dotaios interview --review` when things shift." This is correct. The command exists, flags are accurate.

### Overall verdict

**A non-technical user following the README's primary path (paste one sentence into Claude Code) would succeed.** The agent-led onboarding in INSTALL.md is accurate, warm, and well-tested. 

**Where they'd get stuck:**
1. If they click into `getting-started.md` for more context, the terminal-first framing contradicts the "no terminal needed" promise (Finding #7).
2. If they want the daily brief automated, no complete recipe exists (Finding #13, #16).
3. If they try to use Gemini deeply, `dotaios connect gemini` is nowhere in the docs they can find (Finding #2, #6).
4. If they use the MCP server (agent or power user), `read_session_digest` is invisible (Finding #3, #9).

---

## Version Consistency

| Source | Version |
|---|---|
| `package.json` | 1.17.0 |
| CHANGELOG.md top entry | 1.17.0 ✓ |
| README npm badge | dynamic (npm shield — always current) ✓ |
| Git tag latest | v1.17.0 ✓ |
| CHANGELOG gap | **1.15.0 missing** ✗ |

---

## Dead / Stale References

| File | Reference | Status |
|---|---|---|
| CHANGELOG.md | `docs/superpowers/` (line about removed docs) | Correctly noted as removed — no live link |
| README.md "More docs" | All 7 links | All exist ✓ |
| `package.json` "files" | All 20 entries | All exist ✓ |
| INSTALL.md | `https://github.com/filocosta46/dotaios` | Matches package.json repo URL ✓ |
| README.md | `memory-backend` reference | Not present — correctly removed ✓ |
| docs/pilot/ | Not in package.json files, not in public docs | Internal only — correct ✓ |
