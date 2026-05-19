# GitHub Sync — Cross-Device Memory via Private Repo

> Status: design approved, ready for implementation plan
> Date: 2026-05-19

## Summary

DotAIOS auto-syncs the local `~/aios/` folder to a private GitHub repo per user. Sync is two-way and invisible. Phone-side agents (Claude.ai Project linked to repo) can read the memory anywhere; phone writes drop into `memory/inbox/`, which the local agent processes next session. Zero hosting infrastructure for DotAIOS.

## Goals

- Memory accessible from anywhere the user has a logged-in Claude / Codex / Cursor / Gemini that supports GitHub repo linking
- Setup is one prompt during `dotaios setup` (Y/n)
- Auth is OAuth device flow (paste a code in a browser) — no token generation, no `gh` CLI requirement
- Daemon runs invisibly; user never has to think about "is sync on?"
- Phone-write path is conflict-free by construction (writes go to inbox, never edit live files)
- Zero new npm dependencies in `packages/core`

## Non-Goals

- Encryption at rest (private repo is the privacy boundary)
- Web reader app (`memory.dotaios.app`) — separate v1.6 feature for free-tier users
- Native mobile app — out of scope
- Conflict-resolution UI — last-write-wins via fast-forward + branch escape hatch

## ICP Alignment

ICP = users we recruit from web chat (claude.ai / ChatGPT / Gemini web) and convert to agentic desktop apps (Claude Code / Codex / Open Code). This feature extends the "OS behind your AI tools" thesis to the phone: the memory follows the user across devices, the agentic apps on desktop write to it, the web/mobile agents read it via native GitHub integrations.

Known gaps (call out in setup output):
- Phone read requires Claude Projects (paid Claude plan today)
- User must have a GitHub account

## Architecture

### Three loops

```
LOCAL (~/aios/)                    GITHUB private repo                  PHONE
─────────────────                  ─────────────────────                ─────
write file
   ↓ (debounce 2s)
push commit ────────────────────►  HEAD updates
                                   ◄── Claude Project reads ─── Claude.ai (paid)
                                   ◄── phone commits ────────── phone agent writes to
                                       memory/inbox/<ts>.md      memory/inbox/
poll every 30s
   ◄──── pull new commits
process memory/inbox/* via skill
delete processed inbox files
   ↓ push deletions
```

**Push loop:** local file change → 2s debounce → `git add . && git commit -m "sync: N files" && git push`
**Pull loop:** every 30s → `git fetch && git pull --ff-only` if remote ahead
**Inbox loop:** local agent reads `memory/inbox/*.md` on session start via `process-inbox` skill

### Auth + repo creation (one-time)

1. User runs `dotaios sync init` (or accepts setup wizard prompt)
2. CLI prints device code, user pastes into `github.com/login/device`, approves DotAIOS GitHub App
3. CLI receives OAuth token, stores in OS keychain via shell-out (`security` mac / `secret-tool` linux / `cmdkey` windows)
4. CLI creates private repo `<github-username>-aios` (or reuses if exists)
5. Initial commit: full `~/aios/` mirror + shipped `.gitignore`
6. Installs daemon via launchd (mac) / systemd --user (linux)

Operational: Filippo registers ONE GitHub App at `github.com/settings/apps` named "DotAIOS Sync." Permissions: `contents: read/write`, `metadata: read`. Every user installs this one app via device flow.

### Sync daemon

Background process, polls only (no fs watcher → no npm deps):

```
loop forever:
  every 2s: scan ~/aios/ mtimes → if any changed, debounce 2s, commit, push
  every 30s: git fetch → if remote ahead, git pull --ff-only
  every 60s: if memory/inbox/*.md exists, log "inbox-pending" event
```

Shells out to `git` binary (already required). No `chokidar`, no `isomorphic-git`.

CLI control:
- `dotaios sync init` — first-time setup (auth, repo, daemon install)
- `dotaios sync start` — start daemon (idempotent)
- `dotaios sync stop` — kill daemon
- `dotaios sync status` — daemon running?, last push, last pull, inbox count, repo URL
- `dotaios sync now` — force one immediate push+pull (foreground)
- `dotaios sync logout` — revoke token, remove daemon, leave repo intact
- `dotaios sync repo` — print repo URL (helper for setting up Claude Project)

### Inbox semantics (phone write path)

Phone-side agent commits to repo:
```
memory/inbox/2026-05-19T14-32-08Z-<slug>.md
─────────────────────────────────────────────
---
source: phone
device: claude-ios
captured_at: 2026-05-19T14:32:08Z
hint: "user wanted this saved as a reference"
---

<raw content>
```

Local DotAIOS daemon pulls → file lands locally → logs `inbox-pending` event.

New skill `skills/process-inbox/SKILL.md` (ships in templates):
1. Read each `memory/inbox/*.md`
2. Route content to vault/raw, wiki, daily, or context update based on `hint` + content
3. `git rm` the inbox file → next push removes from GitHub

New AGENTS.md rule (in `templates/AGENTS.md.hbs`):
> If `memory/inbox/` contains files, read them first and use the `process-inbox` skill to file them into the right vault location, then delete the inbox file.

### Default `.gitignore`

Shipped at `templates/sync-gitignore.template`, written to repo root on `sync init`:

```gitignore
.env
.env.*
*.key
*.pem
connections/*/credentials.json
connections/*/token.json
license/*.json
.DS_Store
memory/.daemon.*
```

9 lines. Covers credential leaks. Anything else is fair game; user edits the file like any other.

### Failure modes

| Failure | Auto-handle |
|---|---|
| Offline | Daemon retries every 30s. Local commits queue locally. |
| Token expired | Daemon stops pushing, logs event, prints "run `dotaios sync init` again" on next CLI call |
| Remote diverged | `git pull --ff-only`. If it fails: (1) `git branch local-<ts>` (preserves local divergent commits as a branch), (2) `git reset --hard origin/main` (aligns local main with remote), (3) log event. User's divergent work is recoverable via the named branch. |
| Push rejected | Treat as remote diverged: pull strategy above, then retry push on next cycle. |
| Inbox file malformed | `process-inbox` skips, logs, leaves for human review |
| Repo deleted on GitHub | Daemon errors, stops. User runs `sync init` to recreate |

All errors → `memory/events.jsonl` as `{type: "sync-error", reason, action}`.

## File Map

| File | Change |
|---|---|
| `packages/cli/src/commands/sync.mjs` | **New** — top-level command dispatcher (`init`/`start`/`stop`/`status`/`now`/`logout`/`repo`) |
| `packages/cli/src/sync/auth.mjs` | **New** — device flow, keychain storage |
| `packages/cli/src/sync/repo.mjs` | **New** — create/check repo, push initial mirror |
| `packages/cli/src/sync/daemon.mjs` | **New** — poll loop, git wrapper, launchd/systemd install |
| `packages/cli/src/sync/git.mjs` | **New** — thin shell-out wrapper around `git` binary |
| `packages/cli/src/index.mjs` | Register `sync` command |
| `packages/cli/src/commands/setup.mjs` | Add "Connect to GitHub for cross-device access? (Y/n)" prompt; on yes, run `sync init` |
| `templates/sync-gitignore.template` | **New** — shipped `.gitignore` |
| `templates/AGENTS.md.hbs` | Add inbox-routing rule under `## Rules` |
| `templates/skills/process-inbox/SKILL.md` | **New** — inbox routing skill |
| `packages/core/src/paths.mjs` | Add `inboxDir()` helper |
| `tests/cli/sync_*.test.mjs` | New — auth flow (stubbed), daemon poll loop (stubbed git), inbox routing |
| `README.md` | New "Cloud sync" section with screenshot/example |

## Acceptance Criteria

- `dotaios setup` on a fresh machine offers GitHub sync; on Y, completes device-flow auth and creates the private repo
- `dotaios sync status` shows daemon running, last push within 60s of last edit
- Editing any file under `~/aios/` results in a GitHub commit within 5s
- Phone-side: user creates a Claude Project linked to their `<user>-aios` repo, asks Claude on phone "what am I working on?" — Claude reads `context/work.md` and answers correctly
- Phone-side: user asks Claude on phone "remember that I met Bob from Acme today" — Claude commits `memory/inbox/<ts>-met-bob-acme.md` — next local Claude Code session, `process-inbox` skill files this into `vault/org/people/bob.md` and the inbox file is deleted from the repo
- All existing 271 tests still pass; new sync tests added

## Open Questions (resolve during planning)

1. **Daemon survives reboot?** Default install launchd/systemd, or default foreground only with `--install-service` flag for opt-in? (Lean: default install, hidden behind one yes/no.)
2. **First-time push of a large vault** (~50MB) — show progress bar or silent? (Lean: silent with `dotaios sync status` available to check.)
3. **GitHub App rate limits** — device flow has rate limits; what's the per-user push frequency cap? (Probably non-issue at 2s debounce for personal use, but worth noting.)
