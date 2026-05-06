# DotAIOS

Dotfiles for AI agents: a local-first personal context layer that helps Claude Code, Codex, Cursor, Gemini, and other assistants understand who you are, what you are working on, and how you prefer to communicate.

DotAIOS is not a chat app, agent framework, SaaS, or cloud memory service. It is a folder convention plus a CLI installer. Your memory stays on your machine.

## Install

```bash
npx dotaios init
```

`dotaios` is the published npm package. It also exposes `aios` as a shorter convenience binary when the package is already installed or linked locally.

Use an external Obsidian or notes vault when needed:

```bash
npx dotaios init --vault-path ~/my-vault
```

The v1 setup creates `~/.aios/` with:

- `CLAUDE.md` for Claude Code
- `AGENTS.md` for Codex, Gemini, and agent-neutral tools
- `.cursorrules` for Cursor
- `context/` files for identity, work, priorities, and long-term direction
- `memory/` for recent operational state
- `vault/` for long-term knowledge, or an external `vault_path`
- base skills for planning, auditing, ingesting, and morning review

## Current status

This repository ships the first public CLI: initialize a clean local AIOS folder, inspect it, ingest raw material, and install local plugins without copying any private data from the reference implementation.

## Principles

- Local first: no accounts, no server, no cloud sync by default.
- File based: markdown and JSONL before databases.
- Agent native: existing AI tools read the context; DotAIOS is invisible infrastructure.
- Human controlled: durable identity, knowledge, and CRM updates require explicit approval.

## v1 scope

- `dotaios init`
- `dotaios status`
- `dotaios ingest <file>`
- generated agent entrypoints and context templates
- schema versioning via `aios.json`
- documented plugin manifest contract
- four generalized base skills

## Not in v1

- Gmail OAuth plugin
- paid Career Ops plugin
- payment gate
- hosted sync
- local browser dashboard
- long-running daemon
