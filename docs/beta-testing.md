# Beta Testing

DotAIOS ships a local folder (`~/aios/`) that makes every AI tool on your machine context-aware, shared memory, skills, and saved conversations, all as plain files. This guide covers onboarding terminal-comfortable testers.

## Who To Invite

- People who already use Claude Code, Codex, Gemini CLI, Cursor, or similar local agent tools.
- People comfortable running `npx` commands.
- People willing to report rough edges instead of expecting a finished consumer app.

## Friend Beta Script

```bash
npx dotaios setup        # init + activate + open folder (one command)
npx dotaios context      # confirm what agents can see
npx dotaios search "your name"
npx dotaios status
```

Then open the agent they normally use and ask:

```text
What am I working on?
```

If they use Claude Code, enable session memory so past conversations are remembered:

```bash
dotaios capture enable claude-code
```

Backfill the last 30 days:

```bash
dotaios capture import claude-code
```

Search across saved conversations:

```bash
dotaios search "any topic you discussed"
```

If they use Cursor for a project, also run:

```bash
npx dotaios attach /path/to/project
```

Optional maintenance check:

```bash
npx dotaios cleanup --dry-run
```

Optional Google Workspace check for testers who already use Gmail or Calendar:

```bash
npx dotaios connect google --dry-run
npx dotaios google setup
npx dotaios connect google --status
```

Only run the final connect after `gws auth status` is working:

```bash
npx dotaios connect google
npx dotaios google status
npx dotaios google inbox
npx dotaios google agenda --today
```

Useful feedback:

- Did install work?
- Did activation work in the agent they use?
- Did the generated context feel accurate?
- Did `dotaios context` make it clear what agents can see?
- Did `dotaios search` find something useful without making them read folders manually?
- Did `dotaios status` make the next step obvious?
- Did `dotaios capture enable claude-code` work, and did sessions appear in `~/aios/memory/sessions/`?
- If they tried Google Workspace, did the `gws` setup/auth guidance feel safe and doable?
- Was any safety or secrets guidance confusing?

## Safety Boundaries

- Do not install third-party plugins during the first beta.
- Keep secrets in `~/aios/.env`, not in chat.
- Google OAuth credentials stay in `gws`, not DotAIOS.
- Treat plugin permissions as descriptive, not sandboxed enforcement.
- Use `npx dotaios install ./plugin --dry-run` before installing any local plugin.
- Ask before sending email, creating events, or editing Google files.

## What Not To Test Yet

- MCP server setup.
- Custom Gmail OAuth automation beyond the `gws` beta path.
- Paid plugins or plugin marketplace flows.
- Cloud sync.
