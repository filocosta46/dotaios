# DotAIOS — Friend Setup (5 minutes)

A one-page recipe for getting DotAIOS running on your Mac so your AI tools (Claude Code, Cursor, Codex, Gemini) know who you are, what you're working on, and how to help without asking you to re-explain everything.

## What you need before starting

- A Mac (Linux works the same way; Windows is not officially tested yet).
- Node.js 20 or newer. Check with `node --version` in a terminal. If missing, install from [nodejs.org](https://nodejs.org/) — pick the "LTS" download.
- One AI tool installed already, such as Claude Code or Cursor.

You do **not** need a GitHub account, an npm account, or any cloud service.

## Before you paste anything: open Terminal

The commands below run inside the **Terminal app** on your computer. They will not work if you paste them into ChatGPT, Gemini in a browser, or any chat window.

- **Mac:** press `⌘ + space`, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `cmd`, press Enter.
- **Linux:** open whichever shell you normally use.

A small black-and-white window opens. Every command in this guide is pasted into that window, one line at a time.

## The fast path (one command)

```bash
npx dotaios setup
```

This runs the three steps below in sequence and opens your new folder when finished. If you want to understand each step or troubleshoot, follow the manual path instead.

## The manual path (5 steps)

### Step 1 — Create your DotAIOS folder

In the Terminal you just opened, run:

```bash
npx dotaios init
```

It asks five short questions: your name, what you do, what you're working on right now, what matters most this week, and which AI tools you use. To link an external Markdown vault, pass `--vault-path /path/to/vault` (or skip — DotAIOS creates one inside `~/aios/` by default).

When it finishes, your context lives in `~/aios/`. Open it in Finder or any text editor — every file is plain Markdown you can read and edit.

Later, when your work or priorities change, you do not need to hunt through files. Run `npx dotaios interview --review` and answer a few short questions. DotAIOS previews the updates before saving them.

**Expected output:**

```
DotAIOS initialized
AIOS path: /Users/you/aios
Vault path: /Users/you/aios/vault
Files: 26 created, 0 updated, 0 kept

Next steps:
1. Read FIRST_SESSION.md
2. Run `npx dotaios activate` to connect DotAIOS to your agent tools
3. Optional: run `npx dotaios connect google --dry-run` for Gmail/Calendar beta setup
4. Open Claude Code, Codex, Gemini, Cursor, or another agent-aware tool
5. Run `npx dotaios context` whenever you want to inspect what agents see
```

### Step 2 — Connect it to your AI tools

```bash
npx dotaios activate
```

This creates small bridge files where each tool actually looks for memory (e.g. `~/.claude/CLAUDE.md`). It does not log into any service. It does not send anything anywhere.

**Expected output (varies by which tools you have installed):**

```
DotAIOS activated
[created] /Users/you/.claude/CLAUDE.md
[created] /Users/you/.codex/AGENTS.md
[created] /Users/you/.gemini/GEMINI.md

For Cursor project rules, run `dotaios attach <project-dir>` inside a project.
```

If a tool's memory file already existed before, you'll see `[kept]` instead of `[created]` for that one — that's normal and safe. DotAIOS won't overwrite existing files unless you pass `--overwrite`.

### Step 3 — Build your index

```bash
npx dotaios index
```

This generates `~/aios/_index.md` — a table of contents your agents can use to find the right file fast. Run it whenever you add new notes.

**Expected output:**

```
Indexed 7 markdown file(s) across 3 section(s).
Wrote /Users/you/aios/_index.md
```

(File and section counts grow as you add notes to your vault.)

### Step 4 — Verify it works

```bash
npx dotaios status
```

You should see green checks and your name from Step 1. Then run a search:

```bash
npx dotaios search "your name"
```

You should see results from your `~/aios/context/` files.

### Step 5 — Ask your agent

Open the AI tool you use most. Ask it:

```
What am I working on?
```

It should answer using the work description you typed in Step 1. If it does — DotAIOS is wired in.

## What does success look like

After all 5 steps, you have:

1. A folder at `~/aios/` with small Markdown files for context, memory, vault notes, and skill folders. You can open them. You can edit them. You own them.
2. Your AI tool answers personal questions correctly without you re-introducing yourself every session.
3. A `_index.md` your agents can scan to find specific files.
4. Skill folders in `~/aios/skills/` that explain what each skill does, what it does not do, and how to trigger it.

Each morning you can run `npx dotaios brief` to get a local summary of today's priorities, open loops, and carry-over from yesterday, written directly into `memory/daily/`. Your `~/aios/schedules.yml` has a pre-wired daily schedule you can enable whenever you're ready.

You can stop here. Everything below is optional.

## Optional: link a Cursor project

If you use Cursor on a specific repo, give that project access to your context:

```bash
npx dotaios attach /path/to/your/project
```

## Optional: Google Workspace (experimental)

This is a separate, harder setup that requires installing the Google Workspace CLI (`gws`) and going through Google's OAuth flow. **Skip this for the first pass.** Once your basic setup works, see [google-workspace.md](google-workspace.md) for the step-by-step.

## When something goes wrong

Run this first — it tells you what is missing in one screen:

```bash
npx dotaios doctor
```

Common issues:

- **Nothing happens / the command outputs strange characters** — You probably pasted it into ChatGPT, Gemini in a browser, or another chat window. Open the Terminal app (Mac: `⌘+space` → Terminal. Windows: `cmd`). Re-paste there.
- **`npx: command not found`** — Install Node.js first from [nodejs.org](https://nodejs.org/).
- **`Unknown command`** — Type the command exactly as shown. They are case-sensitive.
- **`interactive terminal required`** — Same fix as the first item. Use the real Terminal app.
- **Agent doesn't seem to know your context** — Restart the agent app after running `npx dotaios activate`. Most tools only re-read their config on launch.
- **You want to change something you typed in Step 1** — Run `npx dotaios interview --review`. It asks the important questions again and shows the file updates before saving. If you prefer editing by hand, open `~/aios/context/work.md` or another file in `context/`, save it, then run `npx dotaios context --refresh --review`.

## Optional: experimental MCP server

DotAIOS ships an experimental MCP server (`dotaios-mcp`) for tools that support the Model Context Protocol. This is **not** recommended for first-time setup — wire up the basic flow above first, then come back. See [mcp.md](mcp.md) when you're ready.

## Asking for help

Open an issue: <https://github.com/filocosta46/dotaios/issues>

Include:
- What command you ran.
- What you expected.
- What actually happened (paste the output).
- Your Node version (`node --version`).
