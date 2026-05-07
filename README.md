# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

**Dotfiles for AI agents.** Personal memory that makes every AI tool smarter.

---

You use Claude Code, Cursor, Codex, or Gemini — but they treat every session as if they've never met you. DotAIOS fixes that. Run one command, answer five questions, and every agent on your machine learns your name, your work, your priorities, and how you write.

DotAIOS is not a chat app, agent framework, SaaS, or cloud memory service. It's a folder convention (`~/.aios/`) plus a CLI installer. Your context stays on your machine. Agents read it automatically.

> `.gitconfig` makes Git know your name. `~/.aios/` makes every AI agent know your life.

## Install

```bash
npx dotaios init
```

No global install. No account. No server.

## What happens

```
$ npx dotaios init

✔ What's your name? › Filippo
✔ What do you do? › student / researcher
✔ What are you working on right now? › MSc thesis on distributed systems
✔ Which AI tools do you use? › Claude Code, Cursor
✔ Link an external vault (e.g. Obsidian)? › No

✅  Created ~/.aios/
✅  Generated CLAUDE.md for Claude Code
✅  Generated AGENTS.md for Codex / Gemini
✅  Generated .cursorrules for Cursor
ℹ   Open your AI tool — it will read your context automatically.
```

Open Claude Code. Ask: **"What am I working on?"** — it answers correctly from your `work.md`.

That's it. There's no step 2.

## How it works

```
~/.aios/
├── CLAUDE.md           ← auto-loaded by Claude Code every session
├── AGENTS.md           ← auto-loaded by Codex, Gemini
├── .cursorrules        ← auto-loaded by Cursor
│
├── context/            ← who you are (always in context)
│   ├── identity.md
│   ├── work.md
│   ├── priorities.md
│   └── north-star.md
│
├── memory/             ← what happened recently (last 50 events)
├── vault/              ← long-term knowledge (loaded on demand)
└── skills/             ← what agents can do (/plan-today, /audit, ...)
```

`CLAUDE.md` is loaded by Claude Code on every session. `.cursorrules` is loaded by Cursor. You fill in `work.md` once — every future session just knows.

## Commands

| Command | What it does |
|---------|-------------|
| `dotaios init` | Interactive setup — creates `~/.aios/` with your context |
| `dotaios status` | Health check — shows what's configured, what's missing |
| `dotaios ingest <file>` | Saves a document to `vault/raw/` and indexes it |
| `dotaios install <plugin>` | Installs a local plugin and registers its skills |

## `dotaios` vs `aios`

`dotaios` is the npm package name. When installed globally, it also exposes `aios` as a shorter alias:

```bash
npx dotaios init      # always works via npx
aios status           # works after: npm install -g dotaios
```

## External vault

If you already use Obsidian, Logseq, or any Markdown-based notes app, point DotAIOS at your existing vault:

```bash
npx dotaios init --vault-path ~/Brain/Obsidian-Mind
```

Your notes become agent-readable knowledge. Use `dotaios ingest` to index specific files into it.

## Base skills

Four skills ship with v1, installed at `~/.aios/skills/`:

| Skill | What it does |
|-------|-------------|
| `plan-today` | Structures your day from `work.md` and `priorities.md` |
| `audit` | Reviews your context files for gaps and staleness |
| `ingest` | Classifies and routes a document into the right vault folder |
| `morning-digest` | Summarizes recent signals and surfaces today's priorities |

Invoke them in Claude Code: `/plan-today`, `/audit`, etc.

## Plugins

DotAIOS has a documented plugin contract. A plugin is a folder with a `manifest.json`, a `SKILL.md`, and optional source code.

```bash
dotaios install ./my-plugin
```

See [docs/plugin-development.md](docs/plugin-development.md) and [examples/plugins/hello-memory/](examples/plugins/hello-memory/) for a working example.

## v1 scope

- `dotaios init` / `status` / `ingest` / `install`
- Auto-generated agent entrypoints (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`)
- Schema versioning via `aios.json`
- Documented plugin manifest contract
- Four base skills

Not in v1: Gmail OAuth plugin, `upgrade` / `cleanup` commands, paid plugins, cloud sync.

## Principles

- **Local first** — no accounts, no server, no cloud sync by default
- **File based** — Markdown and JSONL, not databases
- **Agent native** — your existing AI tools read the context; DotAIOS is invisible infrastructure
- **Human controlled** — identity, knowledge, and CRM updates require explicit approval

## License

MIT
