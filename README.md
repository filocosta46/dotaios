# DotAIOS

**Give your AI one place to remember what matters.**

DotAIOS gives the AI assistants you already use the same sense of you: your identity, priorities, projects, notes, and trusted workflows. Set it up once and keep your context in one private place. No DotAIOS account. No hosted memory.

## Why people use it

If you use more than one AI assistant, DotAIOS helps you:

- stop repeating who you are and what you are working on;
- keep projects, priorities, and important notes together;
- carry the same context between Claude Code, Codex, Cursor, Gemini CLI, and other supported assistants.

The free core is available now. Paid packs and checkout are not open.

## Get started

You do not need a GitHub account.

The simplest path is to ask a local AI assistant to set it up for you. Open Claude Code, Codex, or Cursor and paste:

> Please set up DotAIOS for me. Read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step. Explain anything you need from me in plain language, and do not overwrite existing files without asking.

If you prefer to set it up yourself, the technical instructions are in [INSTALL.md](INSTALL.md). The current setup needs Node.js or a local assistant that can run it.

## What you have afterward

- One place for your identity and priorities
- A clear home for projects and next steps
- Recent notes and saved conversations
- Long-term knowledge and sources
- Trusted workflows your assistants can follow

Everything stays in a local `~/aios` folder: readable, portable, and yours. You can optionally sync it privately between your own devices.

DotAIOS does not keep an endless transcript. Important information is deliberately saved into the right place so it remains useful later.

## Updating

When a new version is published, the normal setup path picks it up automatically. Your existing `~/aios` folder remains yours across versions, with a protected migration path for changes that need one.

## Good to know

- A browser-only chat cannot open local files by itself.
- Each assistant has its own way of discovering and using local context; setup does not guarantee that every assistant will actively use it.
- Paid packs and checkout are **not** open. Nothing is purchasable yet.

## The promise

- **Private by default.** DotAIOS does not run a hosted memory service.
- **Yours to keep.** Your context lives in readable local files, not inside a locked-in account.
- **Works with the assistants you choose.** Models are rented. Your context is owned.

## Docs

- [INSTALL.md](INSTALL.md) — agent-led setup
- [Getting started](docs/getting-started.md) — terminal path
- [Architecture](docs/architecture.md) · [Projects](docs/projects.md) · [Client support](docs/client-support.md) · [Security](docs/security.md) · [all guides](docs/)

## License

MIT
