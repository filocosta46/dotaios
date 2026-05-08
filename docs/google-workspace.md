# Google Workspace Beta

DotAIOS uses the local Google Workspace CLI (`gws`) for Gmail, Calendar, Drive, Docs, and Sheets beta access.

DotAIOS does not implement Google OAuth or store Google credentials. OAuth setup, tokens, and refresh are owned by `gws`.

## Commands

```bash
npx dotaios connect google --dry-run
npx dotaios google setup
npx dotaios connect google --status
npx dotaios connect google
npx dotaios google status
npx dotaios google inbox
npx dotaios google agenda --today
npx dotaios google drive --page-size 5
```

## Setup Shape

1. Install or expose `gws`:
   - `npm install -g @googleworkspace/cli`
   - `brew install googleworkspace-cli`
   - or download a binary from https://github.com/googleworkspace/cli/releases
2. Run `npx dotaios google setup`.
3. If `gcloud` is available, either run `gws auth setup` manually or run `npx dotaios google setup --run`.
4. Login with read-only service scopes: `gws auth login --readonly --services gmail,calendar,drive`.
5. Verify with `gws auth status`.
6. Run `npx dotaios connect google`.

For non-technical users, this is still an assisted beta feature. Google requires an OAuth client for Gmail, Calendar, and Drive access. The easiest local path is `gws auth setup`, which requires the Google Cloud CLI (`gcloud`). Without `gcloud`, users must create a Google Cloud project and Desktop OAuth client manually, then place the client secret at `~/.config/gws/client_secret.json`.

DotAIOS should not pretend this is a one-click setup yet. A genuinely non-technical path requires a hosted or verified OAuth app later, so users only click "Sign in with Google" instead of creating a Google Cloud project.

When auth is ready, DotAIOS writes:

- `connections/apis/google-workspace.md`
- a `Google Workspace` row in `connections/registry.md`
- `skills/google-workspace/SKILL.md`
- a non-secret `connection` event in `memory/events.jsonl`

## Read-First CLI

After connection, use these small wrappers instead of asking testers to remember raw `gws` commands:

```bash
npx dotaios google status
npx dotaios google inbox
npx dotaios google agenda --today
npx dotaios google agenda --week
npx dotaios google drive --page-size 10
```

These commands only call read-first `gws` workflows. Write actions are intentionally not wrapped.

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
