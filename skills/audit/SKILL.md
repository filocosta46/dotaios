---
name: audit
triggers: audit my aios, review my setup, health check, is my aios healthy, status of my system
description: Weekly health check of the local AIOS, context freshness, project clarity, memory hygiene, connection health, skill coverage. Use when the user asks for a review, audit, or status of their AIOS.
when_to_use: audit my aios · review my setup · health check · is my aios healthy · status of my system
---

# audit

Quick health check of your DotAIOS folder. Spots stale context, abandoned projects, and noisy memory before they bite.

## What this does

- Reads your context, projects, connections, and recent events.
- Flags what looks out-of-date or empty.
- Notes if memory has grown too large and could be trimmed.
- Suggests 1-3 small fixes you can make today.

## What this doesn't do

- It doesn't change any files. Findings only.
- It doesn't touch external services (Gmail, Calendar, etc.).
- It's not a substitute for your own weekly review, it's a sanity check.

## How to use it

Try saying:

- "audit my AIOS"
- "give me a health check on my setup"
- "what's stale in my context?"

## Agent steps

### Read

1. `aios.json`
2. `context/`
3. `projects/*/README.md`
4. `connections/registry.md`, if present
5. `skills/_registry.json`, if present
6. `npx dotaios brief --compact` for the bounded recent-memory projection

### Check

- Context freshness: identity, work, priorities, and north-star still match reality.
- Project clarity: active projects have a README and status.
- Memory hygiene: recent events useful, not bloated.
- Connection health: registered services have clear status.
- Skill coverage: repeated workflows have a skill.

### Output

List findings in priority order, then suggest the next 1-3 maintenance actions.
