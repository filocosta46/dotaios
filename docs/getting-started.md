# Getting Started

DotAIOS creates a local `~/.aios/` folder that your AI tools can read.

```bash
npx dotaios init
```

The published package name is `dotaios`. A shorter `aios` binary is also available once the package is installed or linked locally.

The init flow asks five questions, then creates agent entrypoints and starter memory files. After setup, read `FIRST_SESSION.md`, then open Claude Code, Codex, Cursor, or another repo-aware assistant in a workspace that can read your AIOS files.

Use an external vault, such as an Obsidian folder, when you already have long-term notes:

```bash
npx dotaios init --vault-path ~/my-vault
```

Check setup health:

```bash
npx dotaios status
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

For v1, the daily interface is your existing AI tool. You should not need to open DotAIOS directly except to check status, ingest material, or install plugins.

## Safety Flags

`init` will stop if the target folder already contains files. Use `--force` to add missing generated files while preserving existing files. Use `--overwrite` only when you intentionally want to replace generated files.
