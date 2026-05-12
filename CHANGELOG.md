# Changelog

All notable changes to DotAIOS will be documented in this file.

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
