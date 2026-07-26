# Optional Google Workspace Connection

DotAIOS uses the local Google Workspace CLI (`gws`) for explicit Gmail, Calendar, and Drive reads. The connection is optional and does not require a paid DotAIOS package.

DotAIOS does not implement Google OAuth or store Google credentials. OAuth setup, tokens, and refresh are owned by `gws`. Google and `gws` process the Workspace data requested by these commands; DotAIOS invokes the local CLI and returns its output.

## Commands

```bash
npx dotaios@latest connect google --dry-run
npx dotaios@latest google doctor
npx dotaios@latest google setup
npx dotaios@latest connect google --status
npx dotaios@latest connect google
npx dotaios@latest google status
npx dotaios@latest google inbox
npx dotaios@latest google gmail search "from:alice@example.com newer_than:7d"
npx dotaios@latest google gmail read <message-id>
npx dotaios@latest google agenda --today
npx dotaios@latest google calendar prep --today
npx dotaios@latest google drive --page-size 5
npx dotaios@latest google drive find "budget"
```

## Setup Shape

1. Install or expose `gws`:
   - `npm install -g @googleworkspace/cli`
   - `brew install googleworkspace-cli`
   - or download a binary from https://github.com/googleworkspace/cli/releases
2. Run `npx dotaios@latest google setup`.
3. If `gcloud` is available, either run `gws auth setup` manually or run `npx dotaios@latest google setup --run`.
4. Login with the fixed read-only service set: `gws auth login --readonly --services gmail,calendar,drive`.
5. Verify with `gws auth status`.
6. Run `npx dotaios@latest connect google`.

For non-technical users, this is still an assisted beta feature. Google requires an OAuth client for Gmail, Calendar, and Drive access. The easiest local path is `gws auth setup`, which requires the Google Cloud CLI (`gcloud`). Without `gcloud`, users must create a Google Cloud project and Desktop OAuth client manually, then place the client secret at `~/.config/gws/client_secret.json`.

DotAIOS does not expose `--full`, custom `--scopes`, or custom `--services` options. The connection requests the `gws` read-only scopes for Gmail, Calendar, and Drive:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/drive.readonly`

DotAIOS should not pretend this is a one-click setup yet. A genuinely non-technical path requires a hosted or verified OAuth app later, so users only click "Sign in with Google" instead of creating a Google Cloud project.

When auth is ready, DotAIOS writes:

- `connections/apis/google-workspace.md`
- a `Google Workspace` row in `connections/registry.md`
- `skills/google-workspace/SKILL.md`
- a non-secret `connection` event in `memory/events.jsonl`

These records identify `gws` by name and a sanitized version only. They do not contain OAuth material or an absolute path to the `gws` binary.

## Read-First CLI

After connection, use these small wrappers instead of asking testers to remember raw `gws` commands:

```bash
npx dotaios@latest google status
npx dotaios@latest google doctor
npx dotaios@latest google inbox
npx dotaios@latest google gmail search "from:alice@example.com newer_than:7d"
npx dotaios@latest google gmail read <message-id>
npx dotaios@latest google agenda --today
npx dotaios@latest google calendar prep --today
npx dotaios@latest google agenda --week
npx dotaios@latest google drive --page-size 10
npx dotaios@latest google drive find "budget"
```

These commands only call read-first `gws` workflows. Use `--json` when an agent or local automation needs a bounded structured result. Write actions are not wrapped. `gws auth status` does not report enough information to verify the scopes of an existing grant, so re-authenticate with the fixed read-only login command if broader access may have been granted.

## Beta Scope

Start read-first:

- Gmail triage/search and message reading.
- Calendar agenda and meeting prep.
- Drive file listing and lookup.

The optional connection does not provide commands or scopes for:

- sending, replying, forwarding, labeling, archiving, or deleting email
- creating, editing, moving, or deleting calendar events
- writing to Drive content

## Why Not MCP First?

Google Workspace stays behind the explicit `dotaios google` CLI workflows. The DotAIOS MCP adapter remains a read-only memory interface and does not expose Google commands.
