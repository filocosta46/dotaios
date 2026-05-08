# import-context

Use this skill when the user pastes context from another AI chat or asks to bring old ChatGPT, Claude, Gemini, or Cursor conversation knowledge into DotAIOS.

## Read

1. `context/identity.md`
2. `context/work.md`
3. `context/priorities.md`
4. `projects/*/README.md`, if relevant
5. `docs/context-import.md`, if present

## Process

- Separate durable identity, preferences, and values from temporary project status.
- Route active work to `projects/<slug>/README.md` or `context/work.md`.
- Route long-term reusable knowledge to `vault/wiki/`.
- Route people and companies only to `vault/org/people/` or `vault/org/companies/`.
- Route short-lived observations to `memory/signals/<date>.jsonl`.
- Ask the user before durable writes to `context/`, `projects/`, `vault/wiki/`, or `vault/org/`.
- Tell the user to keep secrets in `~/.aios/.env`, never in pasted context.

## Output

Return a proposed DotAIOS import JSON object and tell the user to preview it with:

```bash
npx dotaios import ./import.json --dry-run
```

Only suggest applying it after the user has reviewed the preview:

```bash
npx dotaios import ./import.json --apply
```
