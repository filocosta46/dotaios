# GitHub Sync v3 — Lean Cross-Device Memory

> Status: **v3 design approved** — supersedes v1 + v2 of `2026-05-19-github-sync-design.md`
> Date: 2026-05-21
> Branch: `worktree-feat+github-sync`
> Plan: `docs/superpowers/plans/2026-05-21-github-sync-v3.md`

## Why v3

v2 was built (tasks 1–16, ~340 tests green) and produced a working one-way mirror.
But it carried two pieces of infrastructure DotAIOS would have to own and babysit
forever — violating the hard constraint "no servers, no fragile infrastructure
DotAIOS owns":

- **A custom GitHub App** — registration, app verification (privacy-policy URL +
  homepage, or every user sees an "unverified app" banner), a single point of
  failure for every user at once, and an unhandled 8-hour device-flow token
  expiry that would silently kill sync.
- **A 3-platform background daemon** (launchd / systemd / schtasks). Its only
  unique job — pulling while the machine is idle — has no user value, because
  nobody reads the memory while the machine is idle. It is also the most
  OS-fragile part of the feature.

v3 cuts both. Same outcome — folder mirrors to a private repo, phone reads and
writes it — with less code and zero infrastructure DotAIOS owns.

Governing principle: **KISS.** Simplest thing that works. Any mechanism that does
not uniquely earn its place is cut.

## What stays from v2 (the keep-list)

`sync-config.mjs`, the sync-config + inbox path helpers, the `git.mjs` wrapper,
`repo.mjs` (deep-link repo create + initial mirror push), the `tick.mjs` lock +
10-second rate-gap, the four `*-cmd.mjs` files + the `sync` dispatcher,
`sync-hook.mjs`, the `.gitignore` template, and the `dotaios setup` wizard prompt.

## The three v3 decisions

### 1. Auth — classic `repo`-scope Personal Access Token, not a GitHub App

Setup opens a pre-filled `github.com/settings/tokens/new?scopes=repo&description=...`
link. The user clicks "Generate token", copies it, pastes it into the CLI. The CLI
validates the token with `GET /user` and stores it `0600` at `~/.dotaios/sync.json`
exactly as today.

This removes: the GitHub App, app verification, the privacy-policy obligation, the
single point of failure, the device-flow token-expiry bug, and the
placeholder-client-id hard-fail.

Tradeoff: a classic `repo` token can touch **all** of the user's repositories, not
only the `<name>-aios` one. The token never leaves the machine (stored `0600`).
v3 accepts this for setup simplicity; the README states it plainly. Fine-grained
per-repo tokens are a future hardening, not v1.

### 2. Tick order — commit local → `pull --rebase` → push

v2's tick pulled first (which breaks rebase on a dirty tree) and treated **any**
divergence as an emergency: it parked local commits on an orphan `local-<ts>`
branch and `git reset --hard origin/main` — silently discarding a desktop edit a
non-technical user would never recover.

v3 tick: **stage + commit local changes first, then `git pull --rebase`, then
push.** With the inbox pattern (phone writes only ever *add* new files under
`memory/inbox/`; desktop writes touch everything else), rebasing disjoint-file
commits always succeeds non-interactively. The branch-and-reset survives **only**
as the fallback when a rebase hits a genuine same-file conflict — never the
default path.

### 3. Sync trigger — agent-agnostic, no per-vendor hook

No daemon, no Claude Code hook. Two universal mechanisms:

- **(a)** `sync-hook.mjs` (already built) fires `dotaios sync tick` after every
  `dotaios` command — works regardless of which agent invoked it.
- **(b)** A rule added to `templates/AGENTS.md.hbs` instructing every agent to run
  `dotaios sync tick` at session start and before finishing. `AGENTS.md` is read
  by Claude Code, Codex, Cursor and Gemini alike — it is the universal layer, so
  one rule reaches every agent with zero per-vendor code.

Tradeoff accepted: a file edited in a raw text editor with no `dotaios` command
and no agent session will not sync until the next one runs. For an ICP whose
workflow *is* the agentic desktop app, this is acceptable — the next session
catches it up.

## Phone-write path (inbox) — finish what v2 left unbuilt

v2 never built the phone-write half. v3 completes the two-way design:

- `packages/cli/src/sync/inbox.mjs` — `listInbox()` / `clearInbox()` helpers.
- `templates/skills/process-inbox/SKILL.md` — instructs the local agent to read
  each `memory/inbox/*.md`, route its content into the right `vault/` or
  `context/` location, then `git rm` the inbox file.
- `templates/AGENTS.md.hbs` — an inbox-routing rule under `## Rules`.

## Architecture (v3)

```
LOCAL ~/aios/                          GitHub private repo                 PHONE
─────────────                          ───────────────────                ─────
edit file
  │  (next tick: commit → pull --rebase → push)
  └────────────────────────────────►   HEAD updates
                                       ◄── Claude Project / Codex / GitHub Mobile read
                                       ◄── phone agent writes
                                           memory/inbox/<ts>-<slug>.md
next desktop session:
  process-inbox skill files inbox/* into vault, git rm, push
```

Tick fires from: every `dotaios` command (`sync-hook.mjs`) + every agent session
start/end (`AGENTS.md` rule). No background daemon.

## Out of scope (unchanged)

Encryption at rest, web reader app, native mobile app, conflict-resolution UI,
fine-grained per-repo token (future hardening).

## Acceptance criteria

- `dotaios sync setup` opens the token link, accepts a pasted PAT, validates it,
  drives repo creation via the deep-link, pushes the initial mirror, prints phone
  instructions — and exits `0`.
- The `dotaios setup` wizard offering sync no longer exits `1` on success.
- Editing a file then running any `dotaios` command produces a GitHub commit.
- Two devices committing disjoint files (a desktop edit + a phone inbox file)
  reconcile via rebase — no orphan branch, no conflict markers shown.
- A phone writes `memory/inbox/<ts>.md`; on the next desktop session the
  `process-inbox` skill files it into the vault and removes the inbox file.
- The full test suite passes; heartbeat tests removed; auth / tick / setup tests
  rewritten.
