# Getting Started

DotAIOS creates a local `~/aios/` folder that your AI tools can read. Think of it as the shared notebook for your AI companion: context, memory, and skills stay on your machine as plain files.

> **Audience.** DotAIOS is for people moving between AI tools who want one
> private, readable place for useful context. You do not need to understand
> Node, npm, Git, or MCP. A local agent can handle the technical setup while
> previewing every change and leaving the meaningful choices to you.

```bash
npx dotaios@2.0.8 setup --dry-run
npx dotaios@2.0.8 setup
```

The published package name is `dotaios`. A shorter `aios` binary is also available once the package is installed or linked locally.

First-time setup stays pinned so the package, source tag, and integrity record
are reproducible. Later maintenance examples use `@latest` deliberately when
you choose to inspect or run the newest published release; no global install is
needed.

The recommended flow is the one request in [Friend Setup](friend-setup.md). The
agent checks Node, previews the exact changes, runs the pinned setup, verifies
it, and shows the one AIOS folder. The setup flow asks a few questions, creates starter context and memory files,
then adds managed bridge blocks or links for detected Claude Code, Codex, and
Gemini installations. Private sync remains off unless you explicitly opt in.

## Choose what this session may remember

- `Use my memory` selects **Memory: Shared** for personal continuity.
- `Only this project` selects **Memory: This project** and excludes personal,
  unscoped, and other-project memory.
- `Private chat` locks **Memory: Off**: DotAIOS does not read, search, save, or
  capture in that session. Your AI app may still retain its own chat history.

The receipt is visible in agent instructions, CLI output, and MCP responses.
Agent instruction files and MCP are bridges into the same AIOS folder, not
separate memory stores.

For Cursor or project-scoped agents, attach a project folder:

```bash
npx dotaios@latest project add /path/to/project --apply
npx dotaios@latest attach /path/to/project
```

The project catalog syncs the durable README and repository URL. Each machine
keeps its own checkout path outside the synced AIOS content. On another machine,
restore committed project state into the ignored managed workspace:

```bash
npx dotaios@latest migrate
npx dotaios@latest project restore <slug-or-id>
```

`migrate` is a read-only preview. On an older folder, run the exact
`migrate --apply <plan-id>` command it prints before restore. Restore refuses to
clone until schema 1.2 and the `/workspaces/` privacy boundary are active.

Run without a slug to restore every missing project, or add `--dry-run` to
preview. The project repository stays independent and never enters the AIOS Git
mirror; external checkout locations remain supported.

To point an assistant at a consultant or client asset folder, just tell it
where the folder is. Every assistant DotAIOS connects to reads local folders
natively, with no ceiling and nothing to wire up.

`dotaios project source connect <project> <folder>` is **deprecated**. It still
runs, but it lists file metadata only — never contents — and refuses entirely
past roughly 110-120 files, so it is strictly weaker than the assistant's own
file access. See [Projects across machines](projects.md) for the full reasoning
and the exact bounds.

For search, `--project` selects the portable project corpus by slug or stable
ID. `--session-project` filters session tags only. If an older command used
`--project` to filter session attribution, change it to `--session-project`.

After setup, read `FIRST_SESSION.md`, then open Claude Code, Codex, Gemini, Cursor, or another repo-aware assistant.

Use an external vault, such as an Obsidian folder, when you already have long-term notes:

```bash
npx dotaios@2.0.8 init --vault-path ~/my-vault
```

Check setup health:

```bash
npx dotaios@latest status
```

Keep your context fresh:

```bash
npx dotaios@latest interview --review
npx dotaios@latest context
npx dotaios@latest context work --edit
npx dotaios@latest context --refresh --review
```

Use `interview --review` when your role, active work, priorities, or planning style changes. It asks plain-English questions, previews the files it will update, and creates `context/preferences.md` plus planning prompts for supported skills.

If an assistant is doing this for you, it has no terminal to be asked in: it can ask you the same questions in the conversation and pass the answers with `interview --answers -`. Run `interview --help` for the field names.

Use `context` when you want to inspect the files directly. Use `context --refresh --review` after manual edits when you want to regenerate the agent entrypoints with a preview first.

Import context from old AI chats:

```bash
npx dotaios@latest import ./import.json --dry-run
npx dotaios@latest import ./import.json --apply
```

Save a file or URL into the vault:

```bash
npx dotaios@latest ingest ./notes.md
npx dotaios@latest ingest https://example.com/article
```

Route by purpose with `--to` to put things in the right place from the start:

```bash
npx dotaios@latest ingest research.pdf --to wiki --name ai-research           # lasting reference
npx dotaios@latest ingest brief.pdf --to company --name acme --apply          # org record
npx dotaios@latest ingest call-notes.txt --to signal                          # working note
```

Durable shelves (`wiki`, `company`, `person`) preview without `--apply` and will not write. A human picking the shelf interactively counts as approval.

Dynamic or paywalled pages may ingest partial content. If the saved markdown ends abruptly or misses expected sections, save the logged-in page as a PDF from your browser and ingest the PDF.

Save selected AI conversations locally so other agents on your machine can find what mattered:

```bash
npx dotaios@latest capture enable claude-code     # auto-save every Claude Code session
npx dotaios@latest capture import paste           # paste any conversation manually
npx dotaios@latest capture import claude-code     # backfill past sessions (last 30 days)
npx dotaios@latest capture list                   # browse saved conversations
npx dotaios@latest capture list --agent claude-code --since 7d
npx dotaios@latest search "any topic"             # search includes saved sessions
```

For agents that can write local files, you can also ask: "use save-session" or "save this session". It writes a clean summary with decisions, open threads, and action items.

Captured sessions do not silently change durable context. Use
`dotaios memory promote` to preview one explicit destination and add `--apply` only after the
change looks right. See [saving conversations](sessions.md).

Sessions you save or capture with an enabled adapter go to `~/aios/memory/sessions/` as plain Markdown files. See [sessions.md](sessions.md) and [adapters.md](adapters.md) for supported tools and capability levels.

Write today's local brief into your daily note:

```bash
npx dotaios@latest brief
```

Search your local AIOS files:

```bash
npx dotaios@latest search "daily planning" --scope skills
```

Validate and install a plugin from a reviewed local folder:

```bash
npx dotaios@latest install ./my-plugin --dry-run
npx dotaios@latest install ./my-plugin
```

DotAIOS refuses remote plugin URLs. Pin and download or clone the exact revision
yourself, inspect it outside DotAIOS, then run the local-folder dry run above.

List local manual schedules:

```bash
npx dotaios@latest schedule list
```

Your daily interface is your existing AI tool. You should not need to open DotAIOS directly except to check status, refresh your context, import material, ingest files, adopt reviewed local Agent Skill bundles, or run manual schedules.

Skills live in `~/aios/skills/<name>/SKILL.md`. Open any skill folder to see what it does, what it will not do, and how to ask for it. In Claude Code, skills appear as slash commands after `activate`; in other agents, ask naturally, such as "use the audit skill".

## Safety Flags

`init` will stop if the target folder already contains files. Use `--force` to add missing generated files while preserving existing files. Use `--overwrite` only when you intentionally want to replace generated files.

Never put passwords, private keys, or tokens in chat, context, memory, or vault
files. Prefer provider-owned authentication or the operating system password
manager. If a connection requires a local environment variable, `~/aios/.env`
is the ignored fallback; `doctor` checks that it is a private ordinary file
without reading its contents.

## Optional Connections

The core setup does not require external accounts. Google Workspace is a separate, optional connection powered by the free local `gws` CLI. It stays behind explicit `dotaios connect google` and read-only `dotaios google` commands. See [Google Workspace](google-workspace.md).

Lightpanda is also optional. It renders JavaScript-heavy pages during web ingest, while ordinary pages continue to use plain fetch when it is absent or fails. Interactive `dotaios setup` asks before downloading it. Non-interactive setup does not download it by default; `--install-lightpanda` is the explicit opt-in. The installer uses a pinned release, verifies its SHA-256 digest, and only then atomically installs an executable file.

## Project skills

Projects can carry their own skills without replacing your global library. Put
`SKILL.md` workflows under a project's `skills/` directory and run:

```bash
npx dotaios@latest attach /path/to/project
```

DotAIOS links project-owned skills into the checkout's Claude Code, shared
`.agents/skills` surface for Codex, Cursor, Gemini CLI, Kimi Code CLI, OpenCode,
and Antigravity IDE. Re-running the command is safe and preserves
foreign entries; use `--dry-run` to preview it. A native filesystem link is not
treated as proof that a particular client version will invoke the skill, so
runtime acceptance remains explicit. DotAIOS does not configure project-local
Hermes skills: Hermes loads configuration from its selected `HERMES_HOME`, and
`attach` does not own or change that runtime selector. Global skill links work
the same way:
`dotaios activate` links `~/aios/skills` into Claude Code, the shared Agent
Skills folder for Codex, Cursor, Gemini CLI, Kimi Code CLI, and OpenCode, the
Antigravity IDE global folder, and every existing Hermes root or discovered
profile configuration, then verifies filesystem/configuration propagation.
`dotaios skills doctor` reports configuration and filesystem projection
evidence per surface; it leaves discovery unprobed. A bounded client probe records invocation separately, while only
`produced=yes` proves that the client used the skill.
