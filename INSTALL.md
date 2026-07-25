# DotAIOS: Agent Setup Guide

> This document is written for local AI agents such as Claude Code, Codex, Gemini CLI, and Cursor.
> A human has asked you to set up DotAIOS for them.
> Follow each step in order. Do not skip steps. Prefer running commands yourself
> so the human stays in chat. They are expected to already use a local agent and
> have (or can get) Node / `npx` on this machine.

---

## Before you start

DotAIOS creates a folder at `~/aios/` that connected AI tools on this machine
can read. It holds context about who the user is, what they're working on, and
skills you can run on their behalf. DotAIOS verifies the bridge files, native
skill links, and Hermes configuration it writes; discovery and invocation still
depend on each client and version.

Your job: install it, connect it, learn a few things about the user through
friendly conversation, then explain what they now have.

Run every command yourself when you can. Only hand off to the user for
Node install if every automated path fails.

**Prerequisite:** you need file-editing tools (Claude Code, Cursor, Codex, and
Antigravity all qualify), Step 4 edits the user's context files for them.

---

## Step 1: Make sure Node.js 20+ is available

Run:
```
node --version
```

- Returns `v20.x.x` or higher → continue to Step 2.
- Returns a lower version, or the command fails → **install Node.js yourself**,
  then re-check. Do not send the user to a download page unless automated install
  is impossible.
  - **macOS** with Homebrew (`brew --version` succeeds): `brew install node`
  - **macOS** without Homebrew: install nvm, then load it **in this same shell**
    (do not "open a new shell", that doesn't work when you are driving one session):
    `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash`
    then `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts`
  - **Windows**: `winget install OpenJS.NodeJS.LTS`
  - **Linux**:
    `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash`
    then `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts`
- Only if every automated path fails: hand off to the user with exact,
  click-by-click steps (do not just say "install Node"):
  > "I need Node.js to continue, it's a free, safe install, about 2 minutes:
  > 1. Open **https://nodejs.org** in your browser.
  > 2. Click the big green **LTS** button to download the installer.
  > 3. Open the downloaded file and click **Continue / Next / Agree** through the
  >    default options until it says it's finished.
  > 4. Tell me **done** and I'll take it from here."

  Wait for them to confirm, then re-run `node --version`.

After installing, run `node --version` again and confirm it reports `v20.x.x` or
higher before continuing.

---

## Step 2: Create the folder

Run:
```
npx -y dotaios@latest init --yes
```

(The `-y` answers npx's first-run "Ok to proceed?" prompt for you, so it never
stalls waiting on you.) This scaffolds `~/aios/` with placeholder context files. It takes about 30
seconds. Wait for it to finish. Say nothing to the user while it runs.

Do **not** run `npx dotaios@latest setup`. That command is the interactive path for a
human sitting at a terminal. You are on the agent path: `init` then `activate`,
with the interview done by you in Step 4.

---

## Step 3: Connect the user's AI tools

Run:
```
npx -y dotaios@latest activate
```

This writes small bridge files for detected clients with a documented global
context path, including Claude Code, Codex, and Gemini CLI. Cursor context is
connected per project with `dotaios attach`. DotAIOS also links skills to the
documented local targets. A link proves configuration, not runtime invocation.

After activation, verify the filesystem contract with:
```
npx -y dotaios@latest skills doctor --json
```

Treat any foreign aliases or collisions as visible review items. Do not delete
them automatically; they may belong to another tool.

If the repository you are opening owns a project-local `skills/` directory,
register and attach that checkout too:
```
npx -y dotaios@latest project add /path/to/project --path ~/aios
npx -y dotaios@latest attach /path/to/project --path ~/aios
```
The project record and repository URL can sync, while the checkout path stays
local to this machine. The real repository remains outside AIOS with its own
Git history. Project skills stay separate from the global AIOS library and
foreign project entries are preserved. Use `--dry-run` first when attaching an
existing repo.

---

## Step 4: Learn about the user (conversational, do not rush this)

Ask these three questions **one at a time**. Wait for each answer before asking
the next. Be warm and natural, you are having a conversation, not filling out a
form.

After each answer, write it directly into the correct file using your
file-editing tools. Do not ask permission to write, just do it.

**Question 1:**
> "What's your name, and what do you do for work?"

→ Write to `~/aios/context/identity.md`. Replace the two placeholder lines under
`## Basics` (`- Name:` and `- Role:`) with their name and role. Leave the other
sections as they are.

**Question 2:**
> "What are you working on right now? One thing or a few, whatever's taking up
> your mental energy."

→ Write to `~/aios/context/work.md`. Replace the content under `## Current Work`
with what they said. Keep it in their words.

**Question 3:**
> "What matters most this week? What would make it a good week if it got done?"

→ Write to `~/aios/context/priorities.md`. Replace the content under
`## Current Bets` with what they said.

After all three answers, say:
> "Perfect. You can change any of this later, just tell me, or run
> `npx dotaios@latest interview --review` when things shift."

**Optional, do not push this:**
> "Anything else you'd like me to remember, a CV, a bio, a doc about your
> project? Drag it here or give me a link."

If they give you something:
- A file or local path → run `npx dotaios@latest ingest <path>`
- A URL → run `npx dotaios@latest ingest <url>`
- They say no or skip → move on immediately, do not mention it again.

---

## Step 5: Reflect it back, then show them what they have

First, a short honest recap so the setup *lands*, built only from their three
answers. Adapt it to their exact words:

> "Quick recap so you know it landed: you're **{name}**, working on **{work}**,
> and this week is really about **{priority}**. If I had to pick one thing to
> start on today, it'd be **{one concrete thing pulled from their priority}**, > want me to take a first pass at it now?"

Rules for the recap:
- Use **only** what they told you in the three questions. Invent nothing.
- Pick **exactly one** concrete thing. If you genuinely can't infer one from
  their priority, ask *"what's the first step?"* instead of making one up.
- Do **not** over-promise capability, the memory is still thin. This is a
  reflection plus one grounded suggestion, not a claim. In particular, do **not**
  say "try asking me to plan your day"; `/plan-today` works best after a few
  sessions.

Then show them what they now have (adapt it to what they told you):

> "Here's what DotAIOS gives you now:
>
> **Your supported local agents now point to the same folder.** Claude Code,
> Codex, and Gemini CLI receive their documented global bridge when detected.
> Cursor receives project context after `dotaios attach`. Browser chats cannot
> open local paths; attach the relevant files or paste a small privacy-safe
> brief. Native skill discovery remains client-specific and `skills doctor`
> reports configuration coverage, not guaranteed invocation.
>
> **Skills you can use right now**, just ask me, or type `/` in Claude Code:
>
> - `/plan-today`, a structured plan for the day (works best after a few sessions)
> - `/today`, save today's plan to a daily note
> - `/closeday`, close the day and carry unfinished work forward
> - `/ingest`, save any article, PDF, or document into your vault
> - `/weekly-review`, review the week and update your context
> - `/memory-maintenance`, find what stopped being true and retire it
> - `/audit`, check that your setup is healthy
>
> **A brief any time:** `npx dotaios@latest brief` writes today's local brief into your
> daily note.
>
> **It grows with you.** When your work or priorities change, tell me and I'll
> update the files. You can drag any document in at any time."

**Optional extras, mention them, but do not set them up now.** Tell the user
these exist and that they can turn them on whenever they want:

- **Cross-device sync**, read your memory on your phone: `npx dotaios@latest sync setup`
- **Save conversations**, keep AI sessions as local memory:
  `npx dotaios@latest capture enable claude-code`
- **Daily brief on a schedule**, `~/aios/` ships a pre-wired daily brief
  schedule; run `npx dotaios@latest schedule install --dry-run` to see how to enable it
  with the computer's own scheduler.

Do not run these during first-time setup. Keep the first run minimal.

---

## If something goes wrong

- `npx: command not found` → Node.js is not installed. Go back to Step 1 and
  install it yourself.
- `EACCES` permission error → npm permissions need fixing. See:
  https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
- `Target already exists` → `~/aios/` already exists from a previous install. Run
  `npx dotaios@latest init --force --yes` instead.
- Anything else → run `npx dotaios@latest status` and read the output.

---

## For agents reading the GitHub repo

If a user pointed you at `https://github.com/filocosta46/dotaios` and asked you to
set up DotAIOS, this is the file to follow. Start at Step 1 above.

### Installing third-party plugins
If the user already has DotAIOS set up and gives you a link to a different
repository to install a skill or plugin:
1. `git clone <url> /tmp/dotaios-plugin`
2. `npx dotaios@latest install /tmp/dotaios-plugin`
3. `rm -rf /tmp/dotaios-plugin`

The full documentation is in the `docs/` folder. The skills are in `skills/`.
Everything is plain Markdown, you can read it all.
