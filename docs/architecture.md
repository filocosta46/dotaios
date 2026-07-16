# Architecture

DotAIOS is a local file convention.

## Activation

`~/aios/` is the source of truth, but most agents do not automatically scan that folder. `dotaios activate` writes small bridge files into the global locations each tool already reads:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md`
- Gemini CLI: `~/.gemini/GEMINI.md`

`dotaios attach <project>` writes project-level bridges, including `.cursor/rules/dotaios.mdc` for Cursor. If the checkout owns a `skills/` directory, it also links those project skills into the explicit project-native targets declared in `packages/core/src/agents.json`. The global `~/aios/skills` surface is not replaced or copied into the project. Existing unmanaged files are preserved unless the user passes `--overwrite`.

## Context

`context/` is loaded every session. It describes identity, active work, priorities, long-term direction, and domain-specific modes.

## Projects

`projects/` is the durable catalog of work the user owns. Each project keeps a small synced README with its stable ID, status, domain, repository URL, decisions, and next steps. The actual source repository stays outside `~/aios` and keeps its own Git history.

Local checkout paths are machine-specific and must not be committed to the AIOS mirror. A new machine can read the project catalog before the repository is cloned, then reconnect the local checkout without changing the durable project record.

## Memory

`memory/` is operational state. Agents should load only recent entries:

- last 50 `events.jsonl` entries
- today and yesterday from `signals/`
- `errors.jsonl` only when debugging

**Daily notes** live in `memory/daily/YYYY-MM-DD.md`. `dotaios brief` writes the deterministic `## Brief` section. The `/today` skill writes today's plan (focus, plan, frog). The `/closeday` skill fills the close-out section (done, carry-over, reflection) and stages carry-overs into the next day's note. Daily notes are operational memory, not long-term knowledge, they belong in `memory/`, not `vault/`.

**Session memory** lives in `memory/sessions/<date>/<timestamp>_<agent>_<id>.md`. Each file is agent-neutral Markdown with YAML frontmatter (`agent`, `session_id`, `captured_at`, `project`, `title`, `turns`). `memory/sessions/index.jsonl` is a lightweight catalog enabling fast search and deduplication. Sessions are captured via `dotaios capture enable <agent>` (auto-save) or `dotaios capture import` (manual/backfill). Agents should not load sessions in bulk, use `dotaios search` to surface relevant ones on demand.

Captured text is evidence, not automatically durable knowledge. Promotion to `context/`, a project, `vault/`, or a skill is explicit, previewed, and recorded in `memory/events.jsonl`. Signals remain short-lived operational hints.

`dotaios brief --compact` owns the default working-context selection policy.
It uses a visible 6,000-character budget, applies the same project filter to
sessions, signals, and events, and marks when the budget is reached. The optional
MCP `read_working_context` tool calls the same core projection rather than selecting a
different memory window.

## Vault

`vault/` is long-term knowledge, loaded on demand. Users may keep it inside `~/aios/vault` or configure an external `vault_path` in `aios.json`, such as an Obsidian vault.

Company and people profiles live only in `vault/org/`. Access frequency is routing logic, not a reason to duplicate storage.

## Skills And Plugins

Skills are markdown instruction sets that any agent can read. Plugins may include code, but must declare permissions in `manifest.json`.

There are two skill scopes. AIOS skills are authored in `~/aios/skills` and
propagated globally. Project skills are authored in `<project>/skills` and
propagated only inside that checkout by `dotaios attach`. Both scopes use the
same `SKILL.md` contract; the registry declares their native targets. Symlinks,
Hermes external directories, dry-runs, idempotency, and preservation of foreign
entries are tested at the CLI seam. Native client discovery and invocation are
not inferred from a successful filesystem check and require separate acceptance
evidence.

Plugins are trusted local folders. Permission declarations are visible to users but are not sandbox enforcement. Remote/plugin marketplace installs are intentionally out of scope until provenance and stronger install controls exist.

## Schedules

`schedules.yml` is a local registry of schedules. `dotaios schedule list`, `dotaios schedule due`, `dotaios schedule run-due`, and `dotaios schedule run <name>` do not create a DotAIOS daemon or cloud workflow. Schedules only run DotAIOS commands.

`dotaios schedule install --dry-run --target launchd|cron|task-scheduler` prints an OS scheduler handoff. A real local install requires explicit `--yes` and does not run arbitrary commands.
