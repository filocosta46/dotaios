# ingest

Use this skill when the user asks to save a file, article, source, note, or external material into AIOS.

## Routing

- Article, research, tutorial, transcript, or source dump: `vault/raw/`
- Durable topic summary: `vault/wiki/<topic>/_index.md`
- Company profile: `vault/org/companies/`
- Person profile: `vault/org/people/`
- Writing sample or voice reference: `vault/writing-style.md`
- Generated output: `vault/outputs/`
- Temporary classified input: `memory/signals/<date>.jsonl`

## Rules

- Ask before durable writes to `vault/wiki/`, `vault/org/`, or `context/`.
- Do not duplicate companies or people in `memory/`.
- Append a short event to `memory/events.jsonl` when a meaningful durable ingest occurs.
- Preserve source attribution when available.

## Output

Explain where the material was routed and what, if anything, still needs user approval.
