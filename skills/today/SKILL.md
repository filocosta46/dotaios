---
name: today
triggers: start my day, open today's note, today's plan, build today
description: Build today's plan and save it as a daily note in memory/daily/YYYY-MM-DD.md. Use when the user asks to start the day, open today's note, or save today's plan.
---

# today

Build today's plan and write it to your daily note so you can refer back to it — and close it out at the end of the day with `/closeday`.

## What this does

- Reads your priorities, active work, and recent signals.
- Honors your planning preferences (plan style, priority count, time blocks, frog definition).
- Writes the plan to `memory/daily/YYYY-MM-DD.md` with a structured close-out section ready for `/closeday`.
- Logs the event to `memory/events.jsonl`.

## What this doesn't do

- It does not plan without your context. If `prompt.md` and your context files are both empty, tell the user to run `dotaios interview` first.
- It does not read your calendar or email unless a plugin has written signals for them.
- It does not close the day — that is `/closeday`.
- It does not overwrite the `## Close` section if the file already exists and has been partially filled by `/closeday`.

## How to use it

Try saying:

- "start my day"
- "open today's note"
- "build and save today's plan"

## Agent steps

### Read

1. `prompt.md` in the `skills/today/` directory if present — compiled by `dotaios interview`. Prefer it over reading individual context files.
2. If `prompt.md` is missing, fall back to:
   - `context/priorities.md`
   - `context/work.md`
3. `memory/events.jsonl` last 50 entries, if present
4. Today and yesterday from `memory/signals/`, if present
5. `memory/daily/YYYY-MM-DD.md` where YYYY-MM-DD is today's date — check if it already exists

### Process

- If today's daily note already exists and its `## Plan` section is filled:
  - Show the existing plan.
  - Ask: "Your plan for today is already saved. Do you want to update the Focus or Plan section?"
  - If yes, update only those sections. Do not touch `## Close` if it contains any filled content.
  - If no, stop here.
- If today's daily note does not exist:
  - Build the plan using the same logic as `/plan-today` (honor planning preferences from `prompt.md`).
  - Identify the day's focus (one sentence), the work blocks, the frog, and the explicit non-priority.

### Output

Write `memory/daily/YYYY-MM-DD.md` with this exact structure:

```markdown
---
date: YYYY-MM-DD
created_at: <ISO 8601 timestamp>
source: dotaios today
---

# YYYY-MM-DD

## Focus
<one-sentence intent for the day>

## Plan
<work blocks, frog, and explicit non-priority>

## Close
<!-- Run /closeday to fill this section at the end of the day -->

### Done

### Carry-over

### Reflection
```

Then tell the user:
- The path where the note was saved.
- "Run `/closeday` at the end of the day to close it out."

Log one event to `memory/events.jsonl`:

```json
{ "type": "today", "summary": "Daily note written for YYYY-MM-DD.", "source": "today" }
```
