---
name: process-inbox
triggers: process my inbox, file my inbox notes, sort my captured notes
description: File notes captured on another device (memory/inbox/) into the right place in this AIOS, then clear them.
when_to_use: process my inbox · file my inbox notes · sort my captured notes
---

# process-inbox

Take notes that arrived from another device and file each one into the right
place in this AIOS folder.

## What this does

- Reads every Markdown file in `memory/inbox/`.
- Routes each note's content into the correct location (`vault/`, `context/`,
  `memory/daily/`, or a project) based on its `hint` and its content.
- Removes each inbox file once its content has been filed.

## What this doesn't do

- It does not invent missing details. Unclear notes are left in the inbox for
  the user to review.
- It does not delete a note before its content is safely filed somewhere else.
- It does not write durable identity or CRM knowledge without asking the user.

## When to run it

Run this at the start of a work session whenever `memory/inbox/` contains files.
The `inbox/` folder is where notes written on a phone or another device land, cross-device sync drops them here so a local agent can file them properly.

## Inbox file shape

A phone-side agent writes one file per note, named
`memory/inbox/<ISO-timestamp>-<slug>.md`, with frontmatter:

```markdown
---
source: phone
device: claude-ios
captured_at: 2026-05-19T14:32:08Z
hint: "user wanted this saved as a reference"
---

<the note content>
```

The `hint` is the user's own words about why they saved it. Use it as the
primary routing signal. If a file has no frontmatter or is unreadable, treat it
as malformed (see below).

## Agent steps

### Read

1. Use the current DotAIOS folder. If none is known, use `~/aios`.
2. List the files in `memory/inbox/`. If the folder is missing or empty, tell
   the user there is nothing to process and stop.
3. Read each `.md` file and note its `hint`, `captured_at`, and content.

### Route

For each note, decide where it belongs and write its content there:

- A fact, link, document, or research note → `vault/raw/` (or summarise it with
  the `summarize-source` skill if it is a URL or long source).
- Something about a person or company → `vault/org/`, but ask the user first,
  since that is durable knowledge.
- A task, idea, or thing that happened today → today's daily note in
  `memory/daily/YYYY-MM-DD.md`.
- An update to who the user is, their priorities, or current work →
  the matching file under `context/`, ask the user before changing identity.
- Clearly tied to a project → that project's folder under `projects/`.

When unsure, prefer `vault/raw/` and tell the user where you put it.

### Clear

4. After a note's content is safely filed, remove its inbox file:
   - If this folder is a git repo, run `git rm <file>` so the deletion syncs.
   - Otherwise delete the file normally.
5. Leave any malformed or ambiguous file in `memory/inbox/` and list it for the
   user to handle by hand.

### Output

Tell the user, briefly:

- how many notes were filed and where each one went
- any notes left in the inbox for them to review
