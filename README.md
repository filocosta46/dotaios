# DotAIOS

[![npm version](https://img.shields.io/npm/v/dotaios.svg)](https://www.npmjs.com/package/dotaios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

**Dotfiles for AI agents.** Personal memory that makes every AI tool smarter.

---

You use Claude Code, Cursor, Codex, or Gemini — but they treat every session as if they've never met you. DotAIOS fixes that. Run setup once, answer five questions, activate your agent bridges, and every agent on your machine can find your name, your work, your priorities, and how you write.

DotAIOS is not a chat app, agent framework, SaaS, or cloud memory service. It's a folder convention (`~/aios/`) plus a CLI installer. Your context stays on your machine. Agent-native bridge files point your tools at it.

> `.gitconfig` makes Git know your name. `~/aios/` makes every AI agent know your life.

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
✔ What are you working on right now? › research project and weekly writing
✔ Which AI tools do you use? › Claude Code, Cursor
✔ Link an external vault (e.g. Obsidian)? › No

✅  Created ~/aios/
✅  Generated CLAUDE.md for Claude Code
✅  Generated AGENTS.md for Codex / Gemini
✅  Generated .cursorrules for Cursor
ℹ   Run `npx dotaios activate` to connect Claude, Codex, and Gemini.
```

Open Claude Code. Ask: **"What am I working on?"** — it answers correctly from your `work.md`.

For Cursor projects, run `npx dotaios attach /path/to/project` once to create a project rule.

## How it works

```
~/aios/
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

Open `~/aios/` in Finder, Explorer, or any file manager. Drag notes in. Edit Markdown in your editor of choice. Every agent on your machine sees the changes immediately. Run `dotaios reveal` to open the folder from any terminal.

## Commands

| Command | What it does |
|---------|-------------|
| `dotaios init` | Interactive setup — creates `~/aios/` with your context |
| `dotaios activate` | Connects DotAIOS to global Claude, Codex, and Gemini memory files |
| `dotaios attach <project>` | Adds DotAIOS bridges to a project folder, including Cursor rules |
| `dotaios reveal` | Opens `~/aios/` in Finder, Explorer, or your file manager |
| `dotaios status` | Health check — shows what's configured, what's missing |
| `dotaios context` | Shows, edits, or refreshes the context agents see |
| `dotaios index` | Generates `~/aios/_index.md` — a table of contents agents can use to find the right file fast |
| `dotaios search <query>` | Searches across memory, vault, context, and projects |
| `dotaios ingest <input>` | Universal Knowledge Router — saves a URL, PDF, document, text file, or binary asset into the vault as clean Markdown |
| `dotaios import <file>` | Previews or applies structured context from old AI chats |
| `dotaios connect google` | Verifies local `gws` auth and adds read-first Gmail/Calendar guidance |
| `dotaios google <cmd>` | Runs read-first Google Workspace workflows through `gws` |
| `dotaios mcp <cmd>` | Local MCP server — exposes AIOS over Model Context Protocol |
| `dotaios install <plugin>` | Installs a local plugin and registers its skills |
| `dotaios schedule <cmd>` | Lists, checks, or manually runs local schedules |
| `dotaios cleanup` | Trims stale signals and compacts the event log |

## Universal Knowledge Router

Throw any source at AIOS. The router translates it into clean Markdown your agents can read, with full provenance frontmatter (`source`, `ingested_at`, `kind`, `parser`, `title`, `tags`).

```bash
npx dotaios ingest https://example.com/article   # URL  → article extracted to vault/raw/
npx dotaios ingest research.pdf                  # PDF  → text + original preserved in vault/assets/
npx dotaios ingest notes.txt                     # text → frontmatter + body in vault/raw/
npx dotaios ingest archive.zip                   # unknown binary → vault/assets/ only
```

Documents are parsed locally — nothing is uploaded to any cloud service. PDFs use the bundled `unpdf` text extractor by default; install [marker-pdf](https://github.com/datalab-to/marker) for high-fidelity PDF / DOCX / PPTX / EPUB parsing with tables and math.

Use `--dry-run` to see exactly where an input would land before you commit. Use `--overwrite` to replace an earlier ingest.

## `dotaios` vs `aios`

`dotaios` is the npm package name. When installed globally, it also exposes `aios` as a shorter alias:

```bash
npx dotaios init      # always works via npx
aios status           # works after: npm install -g dotaios
```

## External vault

If you already use Obsidian, Logseq, or any Markdown-based notes app, point DotAIOS at your existing vault:

```bash
npx dotaios init --vault-path ~/my-vault
```

Your notes become agent-readable knowledge. Use `dotaios ingest` to index specific files, URLs, and PDFs into it. Dynamic or paywalled pages may ingest partial content; when an article ends abruptly, save the logged-in page as a PDF and ingest that file.

## Base skills

Five skills ship with DotAIOS, installed at `~/aios/skills/`:

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
npx dotaios google setup
npx dotaios connect google --status
npx dotaios connect google
npx dotaios google status
npx dotaios google inbox
npx dotaios google agenda --today
```

The beta scope is read-first: Gmail triage/search, Calendar agenda, meeting prep, and Drive/Docs/Sheets lookup. Sending email, creating events, or editing files should require explicit approval.

Google setup is still an assisted beta path. New users install `gws` with `npm install -g @googleworkspace/cli`, `brew install googleworkspace-cli`, or the GitHub release binary. They then need either `gws auth setup` with the Google Cloud CLI (`gcloud`) or a manually created Google Cloud OAuth client. DotAIOS makes the flow visible and safer; it does not yet hide Google Cloud setup behind a hosted OAuth app.

## Plugins

DotAIOS has a documented plugin contract. A plugin is a trusted local folder with a `manifest.json`, a `SKILL.md`, and optional source code.

```bash
dotaios install ./my-plugin
```

See [docs/plugin-development.md](docs/plugin-development.md) and [examples/plugins/hello-memory/](examples/plugins/hello-memory/) for a working example.

Do not install third-party plugins you have not reviewed. Permissions are visible before install, but they are not a sandbox.

See also: [getting-started](docs/getting-started.md), [friend-setup](docs/friend-setup.md), [architecture](docs/architecture.md), [beta-testing](docs/beta-testing.md), [google-workspace](docs/google-workspace.md), [mcp](docs/mcp.md), [context-import](docs/context-import.md), [plugin-development](docs/plugin-development.md), [schedules](docs/schedules.md), [security](docs/security.md).

## What's in v1.4

- **Universal Knowledge Router** — `dotaios ingest <input>` routes URLs, PDFs, documents, text files, and binaries into your vault as clean Markdown (see above).
- **Visible folder default** — AIOS lives at `~/aios/`. Drag files in, edit in any editor, see what your agents see.
- **`dotaios reveal`** — opens your AIOS folder in Finder / Explorer / file manager.
- **`dotaios index`** — generates `~/aios/_index.md`, a table of contents agents can use to navigate your vault fast.
- **Local MCP server** — `dotaios mcp` exposes AIOS over Model Context Protocol for agent tools that speak it.
- **Provenance everywhere** — every Markdown file written by ingest carries `source`, `parser`, `kind`, and `ingested_at` frontmatter for auditable memory.
- **Agent-native bridges** — auto-generated `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, plus per-tool entrypoints under `~/.claude/`, `~/.codex/`, and `~/.gemini/`.
- **`dotaios connect google`** — verifies local `gws` auth and adds read-first Gmail / Calendar / Drive workflows.
- **Five base skills** — `plan-today`, `audit`, `ingest`, `morning-digest`, `import-context`.

Not in v1.4: hosted Google OAuth, plugin marketplace, semantic search (SQLite FTS5), `upgrade` command, paid plugins, cloud sync.

## Principles

- **Local first** — no accounts, no server, no cloud sync by default
- **File based** — Markdown and JSONL, not databases
- **Agent native** — your existing AI tools read the context; DotAIOS is invisible infrastructure
- **Human controlled** — identity, knowledge, and CRM updates require explicit approval

## License

MIT
