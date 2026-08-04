---
name: save-session
triggers: save this session, save to memory, remember this session, log this work session
description: Save the current AI conversation as a clean local session summary with decisions, open threads, and action items.
when_to_use: save this session · save to memory · remember this session · log this work session
---

# save-session

Save the useful parts of the current AI conversation into DotAIOS memory.

## What this does

- Summarizes the current session into a readable Markdown file.
- Saves decisions, open threads, and action items in `memory/sessions/`.
- Adds a structured digest block that future agents can read quickly.
- Works without a CLI command when the agent can write local files.

## What this doesn't do

- It does not save a raw transcript.
- It does not upload anything.
- It does not write durable identity, project, CRM, company, person, or wiki knowledge.
- It does not invent missing details. Mark unclear items as uncertain or leave them out.
- It does not save secrets, credentials, private keys, tokens, or large tool-output dumps.

## How to use it

Try saying:

- "save this session"
- "use save-session"
- "/save-session"
- "write a session summary to my AIOS"

## Agent steps

### Read

1. Use the current DotAIOS folder. If no folder is already known, use `~/aios`.
2. Review only the visible current conversation unless the user asks you to include other files.
3. Identify:
   - current timestamp in ISO 8601 format
   - current date as `YYYY-MM-DD`
   - the tool name, such as `claude-code`, `codex`, `cursor`, `gemini-cli`, `claude-web`, `chatgpt-web`, or `manual`
   - project name if obvious from the conversation or working directory

### Process

- Write a short summary of what happened, not a raw transcript.
- Keep the memory useful to a future agent that was not present.
- Prefer concrete facts:
  - decisions made
  - work completed
  - files, PRs, releases, or commands that matter
  - open threads
  - next actions
- Omit chatter, failed dead ends, giant logs, and private details that do not help future work.
- If the session contains secrets or credentials, do not write them. Note only that sensitive material was omitted.
- If there is nothing useful to save, tell the user that and stop.

### File path

Create this folder if it does not exist:

```text
~/aios/memory/sessions/YYYY-MM-DD/
```

Create one Markdown file with this filename shape:

```text
YYYY-MM-DDTHH-MM-SS_<agent-slug>_<session-id-prefix>.md
```

Rules:

- Replace `:` in the ISO timestamp with `-`.
- Use a lowercase agent slug with only `a-z`, `0-9`, and `-`.
- Generate `session-id` as 8 lowercase hex characters when possible.
- Use the first 6 characters of `session-id` in the filename.
- If randomness is unavailable, use a timestamp-based 8 character id and keep going.

Example:

```text
~/aios/memory/sessions/2026-05-17/2026-05-17T15-42-08_codex_a1b2c3.md
```

### File content

Write the session file with this structure:

```markdown
---
agent: <agent-slug>
session_id: <8-char-id>
captured_at: <ISO 8601 timestamp>
source_type: save-session
project: <project-slug-if-known>
turns: 0
title: "<short title>"
schema: 1
---

# <short title>

<!-- digest:start -->
decisions:
- <decision>
open_threads:
- <open thread>
<!-- digest:end -->

## Summary

<3-8 bullets or short paragraphs that explain what happened and why it matters.>

## Key Decisions

- <decision>

## Action Items

- [ ] <next action>

## Open Threads

- <question, risk, or follow-up>

## Notes For Next Agent

<Anything a future AI should know before continuing.>
```

Omit the `project:` frontmatter line when the project is unknown.

If there are no decisions, write:

```markdown
decisions:
- None recorded.
```

If there are no open threads, write:

```markdown
open_threads:
- None.
```

### Index entry

After writing the Markdown file, update:

```text
~/aios/memory/sessions/index.jsonl
```

Append one compact JSON line for the saved session:

```json
{"session_id":"<8-char-id>","agent":"<agent-slug>","captured_at":"<ISO 8601 timestamp>","source_type":"save-session","project":"<project-slug-if-known>","turns":0,"title":"<short title>","path":"memory/sessions/YYYY-MM-DD/<filename>.md"}
```

Rules:

- Use forward slashes in `path`.
- Omit the `project` field when unknown.
- Do not append a duplicate if `session_id` or `path` is already present.
- If you cannot safely update the JSONL index, still save the Markdown file and tell the user the index was not updated.

### Output

After saving, tell the user:

- the relative path saved
- the title
- any sensitive material omitted

Keep the reply short.

## If the agent cannot write files

Some web chat agents cannot write to local files. In that case:

1. Produce the complete Markdown session content.
2. Give the intended path under `~/aios/memory/sessions/YYYY-MM-DD/`.
3. Tell the user to save it with a local agent or text editor.
