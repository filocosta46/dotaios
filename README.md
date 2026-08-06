# DotAIOS

**Give your AI one place to remember what matters.**

DotAIOS keeps your identity, priorities, projects, notes, and trusted workflows in one private place, then connects that context to local AI agents through documented bridges. No DotAIOS account. No hosted memory.

Current boundary: activation configures documented bridge surfaces for detected Claude Code, Codex, and Gemini CLI installations. Cursor connects per project. A verified file or link does not prove that every client version will load or invoke it. Claude Code can auto-save sessions today; other tools use explicit saving or import.

## Why people use it

If you use more than one AI assistant, DotAIOS helps you:

- stop repeating who you are and what you are working on;
- keep projects, priorities, and important notes together;
- carry the same owned context across documented Claude Code, Codex, Cursor, Gemini CLI, and adapter surfaces.

The free core is available now.

## Install: preview, then run

You need Node.js 20 or newer. You do not need a GitHub or DotAIOS account.

Run these commands yourself in Terminal, PowerShell, or another system shell. The first command previews the selected folder, detected clients, and collisions without creating `~/aios` or changing client configuration or sync. npm may download and cache the named package. The second command runs the same pinned release and guides you through setup:

```sh
npx dotaios@1.28.1 setup --dry-run
npx dotaios@1.28.1 setup
```

Setup creates `~/aios`, then connects supported AI apps detected on the machine. It preserves unmanaged files and stops before replacing existing configuration. Private GitHub sync is off by default.

Do not ask an AI assistant to fetch remote instructions and install DotAIOS for you. An assistant can help you inspect the source or explain the preview, but you should run the setup command yourself. Afterward, either you or the assistant can verify the local installation with:

```sh
npx dotaios@1.28.1 doctor
```

### Verify before running

The package is [`dotaios` on npm](https://www.npmjs.com/package/dotaios), published from the [`filocosta46/dotaios` repository](https://github.com/filocosta46/dotaios). Release `1.28.1` maps to Git tag [`v1.28.1`](https://github.com/filocosta46/dotaios/releases/tag/v1.28.1).

These commands inspect registry provenance and packaged contents without running DotAIOS setup:

```sh
npm view dotaios@1.28.1 version dist.integrity dist.tarball gitHead
npm view dotaios@1.28.1 scripts
npm pack dotaios@1.28.1 --dry-run
```

The published package defines no `preinstall`, `install`, or `postinstall` lifecycle script. `npx` still downloads and runs the named npm package when you invoke its CLI. The human-run commands intentionally omit `npx -y`, so npm can show its first-run confirmation for the pinned package. If you do not trust the source, publisher, integrity record, or package contents, do not approve it. Interactive setup may then offer private sync, a daily brief, conversation saving/backfill, and the optional Lightpanda helper; every optional capability defaults to No. Read [INSTALL.md](INSTALL.md) for the complete human-run sequence and [the security model](docs/security.md) for package and permission boundaries.

## What you have afterward

- One place for your identity and priorities
- A clear home for projects and next steps
- One-command restore of a project's committed remote state into a private local workspace
- Recent notes and saved conversations
- Long-term knowledge and sources
- Trusted workflows your assistants can follow

Your context stays in a local `~/aios` folder: readable, portable, and yours. Activation may add a DotAIOS-managed block to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.gemini/GEMINI.md`, plus documented skill links for detected clients. Machine-local project path mappings live in `~/.dotaios/projects.json`. Existing unmanaged content is preserved. When you use an AI client, that provider processes the context you send it. You can optionally sync selected AIOS files privately between your own devices.

Project records sync with AIOS. Managed project repositories sit under its
ignored `workspaces/` root with their own history and credentials, so source
code never enters the personal-context mirror.

DotAIOS does not keep an endless transcript. Important information is deliberately saved into the right place so it remains useful later.

## Projects and workspaces

Register an existing repository without changing it, inspect the plan, then apply it:

```sh
npx -y dotaios@latest project add /path/to/project
npx -y dotaios@latest project add /path/to/project --apply
npx -y dotaios@latest attach /path/to/project --dry-run
npx -y dotaios@latest attach /path/to/project
```

The portable project record lives in `~/aios/projects`. The checkout stays where it is. On another machine, restore a missing checkout into the ignored workspace shelf with:

```sh
npx -y dotaios@latest project restore <slug-or-id> --dry-run
npx -y dotaios@latest project restore <slug-or-id>
```

DotAIOS never copies a project's source code into the personal-context mirror.

## Optional private sync

Sync is opt-in and uses a private GitHub repository you control:

```sh
npx -y dotaios@latest sync setup
npx -y dotaios@latest sync now
npx -y dotaios@latest sync status
```

Credentials stay on the machine and are not written into the Git remote URL. Managed project checkouts, external vault contents, secrets, and ignored local state are outside the mirror. Stop syncing and remove the local sync credential with `npx -y dotaios@latest sync logout`; the private repository remains in your GitHub account.

## Updating

Run the current CLI, then check the installed folder before applying a folder migration:

```sh
npx -y dotaios@latest --version
npx -y dotaios@latest doctor
npx -y dotaios@latest migrate
```

`npx ...@latest` selects the newest published CLI; use an exact version when you need reproducibility. `migrate` previews versioned folder changes and asks for the exact plan before applying them. Your existing `~/aios` remains readable local data across releases. Re-run `activate` after changing clients or repairing managed bridges.

## Disconnecting or removing

DotAIOS has no hosted account or background service to cancel. Before removing local data, make a backup of anything you want to keep.

```sh
npx -y dotaios@latest capture disable claude-code
npx -y dotaios@latest sync logout
```

Those commands stop managed capture and private sync. The current release does not provide a one-command full uninstall: review and remove only DotAIOS-managed bridge blocks or links in your client configuration, then archive or delete `~/aios` yourself. Unmanaged client configuration is deliberately left alone.

## Good to know

- A browser-only chat cannot open local files by itself.
- Each assistant has its own way of discovering and using local context; setup does not guarantee that every assistant will actively use it.
- Claude Code supports managed automatic session capture today. Other clients use explicit capture, import, or the bundled `save-session` workflow.
- Optional sync sends the selected Git mirror to your own private GitHub repository. The free core does not upload context to a DotAIOS service.
- [Client support](docs/client-support.md) separates configured, discoverable, invoked, and produced evidence for each client.

## The promise

- **Private by default.** DotAIOS does not run a hosted memory service.
- **Yours to keep.** Your context lives in readable local files, not inside a locked-in account.
- **Works with the assistants you choose.** Models are rented. Your context is owned.

## Docs

- [INSTALL.md](INSTALL.md) — human-run install and removal
- [Getting started](docs/getting-started.md) — product walkthrough
- [Architecture](docs/architecture.md) · [Projects](docs/projects.md) · [Client support](docs/client-support.md) · [Security](docs/security.md) · [all guides](docs/)

## License

MIT
