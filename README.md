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
- [Claude Code](https://claude.com/download) — recommended
- [Codex CLI](https://github.com/openai/codex) by OpenAI
- [Cursor](https://www.cursor.com) — code editor with AI
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google

**Already using Claude.ai, ChatGPT, or Gemini in your browser?** Great — keep using them. After setup, open your `~/aios/AGENTS.md` file and paste it at the start of any web chat. Your AI reads your context immediately, no extra steps.

## Choose your setup path

Start with the one that matches how you like to work:

- **Agent-led path (recommended):** tell your AI app to install DotAIOS for you. Best for non-technical users (`INSTALL.md`).
- **Terminal path:** run `npx dotaios ...` commands yourself (`docs/getting-started.md` or `docs/friend-setup.md`).
- **Advanced/manual path:** use plugin, marketplace, MCP, and architecture docs when you want full control (`docs/plugin-development.md`, `docs/marketplace.md`, `docs/mcp.md`, `docs/architecture.md`).

## Install in 60 seconds

You will not type a single terminal command. Your AI agent does the whole install for you.

**Step 1. Open an AI agent app.** Any one of these works:

- [Claude Code](https://claude.com/download) — recommended, free
- [Codex CLI](https://github.com/openai/codex) by OpenAI
- [Cursor](https://www.cursor.com) — code editor with AI built in
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google
- [Antigravity](https://antigravity.google/) by Google

Don't have one yet? Install **Claude Code** — it's free and the friendliest place to start.

**Step 2. Paste this sentence into the agent's chat box and press Enter:**

> Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.

That's it. The agent:

1. Installs Node.js if you don't have it
2. Creates your `~/aios/` folder
3. Connects every AI tool on your machine to it
4. Asks you three friendly questions — your name, what you're working on, what matters this week — and writes your answers into the folder

Sit back, answer the questions when it asks, and you're set up in about a minute.

**Step 3. Try it.** Open Claude Code (or whichever AI you use). Ask: **"What am I working on?"** It answers from the folder.

---

### Prefer the terminal?

If you already use a terminal and have Node 20+ installed, you can run setup yourself:

```bash
npx dotaios setup
```

If you don't have Node yet, install the LTS version from [nodejs.org](https://nodejs.org) first, then run the command above.

Three separate steps if you want to control each:

```bash
npx dotaios init       # answer 5 questions, your folder appears
npx dotaios activate   # connect Claude Code, Codex, and Gemini
npx dotaios reveal     # open the folder in Finder / Explorer
```

---

## Changing your context later

Your name, your work, your priorities will change. When they do, you don't need to dig through files. Tell any AI agent on your machine and it will update the right file — or run:

```bash
npx dotaios interview --review
```

A few plain English questions, it shows what will change, then updates the files your agents read.

## Save your AI conversations

DotAIOS can save your AI conversations locally so your context grows over time — across tools and sessions.

```bash
npx dotaios capture enable claude-code   # auto-save every Claude Code session
npx dotaios capture import paste         # paste any conversation in manually (works with any tool)
npx dotaios search "launch timing"       # search across all saved conversations
```

**Claude Code:** auto-saves after every session once enabled.  
**Any capable agent:** ask it to "use save-session" or "save this session" to write a clean summary into your AIOS.
**Any other tool (ChatGPT, Gemini, Cursor, Claude.ai web):** copy-paste the conversation into `npx dotaios capture import paste` if it cannot write local files.

All conversations save to `~/aios/memory/sessions/` as plain Markdown files you can open and read. Nothing leaves your machine.

→ [How it works and which tools are supported](docs/sessions.md)

## Cross-device sync (read your memory on your phone)

Your `~/aios/` folder lives on one computer. `dotaios sync` mirrors it to a **private GitHub repository** so an AI app on your phone can read the same memory — who you are, what you're working on, your notes.

```bash
npx dotaios sync setup     # one-time: connect GitHub, create the repo, first upload
npx dotaios sync status    # is sync on? when did it last run?
```

**One-time setup.** `dotaios sync setup` walks you through three steps:

1. It opens a GitHub page where you click **Generate token** and paste the token back into the terminal. (You need a free GitHub account — making one is the only prerequisite.)
2. It opens `github.com/new` with the form pre-filled — you click **Create repository**.
3. It uploads your folder.

After that, sync runs on its own — after every `dotaios` command, and at the start and end of every AI session. There is no background service to manage and nothing for DotAIOS to host.

**Reading from your phone.** Point a mobile AI at the repo:

- **Claude (free):** claude.ai → Projects → New → link your repo. Tap "Sync now" before you ask.
- **ChatGPT / Codex:** link the repo from Codex; works while your computer is awake.
- **No AI:** the GitHub Mobile app browses and edits the repo by hand.

**Writing from your phone.** When a phone AI saves something, it drops a note into `memory/inbox/`. The next time you work on your computer, your agent files those notes into the right place with the `process-inbox` skill — so two devices never fight over the same file.

**About the token.** Setup uses a classic GitHub token with the `repo` scope. That token can reach *all* of your GitHub repositories, not only the DotAIOS one. It is stored locally in a private file and sent to GitHub only when DotAIOS performs sync operations (setup, push, pull, status checks). If you'd rather scope it tighter, create a fine-grained token limited to your `<username>-aios` repo and paste that instead.

## Where the folder lives

`~/aios/` is a normal, visible folder in your home directory. **You can open it.** Drag notes in. Edit Markdown in any text editor. Move files around. It's yours.

You don't have to "put" the folder anywhere special for your AI tools to find it. `dotaios activate` writes small bridge files that tell each tool where to look:

| Tool | Bridge file |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Gemini | `~/.gemini/GEMINI.md` |
| Cursor (per project) | `<project>/.cursor/rules/dotaios.mdc` (run `dotaios attach <project>`) |

Run `npx dotaios status` any time to confirm every bridge is healthy.

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

Run `npx dotaios skills` to see all installed skills with descriptions. Run `npx dotaios skills <name>` to read one in full.

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

For quickstart users, run commands as `npx dotaios ...`. If you installed `dotaios` globally, the shorter `dotaios ...` form is equivalent.

| Command | What it does |
|---|---|
| `dotaios setup` | One-shot: init + activate + reveal (best for first-time users) |
| `dotaios capture <cmd>` | Save, browse, search, and manage saved AI conversations |
| `dotaios sync <cmd>` | Mirror `~/aios/` to a private GitHub repo so your phone can read it |
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
| `dotaios install <plugin>` | Install a plugin from a local folder or git URL |
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

* **Local first**, no accounts, no server we run — optional cross-device sync uses your own private GitHub repo
* **File based**, Markdown and JSONL, not databases
* **Agent native**, your AI tools read directly; DotAIOS is invisible infrastructure

## Advanced: skill marketplace

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
