---
name: weekly-review
triggers: weekly review, review my week, reflect on the week, weekly memory review
description: Review recent DotAIOS memory, daily notes, projects, and priorities, then propose small context updates.
---

# weekly-review

Turn recent operational memory into a clearer system.

## What this does

- Reads recent events, signals, daily notes, priorities, and active projects.
- Identifies stale priorities, repeated work, loose ends, and candidate knowledge to promote.
- Proposes specific updates to context, project notes, or vault summaries.

## What this doesn't do

- It does not rewrite identity, priorities, projects, wiki, or org files without approval.
- It does not treat memory as an infinite transcript.
- It does not summarize private external services unless the user supplies read-first output.

## How to use it

Try saying:

- "use weekly-review"
- "review my AIOS from this week"
- "what should I update in my context?"

## Agent steps

1. Run `dotaios brief --compact` (with `--project <slug-or-id>` when scoped) for identity, priorities, active work, and bounded recent memory; read active project READMEs and daily notes only when the projection points to them.
2. Group findings into stale, repeated, blocked, and promotable.
3. Recommend at most 5 updates.
4. Ask before durable writes to `context/`, `projects/`, `vault/wiki/`, or `vault/org/`.

## Output

- What changed this week
- What is stale
- Open loops
- Proposed updates
- Next 1-3 actions
