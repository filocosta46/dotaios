# Changelog

All notable changes to DotAIOS will be documented in this file.

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
