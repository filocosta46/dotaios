---
name: audit
description: Weekly health check of the local AIOS — context freshness, project clarity, memory hygiene, connection health, skill coverage. Use when the user asks for a review, audit, or status of their AIOS.
---

# audit

Use this skill for a weekly health check of the local AIOS.

## Read

1. `aios.json`
2. `context/`
3. `projects/*/README.md`
4. `connections/registry.md`, if present
5. `skills/_registry.json`, if present
6. recent `memory/events.jsonl`, if present

## Check

- Context freshness: identity, work, priorities, and north-star still match reality.
- Project clarity: active projects have a README and status.
- Memory hygiene: recent events are useful and not bloated.
- Connection health: registered services have clear status.
- Skill coverage: repeated workflows have a skill.

## Output

List findings in priority order, then suggest the next 1-3 maintenance actions.
