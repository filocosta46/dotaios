# DotAIOS

**One local folder your agents share. Models are rented. Context is owned.**

DotAIOS is a local `~/aios` folder plus a small CLI that bridges that folder into the agents you already use. Same identity, priorities, projects, and notes across Claude Code, Codex, Cursor, Gemini CLI, and friends. No DotAIOS account. No hosted memory.

## Who it is for

People who already live in local agents and feel the fragmentation:

- You bounce between Claude Code, Codex, Cursor, Gemini, or other terminal / IDE agents
- You are tired of re-explaining who you are and what you are working on
- You are comfortable with Node and `npx` (or with asking your agent to run those commands)

This is **not** a no-terminal consumer app. Free core expects a developer-shaped setup. Outcome packs and checkout stay closed for now.

## Install

Requires **Node.js 20+**.

```bash
npx dotaios@latest init
npx dotaios@latest activate
```

Or let a local agent drive setup: open Claude Code / Codex / Cursor, paste:

> Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.

`npx dotaios@latest` always resolves to the current release — nothing to pin, nothing to reinstall.

Check the wire:

```bash
npx dotaios@latest status
```

## What you get

```
~/aios/
  context/   who you are, priorities, active work
  projects/  durable project records (paths stay machine-local)
  memory/    recent events and signals (today + yesterday operational window)
  vault/     lasting notes and ingested sources
  skills/    workflows agents can run
```

Plain Markdown and JSONL. Readable, portable, yours. Optional private GitHub sync for phone / second machine. Search is lexical (TF + IDF + recency), not embeddings.

Durable continuity comes from **promotion** into context / projects / vault, not from keeping an infinite raw window.

## Updating

```bash
npx dotaios@latest doctor   # tells you if a newer version is out
```

- **To upgrade:** just run `npx dotaios@latest <command>`. It always fetches the
  newest published release — there is nothing to uninstall or reinstall.
- **To find out a new version exists:** `dotaios doctor` checks the npm registry
  **when you run it** and prints the new version if there is one. There is no
  background updater and no telemetry; set `DOTAIOS_NO_UPDATE_CHECK=1` to turn
  the check off entirely, and it stays silent when you are offline.
- **Your folder is safe across versions:** a newer CLI meeting an older `~/aios`
  runs a versioned migration (`dotaios migrate`, with preview and recovery), and
  `doctor` warns you when one is pending.

## Honest limits

- Needs Node / `npx`. Browser-only chats cannot open your folder by themselves.
- Client bridges report configuration coverage. Invocation still depends on each client.
- Packs and paid checkout are **not** open. Catalog drafts may appear as coming soon; nothing is purchasable yet.

## Pillars

- **Local first.** No DotAIOS server. Your provider still processes whatever context you send it.
- **Just files.** No vector DB. Not a hosted memory service.
- **Agent-native.** Built for multi-agent builders, not mainstream consumer onboarding theater.

## Docs

- [INSTALL.md](INSTALL.md) — agent-led setup
- [Getting started](docs/getting-started.md) — terminal path
- [Architecture](docs/architecture.md) · [Projects](docs/projects.md) · [Client support](docs/client-support.md) · [Security](docs/security.md) · [all guides](docs/)

## License

MIT
