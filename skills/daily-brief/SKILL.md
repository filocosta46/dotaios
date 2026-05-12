---
name: daily-brief
description: Build a concise daily operating brief from priorities, recent memory, daily notes, and optional read-first Google outputs.
---

# daily-brief

Prepare the user's day without making them reread their whole AIOS.

## What this does

- Reads current priorities, work, north star, recent memory, and today's daily note if present.
- Optionally uses read-first Google agenda or inbox output the user provides.
- Produces a short plan with open loops and suggested focus.

## What this doesn't do

- It does not contact Google directly unless the user asks for a DotAIOS Google command first.
- It does not create calendar events, send email, or write docs.
- It does not update context, vault, or CRM without approval.

## How to use it

Try saying:

- "use daily-brief"
- "make my daily brief from AIOS and today's calendar"
- "what should I pay attention to today?"

## Agent steps

1. Read `context/priorities.md`, `context/work.md`, and `context/north-star.md`.
2. Search recent memory for open loops, blockers, and carry-overs.
3. If Google is connected and the user asks, suggest `dotaios google agenda --today` or use output already provided.
4. Keep the result short enough to act on.
5. Ask before writing a daily note or durable memory.

## Output

- Top focus
- Calendar or time constraints
- Open loops
- Suggested plan
- One small next action
