# Getting Started

DotAIOS creates a local `~/.aios/` folder that your AI tools can read.

```bash
npx dotaios init
npx dotaios activate
```

The published package name is `dotaios`. A shorter `aios` binary is also available once the package is installed or linked locally.

The init flow asks five questions, then creates agent entrypoints and starter memory files. `activate` creates small bridge files in the global memory locations used by Claude Code, Codex, and Gemini.

For Cursor or project-scoped agents, attach a project folder:

```bash
npx dotaios attach /path/to/project
```

After setup, read `FIRST_SESSION.md`, then open Claude Code, Codex, Gemini, Cursor, or another repo-aware assistant.

Use an external vault, such as an Obsidian folder, when you already have long-term notes:

```bash
npx dotaios init --vault-path ~/my-vault
```

Check setup health:

```bash
npx dotaios status
```

Inspect or edit context:

```bash
npx dotaios context
npx dotaios context work --edit
npx dotaios context --refresh
```

Import context from old AI chats:

```bash
npx dotaios import ./import.json --dry-run
npx dotaios import ./import.json --apply
```

Save a file into `vault/raw/`:

```bash
npx dotaios ingest ./notes.md
```

Validate and install a local plugin:

```bash
npx dotaios install ./my-plugin --dry-run
npx dotaios install ./my-plugin
```

List local manual schedules:

```bash
npx dotaios schedule list
```

For v1.1, the daily interface is your existing AI tool. You should not need to open DotAIOS directly except to check status, inspect context, import material, ingest files, install trusted local plugins, or run manual schedules.

## Safety Flags

`init` will stop if the target folder already contains files. Use `--force` to add missing generated files while preserving existing files. Use `--overwrite` only when you intentionally want to replace generated files.

Store secrets in `~/.aios/.env`, not in chat or memory files. The generated `.gitignore` ignores `.env`, token files, credentials, and private keys.
