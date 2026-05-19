# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**One folder on your computer. Every AI agent reads from it.** Tell your AI who you are, what you're working on, and how you like to work — once. Every tool on your machine knows.

***

## What it is

DotAIOS creates **one folder** at `~/aios/` that holds your context, your memory, and your skills. Claude Code, Cursor, Codex, Gemini — they all read from the same place. No sign-up, no server, no cloud. Just files you own.

> `.gitconfig` makes Git know your name. `~/aios/` makes every AI agent know your life.

## Before you start

DotAIOS needs one AI app installed on your computer so it has somewhere to send your context. Once that's set up, every AI you use — on your computer or in a browser — can read from the same folder.

**Pick one app to install (if you haven't already):**
- [Claude Code](https://claude.ai/download) — recommended
- [Codex CLI](https://github.com/openai/codex) by OpenAI
- [Cursor](https://www.cursor.com) — code editor with AI
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google

**Already using Claude.ai, ChatGPT, or Gemini in your browser?** Great — keep using them. After setup, open your `~/aios/AGENTS.md` file and paste it at the start of any web chat. Your AI reads your context immediately, no extra steps.

## Install in 60 seconds

> **Using an AI agent to set this up?** Skip to [Installing with AI help](#installing-with-ai-help) below.

**Step 1. Open your Terminal app.** This is where the commands below run. It is NOT a chat window like ChatGPT or Gemini.

- **Mac:** press `⌘ + space`, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `cmd`, press Enter.
- **Linux:** open whichever shell you normally use.

A small black-and-white window opens. That is your Terminal.

**Step 2. Check that Node.js is installed.** Paste this into your Terminal and press Enter:

```bash
node --version
```

- **You see `v20.x.x` or higher** → you're ready. Go to Step 3.
- **You see a lower version (like `v18`) or get an error** → go to [nodejs.org](https://nodejs.org), click the big green **LTS** button, run the installer, then come back here and run `node --version` again.

**Step 3. Run setup.** Paste this into your Terminal:

```bash
npx dotaios setup
```

This does everything in one go: creates your folder, answers 5 short questions about you, and connects your AI tools. Takes about 60 seconds.

Prefer to run it manually? Three separate steps:

```bash
npx dotaios init       # answer 5 questions, your folder appears
npx dotaios activate   # connect Claude Code, Codex, and Gemini
npx dotaios reveal     # open the folder in Finder / Explorer
```

**Step 4.** Open Claude Code (or whichever AI tool you use). Ask: **"What am I working on?"** It answers from your `work.md`.

---

## Installing with AI help

If you opened this page inside Claude Code, Codex, or another AI agent — or pasted this URL into a chat — the agent can guide you through the whole installation.

**Say this to your agent:**

> Read the DotAIOS README at this URL and help me install it. First run `node --version` to check if I have Node.js 20 or higher. If I don't, install it for me: on Mac run `brew install node` if Homebrew is available, otherwise open https://nodejs.org and download the LTS installer; on Windows run `winget install OpenJS.NodeJS.LTS`; on Linux run `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash` then `nvm install --lts`. Once Node is ready, run `npx dotaios setup` and walk me through the setup questions.

The agent will check your machine, install anything missing, run `npx dotaios setup`, and walk you through the 5 setup questions. You don't need to understand the Terminal commands — just follow what it says.

---

When your role, priorities, or planning style changes, run:

```bash
npx dotaios interview --review
```

It asks a few plain English questions, shows what will change, then updates the files your agents read.

## Save your AI conversations

DotAIOS can save your AI conversations locally so your context grows over time — across tools and sessions.

```bash
dotaios capture enable claude-code   # auto-save every Claude Code session
dotaios capture import paste         # paste any conversation in manually (works with any tool)
dotaios search "launch timing"       # search across all saved conversations
```

**Claude Code:** auto-saves after every session once enabled.  
**Any capable agent:** ask it to "use save-session" or "save this session" to write a clean summary into your AIOS.
**Any other tool (ChatGPT, Gemini, Cursor, Claude.ai web):** copy-paste the conversation into `dotaios capture import paste` if it cannot write local files.

All conversations save to `~/aios/memory/sessions/` as plain Markdown files you can open and read. Nothing leaves your machine.

→ [How it works and which tools are supported](docs/sessions.md)

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
│   └── sessions/       ← saved AI conversations (one Markdown file each)
├── vault/              ← long-term knowledge (loaded on demand)
└── skills/             ← skill folders agents can run and you can inspect
```

Each skill folder contains a `SKILL.md` that explains three things in plain language: what it can do, what it will not do, and how to trigger it.

## Skills

Skills are plain-language instructions your agent follows. Every agent reads them from `~/aios/skills/`. Ask by name — "use the plan-today skill" — or in Claude Code type `/plan-today`.

| Skill | What it does |
|---|---|
| `plan-today` | Plans your day from priorities + recent work |
| `today` | Builds today's plan and saves it as a daily note |
| `closeday` | Closes out today's note and stages carryovers for tomorrow |
| `audit` | Weekly health check of your AIOS |
| `ingest` | Saves a URL, PDF, or document into your vault |
| `import-context` | Routes pasted context from another AI chat |
| `privacy-brief` | Distills sensitive local context into a cloud-safe brief |
| `save-session` | Saves the current AI conversation as a session summary |
| `summarize-source` | Turns ingested raw material into a useful local summary |
| `weekly-review` | Reviews recent memory and proposes context/project updates |

Run `dotaios skills` to see all installed skills with descriptions. Run `dotaios skills <name>` to read one in full.

## Universal Knowledge Router

Throw any source at AIOS and the router translates it to clean Markdown your agents can read.

```bash
npx dotaios ingest https://example.com/article   # URL  → article extracted
npx dotaios ingest research.pdf                  # PDF  → text + original preserved
npx dotaios ingest notes.txt                     # text → wrapped in Markdown
npx dotaios ingest archive.zip                   # unknown binary → vault/assets/
```

Route by purpose with `--to` to put things in the right place from the start:

```bash
npx dotaios ingest research.pdf --to wiki --name ai-research           # lasting reference → vault/wiki/
npx dotaios ingest brief.pdf --to company --name acme --apply          # org record → vault/org/companies/
npx dotaios ingest call-notes.txt --to signal                          # working note → memory/signals/
```

| `--to` | Where it lands | Notes |
|---|---|---|
| `raw` (default) | `vault/raw/<slug>.md` | Rough source, no questions asked |
| `wiki` | `vault/wiki/<name>/_index.md` | Lasting reference. Appends if exists. Previews first; add `--apply` to write. |
| `company` | `vault/org/companies/<name>.md` | Org record. `--name` required. Appends. Needs `--apply`. |
| `person` | `vault/org/people/<name>.md` | Org record. `--name` required. Appends. Needs `--apply`. |
| `signal` | `memory/signals/<date>.jsonl` | Working note. Short texts inline, long sources linked from `vault/raw`. |

Every Markdown file gets full provenance frontmatter (`source`, `ingested_at`, `kind`, `parser`, `title`). Documents are parsed locally, nothing is uploaded. PDFs use the bundled `unpdf` extractor by default. Install [marker-pdf](https://github.com/datalab-to/marker) for high-fidelity PDF / DOCX / PPTX / EPUB parsing.

Web pages are fetched using [Lightpanda](https://github.com/lightpanda-io/browser), a lightweight headless browser that renders JavaScript. It installs automatically during `dotaios setup`.

## Daily Brief

```bash
npx dotaios brief
```

Writes today's brief into `memory/daily/YYYY-MM-DD.md`. Reads your priorities, recent open loops, and carry-over from yesterday. No AI, no network. Run it each morning or enable the pre-wired schedule in `~/aios/schedules.yml`.

## Quick memory capture

```bash
npx dotaios update "met Sarah, decided to push launch to next Thursday"
```

Logs a note to memory instantly — no need to know which file to edit. Run with no arguments for an interactive prompt. Saved to `memory/signals/` and `memory/events.jsonl`.

## Commands

| Command | What it does |
|---|---|
| `dotaios setup` | One-shot: init + activate + reveal (best for first-time users) |
| `dotaios capture <cmd>` | Save, browse, search, and manage saved AI conversations |
| `dotaios brief` | Writes today's local brief into `memory/daily/YYYY-MM-DD.md` |
| `dotaios doctor` | One-stop health check |
| `dotaios init` | Interactive setup, creates `~/aios/` |
| `dotaios activate` | Connects Claude Code, Codex, Gemini, and registers skills |
| `dotaios attach <project>` | Adds a per-project rule for Cursor |
| `dotaios reveal` | Opens `~/aios/` in your file manager |
| `dotaios status` | Health check |
| `dotaios interview` | Updates your context and planning preferences with guided questions |
| `dotaios update [text]` | Log a quick note to memory (decision, meeting, anything) |
| `dotaios skills [name]` | List installed skills; show full instructions for one |
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
