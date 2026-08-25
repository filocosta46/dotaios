---
name: save-session
triggers: save this session, save to memory, remember this session, log this work session
description: Save the current AI conversation as a clean local session summary with decisions, open threads, and action items.
when_to_use: save this session · save to memory · remember this session · log this work session
---

# save-session

Save the useful parts of the current AI conversation into DotAIOS memory.

## What this does

- Summarizes the current session into useful Markdown.
- Sends one bounded, versioned request to `capture save-summary`.
- Returns only after DotAIOS verifies both the session file and its index row.

## What this doesn't do

- It does not save a raw transcript.
- It does not upload anything.
- It does not write session Markdown or `index.jsonl` directly.
- It does not create a prepared request, journal, or other plaintext intermediate file.
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

1. Use the current memory receipt before any DotAIOS access.
   - For `Memory: Off`, stop without running the save command or opening the AIOS folder.
   - For `Memory: Shared`, use `{ "mode": "shared" }`.
   - For `Memory: This project`, require the selected registered project's exact stable `id` and `slug`. Never guess either value from prose or a working-directory name.
2. Use the current DotAIOS folder. If no folder is already known, use `~/aios`.
3. Review only the visible current conversation unless the user asks you to include other files.
4. Identify the tool name, such as `claude-code`, `codex`, `cursor`, `gemini-cli`, `claude-web`, `chatgpt-web`, or `manual`.

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

### Summary content

Use this structure for the `session.summary` Markdown string:

```markdown
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

### Request

Generate one unique `operation_id` for this save before the first attempt. It must be 1-128 ASCII characters, start with a letter or number, and otherwise contain only letters, numbers, `.`, `_`, or `-`. Keep that value and the exact serialized request bytes available in memory until the operation succeeds or is explicitly abandoned.

For Shared memory, build exactly this JSON shape:

```json
{
  "version": 1,
  "operation_id": "save-session-<unique-safe-id>",
  "memory": { "mode": "shared" },
  "session": {
    "agent": "<lowercase-agent-slug>",
    "title": "<short-title>",
    "summary": "<the-Markdown-summary>"
  }
}
```

For Project memory, replace `memory` with:

```json
{
  "mode": "project",
  "project": {
    "id": "<exact-stable-project-id>",
    "slug": "<exact-project-slug>"
  }
}
```

The request must be valid UTF-8 and smaller than 65,536 bytes. Use only the documented keys. Keep `agent` as a lowercase slug of at most 64 characters and `title` as one control-free line of at most 200 characters.

Do not generate or send `session_id`, `captured_at`, a file path, frontmatter, or an index row. The writer owns those values.

### Execute

1. Invoke the current package-resolved DotAIOS CLI's `capture save-summary` subcommand, with at most the already selected `--path <aios-folder>` option.
2. Stream the serialized JSON directly to stdin. Do not place it in a temporary file, shell history, Markdown file, journal, or environment-backed plaintext artifact.
3. If the process is interrupted or its success receipt is lost, retry with the same `operation_id` and the exact same envelope bytes. Do not regenerate or re-summarize between attempts.
4. Accept success only when exit status is zero and stdout is one compact receipt with exactly these fields:

```json
{
  "version": 1,
  "status": "verified",
  "operation_id": "<the-caller-operation-id>",
  "session_id": "<writer-generated-id>",
  "path": "memory/sessions/<date>/<file>.md"
}
```

If the command refuses, report the refusal. Never fall back to direct file or index writes.

### Output

After saving, tell the user:

- the relative path saved
- the title
- the verified session ID
- any sensitive material omitted

Keep the reply short.

## If the agent cannot run the local CLI

Some web chat agents cannot execute local commands. In that case:

1. Build the exact bounded JSON request above, including one caller-generated `operation_id` and the explicit memory selection.
2. Hand that request to a local agent and instruct it to stream those exact bytes to `capture save-summary`.
3. Do not provide independent Markdown/index write instructions and do not claim a save receipt before the local command verifies one.
