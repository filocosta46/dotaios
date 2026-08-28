# DotAIOS

**Stop starting from zero every time you change AI tools.**

DotAIOS gives your assistants one readable folder for the context that should
stay with you: who you are, what matters now, what you are working on, and what
was decided. You keep that folder on your computer. There is no DotAIOS account
and no hosted DotAIOS memory service.

## Who this is for

An independent consultant or freelancer who already moves between AI chats
and local agents, and does not want to build a memory system.

The expensive part of changing tools is not the new interface. It is having
to retell the useful context again.

The free core is available now.

### How it stays with you

1. **Install** and **personalize** one folder with the context you choose.
2. **Connect** one existing work folder without moving or copying it.
3. Let the agent **understand** the bounded context and **propose** one action.
4. **Approve** that exact action in a new reply before the agent acts.
5. Choose **privacy** for the work in front of you: Shared, This project, or Off.

## Install with one request

Open Claude Code, Codex, Cursor, or another local assistant that can run
commands, and paste:

> Please set up DotAIOS on my computer: https://github.com/filocosta46/dotaios

That link stays the same next year.

If you are the assistant reading this page, follow
[INSTALL.md](INSTALL.md), under “If an AI assistant is helping you”.

### What the assistant does

- Checks for Node.js 20 or newer, and installs it for you if it is missing
- On a Mac and on Linux, that does not need your password
- Previews the folder and app changes
- Asks you three questions that become your starting context
- Runs setup, verifies it, and says what happened in plain language

The questions reach you in the conversation, not at a shell prompt. You do
not need a GitHub or DotAIOS account.

### If you prefer Terminal

Use Terminal, PowerShell, or another system shell. DotAIOS requires Node.js 20
or newer. The first command previews without creating `~/aios` or changing app
configuration; the second runs the exact release version named here:

npm may download and cache the named package.

```sh
npx dotaios@2.0.11 setup --dry-run
npx dotaios@2.0.11 setup
```

Setup creates `~/aios`, then connects supported AI apps detected on the
machine. It preserves unmanaged files and stops before replacing existing
configuration. Private GitHub sync is off by default.

Afterward, verify the local installation with:

```sh
npx dotaios@2.0.11 doctor
```

## Do one useful task

In a supported local agent, paste:

> Help me with one useful task in an existing work folder. Ask what I want to accomplish. If the folder is not connected, also ask for its location and what it is for. Explain what you understand, propose exactly one action, and wait for my explicit approval before acting.

If the folder is not connected yet, the agent asks for its location, purpose,
and your desired outcome. DotAIOS previews the connection first and waits for a
fresh confirmation before recording it. It then resolves only that project's
bounded context and relevant workflow. The agent explains what it understood,
proposes one exact action, and waits for another fresh direct approval. A
decline performs no proposed work and no further DotAIOS write.

A browser-only chat cannot access a local work folder or run the local DotAIOS
commands. Continue in Claude Code, Codex, or another supported local agent on
the computer that holds the folder.

## Choose what your AI can remember

Your AIOS folder is what they read. Start a connected local-agent session
with one of these phrases:

- `Use my memory` — **Memory: Shared** uses your personal continuity.
- `Only this project` — **Memory: This project** uses only that explicitly
  registered project's files and attributed continuity. It excludes personal,
  unscoped, and other-project memory.
- `Private chat` — **Memory: Off** tells DotAIOS operations to perform no read,
  search, save, or capture. Your AI app may still keep its own chat history.

### What Off actually does

Gemini's managed hook preserves the first-message choice. Codex and Claude Code
rely on their bridge instructions to forward Off on every DotAIOS operation and
show the receipt; they do not independently enforce a host-wide session lock.
Off also cannot undo instructions or context the AI app may already have loaded
before your first message, so begin a Private chat outside the AIOS folder or an
attached project.

Saving stays deliberate. The agent creates durable memory only when you ask it
to save and the Shared or This project scope is selected.

## What you have afterward

- One place for your identity and priorities
- A clear home for projects and next steps
- Recent notes and conversations you chose to save
- Long-term knowledge, sources, and trusted workflows
- A readable history you can inspect, back up, or move

Your context stays in a local `~/aios` folder: readable, portable, and yours.
DotAIOS does not keep an endless transcript or turn every chat into permanent
memory. You save the important parts on purpose, in the right place.

### Good to know

- A browser-only chat cannot open local files by itself; use the supported
  local-agent transition above for existing work.
- Each assistant uses local context in its own way.
  [Client support](docs/client-support.md) records what has been observed.
- Claude Code supports managed automatic session capture today. Other clients
  use explicit capture, import, or the bundled `save-session` workflow.
- Optional sync sends the selected Git mirror to your own private GitHub
  repository. The free core does not upload context to a DotAIOS service.

### The promise

- **Private by default.** DotAIOS does not run a hosted memory service.
- **Yours to keep.** Your context lives in readable local files, not inside a
  locked-in account.
- **Works with the assistants you choose.** Models are rented. Your context
  is owned.

## Technical reference

For package provenance and verified install, update, and removal commands, use
[INSTALL.md](INSTALL.md). It is the command reference for this release.
Feature-specific workflows are in the linked guides below.

## Docs

- [INSTALL.md](INSTALL.md) — assistant-guided install, manual recovery, and removal
- [Getting started](docs/getting-started.md) — product walkthrough
- [Architecture](docs/architecture.md) · [Projects](docs/projects.md) · [Client support](docs/client-support.md) · [Security](docs/security.md) · [all guides](docs/)

## License

MIT
