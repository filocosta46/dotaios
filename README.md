# DotAIOS

**Stop re-explaining yourself to every AI.**

One folder on your computer. Who you are, what you are working on, what you saved. Every AI reads the same files. No account. No cloud memory.

## What it is

DotAIOS makes one folder on your computer, called `~/aios`. It holds the things your AI should always know about you: your name, your work, your priorities, and your notes. Claude, Cursor, Codex, and Gemini all read from it. There is no account, no website to log into, and nothing stored on anyone else's server. It is just files on your computer that belong to you.

Here is the simplest way to think about it. Your phone keeps your contacts in one place so every app can use them. DotAIOS keeps *you* in one place so every AI can use that.

And you never learn commands. Ask in plain words, and your AI picks the right workflow automatically.

## Get started

You will not type a single command. Your AI does the whole setup for you.

First, make sure you have one AI app on your computer. If you are not sure which to pick, start with Claude Code, the friendliest one.

- [Claude Code](https://claude.com/download), recommended
- [Cursor](https://www.cursor.com), an editor with AI built in
- [Codex](https://github.com/openai/codex) by OpenAI
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google

Then open that app, paste this one sentence into the chat, and press Enter:

> Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.

That is the whole install. The AI sets everything up, connects your tools, and asks you a few friendly questions (your name, what you are working on, what matters this week). About a minute later you are done.

Want to check it worked? Ask your AI: **"What am I working on?"** It will answer from your folder.

If anything ever looks off, just ask: **"Is everything connected?"** Your AI runs a quick connection check and tells you what needs attention.

**Already use ChatGPT, Claude, or Grok in your browser?** Those work too. After setup, open the file `~/aios/AGENTS.md`, copy what is inside, and paste it at the start of any chat. Your AI instantly knows your context.

## What you can ask

Once it is set up, ask any connected AI things like:

- "Plan my day." It builds a plan from your priorities and your recent work.
- "Save this article for me." It tucks a web page or PDF into your notes as clean, readable text.
- "What did I decide about the trip?" It searches everything you have saved.
- "Update my skills." It checks everything you have installed and freshens what changed.

Ask in your own words. You never name a skill or type a command; your AI routes the request to the right workflow on its own. The same asks work in every connected tool, and your AI can remember your conversations automatically, so it gets to know you better over time.

## It is just your files

Your folder lives at `~/aios` in your home directory. You can open it any time, read it, edit it, or move things around. Nothing is hidden and nothing is locked away.

```
~/aios/
  context/   who you are (your name, work, priorities)
  memory/    what happened recently, and saved conversations
  vault/     articles, PDFs, and notes you have saved
  skills/    things you can ask your AI to do
```

If you ever want to read your memory on your phone, DotAIOS can mirror the folder to a private space that only you can see. That part is optional.

## The folder is free. The packs are the shortcut.

Everything in the packs exists somewhere on the internet, free. We find it, test it, package it, and keep it updated every week, so you never have to.

- **[Skills, €12.99](https://filocosta.gumroad.com/l/tgaeui)**. The best skills, picked for you. The ones that actually matter for knowledge workers, curated from the whole internet and refreshed every week.
- **[Automations, €35](https://filocosta.gumroad.com/l/baglw)**. Real systems. Your AI works like a pro. Everything in Skills, plus complete working setups for research, transcripts, and memory. Full packaging, not pieces.

Each pack is one prompt. Paste it into your AI once: it installs everything, wires it into your folder, and keeps it updated.

## Pillars

- **Local first.** No account, no server we run. Optional phone sync uses your own private space.
- **Just files.** Plain Markdown and text, never a database. You can read everything yourself.
- **Out of the way.** Your AI tools read your folder directly. DotAIOS stays invisible.

## Want to go deeper?

Comfortable with a terminal, or curious how it works inside? Start with the [getting started guide](docs/getting-started.md). More: [saving conversations](docs/sessions.md) · [phone sync](docs/advanced-memory.md) · [security](docs/security.md) · [all guides](docs/).

## License

MIT
