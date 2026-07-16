# DotAIOS

**Stop re-explaining yourself to every AI.**

One folder on your computer. Who you are, what you are working on, what you saved. Supported local agents can be configured to read the same files. No DotAIOS account or hosted memory service.

## What it is

DotAIOS makes one folder on your computer, called `~/aios`. It holds the things your agents should know about you: your work, priorities, projects, and saved knowledge. DotAIOS connects that folder to supported local agents. The files stay readable, portable, and yours.

Here is the simplest way to think about it. Your phone keeps your contacts in one place so connected apps can use them. DotAIOS keeps your context in one place so supported agents can use it.

You can stay in plain language. Once connected, your local agent can match a request to an installed workflow. The connection check tells you what is actually available in that client.

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

**Already use ChatGPT, Claude, or Grok in your browser?** A browser chat cannot open a folder on your computer by itself. Paste the relevant context or attach the files you want it to use. DotAIOS can help you prepare a small privacy-safe brief for that.

## What you can ask

Once it is set up, ask any connected AI things like:

- "Plan my day." It builds a plan from your priorities and your recent work.
- "Save this article for me." It tucks a web page or PDF into your notes as clean, readable text.
- "What did I decide about the trip?" It searches everything you have saved.
- "Is everything connected?" It checks the local setup and explains anything that needs attention.

Ask in your own words. Connected agents use the installed workflows when they match your request. Saving is explicit by default. Supported local adapters can also save sessions after you enable them.

## It is just your files

Your folder lives at `~/aios` in your home directory. You can open it any time, read it, edit it, or move things around. Nothing is hidden and nothing is locked away.

```
~/aios/
  context/   who you are (your name, work, priorities)
  projects/  one durable record for every project you own
  memory/    what happened recently, and saved conversations
  vault/     articles, PDFs, and notes you have saved
  skills/    things you can ask your AI to do
```

If you ever want to read your memory on your phone, DotAIOS can mirror the folder to a private space that only you can see. That part is optional.

## The folder is free. Outcome packs are coming next.

The planned packs are for people who want better results without researching prompts, plugins, or agent setup. They will be sold by the work they help you finish, not by the number of files inside.

- **Guided work, planned at €12.99.** Better writing, research, applications, CRM work, and design guidance, tested as complete agent workflows.
- **Done-for-you systems, planned at €35.** Hand repeatable work to your agent with guided setups, verification, and clear operating instructions.

Both packs are still in preparation. There is no checkout or delivery claim until the packages and update path are ready.

## Pillars

- **Local first.** No DotAIOS account or server. Optional phone sync uses your own private GitHub repository. Your chosen AI provider still processes any context you send to it.
- **Just files.** Plain Markdown and text, never a database. You can read everything yourself.
- **Out of the way.** Supported local agents can read the folder directly after configuration. DotAIOS stays invisible.

## Want to go deeper?

Comfortable with a terminal, or curious how it works inside? Start with the [getting started guide](docs/getting-started.md). More: [projects across machines](docs/projects.md) · [client support](docs/client-support.md) · [saving conversations](docs/sessions.md) · [phone sync](docs/advanced-memory.md) · [security](docs/security.md) · [all guides](docs/).

## License

MIT
