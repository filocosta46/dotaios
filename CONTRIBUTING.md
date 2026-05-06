# Contributing

DotAIOS is early. Keep changes small, local-first, and easy to inspect.

## Development

```bash
pnpm install
pnpm check
pnpm cli -- --help
```

## Guardrails

- Do not commit personal memory, private vault files, `.env`, credentials, or tokens.
- Do not add a cloud dependency to the core.
- Prefer markdown, JSON, and JSONL for user-owned data.
- Keep agent entrypoints short; route detail into context files and skills.
- Treat plugin code as optional. The core product is the folder convention and CLI.
