# Contributing

DotAIOS is early. Keep changes small, local-first, and easy to inspect.

## Development

```bash
pnpm install
pnpm check
pnpm cli -- --help
```

Before sending changes, run `npm test` and `npm run smoke` (both must pass). For
agent-specific architecture, rules, and gotchas see [CLAUDE.md](CLAUDE.md).

Optional: enable the test gate so pushes are blocked when tests fail:

```bash
git config core.hooksPath scripts/hooks
```

## Guardrails

- Do not commit personal memory, private vault files, `.env`, credentials, or tokens.
- Do not add a cloud dependency to the core.
- Prefer markdown, JSON, and JSONL for user-owned data.
- Keep agent entrypoints short; route detail into context files and skills.
- Treat plugin code as optional. The core product is the folder convention and CLI.
