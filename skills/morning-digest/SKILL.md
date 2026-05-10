---
name: morning-digest
description: Produce a daily brief — yesterday's signals + today's priorities. Use when the user asks for a morning review, daily digest, or what they missed.
---

# morning-digest

Use this skill when the user asks for a daily brief or morning review.

## Read

1. `context/priorities.md`
2. `context/work.md`
3. last 50 entries from `memory/events.jsonl`, if present
4. today and yesterday from `memory/signals/`, if present
5. project README files for active priorities

## Process

- Summarize what changed since the last digest.
- Surface deadlines, blockers, and open loops.
- Connect the day back to the user's stated priorities.
- Avoid inventing external news or email context unless a plugin has written signals for it.

## Output

Return:

- important updates
- suggested focus
- open loops
- one small maintenance action for AIOS, if needed
