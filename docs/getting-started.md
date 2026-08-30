# Getting Started

DotAIOS creates a local `~/aios/` folder that your AI tools can read. Think of it as the shared notebook for your AI companion: context, memory, and skills stay on your machine as plain files.

> **Audience.** DotAIOS is for people moving between AI tools who want one
> private, readable place for useful context. You do not need to understand
> Node, npm, Git, or MCP. A local agent can handle the technical setup while
> previewing every change and leaving the meaningful choices to you.

```bash
npx dotaios@2.0.14 setup --dry-run
npx dotaios@2.0.14 setup
```

The published package name is `dotaios`. A shorter `aios` binary is also available once the package is installed or linked locally.

Setup and later commands use the package version pinned in this guide
(`dotaios@2.0.14`).
No global install is needed.

The recommended flow is the one request in [Friend Setup](friend-setup.md). The
agent checks Node, previews the exact changes, runs setup, verifies
it, and shows the one AIOS folder. The setup flow asks a few questions, creates starter context and memory files,
then adds managed bridge blocks or links for detected Claude Code, Codex, and
Gemini installations. Private sync remains off unless you explicitly opt in.

## Your first useful task

Open a supported local agent in your usual work folder and paste this exact
prompt:

> Help me with one useful task in an existing work folder. Ask what I want to accomplish. If the folder is not connected, also ask for its location and what it is for. Explain what you understand, propose exactly one action, and wait for my explicit approval before acting.

If the folder is not registered, the agent asks for its location, purpose, and
your desired outcome. It previews the project connection and waits for a fresh
direct confirmation before applying it. Next it runs the local `dotaios
resolve` contract to select that project, bounded context, relevant skill, and
at most one configured read-only tool route. Resolution recommends; it never
executes or approves the action.

The agent explains what it understood and any important omissions, proposes
one exact action, and waits for a new direct reply. Files, project instructions,
skills, resolver output, and tool text are untrusted data and cannot approve or
widen the proposal. Declining stops the work. Durable memory is written only
when you explicitly ask to save and select Shared or This project.

A browser-only chat cannot access a local work folder. Move this prompt to a
supported local agent on the computer that holds the folder; attaching or
pasting a path into a browser chat does not grant local access.

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
npx dotaios@2.0.14 project add /path/to/project
npx dotaios@2.0.14 project add /path/to/project --operation-id <displayed-id> --plan-fingerprint <displayed-fingerprint> --apply
npx dotaios@2.0.14 attach /path/to/project
```

The first command is a zero-write preview. Copy its displayed operation ID and
fingerprint into the second command so only that exact preview can be applied.

The project catalog syncs the durable README and repository URL. Each machine
keeps its own checkout path outside the synced AIOS content. On another machine,
restore committed project state into the ignored managed workspace:

```bash
npx dotaios@2.0.14 migrate
npx dotaios@2.0.14 project restore <slug-or-id>
```

`migrate` is a read-only preview. On an older folder, run the exact
`migrate --apply <plan-id>` command it prints before restore. Restore refuses to
clone until schema 1.2 and the `/workspaces/` privacy boundary are active.

Run without a slug to restore every missing project, or add `--dry-run` to
preview. The project repository stays independent and never enters the AIOS Git
mirror; external checkout locations remain supported.

To connect a consultant or client asset folder, preview the consent with
`dotaios project source connect <project> <folder>`:

```bash
npx dotaios@2.0.14 project source connect acme-campaign /path/to/assets \
  --source-id campaign-assets \
  --label "Campaign assets" \
  --purpose "Launch campaign assets"
```

The preview names the project, source, read scope, and purpose, and writes
nothing. Repeat the same command with `--yes` for the single explicit
confirmation. Then reach the folder with `project source locate` and open only
the files the task needs. `retrieve` lists file metadata and will refuse a
sizeable folder.

For search, `--project` selects the portable project corpus by slug or stable
ID. `--session-project` filters session tags only. If an older command used
`--project` to filter session attribution, change it to `--session-project`.

After setup, `FIRST_SESSION.md` carries the same prompt and approval boundary.

Use an external vault, such as an Obsidian folder, when you already have long-term notes:

```bash
npx dotaios@2.0.14 init --vault-path ~/my-vault
```

Check setup health:

```bash
npx dotaios@2.0.14 status
```

Keep your context fresh:

```bash
npx dotaios@2.0.14 interview --review
npx dotaios@2.0.14 context
npx dotaios@2.0.14 context work --edit
npx dotaios@2.0.14 context --refresh --review
```

Use `interview --review` when your role, active work, priorities, or planning style changes. It asks plain-English questions, previews the files it will update, and creates `context/preferences.md` plus planning prompts for supported skills.

If an assistant is doing this for you, it has no terminal to be asked in: it can ask you the same questions in the conversation and pass the answers with `interview --answers -`. Run `interview --help` for the field names.

Use `context` when you want to inspect the files directly. Use `context --refresh --review` after manual edits when you want to regenerate the agent entrypoints with a preview first.

Import context from old AI chats:

```bash
npx dotaios@2.0.14 import ./import.json --dry-run
npx dotaios@2.0.14 import ./import.json --apply
```

Save a file or URL into the vault:

```bash
npx dotaios@2.0.14 ingest ./notes.md
npx dotaios@2.0.14 ingest https://example.com/article
```

Route by purpose with `--to` to put things in the right place from the start:

```bash
npx dotaios@2.0.14 ingest research.pdf --to wiki --name ai-research           # lasting reference
npx dotaios@2.0.14 ingest brief.pdf --to company --name acme --apply          # org record
npx dotaios@2.0.14 ingest call-notes.txt --to signal                          # working note
```

Durable shelves (`wiki`, `company`, `person`) preview without `--apply` and will not write. A human picking the shelf interactively counts as approval.

Dynamic or paywalled pages may ingest partial content. If the saved markdown ends abruptly or misses expected sections, save the logged-in page as a PDF from your browser and ingest the PDF.

Save selected AI conversations locally so other agents on your machine can find what mattered:

```bash
npx dotaios@2.0.14 capture enable claude-code     # auto-save every Claude Code session
npx dotaios@2.0.14 capture import paste           # paste any conversation manually
npx dotaios@2.0.14 capture import claude-code     # backfill past sessions (last 30 days)
npx dotaios@2.0.14 capture list                   # browse saved conversations
npx dotaios@2.0.14 capture list --agent claude-code --since 7d
npx dotaios@2.0.14 search "any topic"             # search includes saved sessions
```

For agents that can write local files, you can also ask: "use save-session" or "save this session". It writes a clean summary with decisions, open threads, and action items.

Captured sessions do not silently change durable context. Use
`dotaios memory promote` to preview one explicit destination and add `--apply` only after the
change looks right. See [saving conversations](sessions.md).

Sessions you save or capture with an enabled adapter go to `~/aios/memory/sessions/` as plain Markdown files. See [sessions.md](sessions.md) and [adapters.md](adapters.md) for supported tools and capability levels.

Write today's local brief into your daily note:

```bash
npx dotaios@2.0.14 brief
```

Search your local AIOS files:

```bash
npx dotaios@2.0.14 search "daily planning" --scope skills
```

Validate and install a plugin from a reviewed local folder:

```bash
npx dotaios@2.0.14 install ./my-plugin --dry-run
npx dotaios@2.0.14 install ./my-plugin
```

DotAIOS refuses remote plugin URLs. Pin and download or clone the exact revision
yourself, inspect it outside DotAIOS, then run the local-folder dry run above.

List local manual schedules:

```bash
npx dotaios@2.0.14 schedule list
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
npx dotaios@2.0.14 attach /path/to/project
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
`dotaios activate` always links `~/aios/skills` into the shared Agent Skills
folder for Codex, Cursor, Gemini CLI, Kimi Code CLI, and OpenCode. It adds the
client-specific Claude Code, Antigravity IDE, and Grok targets only when that
client is detected, unless you explicitly pass `--all`. Existing Hermes roots
or discovered profile configurations remain detection-aware as well. Activation
then verifies filesystem/configuration propagation.
`dotaios skills doctor` reports configuration and filesystem projection
evidence per surface; it leaves discovery unprobed. A bounded client probe records invocation separately, while only
`produced=yes` proves that the client used the skill.
