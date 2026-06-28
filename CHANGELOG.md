# Changelog

All notable changes to DotAIOS will be documented in this file.

## [1.21.0] - 2026-06-28
### Added
- **Flagship: native agent skills-routing.** `dotaios skills resolve "<intent>"` ranks the installed skill that fits a free-text intent, with no embeddings, network, or model calls. Plain-text scoring over each skill's declared `triggers:` and `description`: exact-name hit, trigger token overlap, description overlap, specificity tiebreak. Prints the top match (name, dir, confidence, triggers, `SKILL.md` path); `--full` also prints the `SKILL.md` body, `--all` prints the ranked list, `--json` returns the documented shape for fleet and MCP callers. Exit 2 when nothing clears the bar so fleet scripts can branch on "no skill fits, hand-roll." The scoring lives in a new shared `packages/core/src/skill-resolver.mjs` so the CLI and MCP server use one function.
- **MCP `resolve_skill` tool.** IDE agents (Cursor, Claude Code) call `resolve_skill` with the user's intent at boot or before acting, and get the same ranked payload as `dotaios skills resolve --json`. The MCP `instructions` now tell agents to resolve a skill first and only hand-roll when nothing matches.
- **`dotaios skills resolve --boot-context`** prints a Markdown `## Skills first` prompt block (the resolver rule plus the live catalog) for fleet scripts and any non-IDE consumer. Capture it as text with `BOOT_CONTEXT="$(dotaios skills resolve --boot-context)"`, then append that variable to the agent prompt. The generated block stays in sync with installed skills.
- **`dotaios activate --skills-first`** persists a preference in `aios.json` that makes the managed bridge block INLINE `skills/INDEX.md` + `skills/RESOLVER.md` into every agent entrypoint, so agents that do not auto-follow file references (headless fleet workers, MCP-only clients, browser-paste users) still see the catalog at boot. Default stays pointer-mode to keep bridge files small; `--no-skills-first` switches back.
- **`dotaios brief --lean`** prints a small high-signal surface to stdout: identity, priorities, north-star, today's daily note, and the first active project README. The rest of `memory/` stays opt-in, the lean default load the push-memory thesis asks for. No file write.
- **`dotaios plan "<title>"`** writes a lightweight `memory/plans/YYYY-MM-DD-<slug>.md` artifact (goal, checkbox steps, status, open questions) an agent can pick up across sessions, and logs a `plan` event so it surfaces in the session digest. `--print` prints instead of writing; `--steps` and `--project` tag it.
- **`docs/gitsync-mobile.md`** documents reading and capturing notes into your AIOS from a phone via GitSync (iOS) / MGit (Android) against the same private GitHub repo `dotaios sync setup` creates. No new services.

### Changed
- `dotaios sync` now stages changed paths explicitly. `commitAll` enumerates `git status --porcelain -z` and runs `git add -- <path>` per entry instead of `git add -A`, so the commit surface is explicit and a future caller can filter paths (skip large files, secrets). Deletions and renames still stage by naming the destination path. Conflict handling (rebase, branch-and-reset escape hatch) is unchanged.

## [1.20.2] - 2026-06-15
### Added
- New default skill: **`research`** — deep research on any question. The agent breaks it into sub-questions, searches the web across all of them, and writes back one cited report (TL;DR · key findings · open questions · sources), saved to `vault/research/deep/`. Fully portable: any agent runs it with its own web search, no servers, accounts, or keys. Bounded by design (plan once, search once, synthesize once — no runaway sub-agent loops). Added to the default skill registry so new AIOS folders get it, and it auto-routes via RESOLVER on intents like "deep research", "compare the options", "what's the latest on".
- `dotaios export-okf` — export your knowledge (context, vault, projects, decisions, connections) into an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (OKF v0.1) bundle: plain markdown + YAML frontmatter, git-shaped, readable by any OKF tool. It injects the OKF-required `type` field at export, generates a progressive-disclosure `index.md` per directory plus a bundle-root `index.md` declaring `okf_version`, and rewrites resolvable `[[wikilinks]]` to absolute `/path.md` links. Read-only — your source files are never modified. OKF is treated as portable plumbing: the bundle is a disposable projection, not a migration, and is produced locally only (sharing it is your decision). Ships with an `export-okf` skill and `docs/okf.md`.

## [1.20.1] - 2026-06-11
### Fixed
- Fresh installs are warning-free again. The web scraper now uses linkedom for HTML cleanup instead of cheerio, removing the deprecated `whatwg-encoding` transitive dependency that printed an npm deprecation warning on every first `npx dotaios` run — and 12 transitive packages with it. Ingest output is unchanged.
- `dotaios init` validates `--vault-path` before writing anything. A vault path that cannot be created (nested under a file, or in an unwritable location) now fails up front with a clear message instead of leaving a half-created AIOS folder behind.

### Changed
- The README command list now mentions `dotaios brief --compact`, the compact working-memory digest that AGENTS.md tells agents to use.

## [1.20.0] - 2026-06-08
### Added
- Native skills in every tool. `dotaios activate` now installs your `skills/<name>/SKILL.md` workflows as first-class native skills, not only the resolver convention. It symlinks each skill into `~/.claude/skills` (Claude Code) and `~/.agents/skills`, the shared Agent Skills standard folder read by Codex, Cursor 2.5+, Gemini, Warp, and VS Code, and registers your `~/aios/skills` folder in Hermes via `skills.external_dirs`. Edit a skill once and every tool that supports the standard sees it. Surfaces that do not read a local skills folder, like the Claude desktop app and browser chat, keep using the AGENTS.md paste convention. DotAIOS manages only the links it created, and cleans up a link when its source skill is removed.

### Fixed
- The Hermes config writer matches an exact list line instead of a substring, so a path like `/aios/skills` is not treated as already present when only `/aios/skills-backup` is listed. Symlink comparisons now resolve both sides so they stay correct on Windows.
- Removed a hardcoded personal path from a test fixture.

## [1.19.0] - 2026-06-03
### Added
- Skill resolver. Skills now declare `triggers:` (the phrases a user would naturally say) in their `SKILL.md` frontmatter, and DotAIOS auto-generates `skills/RESOLVER.md`, a routing table that maps intent to the skill that handles it. Connected agents match a request against the resolver instead of guessing from descriptions, so the right skill fires even when you don't know which skill you have. All bundled skills ship with triggers.
- `skillify` skill. Turn a workflow you keep repeating into a reusable skill: it drafts the skill (with trigger phrases) and saves it only after you approve. No evals, no auto-save, plain markdown.

### Fixed
- Date helpers unified on local time. Ingest signal placement and `cleanup`'s dry-run cutoff computed the day in UTC while signals are written under local dates, so near local midnight they could name a different day-file than where data actually lives. Both now use the canonical local `isoDate`.

## [1.18.0] - 2026-05-30
### Added
- Onboarding now ends with a short, honest reflective recap, your name, what you're working on, this week's priority, and one concrete thing to start today, instead of just listing features. Applies to the agent-led `INSTALL.md` flow and to `dotaios interview`.

### Fixed
- Search tolerates a corrupt line in a JSONL memory file instead of crashing, this also protects the session digest and the agent SessionStart hook that inject your working context.
- `connect gemini` shell-escapes the AIOS path in the generated hook script (no command execution via an unusual path).
- `install --subdir` rejects path traversal (`..` / absolute) from an untrusted plugin or marketplace entry.
- The MCP server never executes a client-supplied `gws` binary, it is resolved only from `DOTAIOS_GWS_BIN` or `PATH`.
- The session index lock is now crash-safe: it records the holder's PID, reclaims a crashed holder's lock, and never runs unlocked. Index entries are appended atomically, so concurrent captures can't drop an entry.

### Changed
- Search reads and scores files concurrently, faster on large vaults, with identical results.

### Docs
- Backfilled the missing `[1.15.0]` changelog entry; documented `read_session_digest` and the `connect` SessionStart hook; made the cold-start install steps followable on a fresh machine (single-shell Node install, the `npx` first-run prompt, a beginner-followable fallback); added a repo `CLAUDE.md`.

## [1.17.0] - 2026-05-28
### Added
- **Cross-agent context continuity.** `read_session_digest` MCP tool and `dotaios brief --compact` produce a compact working-memory digest (today's focus, carry-overs, recent signals, recent sessions) so any agent can get up to speed at session start without loading everything.
- `dotaios connect gemini`, install a Gemini CLI SessionStart hook + MCP server entry so context is injected automatically each session.
- `dotaios connect opencode`, install an OpenCode MCP server entry + per-skill stubs.
- `list_skills` MCP tool.
- Session access tracking (`access_count`, `last_accessed`) used to rank recent sessions in the digest.
- Frequency-weighted relevance ranking for search (phrase matches rank above multi-term matches; repeated hits rank higher). Note: this is term-frequency scoring, not full BM25.

### Changed
- `connect gemini`/`connect opencode` merge into existing agent config, refuse to overwrite a config file that exists but is not valid JSON, and run the merge before writing any other files (no partial install on failure).
- Session index mutations are serialized with a cross-process lock and written atomically (temp file + rename), so concurrent appends and digest-driven rewrites can't drop entries.

### Removed
- Unused adapter-first memory backend scaffolding (`memory-backend.mjs`, `MEMORY_BACKEND_KIND`), it was never wired into any command. It will return when adapters are actually integrated.
- Internal design-history docs under `docs/superpowers/` (still preserved in git history).

## [1.16.0] - 2026-05-28
### Added
- Internal scaffolding for a future adapter-first memory backend (resolver + contract). Note: not wired into any command in this release; the running product still uses the existing local file-based memory.
- **Pilot instrumentation**, `dotaios setup`, `search`, and `capture` emit best-effort, non-blocking metrics to `memory/metrics/pilot.jsonl` (`install_start/end`, `setup_phase_start/end`, `search_run`, `capture_saved/deleted`).
- `dotaios pilot-score`, record one scored pilot sample with required provenance (`--scorer-id`, `--method-version`, `--first-recall-min`, `--p-at-5`).
- `dotaios pilot-report [--json]`, run the rollup and print ship decisions (pilot + public) with explicit block reasons.
- Go/kill rollup with anti-gaming gates: requires ≥2 distinct scorers (pilot) / ≥3 (public), rejects future-dated and incomplete score rows, and a stricter public bar. See `docs/pilot/scoring-rubric.md`.

### Changed
- Rollup logic now lives in a shared library (`packages/cli/src/lib/pilot-rollup.mjs`) used by both `pilot-report` and `scripts/pilot-rollup.mjs`, so `pilot-report` works from an installed npm package (no subprocess, no unshipped script).

### Removed
- Stale `HANDOVER.md` internal handoff doc.

## [1.15.0] - 2026-05-23
### Added
- **Agent-carried onboarding.** Collapsed the install funnel to a single step: paste one sentence into any AI agent and it reads the repo, runs setup, connects your tools, and interviews you, no terminal commands required. This is now the primary install path in the README.
- **Private GitHub sync (`dotaios sync`).** Optional, opt-in sync of your `~/aios` folder to a private GitHub repo you own, so your context follows you across devices.
  - `dotaios sync setup`, guided setup using a pasted GitHub Personal Access Token (no OAuth app, no device flow).
  - `dotaios sync status`, `dotaios sync repo`, `dotaios sync logout`.
  - Rebase-model tick (commit → pull --rebase → push) fired after CLI commands via a hook; conflicts are surfaced, not silently resolved.
  - Phone-write inbox: drop notes from any device into the synced repo; the `process-inbox` skill files them into the right place.
- GitHub sync offered as an optional step during `dotaios setup`.

### Changed
- `dotaios sync` stamps its own DotAIOS git identity for sync commits, so it never depends on or modifies your global git config.

### Security
- `dotaios sync logout` strips the Personal Access Token from `.git/config` as well as `sync.json`, leaving no token behind.

## [1.14.0] - 2026-05-16
### Added
- **Session memory**, DotAIOS can now save your AI conversations locally so every agent on your machine can remember them. All sessions saved to `~/aios/memory/sessions/` as plain Markdown files.
- `dotaios capture` command tree, `import`, `list`, `delete`, `status`, `enable`, `disable`, `hook`.
- `dotaios capture import file <path>`, save any conversation file.
- `dotaios capture import paste`, paste a conversation in your editor; any tool supported.
- `dotaios capture import claude-code [--all]`, backfill past Claude Code sessions (last 30 days by default).
- `dotaios capture list [--agent] [--project] [--since]`, browse saved conversations in plain English.
- `dotaios capture delete <id>`, remove a saved conversation.
- `dotaios capture enable claude-code`, enable automatic saving when a Claude Code session closes.
- `dotaios capture disable claude-code`, turn off automatic saving.
- `dotaios capture status`, per-tool capability: auto-save / import only / paste only.
- `dotaios search` now searches saved sessions in addition to memory, vault, and context.
- `dotaios search --agent`, `--project`, `--since`, filter session results.
- Universal session format: agent-neutral Markdown + YAML frontmatter, one file per conversation, human-readable in any editor.
- `memory/sessions/index.jsonl`, lightweight catalog enabling fast search and deduplication across all saved sessions.
- `docs/sessions.md`, plain-English guide: where conversations save, how to delete, how to turn off.
- `docs/adapters.md`, per-tool capability levels in plain English.

### Changed
- `dotaios init` now creates `memory/sessions/` in the base folder tree.
- Help text updated to include `capture` command.
- README updated with session memory section.

## [1.13.1] - 2026-05-15
### Fixed
- `brief.mjs`: yesterday calculation broke at month boundaries (day 1 → day 0); now uses `getTime() - 86400000`
- `memory.mjs`: malformed JSONL line crashed all memory reads; invalid lines now skipped silently
- `files.mjs`: malformed `aios.json` crashed every command; now returns fallback value instead
- `init.mjs`: `memory/daily/` not created at init time; caused silent failures in brief, closeday, and today commands on fresh installs

## [1.13.0] - 2026-05-15
### Added
- `dotaios update [text]`, log a quick update (decision, meeting, note) directly to memory. Writes to `memory/signals/<date>.jsonl` and `memory/events.jsonl`. With no argument, prompts interactively. Designed for non-technical users who should not need to know which file to edit.
- `dotaios skills [name]`, list all installed skills with one-line descriptions. `dotaios skills <name>` prints the full skill instructions. Works with any agent, not just Claude Code.
- `closeday` skill now opens with an optional capture step: "anything to capture before we close?", agent appends the note directly to signals, no CLI required.

### Changed
- `dotaios setup` now asks once after onboarding whether to enable the daily brief schedule (Y/n), enables it in `schedules.yml`, and prints `dotaios schedule install` as the next step for full OS automation. Default: yes.
- `dotaios setup` prints a preview of the top 3 installed skills and how to invoke them after setup completes.
- Setup completion message is now agent-agnostic, names Claude Code, Codex, Gemini CLI, and Cursor, and uses plain English prompts that work with any of them.
- `skills/INDEX.md` preamble updated: removed Claude Code-specific `/skillname` slash syntax; invocation examples now read "use the audit skill" or "run plan-today" so any agent understands. Added: "When the user seems stuck or asks what you can help with, suggest a relevant skill."

## [1.12.0] - 2026-05-14
### Added
- `dotaios brief`, writes today's deterministic local brief into `memory/daily/YYYY-MM-DD.md` as a `## Brief` section. It reads priorities, recent open loops, and carry-over; no LLM or external service required.
- New AIOS folders now include a disabled daily brief schedule in `schedules.yml` (`dotaios brief`, daily), so the output loop is visible and can be enabled once.
- `dotaios ingest --to raw|wiki|company|person|signal`, route an ingested item to a shelf by purpose instead of always landing in `vault/raw`. `--name <name>` sets the record name (required for `company`/`person`, optional for `wiki`).
- Interactive shelf routing: `dotaios ingest <input>` with no `--to` in a Terminal now asks one plain question (rough source / lasting reference / company / person / working note); Enter defaults to `vault/raw`.
- `--apply` flag on `ingest`. Durable shelves (`wiki`, `company`, `person`) require approval: a non-interactive caller (an agent or script) gets a preview and writes nothing unless `--apply` is passed. A human picking the shelf interactively counts as approval.
- `packages/cli/src/ingest/placement.mjs`, shared shelf router used by the web, document, and text ingest paths.

### Changed
- `dotaios ingest` with no `--to` and no Terminal (agent/script) keeps today's behavior, saves to `vault/raw`, and prints a note pointing at `--to`.
- Ingesting onto a durable shelf that already has a record for that name now **appends** the new content under a dated heading instead of overwriting.
- `--to signal` appends a working note to `memory/signals/<date>.jsonl`; long parsed documents are preserved as markdown in `vault/raw` and linked from the signal.
- `skills/ingest/SKILL.md` documents `--to`, `--name`, `--apply`, and the durable-shelf approval gate so every agent routes by purpose.

### Removed
- Removed the overlapping `daily-brief` and `morning-digest` skills. `dotaios brief` is now the single brief path, and it writes the result down instead of printing into the void.

## [1.11.0] - 2026-05-14
### Added
- `skills/INDEX.md`, an auto-generated, agent-neutral list of every installed skill with a one-line description and run instructions. Regenerated on `init`, `activate`, raw-skill install, and `skill remove`, so every connected agent (not just Claude Code) can discover and run skills.
- `packages/core/src/agents.json`, editable registry of supported AI tools (name, detect path, bridge path, include syntax). Extendable per-user via `<aios>/agents.json`, merged by name. Adding a new AI tool no longer requires a code change.
- `dotaios activate --all`, connect every known AI tool even when not detected on the machine.
- `dotaios activate` and `dotaios doctor` print a copy-paste line for AI tools not in the registry: "Read <aios>/AGENTS.md first and follow it."

### Changed
- `dotaios activate` now connects only AI tools actually installed on the machine (detected by their config folder), and reports skipped tools clearly. Use `--all` to override.
- `AGENTS.md` inside the AIOS folder is now the single canonical, agent-neutral front door, folder map, read order, memory routing, rules, and skills. `CLAUDE.md` shrinks to a one-line pointer at it. Every agent bridge points at `AGENTS.md`.
- `dotaios doctor` and `dotaios status` report not-installed AI tools as informational, not warnings.

## [1.10.0] - 2026-05-14
### Added
- `dotaios setup`, one-shot onboarding wizard (init + activate + reveal).
- `dotaios doctor`, single health-check command that reports Node version, Terminal state, AIOS folder, and agent bridges with fix-lines per warning.
- `dotaios skill add|list|remove`, friendly alias surface for plugin management.
- `dotaios market list|info|install`, public skill marketplace, fetches `https://dotaios.com/registry.json` (override via `--registry` or `DOTAIOS_REGISTRY_URL`).
- `dotaios license add|list|remove`, license keys for paid skills, stored at `~/.dotaios/licenses.json` (mode 0600). Verified once via Gumroad License Verification API, then offline.
- `install` accepts git URLs (`https://...git`, `git@host:owner/repo`) and `--subdir <path>` for monorepo plugins.
- Monetization manifest fields: `paid`, `vendor`, `product_id`. Paid plugins require a stored license before install.
- Windows installer source under `installers/windows/` (WiX 4 `.wxs`), GitHub Actions workflow at `.github/workflows/release-installers.yml` that builds an MSI on tag push and attaches it to the release.
- New docs: `docs/marketplace.md`.

### Changed
- `dotaios --version` now reads from `package.json` instead of a hardcoded constant. Removes the version-drift bug that left users on stale CLI metadata.
- `dotaios init` prints a clear "open the Terminal app" error when run without a TTY, instead of silently falling back to placeholders.
- `core/src/files.mjs:readJson` and `core/src/memory.mjs:readJsonl` now re-throw non-ENOENT errors. Corrupt `events.jsonl` surfaces immediately instead of looking empty.
- Sensitive-term pattern in `import` extended to catch OpenAI `sk-...`, AWS `AKIA...`, Google `ya29...`, Slack `xox*-`, GitHub `ghp_`/`github_pat_`, PEM private-key headers, and `bearer` tokens.
- README and `docs/friend-setup.md` now lead with explicit "open Terminal first" guidance to fix the most common ICP friction (pasting CLI commands into a chat window).

## [1.9.0] - 2026-05-12
### Added
- Official static landing page deployed via Vercel (`website/` directory)
- Support for installing third-party raw skills (without manifests)
- Taught agents how to install plugins directly from repository URLs
- Removed dashes and hyphens from README to simplify reading for non-technical users

## [1.8.0] - 2026-05-12
### Added
- Agent-native onboarding via `INSTALL.md`
- Progressive `init` command that generates empty hint-based context files instead of placeholder strings
- Added `LICENSE` files to all built-in skills

### Fixed
- Fixed timezone inaccuracy in signal generation (now uses local timezone instead of UTC)
- Added debug warnings when vault search encounters unreadable files

## [1.7.0] - 2026-05-12
### Added
- Refined non-technical `README.md`
- Audited system packaging and test suite

## [1.6.0] - 2026-05-11
### Added
- Browser Use integration blueprint
- Stabilized plugin manifest formats

## [1.5.0] - 2026-05-11
### Added
- `today` and `closeday` writeback skills to introduce a new daily-note convention
- `interview` command and `review` helpers for guided context updates

## [1.4.0] - 2026-05-10
### Added
- Universal Knowledge Router (`dotaios ingest`)
- Support for web URLs, PDFs, and local document ingestion directly to vault
- Lazy-loading architecture and chunked extraction

## [1.2.0] - 2026-05-08
### Added
- `search` command for multi-layered keyword retrieval
- `cleanup` command for memory maintenance
- Centralized `memory.mjs` module supporting event logging and signal trimming

## [1.0.0] - 2026-05-04
### Added
- Initial public release of the local-first AIOS core
- Memory, context, projects, and skills directories
- CLI commands (`init`, `activate`, `attach`)
