---
name: morning-digest
description: Produce a daily brief — yesterday's signals + today's priorities. Use when the user asks for a morning review, daily digest, or what they missed.
---

# morning-digest

Quick morning brief: what changed yesterday, what to focus on today.

## What this does

- Surfaces deadlines, blockers, and open loops from recent activity.
- Connects the day back to your stated priorities and planning preferences.
- Suggests one small AIOS maintenance action when something needs attention.

## What this doesn't do

- It does not read your email, calendar, or messages unless a plugin has written signals for them.
- It does not plan your day in detail — that is `/plan-today`.
- It does not write a daily note — that is `/today`. Use `/today` after your morning digest when you want to commit the plan to disk.

## How to use it

Try saying:

- "morning brief"
- "what did I miss yesterday?"
- "give me a daily digest"

## Agent steps

### Read

1. `prompt.md` in this skill directory if present — compiled by `dotaios interview`. Prefer it over reading individual context files.
2. If `prompt.md` is missing, fall back to:
   - `context/priorities.md`
   - `context/work.md`
3. Last 50 entries from `memory/events.jsonl`, if present
4. Today and yesterday from `memory/signals/`, if present
5. Project README files for active priorities

### Process

- Summarize what changed since the last digest.
- Surface deadlines, blockers, and open loops.
- Connect the day back to the user's stated priorities and planning preferences.
- Avoid inventing external news or email context unless a plugin has written signals for it.

### Output

Return:

- important updates
- suggested focus
- open loops
- one small maintenance action for AIOS, if needed
