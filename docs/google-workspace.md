# Google Workspace Beta

DotAIOS uses the local Google Workspace CLI (`gws`) for Gmail, Calendar, Drive, Docs, and Sheets beta access.

DotAIOS does not implement Google OAuth or store Google credentials. OAuth setup, tokens, and refresh are owned by `gws`.

## Commands

```bash
npx dotaios connect google --dry-run
npx dotaios connect google --status
npx dotaios connect google
```

## Setup Shape

1. Install or expose `gws`.
2. Run `gws auth login`.
3. Verify with `gws auth status`.
4. Run `npx dotaios connect google`.

When auth is ready, DotAIOS writes:

- `connections/apis/google-workspace.md`
- a `Google Workspace` row in `connections/registry.md`
- `skills/google-workspace/SKILL.md`
- a non-secret `connection` event in `memory/events.jsonl`

## Beta Scope

Start read-first:

- Gmail triage/search and message reading.
- Calendar agenda and meeting prep.
- Drive, Docs, and Sheets lookup when needed.

Ask for explicit approval before:

- sending, replying, forwarding, labeling, archiving, or deleting email
- creating, editing, moving, or deleting calendar events
- writing to Docs, Sheets, or Drive

## Why Not MCP First?

MCP is still the right later connector layer for multi-agent tooling. Google Workspace is different: the hard part is user trust, OAuth setup, and safe daily workflows. Wrapping `gws` gives weekend testers a useful path without adding a running server or storing secrets in DotAIOS.
