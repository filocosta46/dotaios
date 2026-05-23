# Onboarding Funnel — Agent-Carried Onboarding

> Status: **design approved** — Option 2 of the options memo, 2026-05-22
> Date: 2026-05-22
> Branch: `feat/onboarding-funnel`
> Plan: `docs/superpowers/plans/2026-05-22-onboarding-funnel.md`

## Problem

The ICP is a non-technical daily AI user who lives in web chat (claude.ai, ChatGPT)
and re-explains themselves every conversation. To onboard to DotAIOS today they face
four walls: (1) install an agentic desktop app, (2) open a terminal — the README has
to explain "this is not a chat window", (3) have Node.js 20, (4) run `npx dotaios
setup`. A business audit's finding: "the only people who can install DotAIOS unaided
are the people who don't need the hand-holding."

The funnel is also currently **broken**, not merely stale:

- The live site's primary hero CTA reads *"paste this into any AI chat → Ask Claude
  Code: …"*. The ICP is in web chat and has no Claude Code; web chat cannot run
  `npx`. The CTA points the exact target user at a tool they do not have.
- The version pill says `v0.3`; the package is at `1.14.6`.
- The hero claims "no sync, no server" — false since GitHub cross-device sync shipped.
- Shipped features — GitHub sync, Lightpanda web-fetch / Universal Knowledge Router,
  session capture — are invisible on the site.
- Two onboarding scripts diverge: `README.md` / `docs/friend-setup.md` push
  interactive `npx dotaios setup`; `INSTALL.md` (the agent path) uses `init --yes` +
  a conversational interview. The agent and the human are routed through different
  doors.

## The reframe

Walls 2–4 are not walls the *user* climbs. Once one agentic app is installed, the
agent inside it opens the terminal, installs Node, and runs setup — the user types
nothing. The four walls collapse to **one: install a single agentic desktop app**,
and that one is a normal signed app download owned by Anthropic / OpenAI / Google,
not by DotAIOS.

The funnel, end to end:

```
web-chat user → dotaios.vercel.app → installs one agent app → pastes one line →
agent reads the GitHub repo → follows INSTALL.md → DotAIOS folder exists, tools connected
```

The design touches three surfaces — the website, the handoff, the in-IDE script — as
one piece.

## Constraints (carried from the mission)

KISS — the fix is itself subject to KISS. No servers or infrastructure DotAIOS owns
and babysits (the Vercel static site is fine; it must not grow a backend).
Zero-dependency core, agent-agnostic, open-source and free.

Rejected on KISS: native `.dmg`/`.msi` installers — code-signing, macOS
notarization, per-OS CI are owned release infrastructure, and the installer still
needs an agent app + Node to be useful, so it does not even remove wall 1. The
unsigned Windows MSI source in `installers/windows/` is a dead path; this design
recommends archiving it.

## The four decisions (settled with Filippo)

1. **Front door = the agentic app carries it in.** The website's job is to get the
   user to install one agent app; the agent does Node + setup.
2. **Ubiquity is a headline selling point.** The site lists every agent it can
   (Claude Code, Codex, Cursor, Gemini, Antigravity, …) and sells "works with all of
   them." It still gives a clear easiest-default for the install action, because a
   non-technical user needs one concrete next step.
3. **Handoff target = the GitHub repo.** The paste line points the agent at
   `github.com/filocosta46/dotaios`; the agent follows `INSTALL.md`.
4. **In-IDE flow = docs-only polish now; an `--agent` CLI mode is a documented
   follow-up, not built this session.**

## Design

### Part A — Website refresh (`website/`)

The site is a static React 18 + Babel-standalone-in-browser SPA (`index.html`,
`app.jsx`, `graph.jsx`, `marketplace.jsx`, `tweaks-panel.jsx`, `plugins.js`,
`styles.css`). **This design edits content and structure within that setup; it does
not rebuild the site** (see Non-goals).

- **A1 — Install path, the funnel fix.** Replace the single hero "install" box with
  an explicit two-move path. *Have an agent app?* — present the ubiquity story:
  DotAIOS works with any agent that reads `AGENTS.md`; list them. For a user with
  none installed, give one clearly-marked easiest default (Claude Code desktop —
  signed, Mac/Windows) with a download link. The other agents stay visible
  alternatives, not buried. *Then paste this line* — one agent-neutral line (Part
  B). The "Ask Claude Code" wording is removed; the line works regardless of which
  agent the user installed. The `npx dotaios setup` command-line route stays as a
  clearly-secondary option for terminal-comfortable users.
- **A2 — Version pill.** Remove the rot-prone hardcoded `v0.3`. Do not replace it
  with another hardcoded number — use a non-versioned label or drop the pill. A
  pill that must be hand-updated every release is a maintenance trap.
- **A3 — "No sync, no server" claim.** Reword the hero-meta. Accurate framing: no
  DotAIOS-run server, no account; cross-device sync is opt-in and runs on the
  *user's own* GitHub. Exact copy in the plan.
- **A4 — Feature coverage.** Add concise coverage of shipped features absent from
  the site: cross-device GitHub sync, Lightpanda web-fetch / Universal Knowledge
  Router, session capture. One compact section or folded into existing sections —
  KISS, no sprawl.
- **A5 — "Four tools" → ubiquity.** The hero-meta strip ("Four tools — Claude ·
  Cursor · Codex · Gemini") and HowItWorks Step 02 are reframed to the ubiquity
  selling point: any agent that reads `AGENTS.md`.
- **A6 — Constants + copy.** `INSTALL_SNIPPET` / `NPX_SNIPPET` in `app.jsx` updated
  to match Part B. HowItWorks copy and the skill list refreshed to match the
  current `README.md`.

### Part B — The handoff (the paste line)

One agent-neutral line, pointing at the repo and naming `INSTALL.md` so the agent
lands on the doc written for it — not the README, then a nested prompt. Working
draft:

> *"Read https://github.com/filocosta46/dotaios — open INSTALL.md and set up
> DotAIOS for me, following every step."*

It is agent-neutral (no "Claude Code"), single-hop (names `INSTALL.md` directly),
and carries no Node logic — that lives in `INSTALL.md` (Part C), so the line stays
short. Final wording is fixed in the plan. The same line appears identically on the
website and in `README.md`.

### Part C — In-IDE onboarding: `INSTALL.md` as the one canonical agent script

`INSTALL.md` becomes the single source of truth for agent-driven setup. Rewrite:

- **C1 — Node, the agent installs it.** Today Step 1, on a missing or old Node,
  tells the agent to tell the *user* to visit nodejs.org and wait — re-introducing a
  wall. New: the agent installs Node itself — `brew install node` on Mac when
  Homebrew is present, `winget install OpenJS.NodeJS.LTS` on Windows, nvm on Linux —
  and falls back to directing the user to nodejs.org only when automated install is
  not possible. The user types nothing.
- **C2 — One scaffold path.** Keep `npx dotaios init --yes` (placeholder scaffold) +
  `npx dotaios activate`. The agent does **not** run interactive `npx dotaios
  setup` — that command's TTY prompts are the human-terminal path, not the agent
  path.
- **C3 — One interview.** The agent runs the lean conversational interview (name +
  role, current work, priorities) and writes `context/identity.md`, `work.md`,
  `priorities.md` directly. This is the *only* interview on the agent path; `init`'s
  built-in 5-question interview is bypassed by `--yes`. The small mismatch (`init`
  also asks for AI tools; the agent path does not) is resolved in favor of the lean
  three: `activate` auto-connects detected tools, so the question is unnecessary.
- **C4 — Defer the extras.** GitHub sync, daily brief, and session capture are
  *not* set up during first run. `INSTALL.md`'s closing step lists them as optional
  later steps, one command each, and explicitly says not to run them now. First run
  stays minimal.
- **C5 — Reconcile the other docs.** `README.md` and `docs/friend-setup.md` are
  updated so they no longer send an agent down the interactive-`setup` door. The
  human-terminal path (`npx dotaios setup`) stays documented for users who genuinely
  use a terminal, but the agent path is `INSTALL.md` and only `INSTALL.md`. README's
  existing "Installing with AI help" block is simplified to the Part B paste line
  (Node logic now lives in `INSTALL.md`).

### Part D — `--agent` CLI mode (documented follow-up — NOT built)

A future `npx dotaios setup --agent` (or non-TTY auto-detect): runs init + activate
quietly with sane defaults, skips interactive prompts, and prints machine-readable
next-steps for the agent to narrate. It would collapse Part C's multi-step script
into one command and harden the flow against agent web-fetch flakiness. **Out of
scope for this session — CLI feature code.** The spec records it so the idea is not
lost; the implementation plan does not include it.

## Out of scope / non-goals

- Native installers (`.dmg`/`.msi`); the `installers/windows/` source is
  recommended for archival.
- Rebuilding the website off Babel-in-browser onto a build pipeline — it works
  today; not this session's job.
- Any CLI feature code, including `--agent` mode (Part D).
- Web-chat-only "no install" onboarding — rejected; the one app install is the
  accepted irreducible wall.
- The GitHub-sync feature branch — not touched.
- Deploying to Vercel production — preview deploys only, and only on Filippo's
  explicit go.

## Accepted irreducible wall

A web-chat-only user cannot bootstrap with zero installs — the folder needs an agent
or the CLI to create it. The website's narrative job is to make that one install
obviously worth it ("stop re-explaining yourself in every chat"). This is accepted,
not solved.

## Risks / open questions

- **Agent web-fetch reliability.** If the agent cannot fetch the public repo, the
  handoff stalls. Mitigation: the paste line is plain English, the repo is public,
  `INSTALL.md` is short. The Part D `--agent` self-contained route would harden
  this — a reason it is the documented follow-up.
- **Node install needs shell access + permission.** Claude Code, Codex, and Cursor
  have shell access; acceptable. An agent without shell access cannot complete
  setup — out of the funnel's reach.
- **Easiest-default agent.** The "if you have nothing, install this" recommendation
  needs a current, genuinely non-technical-friendly, signed download — Claude Code
  desktop (Mac/Windows). The plan verifies the live download URL.
- **No-build website.** Editing JSX in a Babel-in-browser setup has no compiler to
  catch errors; changes are verified by opening the site locally and via a Vercel
  preview deploy.

## Acceptance criteria

- A non-technical visitor to dotaios.vercel.app can tell, without prior knowledge:
  what DotAIOS is, that they need one agent app and which one is easiest, and the
  single line to paste.
- The paste line contains no tool-specific assumption ("Claude Code") and is
  identical on the website and in `README.md`.
- No false or stale claims on the site: the version pill is not a rot-prone number;
  the sync/server wording is accurate; sync, web-fetch, and session capture are
  represented.
- `INSTALL.md` is a single, self-contained agent script: the agent installs Node,
  scaffolds, activates, runs one lean interview, and defers sync/brief/capture —
  with the user typing zero terminal commands.
- `README.md` and `docs/friend-setup.md` no longer instruct an agent to run
  interactive `npx dotaios setup`; the agent path and the human path are clearly
  separated and do not contradict each other.
- No CLI code changed; no production deploy; the GitHub-sync branch untouched.
