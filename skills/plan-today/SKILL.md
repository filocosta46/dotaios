# plan-today

Use this skill when the user asks to plan the day or choose what to work on next.

## Read

1. `context/priorities.md`
2. `context/work.md`
3. `memory/events.jsonl` last 50 entries, if present
4. Today and yesterday in `memory/signals/`, if present

## Process

- Identify the user's active priorities and deadlines.
- Separate urgent obligations from compounding work.
- Propose 1-3 focused work blocks.
- Name one explicit non-priority to avoid.

## Output

Return a short plan with:

- today's focus
- the work blocks
- any dependency or missing context
