# DotAIOS — Friend Setup (5 minutes)

A one-page recipe for getting DotAIOS running on your Mac so your AI tools (Claude Code, Cursor, Codex, Gemini) know who you are and what you're working on.

## What you need before starting

- A Mac (Linux works the same way; Windows is not officially tested yet).
- Node.js 20 or newer. Check with `node --version` in a terminal. If missing, install from [nodejs.org](https://nodejs.org/) — pick the "LTS" download.
- One AI tool installed already, such as Claude Code or Cursor.

You do **not** need a GitHub account, an npm account, or any cloud service.

## The 5 steps

### Step 1 — Create your DotAIOS folder

Open a terminal and run:

```bash
npx dotaios init
```

It asks five short questions: your name, what you do, what you're working on, which AI tools you use, and whether to link an external Markdown vault (say "no" if you don't have one).

When it finishes, your context lives in `~/aios/`. Open it in Finder or any text editor — every file is plain Markdown you can read and edit.

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

1. A folder at `~/aios/` with about 8 small Markdown files. You can open them. You can edit them. You own them.
2. Your AI tool answers personal questions correctly without you re-introducing yourself every session.
3. A `_index.md` your agents can scan to find specific files.

You can stop here. Everything below is optional.

## Optional: link a Cursor project

If you use Cursor on a specific repo, give that project access to your context:

```bash
npx dotaios attach /path/to/your/project
```

## Optional: Google Workspace (experimental)

This is a separate, harder setup that requires installing the Google Workspace CLI (`gws`) and going through Google's OAuth flow. **Skip this for the first pass.** Once your basic setup works, see [google-workspace.md](google-workspace.md) for the step-by-step.

## When something goes wrong

- **`npx: command not found`** — Install Node.js first.
- **`Unknown command`** — Type the command exactly as shown. They are case-sensitive.
- **Agent doesn't seem to know your context** — Restart the agent app after running `npx dotaios activate`. Most tools only re-read their config on launch.
- **You want to change something you typed in Step 1** — Open `~/aios/context/work.md` (or any other file in `context/`) in any text editor and edit it. Save. Done. Run `npx dotaios index` again to refresh the index.

## Optional: experimental MCP server

DotAIOS ships an experimental MCP server (`dotaios-mcp`) for tools that support the Model Context Protocol. This is **not** recommended for first-time setup — wire up the basic flow above first, then come back. See [mcp.md](mcp.md) when you're ready.

## Asking for help

Open an issue: <https://github.com/filocosta46/dotaios/issues>

Include:
- What command you ran.
- What you expected.
- What actually happened (paste the output).
- Your Node version (`node --version`).
