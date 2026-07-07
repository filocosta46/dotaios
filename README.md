# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](https://nodejs.org/)

**One folder on your computer that every AI knows you by.**

Tell your AI who you are, what you are working on, and how you like to work. You do it once. After that, every AI tool you use reads from the same place, so you never have to explain yourself again.

## What it is

DotAIOS makes one folder on your computer, called `~/aios`. It holds the things your AI should always know about you: your name, your work, your priorities, and your notes. Claude, Cursor, Codex, and Antigravity all read from it. There is no account, no website to log into, and nothing stored on anyone else's server. It is just files on your computer that belong to you.

Here is the simplest way to think about it. Your phone keeps your contacts in one place so every app can use them. DotAIOS keeps *you* in one place so every AI can use that.

## Get started

You will not type a single command. Your AI does the whole setup for you.

First, make sure you have one AI app on your computer. If you are not sure which to pick, start with Claude Code, the friendliest one. You can also use Cursor, Codex, or Antigravity.

- [Claude Code](https://claude.com/download), recommended
- [Cursor](https://www.cursor.com), an editor with AI built in
- [Codex CLI](https://github.com/openai/codex) by OpenAI
- [Antigravity](https://antigravity.google/download) by Google, agentic development platform

Then open that app, paste this one sentence into the chat, and press Enter:

> Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.

That is the whole install. The AI sets everything up, connects your tools, and asks you a few friendly questions (your name, what you are working on, what matters this week). About a minute later you are done.

Want to check it worked? Ask your AI: **"What am I working on?"** It will answer from your folder.

If anything ever looks off, run `npx dotaios doctor` and it will tell you what is wrong and how to fix it.

**Already use ChatGPT or Claude in your browser?** Those work too. After setup, open the file `~/aios/AGENTS.md`, copy what is inside, and paste it at the start of any chat. Your AI instantly knows your context.

## What you can do with it

Once it is set up, you can ask any connected AI things like:

- "Plan my day." It builds a plan from your priorities and your recent work.
- "Save this article for me." It tucks a web page or PDF into your notes as clean, readable text.
- "What did I decide about the launch?" It searches everything you have saved.
- "What am I working on?" It reads your context and answers from your folder.

Setup also links your skills into every tool that supports them, so the same workflows work in Claude Code, Cursor, Codex, Antigravity, and Hermes. Edit a skill once in `~/aios/skills/` and every connected tool sees the update.

You can also let it remember your conversations automatically, so your AI gets to know you better over time.

## It is just your files

Your folder lives at `~/aios` in your home directory. You can open it any time, read it, edit it, or move things around in any text editor. Nothing is hidden and nothing is locked away.

Inside, it looks roughly like this:

```
~/aios/
  context/   who you are (your name, work, priorities)
  memory/    what happened recently, and saved conversations
  vault/     articles, PDFs, and notes you have saved
  skills/    things you can ask your AI to do
```

If you ever want to read your memory on your phone, DotAIOS can mirror the folder to a private GitHub repository that only you can see. That part is optional, and you set it up with one command.

## Pillars

- **Local first.** No account, no server we run. Optional phone sync uses your own private GitHub repo.
- **Just files.** Plain Markdown and text, never a database. You can read everything yourself.
- **Out of the way.** Your AI tools read your folder directly. DotAIOS stays invisible.

## If you like the terminal

Comfortable with a terminal and have Node 20 or newer? You can run setup yourself:

```bash
npx dotaios setup
```

A few commands you will use most:

```bash
dotaios status              # check everything is connected and healthy
dotaios update "note"       # jot something to memory in one line
dotaios search "topic"      # search across everything you have saved
dotaios ingest <url|file>   # save an article, PDF, or document
dotaios brief               # write today's brief from your priorities
dotaios brief --lean        # print a small high-signal surface (identity, priorities, north-star, today, active project)
dotaios brief --compact     # print a compact working-memory digest for agents
dotaios skills resolve "plan my day"   # route an intent to the skill that handles it
dotaios plan "ship it" --steps "tests,implement"  # write a plan.md artifact agents pick up later
dotaios memory audit        # find bloated hot memory and skill-tied lessons
dotaios memory audit --apply-skills  # append explicit lessons to existing skills
dotaios sync setup          # mirror your folder to a private GitHub repo
dotaios export-okf          # export your knowledge as a portable Open Knowledge Format bundle
```

Run `dotaios --help` to see everything.

## Learn more

[Getting started](docs/getting-started.md) · [Saving conversations](docs/sessions.md) · [Phone sync and advanced memory](docs/advanced-memory.md) · [GitSync on mobile](docs/gitsync-mobile.md) · [Google Workspace](docs/google-workspace.md) · [Skill marketplace](docs/marketplace.md) · [Security](docs/security.md) · [Architecture](docs/architecture.md) · [OKF export](docs/okf.md)

## License

MIT
