# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

**Dotfiles for AI agents.** Personal memory that makes every AI tool smarter.

---

You use Claude Code, Cursor, Codex, or Gemini — but they treat every session as if they've never met you. DotAIOS fixes that. Run setup once, answer five questions, activate your agent bridges, and every agent on your machine can find your name, your work, your priorities, and how you write.

DotAIOS is not a chat app, agent framework, SaaS, or cloud memory service. It's a folder convention (`~/.aios/`) plus a CLI installer. Your context stays on your machine. Agent-native bridge files point your tools at it.

> `.gitconfig` makes Git know your name. `~/.aios/` makes every AI agent know your life.

## Install

```bash
npx dotaios init
npx dotaios activate
```

No global install. No account. No server.

## What happens

```
$ npx dotaios init

✔ What's your name? › Filippo
✔ What do you do? › student / researcher
✔ What are you working on right now? › MSc thesis on distributed systems
✔ Which AI tools do you use? › Claude Code, Cursor
✔ Link an external vault (e.g. Obsidian)? › No

✅  Created ~/.aios/
✅  Generated CLAUDE.md for Claude Code
✅  Generated AGENTS.md for Codex / Gemini
✅  Generated .cursorrules for Cursor
ℹ   Run `npx dotaios activate` to connect Claude, Codex, and Gemini.
```

Open Claude Code. Ask: **"What am I working on?"** — it answers correctly from your `work.md`.

For Cursor projects, run `npx dotaios attach /path/to/project` once to create a project rule.

## How it works

```
~/.aios/
├── CLAUDE.md           ← Claude Code entrypoint
├── AGENTS.md           ← Codex / Gemini / generic agent entrypoint
├── .cursorrules        ← legacy Cursor entrypoint
│
├── context/            ← who you are (always in context)
│   ├── identity.md
│   ├── work.md
│   ├── priorities.md
│   └── north-star.md
│
├── memory/             ← what happened recently (last 50 events)
├── vault/              ← long-term knowledge (loaded on demand)
└── skills/             ← what agents can do (/plan-today, /audit, ...)
```

`dotaios activate` creates small bridge files in the locations each tool actually reads, such as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`. `dotaios attach` adds project-level rules for Cursor and repo-aware agents.

## Commands

| Command | What it does |
|---------|-------------|
| `dotaios init` | Interactive setup — creates `~/.aios/` with your context |
| `dotaios activate` | Connects DotAIOS to global Claude, Codex, and Gemini memory files |
| `dotaios attach <project>` | Adds DotAIOS bridges to a project folder, including Cursor rules |
| `dotaios cleanup` | Trims stale signals and compacts the event log |
| `dotaios connect google` | Verifies local `gws` auth and adds read-first Gmail/Calendar guidance |
| `dotaios context` | Shows, edits, or refreshes the context agents see |
| `dotaios import <file>` | Previews or applies structured context from old AI chats |
| `dotaios search <query>` | Searches across memory, vault, context, and projects |
| `dotaios status` | Health check — shows what's configured, what's missing |
| `dotaios ingest <file>` | Saves a document to `vault/raw/` and indexes it |
| `dotaios install <plugin>` | Installs a local plugin and registers its skills |
| `dotaios schedule <cmd>` | Lists, checks, or manually runs local schedules |

## `dotaios` vs `aios`

`dotaios` is the npm package name. When installed globally, it also exposes `aios` as a shorter alias:

```bash
npx dotaios init      # always works via npx
aios status           # works after: npm install -g dotaios
```

## External vault

If you already use Obsidian, Logseq, or any Markdown-based notes app, point DotAIOS at your existing vault:

```bash
npx dotaios init --vault-path ~/Brain/Obsidian-Mind
```

Your notes become agent-readable knowledge. Use `dotaios ingest` to index specific files into it.

## Base skills

Five skills ship with DotAIOS, installed at `~/.aios/skills/`:

| Skill | What it does |
|-------|-------------|
| `plan-today` | Structures your day from `work.md` and `priorities.md` |
| `audit` | Reviews your context files for gaps and staleness |
| `ingest` | Classifies and routes a document into the right vault folder |
| `morning-digest` | Summarizes recent signals and surfaces today's priorities |
| `import-context` | Routes context exported from other AI chats |

Invoke them in Claude Code: `/plan-today`, `/audit`, etc.

## Google Workspace beta

DotAIOS can connect to Gmail, Calendar, Drive, Docs, and Sheets through the local Google Workspace CLI (`gws`). DotAIOS does not store Google OAuth credentials; it verifies `gws auth status`, writes a local connection note, and installs a read-first `google-workspace` skill.

```bash
npx dotaios connect google --dry-run
npx dotaios connect google --status
npx dotaios connect google
```

The beta scope is read-first: Gmail triage/search, Calendar agenda, meeting prep, and Drive/Docs/Sheets lookup. Sending email, creating events, or editing files should require explicit approval.

## Plugins

DotAIOS has a documented plugin contract. A plugin is a trusted local folder with a `manifest.json`, a `SKILL.md`, and optional source code.

```bash
dotaios install ./my-plugin
```

See [docs/plugin-development.md](docs/plugin-development.md) and [examples/plugins/hello-memory/](examples/plugins/hello-memory/) for a working example.

Do not install third-party plugins you have not reviewed. Permissions are visible before install, but they are not a sandbox.

For beta guidance, Google Workspace setup, context import prompts, schedules, and secrets policy, see:
[beta-testing](docs/beta-testing.md), [google-workspace](docs/google-workspace.md), [context-import](docs/context-import.md), [schedules](docs/schedules.md), and [security](docs/security.md).

## v1.2.x scope

- `dotaios init` / `status` / `ingest` / `install`
- `dotaios activate` / `attach` / `context` / `import` / `schedule`
- `dotaios search` / `cleanup`
- `dotaios connect google` for local `gws`-backed Google Workspace setup
- Auto-generated agent entrypoints (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`)
- Agent-native bridges for Claude Code, Codex, Gemini, and Cursor projects
- Full memory system: append, filter, compact, trim, search
- Schema versioning via `aios.json`
- Documented plugin manifest contract
- Five base skills

Not in v1.2: custom Gmail OAuth plugin, MCP server, semantic search (SQLite FTS5), `upgrade` command, paid plugins, cloud sync, plugin marketplace.

## Principles

- **Local first** — no accounts, no server, no cloud sync by default
- **File based** — Markdown and JSONL, not databases
- **Agent native** — your existing AI tools read the context; DotAIOS is invisible infrastructure
- **Human controlled** — identity, knowledge, and CRM updates require explicit approval

## License

MIT
