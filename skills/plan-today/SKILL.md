---
name: plan-today
triggers: plan my day, what should I work on, structure today, what's my focus today
description: Plan the day from priorities, active work, and recent signals. Use when the user asks what to work on, how to structure today, or what to focus on next.
---

# plan-today

Build today's plan from your priorities, active work, and your stated planning preferences.

## What this does

- Reads your priorities, work, and recent signals.
- Honors your planning preferences (plan style, priority count, time blocks, frog definition).
- Proposes focused work blocks and one explicit non-priority.
- Names one "frog", the task you'd avoid otherwise.

## What this doesn't do

- It does not write a daily note, that is `/today`. Use `/today` when you want to save the plan and close it out at the end of the day.
- It does not read your calendar or email unless a plugin has captured signals.
- It does not second-guess your priorities. If they are wrong, run `dotaios interview` first.

## How to use it

Try saying:

- "plan my day"
- "what should I work on today?"
- "build me today's plan"

## Agent steps

### Read

1. `prompt.md` in this skill directory if present, compiled by `dotaios interview`. Prefer it over reading individual context files.
2. Run `dotaios brief --compact` to receive the bounded identity, priorities, work, and recent-memory projection. If the work is project-scoped, add `--project <slug-or-id>`.
3. If `prompt.md` is missing, use the identity, priorities, and active-work sections from that projection as the fallback context.

### Process

- Identify active priorities and deadlines.
- Honor the planning preferences from `prompt.md` (plan style, priority count, time blocks, frog definition).
- Separate urgent obligations from compounding work.
- Propose the number of focused work blocks the preferences request (default 1-3).
- Name one explicit non-priority to avoid.

### Output

Return a short plan with:

- today's focus
- the work blocks
- any dependency or missing context
