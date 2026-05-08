# Beta Testing

DotAIOS v1.1 is intended for a small group of terminal-comfortable testers.

## Who To Invite

- People who already use Claude Code, Codex, Gemini CLI, Cursor, or similar local agent tools.
- People comfortable running `npx` commands.
- People willing to report rough edges instead of expecting a finished consumer app.

## What To Test

```bash
npx dotaios init
npx dotaios activate
npx dotaios context
npx dotaios status
```

Then open an agent and ask:

```text
What am I working on?
```

Useful feedback:

- Did install work?
- Did activation work in the agent they use?
- Did the generated context feel accurate?
- Did `dotaios context` make it clear what agents can see?
- Was any safety or secrets guidance confusing?

## Safety Boundaries

- Do not install third-party plugins during the first beta.
- Keep secrets in `~/.aios/.env`, not in chat.
- Treat plugin permissions as descriptive, not sandboxed enforcement.
- Use `dotaios install ./plugin --dry-run` before installing any local plugin.
