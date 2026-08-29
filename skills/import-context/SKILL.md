---
name: import-context
triggers: import this chat, bring in context from chatgpt, save this conversation context, route pasted context
description: Route context pasted from another AI chat (ChatGPT, Claude, Gemini, Cursor) into the right DotAIOS files. Use when the user pastes prior conversation knowledge or asks to bring old AI memory in.
when_to_use: import this chat · bring in context from chatgpt · save this conversation context · route pasted context
---

# import-context

Take what you told another AI tool (ChatGPT, Claude, Gemini, Cursor) and save it into your AIOS so every future tool sees the same context.

## What this does

- Sorts pasted text into the right AIOS file: identity, work, priorities, project, person, company, or wiki.
- Builds a draft import file you can preview before any write.
- Flags anything that looks like a secret so you can keep it out of memory.

## What this doesn't do

- It does not connect to ChatGPT, Claude, Gemini, or Cursor. You paste in or upload an export file yourself.
- It does not overwrite anything without a preview. Import is dry-run by default.
- It does not store secrets. API keys belong in `~/aios/.env`, never in your context files.

## How to use it

Try saying:

- "I'm switching from ChatGPT, here's what it knew about me: <paste>"
- "import this old chat into my AIOS"
- "merge what Gemini had on this project into DotAIOS"

The agent will propose what to write and where. Review the proposed changes before confirming any write. For pasted chat context, the agent handles routing directly in conversation. For structured JSON import files, use only the current host-managed `candidate_invocation`: launch its `executable` with its `argv_prefix` plus `["import","<file>"]`, without a shell. Stop if the object is absent.

## Agent steps

### Read

1. `context/identity.md`
2. `context/work.md`
3. `context/priorities.md`
4. `projects/*/README.md`, if relevant
5. `docs/context-import.md`, if present

### Process

- Separate durable identity, preferences, and values from temporary project status.
- Route active work to `projects/<slug>/README.md` or `context/work.md`.
- Route long-term reusable knowledge to `vault/wiki/`.
- Route people and companies only to `vault/org/people/` or `vault/org/companies/`.
- Route short-lived observations to `memory/signals/<date>.jsonl`.
- Ask the user before durable writes to `context/`, `projects/`, `vault/wiki/`, or `vault/org/`.
- Tell the user to keep secrets in `~/aios/.env`, never in pasted context.

### Output

Return a proposed DotAIOS import JSON object. Preview it by appending `["import","./import.json","--dry-run"]` to that same `candidate_invocation` before applying.
