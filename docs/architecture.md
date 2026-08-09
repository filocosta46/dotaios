# Architecture

DotAIOS is a local file convention.

## Activation

`~/aios/` is the source of truth, but most agents do not automatically scan that folder. `dotaios activate` writes small bridge files into the global locations each tool already reads:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md`
- Gemini CLI: `~/.gemini/GEMINI.md`

`dotaios attach <project>` writes the shared project-level `AGENTS.md` bridge. Cursor reads that root file directly, so DotAIOS does not add a duplicate always-applied Cursor rule. A managed legacy `.cursor/rules/dotaios.mdc` is removed during attachment; unmanaged files are preserved. If the checkout owns a `skills/` directory, DotAIOS also links those project skills into the explicit project-native targets declared in `packages/core/src/agents.json`. The global `~/aios/skills` surface is not replaced or copied into the project. Existing unmanaged files are preserved unless the user passes `--overwrite`.

## Context

`context/` is the durable source for identity, active work, priorities, long-term direction, and domain-specific modes. Managed bridges point supported hosts to it, but a configured path does not prove that every client session loaded it.

## Projects

`projects/` is the durable catalog of work the user owns. Each project keeps a
small synced README with its stable ID, status, domain, repository URL,
decisions, and next steps. A managed checkout may live at
`workspaces/<slug>/`, inside the AIOS folder but outside its Git mirror. External
checkouts remain supported. Every checkout keeps its own Git history.

Local checkout paths are machine-specific and must not be committed to the
AIOS mirror. A new machine can read the project catalog, run
`dotaios project restore`, and recreate committed project state without
changing the durable record. The sync boundary rejects every outer-index entry
under `workspaces/`, unregistered or partial workspaces, remote mismatches, and
other nested repositories. See [ADR 0002](adr/0002-managed-project-workspaces.md).

## Memory

`memory/` is operational state. Agents should not preload `events.jsonl`,
`signals/`, or `sessions/` directly. Those stores enter startup context only
through the canonical bounded projection. `errors.jsonl` remains opt-in when
debugging.

**Daily notes** live in `memory/daily/YYYY-MM-DD.md`. `dotaios brief` writes the deterministic `## Brief` section. The `/today` skill writes today's plan (focus, plan, frog). The `/closeday` skill fills the close-out section (done, carry-over, reflection) and stages carry-overs into the next day's note. Daily notes are operational memory, not long-term knowledge, they belong in `memory/`, not `vault/`.

**Session memory** lives in `memory/sessions/<date>/<timestamp>_<agent>_<id>.md`. Each file is agent-neutral Markdown with YAML frontmatter (`agent`, `session_id`, `captured_at`, `project`, `title`, `turns`). `memory/sessions/index.jsonl` is a lightweight catalog enabling fast search and deduplication. Sessions are captured via `dotaios capture enable <agent>` (auto-save) or `dotaios capture import` (manual/backfill). Agents should not load sessions in bulk, use `dotaios search` to surface relevant ones on demand.

Captured text is evidence, not automatically durable knowledge. Promotion to `context/`, a project, `vault/`, or a skill is explicit, previewed, and recorded in `memory/events.jsonl`. Signals remain short-lived operational hints.

`dotaios brief --compact` owns the default working-context selection policy. It
selects up to three ranked session-index records plus at most eight signals and
eight events from today and yesterday, combines them with bounded daily and
project context, applies one project filter to all three memory sources, and
fits the result into a visible 6,000-character budget. When the budget is
reached, lower-priority items are omitted and the rendered projection says so.
The standard daily brief, session-start hooks, managed bridges, and the default
hot-memory audit consume this shared selection instead of defining parallel
windows. Explicit all-history audit and search remain opt-in operations.

The optional MCP adapter exposes exactly `read_working_context`, `search_aios`,
and `resolve_skill`. `read_working_context` calls the same core projection;
`search_aios` is the bounded on-demand search path, and `resolve_skill` routes
workflow intent. There are no compatibility aliases.

## Vault

`vault/` is long-term knowledge, loaded on demand. Users may keep it inside `~/aios/vault` or configure an external `vault_path` in `aios.json`, such as an Obsidian vault.

Company and people profiles live only in `vault/org/`. Access frequency is routing logic, not a reason to duplicate storage.

## Skills And Plugins

Skills are markdown instruction sets that any agent can read. Plugins may include code, but must declare permissions in `manifest.json`.

There are two skill scopes. AIOS skills are authored in `~/aios/skills` and
propagated globally. Project skills are authored in `<project>/skills` and
propagated only inside that checkout by `dotaios attach`. Both scopes use the
same `SKILL.md` contract; the registry declares their native targets. Symlinks,
global Hermes external directories, dry-runs, idempotency, and preservation of
foreign entries are tested at the CLI seam. Hermes has no project-local target:
DotAIOS does not own the `HERMES_HOME` selector that would make a checkout-local
config authoritative. Native client discovery and invocation are not inferred
from a successful filesystem check and require separate acceptance evidence.

Plugins are trusted local folders. Permission declarations are visible to users but are not sandbox enforcement. Remote/plugin marketplace installs are intentionally out of scope until provenance and stronger install controls exist.

## Schedules

`schedules.yml` is a local registry of schedules. `dotaios schedule list`, `dotaios schedule due`, `dotaios schedule run-due`, and `dotaios schedule run <name>` do not create a DotAIOS daemon or cloud workflow. Schedules only run DotAIOS commands.

`dotaios schedule install --dry-run --target launchd|cron|task-scheduler` prints an OS scheduler handoff. A real local install requires explicit `--yes` and does not run arbitrary commands.
