# Architecture

DotAIOS is a local file convention.

## Activation

`~/aios/` is the source of truth, but most agents do not automatically scan that folder. `dotaios activate` writes small bridge files into the global locations each tool already reads:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md`
- Gemini CLI: `~/.gemini/GEMINI.md`

`dotaios attach <project>` writes project-level bridges, including `.cursor/rules/dotaios.mdc` for Cursor. Existing unmanaged files are preserved unless the user passes `--overwrite`.

## Context

`context/` is loaded every session. It describes identity, active work, priorities, long-term direction, and domain-specific modes.

## Memory

`memory/` is operational state. Agents should load only recent entries:

- last 50 `events.jsonl` entries
- today and yesterday from `signals/`
- `errors.jsonl` only when debugging

**Daily notes** live in `memory/daily/YYYY-MM-DD.md`. The `/today` skill writes today's note (focus, plan, frog). The `/closeday` skill fills the close-out section (done, carry-over, reflection) and stages carry-overs into the next day's note. Daily notes are operational memory, not long-term knowledge — they belong in `memory/`, not `vault/`.

## Vault

`vault/` is long-term knowledge, loaded on demand. Users may keep it inside `~/aios/vault` or configure an external `vault_path` in `aios.json`, such as an Obsidian vault.

Company and people profiles live only in `vault/org/`. Access frequency is routing logic, not a reason to duplicate storage.

## Skills And Plugins

Skills are markdown instruction sets that any agent can read. Plugins may include code, but must declare permissions in `manifest.json`.

Plugins are trusted local folders. Permission declarations are visible to users but are not sandbox enforcement. Remote/plugin marketplace installs are intentionally out of scope until provenance and stronger install controls exist.

## Schedules

`schedules.yml` is a local registry of schedules. `dotaios schedule list`, `dotaios schedule due`, `dotaios schedule run-due`, and `dotaios schedule run <name>` do not create a DotAIOS daemon or cloud workflow. Schedules only run DotAIOS commands.

`dotaios schedule install --dry-run --target launchd|cron|task-scheduler` prints an OS scheduler handoff. A real local install requires explicit `--yes` and does not run arbitrary commands.
