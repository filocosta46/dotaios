# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

**A folder for your AI agents.** Tell every AI tool on your machine who you are, what you're working on, and how you write — once. Then forget about it.

---

## What it is

DotAIOS creates **one folder** at `~/aios/` that holds your context, your memory, and your skills. Every AI tool on your machine — Claude Code, Cursor, Codex, Gemini — reads from that same folder. No sign-up, no server, no cloud. Just files you own.

> `.gitconfig` makes Git know your name. `~/aios/` makes every AI agent know your life.

## Install in 60 seconds

```bash
npx dotaios init       # answer 5 questions, your folder appears
npx dotaios activate   # connect Claude Code, Codex, and Gemini
npx dotaios reveal     # open the folder in Finder / Explorer
```

That's it. Open Claude Code. Ask: **"What am I working on?"** It answers from your `work.md`.

## Where the folder lives

`~/aios/` is a normal, visible folder in your home directory. **You can open it.** Drag notes in. Edit Markdown in any text editor. Move files around. It's yours.

You don't have to "put" the folder anywhere special for your AI tools to find it. `dotaios activate` writes small bridge files that tell each tool where to look:

| Tool | Bridge file |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Gemini | `~/.gemini/GEMINI.md` |
| Cursor (per project) | `<project>/.cursor/rules/dotaios.mdc` (run `dotaios attach <project>`) |

Run `dotaios status` any time to confirm every bridge is healthy.

## What's inside `~/aios/`

```
~/aios/
├── CLAUDE.md           ← Claude Code entrypoint
├── AGENTS.md           ← Codex / Gemini / generic agent entrypoint
├── .cursorrules        ← legacy Cursor entrypoint
│
├── context/            ← who you are (always read by agents)
│   ├── identity.md
│   ├── work.md
│   ├── priorities.md
│   └── north-star.md
│
├── memory/             ← what happened recently
├── vault/              ← long-term knowledge (loaded on demand)
└── skills/             ← reusable workflows agents can run
```

## Skills as slash commands

After `dotaios activate`, every DotAIOS skill becomes a slash command in Claude Code. Type `/` and pick one:

| Slash command | What it does |
|---|---|
| `/plan-today` | Plans your day from priorities + recent work |
| `/audit` | Weekly health check of your AIOS |
| `/morning-digest` | Yesterday's signals + today's priorities |
| `/ingest` | Saves a URL, PDF, or document into your vault |
| `/import-context` | Routes pasted context from another AI chat |

Codex, Gemini, and Cursor read the same skills inline from `~/aios/AGENTS.md`. Just say *"use the audit skill"* — they find it.

## Universal Knowledge Router

Throw any source at AIOS and the router translates it to clean Markdown your agents can read.

```bash
npx dotaios ingest https://example.com/article   # URL  → article extracted
npx dotaios ingest research.pdf                  # PDF  → text + original preserved
npx dotaios ingest notes.txt                     # text → wrapped in Markdown
npx dotaios ingest archive.zip                   # unknown binary → vault/assets/
```

Every Markdown file gets full provenance frontmatter (`source`, `ingested_at`, `kind`, `parser`, `title`). Documents are parsed locally — nothing is uploaded. PDFs use the bundled `unpdf` extractor by default. Install [marker-pdf](https://github.com/datalab-to/marker) for high-fidelity PDF / DOCX / PPTX / EPUB parsing.

## Commands

| Command | What it does |
|---|---|
| `dotaios init` | Interactive setup — creates `~/aios/` |
| `dotaios activate` | Connects Claude Code, Codex, Gemini, and registers skills |
| `dotaios attach <project>` | Adds a per-project rule for Cursor |
| `dotaios reveal` | Opens `~/aios/` in your file manager |
| `dotaios status` | Health check |
| `dotaios context` | View, edit, or refresh your context files |
| `dotaios index` | Generates `~/aios/_index.md` table of contents |
| `dotaios search <query>` | Searches across memory, vault, context, projects |
| `dotaios ingest <input>` | Universal Knowledge Router (see above) |
| `dotaios import <file>` | Apply structured context from old AI chats |
| `dotaios connect google` | Add read-first Gmail / Calendar via local `gws` |
| `dotaios google <cmd>` | Run Google Workspace workflows |
| `dotaios mcp <cmd>` | Local MCP server status / config |
| `dotaios install <plugin>` | Install a local plugin |
| `dotaios schedule <cmd>` | List or run local schedules |
| `dotaios cleanup` | Trim stale signals, compact event log |

Run `dotaios <command> --help` for details on any command.

## External vault

If you already use Obsidian, Logseq, or any Markdown notes app, point DotAIOS at it:

```bash
npx dotaios init --vault-path ~/my-vault
```

Your existing notes become agent-readable knowledge.

## Principles

- **Local first** — no accounts, no server, no cloud sync
- **File based** — Markdown and JSONL, not databases
- **Agent native** — your AI tools read directly; DotAIOS is invisible infrastructure

## More docs

[getting-started](docs/getting-started.md) · [friend-setup](docs/friend-setup.md) · [architecture](docs/architecture.md) · [google-workspace](docs/google-workspace.md) · [mcp](docs/mcp.md) · [plugin-development](docs/plugin-development.md) · [security](docs/security.md)

## License

MIT
