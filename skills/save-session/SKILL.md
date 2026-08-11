---
name: save-session
triggers: save this session, save to memory, remember this session, log this work session
description: Use when the user asks to save, remember, or log the current conversation into local DotAIOS session memory.
when_to_use: save this session · save to memory · remember this session · log this work session
---

# save-session

Save the useful parts of the visible conversation as local session evidence. SessionStore is the only publication authority.

## Authority boundary

- Submit one prepared schema-1 document to `dotaios capture import prepared` through standard input (stdin).
- Never create or modify files under `memory/sessions/`, and never append or rewrite `index.jsonl` directly.
- Do not fall back to a direct file write, partial save, editor instruction, or hand-built index entry.
- If the local CLI cannot run or returns a non-zero exit code, report that the session was not saved and stop.

## Prepare

1. Use the current DotAIOS folder. If none is known, use `~/aios`.
2. Review only the visible conversation unless the user explicitly includes another source.
3. Produce a concise summary of decisions, completed work, action items, risks, and open threads. Omit chatter, failed dead ends, raw transcripts, large tool output, credentials, tokens, keys, and other secrets.
4. If nothing useful remains, tell the user there is nothing to save and do not invoke the CLI.
5. Choose an ISO 8601 capture time and a lowercase agent slug. SessionStore assigns the session ID. Include a lowercase project slug only when it is known.

The complete UTF-8 document has a hard ceiling of 1 MiB; target at most 64 KiB. Use `turns: 0` because this is a curated summary, not a transcript. Keep frontmatter scalar-only and omit `project` when unknown.

```markdown
---
agent: <agent-slug>
captured_at: <ISO-8601-timestamp>
source_type: save-session
project: <project-slug-if-known>
turns: 0
title: "<short-title>"
schema: 1
---

# <short title>

<!-- digest:start -->
decisions:
- <decision, or None recorded.>
open_threads:
- <open thread, or None.>
<!-- digest:end -->

## Summary

<What happened and why it matters.>

## Key Decisions

- <decision>

## Action Items

- [ ] <next action>

## Open Threads

- <question, risk, or follow-up>

## Notes For Next Agent

<Useful continuation context.>
```

## Publish

Pass the completed document directly to the CLI without creating a temporary session file. Substitute the resolved AIOS path and all template fields before execution.

```sh
dotaios capture import prepared --path <absolute-aios-path> <<'DOTAIOS_SESSION'
<complete prepared Markdown document>
DOTAIOS_SESSION
```

Success requires exit code zero and the CLI's explicit `Saved:` or `Already saved` outcome. Only then tell the user the returned relative path, title, and whether sensitive material was omitted.

On a non-zero exit code, conflict, reconciliation requirement, refusal, timeout, or missing CLI, surface the bounded CLI diagnostic and say the session was not saved. Never report it as saved and never attempt a direct-write recovery.
