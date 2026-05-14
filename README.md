# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**A folder for your AI agents.** Tell every AI tool on your machine who you are, what you're working on, and how you like to work, once. Then keep it fresh with a short interview whenever life changes.

***

## What it is

DotAIOS creates **one folder** at `~/aios/` that holds your context, your memory, and your skills. Every AI tool on your machine, Claude Code, Cursor, Codex, Gemini, reads from that same folder. No sign up, no server, no cloud. Just files you own.

If ChatGPT or Gemini is a conversation, DotAIOS is the notebook your AI companion keeps beside it: who you are, what matters now, and which repeatable skills it can use for you.

> `.gitconfig` makes Git know your name. `~/aios/` makes every AI agent know your life.

## Install in 60 seconds

**Step 1. Open your Terminal app.** This is where the commands below run. It is NOT a chat window like ChatGPT or Gemini.

- **Mac:** press `⌘ + space`, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `cmd`, press Enter.
- **Linux:** open whichever shell you normally use.

A small black-and-white window opens. That is your Terminal.

**Step 2. Paste these three commands into the Terminal**, one at a time, pressing Enter after each:

```bash
npx dotaios setup      # full setup in one step (init + connect agents + open folder)
```

Prefer it manual? Run the three steps yourself:

```bash
npx dotaios init       # answer 5 questions, your folder appears
npx dotaios activate   # connect Claude Code, Codex, and Gemini
npx dotaios reveal     # open the folder in Finder / Explorer
```

**Step 3.** Open Claude Code (or whichever AI tool you use). Ask: **"What am I working on?"** It answers from your `work.md`.

When your role, priorities, or planning style changes, run:

```bash
npx dotaios interview --review
```

It asks a few plain English questions, shows what will change, then updates the files your agents read.

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
│   ├── north star.md
│   └── preferences.md    ← created by interview; how you like plans shaped
│
├── memory/             ← what happened recently (fast operational notes)
├── vault/              ← long-term knowledge (loaded on demand)
└── skills/             ← skill folders agents can run and you can inspect
```

Each skill folder contains a `SKILL.md` that explains three things in plain language: what it can do, what it will not do, and how to trigger it.

## Skills as slash commands

After `dotaios activate`, every DotAIOS skill becomes a slash command in Claude Code. Type `/` and pick one:

| Slash command | What it does |
|---|---|
| `/plan-today` | Plans your day from priorities + recent work |
| `/today` | Builds today's plan and saves it as a daily note |
| `/closeday` | Closes out today's note and stages carryovers for tomorrow |
| `/audit` | Weekly health check of your AIOS |
| `/morning-digest` | Yesterday's signals + today's priorities |
| `/ingest` | Saves a URL, PDF, or document into your vault |
| `/import-context` | Routes pasted context from another AI chat |
| `/daily-brief` | Builds a short operating brief from priorities and recent memory |
| `/privacy-brief` | Distills sensitive local context into a cloud safe brief |
| `/summarize-source` | Turns ingested raw material into a useful local summary |
| `/weekly-review` | Reviews recent memory and proposes context/project updates |

Codex, Gemini, and Cursor read the same skills inline from `~/aios/AGENTS.md`. Just say *"use the audit skill"*, they find it.

## Universal Knowledge Router

Throw any source at AIOS and the router translates it to clean Markdown your agents can read.

```bash
npx dotaios ingest https://example.com/article   # URL  → article extracted
npx dotaios ingest research.pdf                  # PDF  → text + original preserved
npx dotaios ingest notes.txt                     # text → wrapped in Markdown
npx dotaios ingest archive.zip                   # unknown binary → vault/assets/
```

Every Markdown file gets full provenance frontmatter (`source`, `ingested_at`, `kind`, `parser`, `title`). Documents are parsed locally, nothing is uploaded. PDFs use the bundled `unpdf` extractor by default. Install [marker-pdf](https://github.com/datalab-to/marker) for high-fidelity PDF / DOCX / PPTX / EPUB parsing.

## Commands

| Command | What it does |
|---|---|
| `dotaios setup` | One-shot: init + activate + reveal (best for first-time users) |
| `dotaios doctor` | One-stop health check |
| `dotaios init` | Interactive setup, creates `~/aios/` |
| `dotaios activate` | Connects Claude Code, Codex, Gemini, and registers skills |
| `dotaios attach <project>` | Adds a per-project rule for Cursor |
| `dotaios reveal` | Opens `~/aios/` in your file manager |
| `dotaios status` | Health check |
| `dotaios interview` | Updates your context and planning preferences with guided questions |
| `dotaios skill <cmd>` | Add, list, or remove skills (friendly alias for install) |
| `dotaios market <cmd>` | Browse and install skills from the public registry |
| `dotaios license <cmd>` | Add or remove license keys for paid skills |
| `dotaios context` | View, edit, or refresh your context files |
| `dotaios index` | Generates `~/aios/_index.md` table of contents |
| `dotaios search <query>` | Searches across memory, vault, context, projects, skills, references, and plugins |
| `dotaios ingest <input>` | Universal Knowledge Router (see above) |
| `dotaios import <file>` | Apply structured context from old AI chats |
| `dotaios connect google` | Add read first Gmail / Calendar via local `gws` |
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

Your existing notes become agent readable knowledge.

## Principles

* **Local first**, no accounts, no server, no cloud sync
* **File based**, Markdown and JSONL, not databases
* **Agent native**, your AI tools read directly; DotAIOS is invisible infrastructure

## Skill marketplace

DotAIOS itself is and always will be free. On top of it you can install free or paid skills curated by vendors:

```bash
npx dotaios market list
npx dotaios market install <id>
```

Paid skills require a license key from the vendor's checkout (Gumroad, etc):

```bash
npx dotaios license add <product-id> <license-key>
```

See [marketplace.md](docs/marketplace.md) for the full flow and how to publish your own pack.

## More docs

[getting-started](docs/getting-started.md) · [friend-setup](docs/friend-setup.md) · [architecture](docs/architecture.md) · [google-workspace](docs/google-workspace.md) · [mcp](docs/mcp.md) · [plugin-development](docs/plugin-development.md) · [security](docs/security.md)

## License

MIT
