# DotAIOS Session Handoff

## v1.2.2 Google Readiness Checkpoint (updated 2026-05-08)

DotAIOS v1.2.2 is the local Google-readiness pass on top of the published v1.2.1 release.

- package version in repo: `1.2.2`
- published baseline: `dotaios@1.2.1`
- release commit/tag for v1.2.1: `b7eb006` / `v1.2.1`
- v1.2.2 focus: simple read-first `dotaios google` workflows on top of the `gws`-backed Google Workspace connector, plus a zero-dependency local MCP server prototype
- not included: MCP server, semantic search, custom Gmail OAuth, cloud sync, plugin marketplace

Verification target before publishing v1.2.2:

- `npm test`
- `npm run smoke`
- `npm run check`
- `npm pack --dry-run --cache /private/tmp/dotaios-npm-cache`
- `git ls-remote origin refs/heads/main refs/tags/v1.2.0`
- `curl -L https://registry.npmjs.org/dotaios`

## Published v1.2.0 State

DotAIOS v1.2.0 is published and live.

- npm package: `dotaios@1.2.0`
- binary names: `dotaios`, `aios`
- npm page: https://www.npmjs.com/package/dotaios
- GitHub: https://github.com/filocosta46/dotaios
- branch: `main`
- current shipped commands: `init`, `activate`, `attach`, `context`, `import`, `ingest`, `install`, `schedule`, `status`, `search`, `cleanup`

What v1.2.0 added:

- local keyword search across context, memory, vault, and projects
- event compaction and stale signal cleanup
- structured memory append helpers
- zero-runtime-dependency CLI package
- node:test coverage for core memory and CLI flows

## Weekend Beta Guidance

Invite a small group of testers who already use local AI agents and are comfortable running `npx`.

Recommended script:

```bash
npx dotaios init
npx dotaios activate
npx dotaios context
npx dotaios search "your name"
npx dotaios status
```

Optional Gmail/Calendar beta script:

```bash
npx dotaios connect google --dry-run
npx dotaios google setup
npx dotaios connect google --status
npx dotaios connect google
npx dotaios google status
npx dotaios google inbox
npx dotaios google agenda --today
```

Then ask their normal agent:

```text
What am I working on?
```

Collect feedback on install friction, activation, context accuracy, search usefulness, status guidance, Google setup clarity, and safety clarity.

## Next Milestone

The next strategic milestone remains publishing/hardening `@dotaios/mcp` for v1.3 after the local MCP prototype gets tested with real MCP clients.

- Keep MCP separate from `dotaios activate`.
- Use an explicit future command such as `dotaios mcp install --dry-run`.
- Start with local stdio MCP tools for `search_memory`, `search_vault`, `log_event`, `read_context`, and `list_projects`.
- Keep any MCP SDK dependency in an optional MCP package, not the zero-dependency root CLI.

## Notes For The Next Agent

- Treat `~/.aios/` as the core product: local files first, no cloud dependency by default.
- Do not re-scaffold the repo.
- Public beta docs should use the package-name command form: `npx dotaios`.
- Do not publish, push tags, or mutate npm without an explicit release instruction.
- Read this file, `README.md`, `docs/beta-testing.md`, and `Obsidian-Mind/outputs/aios-product-session/dotaios-v1.2-codex-audit.md` before planning v1.3.
- Use `docs/v1.3-plan.md` as the current plan for Google, MCP, memory/indexing, and external inspiration.
