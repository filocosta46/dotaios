---
name: closeday
triggers: close the day, wrap up today, end of day, log what I shipped, close out my daily note
description: Close out today's daily note, log what shipped, carry tasks over, and write one reflection. Use when the user is done for the day or asks to close the day.
---

# closeday

End the day cleanly: log what shipped, move carry-over tasks to tomorrow, and write one reflection, all inside your daily note.

## What this does

- Reads today's note at `memory/daily/YYYY-MM-DD.md`.
- Asks three short end-of-day questions.
- Fills the `## Close` section (Done, Carry-over, Reflection).
- Creates tomorrow's note with carry-over tasks staged in `## Plan` if there are any.
- Logs the event to `memory/events.jsonl`.

## What this doesn't do

- It does not invent what you did. You answer the questions, it writes them down.
- It does not read email or calendar. Only what you tell it and what is in today's note.
- It does not overwrite a `## Close` section that already has content without asking first.

## How to use it

Try saying:

- "close my day"
- "I'm done for the day"
- "fill in my daily note"

## Agent steps

### Capture (optional, before questions)

Before the end-of-day questions, ask once:

**"Before we close, anything to capture from today? A decision, meeting, contact, or something you learned. (Press Enter to skip.)"**

If the user provides something:
- Append it as a signal to `memory/signals/YYYY-MM-DD.jsonl` with `type: "update"` and the text as `summary`. Use today's date.
- Confirm: "Saved to memory."

If the user skips or presses Enter: proceed directly to the Read section.

---

### Read

1. `memory/daily/YYYY-MM-DD.md` where YYYY-MM-DD is today's date.
   - If the file does not exist, tell the user: "No daily note found for today. Run `/today` first to create one." Stop.
   - If `## Close` already has content beneath `### Done`, ask: "Your close section already has content. Do you want to overwrite it?" Stop if they say no.
2. Read the `## Plan` section from today's note to understand what was intended.

### Ask

Ask these three questions, one at a time, waiting for an answer each time:

1. **Done**, "What did you actually finish or move forward today?"
2. **Carry-over**, "What didn't get done and needs to move to tomorrow? (Press Enter to skip)"
3. **Reflection**, "One sentence: what would you do differently tomorrow?"

Keep answers as-is. Do not paraphrase or summarize.

### Process

- Fill `### Done` with the answer to question 1.
- Fill `### Carry-over` with the answer to question 2, or leave blank if skipped.
- Fill `### Reflection` with the answer to question 3.
- If carry-over is not empty:
  - Check if `memory/daily/YYYY-MM-DD+1.md` (tomorrow's date) already exists.
  - If it does not exist, create it with this structure:

```markdown
---
date: YYYY-MM-DD+1
created_at: <ISO 8601 timestamp>
source: dotaios closeday
---

# YYYY-MM-DD+1

## Focus


## Plan
Carried over from YYYY-MM-DD:

<carry-over items>

## Close
<!-- Run /closeday to fill this section at the end of the day -->

### Done

### Carry-over

### Reflection
```

  - If tomorrow's note already exists and has a `## Plan` section, append the carry-over items to the end of that section with a `Carried over from YYYY-MM-DD:` label. Do not overwrite existing plan content.

### Output

- Confirm what was written: "Day closed. Note saved at `memory/daily/YYYY-MM-DD.md`."
- If a tomorrow note was created or updated: "Carry-over staged in `memory/daily/YYYY-MM-DD+1.md`."

Log one event to `memory/events.jsonl`:

```json
{ "type": "closeday", "summary": "Day closed for YYYY-MM-DD. N tasks carried over.", "source": "closeday" }
```
