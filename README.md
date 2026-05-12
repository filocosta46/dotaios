# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

**Every time you open Claude, Cursor, or Codex — you have to explain yourself again.**

Who you are. What you're working on. What matters this week. Over and over, every session.

**DotAIOS fixes that.** It creates one small folder on your computer that every AI tool reads automatically. Set it up once. Your AI always knows you.

No account. No subscription. No cloud. Just your files, on your machine.

---

## What it looks like in practice

You open Claude Code and ask: **"What should I focus on today?"**

It already knows your name, your role, your current project, and your priorities — because it read your `~/aios/` folder. You didn't paste anything. You didn't re-explain yourself.

**That's DotAIOS.**

---

## Before you start — two things you need

### 1. Node.js (free, takes 2 minutes to install)

Node.js is a small program that lets tools like DotAIOS run on your computer.

👉 Go to **[nodejs.org](https://nodejs.org/)** → click the big **"LTS"** button → follow the installer. That's it.

To check it worked, open your Terminal and type `node --version`. You should see a number like `v20.x.x`.

### 2. A Terminal

The Terminal is a text window where you type short commands. It comes built in to every computer — you don't need to install anything.

- **Mac:** press `⌘ Space`, type **Terminal**, press Enter
- **Windows:** press the Windows key, type **Command Prompt**, press Enter
- **Linux:** you already know 😄

Once both are ready, come back here and follow the 3 steps below.

---

## Set up in 3 steps

Open your Terminal and paste each line below, **one at a time**, pressing Enter after each.

**Step 1 — Create your folder**

```bash
npx dotaios init
```

It asks you 5 short questions in plain English: your name, what you do, what you're currently working on, what matters most right now, and which AI tools you use. Takes about 2 minutes.

When it finishes, your personal `~/aios/` folder has been created.

**Step 2 — Connect it to your AI tools**

```bash
npx dotaios activate
```

This tells Claude Code, Codex, Gemini, and Cursor where your folder is. Nothing is uploaded. Nothing is shared. It just creates small pointer files on your own computer.

**Step 3 — Open your folder and have a look**

```bash
npx dotaios reveal
```

Your `~/aios/` folder opens in Finder (Mac) or File Explorer (Windows). Everything inside is plain text — open any file in Notes, TextEdit, or VS Code. You own it all.

**Done.** Open your AI tool and ask it anything personal. Try: *"What am I working on right now?"* — and watch it answer from your files.

---

## When things in your life change

When your job, project, or priorities shift, run:

```bash
npx dotaios interview --review
```

It asks a few plain-English questions, shows you a preview of what will change, then updates your files. Your AI tools will be current the next time you open them.

---

## What's inside your folder

```
~/aios/
│
├── context/            ← who you are (your AI reads this every session)
│   ├── identity.md     ← your name and role
│   ├── work.md         ← what you're working on right now
│   ├── priorities.md   ← what matters most this week
│   └── preferences.md  ← how you like your AI to plan your day
│
├── memory/             ← a log of what happened recently
├── vault/              ← your long-term notes and saved articles
└── skills/             ← ready-made workflows your AI can run for you
```

Every file is plain text. You can open, edit, and read them in any app. Nothing is hidden, nothing is locked.

---

## Skills — things your AI can do for you

After setup, your AI gains a set of ready-made workflows called **skills**. In Claude Code, they appear as slash commands — just type `/` to see them:

| Skill | What it does |
|---|---|
| `/plan-today` | Plans your day from your priorities |
| `/today` | Builds today's plan and saves it as a note |
| `/closeday` | Wraps up today and carries unfinished tasks to tomorrow |
| `/morning-digest` | Yesterday's highlights + today's priorities in one summary |
| `/daily-brief` | A quick snapshot of where things stand right now |
| `/weekly-review` | Reviews your week and suggests what to update |
| `/audit` | Health check of your whole AIOS setup |
| `/ingest` | Saves a web article, PDF, or document into your vault |
| `/privacy-brief` | Summarises sensitive context safely before sharing with AI |
| `/summarize-source` | Turns a saved article or document into a clean summary |
| `/import-context` | Brings in saved context from another AI chat |

In Codex, Gemini, or Cursor, just ask naturally: *"use the weekly-review skill"* — they find it in your folder.

---

## Save articles, PDFs, and links to read later

Found something useful? Save it so your AI can reference it:

```bash
npx dotaios ingest https://example.com/article   # saves a web article
npx dotaios ingest research.pdf                  # saves a PDF
npx dotaios ingest notes.txt                     # saves a text file
```

Everything is saved locally as readable text. Nothing is uploaded anywhere.

---

## Check everything is working

```bash
npx dotaios status
```

Shows a quick health summary — green ticks for everything connected correctly.

---

## Which AI tools does it support?

| Tool | Works with DotAIOS? |
|---|---|
| Claude Code | ✅ Full support + slash commands |
| Cursor | ✅ Full support (per-project) |
| Codex | ✅ Full support |
| Gemini CLI | ✅ Full support |
| Any other agent | ✅ Reads `~/aios/AGENTS.md` automatically |

---

## Your files. Your rules.

- ✅ Everything lives on your own computer — no cloud, no sync, no server
- ✅ Every file is plain text you can open and edit in any app
- ✅ Nothing is sent anywhere without you explicitly asking for it
- ✅ Delete the folder any time and it's completely gone

---

## New to GitHub? Start here instead.

This page is where the code lives. You don't need to understand any of it.

If you want a slower, step-by-step walkthrough written specifically for people setting this up for the first time, read the **[Friend Setup Guide →](docs/friend-setup.md)**

---

## Full command reference

| Command | What it does |
|---|---|
| `dotaios init` | First-time setup — creates your `~/aios/` folder |
| `dotaios activate` | Connects Claude Code, Codex, Gemini, Cursor |
| `dotaios interview` | Updates your context with guided questions |
| `dotaios reveal` | Opens your folder in Finder / File Explorer |
| `dotaios status` | Health check |
| `dotaios search <query>` | Searches across all your local files |
| `dotaios ingest <input>` | Saves a URL, PDF, or file into your vault |
| `dotaios context` | View or edit your context files directly |
| `dotaios cleanup` | Removes stale data from memory |
| `dotaios attach <project>` | Adds Cursor support to a specific project folder |
| `dotaios schedule <cmd>` | List or run your configured schedules |
| `dotaios connect google` | Optional: connect Gmail and Calendar (beta) |
| `dotaios mcp <cmd>` | Optional: local MCP server for advanced tools |

Run `dotaios <command> --help` for details on any command.

---

## If you already use Obsidian or another notes app

Point DotAIOS at your existing notes folder and they become agent-readable knowledge:

```bash
npx dotaios init --vault-path ~/my-vault
```

---

## More guides

- [Friend Setup Guide](docs/friend-setup.md) — step-by-step for non-technical users ← **start here if unsure**
- [Getting Started](docs/getting-started.md) — quick command reference
- [Architecture](docs/architecture.md) — how it all fits together
- [Google Workspace](docs/google-workspace.md) — optional Gmail and Calendar connection
- [MCP Server](docs/mcp.md) — for advanced agent setups
- [Security](docs/security.md) — what DotAIOS does and doesn't do with your data

---

## Something went wrong?

Open an issue at [github.com/filocosta46/dotaios/issues](https://github.com/filocosta46/dotaios/issues) and include:
- What command you ran
- What you expected to happen
- What actually happened (paste the output)
- Your Node version (run `node --version`)

---

## License

MIT
