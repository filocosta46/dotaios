# DotAIOS — Agent Setup Guide

> This document is written for AI agents (Claude Code, Codex, Gemini, Cursor).
> A human has asked you to set up DotAIOS for them.
> Follow each step in order. Do not skip steps. Do not ask the user about steps they don't need to see.

---

## Before you start

DotAIOS creates a folder at `~/aios/` that you and every other AI tool on this machine will read automatically. It holds context about who the user is, what they're working on, and skills you can run on their behalf.

Your job is to install it, connect it, learn a few things about the user through friendly conversation, and then explain what they now have access to.

---

## Step 1 — Check Node.js

Run this command and read the output:
```
node --version
```

- If it returns `v20.x.x` or higher → continue to Step 2.
- If it returns a version below 20 → tell the user: *"You need to update Node.js first. Go to nodejs.org, click the LTS button, and run the installer. Come back when it's done."* Wait for them to confirm before continuing.
- If the command fails entirely → tell the user: *"Node.js is not installed. Go to nodejs.org, click the LTS button, and run the installer. Come back when it's done."* Wait for them to confirm before continuing.

---

## Step 2 — Create the folder

Run:
```
npx dotaios init --yes
```

This creates `~/aios/` with empty context files. It takes about 30 seconds. Do not tell the user anything while it runs — just wait for it to finish. Say nothing if it succeeds.

---

## Step 3 — Connect to agent tools

Run:
```
npx dotaios activate
```

This writes small files that tell Claude Code, Codex, and Gemini where to find the user's context. Say nothing if it succeeds.

---

## Step 4 — Learn about the user (conversational — do not rush this)

Ask the user these questions **one at a time**. Wait for each answer before asking the next. Be warm and natural — you are having a conversation, not filling out a form.

After each answer, write it directly into the correct file using your file editing tools. Do not ask permission to write — just do it.

**Question 1:**
> "What's your name and what do you do for work?"

→ Write the answer to `~/aios/context/identity.md`. Replace the placeholder line under `## Basics` with their actual name and role. Leave the other sections as they are.

**Question 2:**
> "What are you currently working on? Can be one thing or a few — whatever's taking up your mental energy right now."

→ Write the answer to `~/aios/context/work.md`. Replace the content under `## Current Work` with what they said. Keep it in their words.

**Question 3:**
> "What matters most to you this week? What would make it a good week if it got done?"

→ Write the answer to `~/aios/context/priorities.md`. Replace the content under `## Current Bets` with what they said.

After all three answers, say:
> "Perfect. You can always update any of this later — just tell me, or run `dotaios interview` when things change."

**Optional — do not push this:**
> "One last thing: do you have a CV, bio, a document about your project, or anything else you'd like me to remember? If yes, drag it here or give me a link."

If they give you something:
- If it's a file or local path: run `npx dotaios ingest <path>`
- If it's a URL: run `npx dotaios ingest <url>`
- If they say no or skip: move on immediately, do not mention it again.

---

## Step 5 — Show them what they now have

Do NOT say "try asking me to plan your day" — the memory may not have enough information yet to do that well.

Instead, say something like this (adapt to what they told you):

> "You're set up. Here's what DotAIOS gives you now:
>
> **Your AI always knows who you are.** Every time you open Claude Code, Cursor, Codex, or Gemini, they'll read your context automatically — no re-introduction needed.
>
> **Skills you can use right now** (just ask me, or type `/` in Claude Code):
>
> - `/plan-today` — a structured plan for the day (works best after a few sessions)
> - `/today` — save today's plan to a daily note
> - `/closeday` — close the day and carry unfinished work forward
> - `/ingest` — save any article, PDF, or document into your memory vault
> - `/weekly-review` — review the week and update your context
> - `/audit` — check that your setup is healthy
>
> **A brief you can run any time:** `npx dotaios brief` writes today's local brief into your daily note.
>
> **How the system grows with you:**
> The more you use it, the more useful it gets. When a project changes, tell me and I'll update `work.md`. When your priorities shift, just say so. You can also drag any document in at any time and I'll save it to your vault.
>
> **One good first thing to try:** Ask me to run `npx dotaios brief`. It'll show you what DotAIOS can already give back from your local context."

---

## If something goes wrong

- `npx: command not found` → Node.js is not installed. Go back to Step 1.
- `EACCES` permission error → The user needs to fix npm permissions. See: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
- `Target already exists` → `~/aios/` already exists from a previous install. Run `npx dotaios init --force` instead.
- Anything else → Run `npx dotaios status` and show the output.

---

## For agents reading the GitHub repo

If a user pointed you at `https://github.com/filocosta46/dotaios` and asked you to set up DotAIOS, this is the file to follow. Start at Step 1 above.

### Installing third-party plugins
If the user already has DotAIOS set up and gives you a link to a different repository to install a skill/plugin:
1. `git clone <url> /tmp/dotaios-plugin`
2. `npx dotaios install /tmp/dotaios-plugin`
3. `rm -rf /tmp/dotaios-plugin`

The full documentation is in the `docs/` folder. The skills are in `skills/`. Everything is plain Markdown — you can read it all.
