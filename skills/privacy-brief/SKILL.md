---
name: privacy-brief
triggers: make a privacy brief, redact this before sharing, cloud-safe brief, strip sensitive info
description: Distill sensitive local context into a cloud-safe brief before using Claude, Codex, Gemini, or another cloud model.
when_to_use: make a privacy brief · redact this before sharing · cloud-safe brief · strip sensitive info
---

# privacy-brief

Create a short brief that preserves the useful decision context while omitting sensitive raw details.

## What this does

- Reviews the user-provided local files or pasted context.
- Separates safe context from sensitive details.
- Produces a cloud-safe brief the user can approve before sharing.
- Lists what was omitted and why.

## What this doesn't do

- It does not send anything to a cloud model by itself.
- It does not hide secrets inside summaries.
- It does not rewrite durable memory unless the user explicitly asks.
- It does not guarantee legal, medical, or compliance-grade redaction.

## How to use it

Try saying:

- "use privacy-brief on this folder before we ask Claude"
- "make a cloud-safe brief of this email thread"
- "summarize this without exposing private details"

## Agent steps

1. Read only the files or text the user named.
2. Identify sensitive classes: credentials, private messages, personal identifiers, financial details, health details, legal material, unreleased business data.
3. Write a brief with:
   - goal
   - relevant facts
   - constraints
   - decision needed
   - safe excerpts or paraphrases
4. Add an "Omitted" section that names categories, not secrets.
5. Ask before sending the brief to another model or writing durable memory.

## Output

Use this shape:

```markdown
# Cloud-Safe Brief

## Goal

## Useful Context

## Constraints

## Omitted

## Suggested Next Prompt
```
