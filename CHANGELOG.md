# Changelog

All notable changes to DotAIOS will be documented in this file.

## [1.13.1] - 2026-05-15
### Fixed
- `brief.mjs`: yesterday calculation broke at month boundaries (day 1 → day 0); now uses `getTime() - 86400000`
- `memory.mjs`: malformed JSONL line crashed all memory reads; invalid lines now skipped silently
- `files.mjs`: malformed `aios.json` crashed every command; now returns fallback value instead
- `init.mjs`: `memory/daily/` not created at init time; caused silent failures in brief, closeday, and today commands on fresh installs

## [1.13.0] - 2026-05-15
### Added
- `dotaios update [text]` — log a quick update (decision, meeting, note) directly to memory. Writes to `memory/signals/<date>.jsonl` and `memory/events.jsonl`. With no argument, prompts interactively. Designed for non-technical users who should not need to know which file to edit.
- `dotaios skills [name]` — list all installed skills with one-line descriptions. `dotaios skills <name>` prints the full skill instructions. Works with any agent, not just Claude Code.
- `closeday` skill now opens with an optional capture step: "anything to capture before we close?" — agent appends the note directly to signals, no CLI required.

### Changed
- `dotaios setup` now asks once after onboarding whether to enable the daily brief schedule (Y/n), enables it in `schedules.yml`, and prints `dotaios schedule install` as the next step for full OS automation. Default: yes.
- `dotaios setup` prints a preview of the top 3 installed skills and how to invoke them after setup completes.
- Setup completion message is now agent-agnostic — names Claude Code, Codex, Gemini CLI, and Cursor, and uses plain English prompts that work with any of them.
- `skills/INDEX.md` preamble updated: removed Claude Code-specific `/skillname` slash syntax; invocation examples now read "use the audit skill" or "run plan-today" so any agent understands. Added: "When the user seems stuck or asks what you can help with, suggest a relevant skill."

## [1.12.0] - 2026-05-14
### Added
- `dotaios brief` — writes today's deterministic local brief into `memory/daily/YYYY-MM-DD.md` as a `## Brief` section. It reads priorities, recent open loops, and carry-over; no LLM or external service required.
- New AIOS folders now include a disabled daily brief schedule in `schedules.yml` (`dotaios brief`, daily), so the output loop is visible and can be enabled once.
- `dotaios ingest --to raw|wiki|company|person|signal` — route an ingested item to a shelf by purpose instead of always landing in `vault/raw`. `--name <name>` sets the record name (required for `company`/`person`, optional for `wiki`).
- Interactive shelf routing: `dotaios ingest <input>` with no `--to` in a Terminal now asks one plain question (rough source / lasting reference / company / person / working note); Enter defaults to `vault/raw`.
- `--apply` flag on `ingest`. Durable shelves (`wiki`, `company`, `person`) require approval: a non-interactive caller (an agent or script) gets a preview and writes nothing unless `--apply` is passed. A human picking the shelf interactively counts as approval.
- `packages/cli/src/ingest/placement.mjs` — shared shelf router used by the web, document, and text ingest paths.

### Changed
- `dotaios ingest` with no `--to` and no Terminal (agent/script) keeps today's behavior — saves to `vault/raw` — and prints a note pointing at `--to`.
- Ingesting onto a durable shelf that already has a record for that name now **appends** the new content under a dated heading instead of overwriting.
- `--to signal` appends a working note to `memory/signals/<date>.jsonl`; long parsed documents are preserved as markdown in `vault/raw` and linked from the signal.
- `skills/ingest/SKILL.md` documents `--to`, `--name`, `--apply`, and the durable-shelf approval gate so every agent routes by purpose.

### Removed
- Removed the overlapping `daily-brief` and `morning-digest` skills. `dotaios brief` is now the single brief path, and it writes the result down instead of printing into the void.

## [1.11.0] - 2026-05-14
### Added
- `skills/INDEX.md` — an auto-generated, agent-neutral list of every installed skill with a one-line description and run instructions. Regenerated on `init`, `activate`, raw-skill install, and `skill remove`, so every connected agent (not just Claude Code) can discover and run skills.
- `packages/core/src/agents.json` — editable registry of supported AI tools (name, detect path, bridge path, include syntax). Extendable per-user via `<aios>/agents.json`, merged by name. Adding a new AI tool no longer requires a code change.
- `dotaios activate --all` — connect every known AI tool even when not detected on the machine.
- `dotaios activate` and `dotaios doctor` print a copy-paste line for AI tools not in the registry: "Read <aios>/AGENTS.md first and follow it."

### Changed
- `dotaios activate` now connects only AI tools actually installed on the machine (detected by their config folder), and reports skipped tools clearly. Use `--all` to override.
- `AGENTS.md` inside the AIOS folder is now the single canonical, agent-neutral front door — folder map, read order, memory routing, rules, and skills. `CLAUDE.md` shrinks to a one-line pointer at it. Every agent bridge points at `AGENTS.md`.
- `dotaios doctor` and `dotaios status` report not-installed AI tools as informational, not warnings.

## [1.10.0] - 2026-05-14
### Added
- `dotaios setup` — one-shot onboarding wizard (init + activate + reveal).
- `dotaios doctor` — single health-check command that reports Node version, Terminal state, AIOS folder, and agent bridges with fix-lines per warning.
- `dotaios skill add|list|remove` — friendly alias surface for plugin management.
- `dotaios market list|info|install` — public skill marketplace, fetches `https://dotaios.com/registry.json` (override via `--registry` or `DOTAIOS_REGISTRY_URL`).
- `dotaios license add|list|remove` — license keys for paid skills, stored at `~/.dotaios/licenses.json` (mode 0600). Verified once via Gumroad License Verification API, then offline.
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
