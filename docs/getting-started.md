# Getting Started

DotAIOS creates a local `~/aios/` folder that your AI tools can read. Think of it as the shared notebook for your AI companion: context, memory, and skills stay on your machine as plain files.

> **Audience.** DotAIOS free core is for people already using local agents and comfortable with Node / `npx`. A local agent can still run setup for you via [INSTALL.md](../INSTALL.md). The commands below are the direct terminal path. See the [README](../README.md) for the product promise and honest limits.

```bash
npx dotaios@latest init
npx dotaios@latest activate
```

The published package name is `dotaios`. A shorter `aios` binary is also available once the package is installed or linked locally.

Setup and upgrade commands use `npx dotaios@latest ...`: no global install is
needed, and `@latest` always fetches the newest published release rather than a
cached older copy. Later examples in this guide drop `@latest` for brevity —
add it whenever you want to be sure you are on the current version.

The init flow asks five questions, then creates starter context and memory files. `activate` creates small bridge files in the global memory locations used by Claude Code, Codex, and Gemini.

For Cursor or project-scoped agents, attach a project folder:

```bash
npx dotaios project add /path/to/project
npx dotaios attach /path/to/project
```

The project catalog syncs the durable README and repository URL. Each machine
keeps its own checkout path outside the synced AIOS content. The project source
repository stays independent and is never copied into `~/aios`.

After setup, read `FIRST_SESSION.md`, then open Claude Code, Codex, Gemini, Cursor, or another repo-aware assistant.

Use an external vault, such as an Obsidian folder, when you already have long-term notes:

```bash
npx dotaios init --vault-path ~/my-vault
```

Check setup health:

```bash
npx dotaios status
```

Keep your context fresh:

```bash
npx dotaios interview --review
npx dotaios context
npx dotaios context work --edit
npx dotaios context --refresh --review
```

Use `interview --review` when your role, active work, priorities, or planning style changes. It asks plain-English questions, previews the files it will update, and creates `context/preferences.md` plus planning prompts for supported skills.

Use `context` when you want to inspect the files directly. Use `context --refresh --review` after manual edits when you want to regenerate the agent entrypoints with a preview first.

Import context from old AI chats:

```bash
npx dotaios import ./import.json --dry-run
npx dotaios import ./import.json --apply
```

Save a file or URL into the vault:

```bash
npx dotaios ingest ./notes.md
npx dotaios ingest https://example.com/article
```

Route by purpose with `--to` to put things in the right place from the start:

```bash
npx dotaios ingest research.pdf --to wiki --name ai-research           # lasting reference
npx dotaios ingest brief.pdf --to company --name acme --apply          # org record
npx dotaios ingest call-notes.txt --to signal                          # working note
```

Durable shelves (`wiki`, `company`, `person`) preview without `--apply` and will not write. A human picking the shelf interactively counts as approval.

Dynamic or paywalled pages may ingest partial content. If the saved markdown ends abruptly or misses expected sections, save the logged-in page as a PDF from your browser and ingest the PDF.

Save selected AI conversations locally so other agents on your machine can find what mattered:

```bash
npx dotaios capture enable claude-code     # auto-save every Claude Code session
npx dotaios capture import paste           # paste any conversation manually
npx dotaios capture import claude-code     # backfill past sessions (last 30 days)
npx dotaios capture list                   # browse saved conversations
npx dotaios capture list --agent claude-code --since 7d
npx dotaios search "any topic"             # search includes saved sessions
```

For agents that can write local files, you can also ask: "use save-session" or "save this session". It writes a clean summary with decisions, open threads, and action items.

Captured sessions do not silently change durable context. Use
`dotaios memory promote` to preview one explicit destination and add `--apply` only after the
change looks right. See [saving conversations](sessions.md).

Sessions you save or capture with an enabled adapter go to `~/aios/memory/sessions/` as plain Markdown files. See [sessions.md](sessions.md) and [adapters.md](adapters.md) for supported tools and capability levels.

Write today's local brief into your daily note:

```bash
npx dotaios brief
```

Search your local AIOS files:

```bash
npx dotaios search "daily planning" --scope skills
```

Validate and install a plugin (trusted local folder or reviewed git URL):

```bash
npx dotaios install ./my-plugin --dry-run
npx dotaios install ./my-plugin
npx dotaios install https://github.com/example/my-plugin.git
npx dotaios install https://github.com/owner/repo.git --subdir packages/my-plugin
```

Browse the public outcome catalog. Draft entries are visible as coming soon but cannot be purchased or installed:

```bash
npx dotaios market list
npx dotaios market info <id>
npx dotaios market install <id>
```

When a paid package is released, its publisher can require a license key:

```bash
npx dotaios license add <product-id> <license-key>
npx dotaios license list
```

See [marketplace.md](marketplace.md) for the full publishing flow.

List local manual schedules:

```bash
npx dotaios schedule list
```

Your daily interface is your existing AI tool. You should not need to open DotAIOS directly except to check status, refresh your context, import material, ingest files, install trusted local plugins, or run manual schedules.

Skills live in `~/aios/skills/<name>/SKILL.md`. Open any skill folder to see what it does, what it will not do, and how to ask for it. In Claude Code, skills appear as slash commands after `activate`; in other agents, ask naturally, such as "use the audit skill".

## Safety Flags

`init` will stop if the target folder already contains files. Use `--force` to add missing generated files while preserving existing files. Use `--overwrite` only when you intentionally want to replace generated files.

Store secrets in `~/aios/.env`, not in chat or memory files. The generated `.gitignore` ignores `.env`, token files, credentials, and private keys.

## Optional Connections

The core setup does not require external accounts. Google Workspace is a separate, optional connection powered by the free local `gws` CLI. It stays behind explicit `dotaios connect google` and read-only `dotaios google` commands. See [Google Workspace](google-workspace.md).

Lightpanda is also optional. It renders JavaScript-heavy pages during web ingest, while ordinary pages continue to use plain fetch when it is absent or fails. Interactive `dotaios setup` asks before downloading it. Non-interactive setup does not download it by default; `--install-lightpanda` is the explicit opt-in. The installer uses a pinned release, verifies its SHA-256 digest, and only then atomically installs an executable file.

## Project skills

Projects can carry their own skills without replacing your global library. Put
`SKILL.md` workflows under a project's `skills/` directory and run:

```bash
npx dotaios attach /path/to/project
```

DotAIOS links project-owned skills into the checkout's Claude Code,
Agent-Skills, Antigravity, and Hermes project surfaces. Re-running the command
is safe and preserves foreign entries; use `--dry-run` to preview it. A native
filesystem link is not treated as proof that a particular client version will
invoke the skill, so runtime acceptance remains explicit. Global skill links
work the same way: `dotaios activate` links `~/aios/skills` into Claude Code,
the shared Agent-Skills folder (Codex, Cursor, Gemini, Warp, VS Code),
Antigravity, and Hermes, verifies filesystem propagation, and `dotaios skills
doctor` reports configured / discoverable / invoked status per surface.
