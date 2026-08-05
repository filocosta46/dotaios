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

## Install and activate

You do not need a GitHub account.

The simplest path is to ask a local AI assistant to set it up for you. Open Claude Code, Codex, or Cursor and paste:

> Please set up DotAIOS for me. Read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step. Explain anything you need from me in plain language, and do not overwrite existing files without asking.

If you prefer the terminal, you need Node.js 20 or newer:

```sh
npx -y dotaios@latest init --yes
npx -y dotaios@latest activate
npx -y dotaios@latest skills doctor --json
```

`init` creates `~/aios`. `activate` connects detected local clients without replacing unmanaged files. `skills doctor` verifies the files and links DotAIOS controls; it cannot guarantee that every client version will invoke every skill. See [INSTALL.md](INSTALL.md) for the complete agent-led setup and optional Claude Code capture.

## What you have afterward

- One place for your identity and priorities
- A clear home for projects and next steps
- One-command restore of a project's committed remote state into a private local workspace
- Recent notes and saved conversations
- Long-term knowledge and sources
- Trusted workflows your assistants can follow

Your context stays in a local `~/aios` folder: readable, portable, and yours. Activation also writes small managed bridge files and skill links in client-owned configuration locations, while machine-local project path mappings live in `~/.dotaios/projects.json`. When you use an AI client, that provider processes the context you send it. You can optionally sync selected AIOS files privately between your own devices.

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

`npx ...@latest` selects the current published CLI. `migrate` previews versioned folder changes and asks for the exact plan before applying them. Your existing `~/aios` remains readable local data across releases. Re-run `activate` after changing clients or repairing managed bridges.

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

- [INSTALL.md](INSTALL.md) — agent-led setup
- [Getting started](docs/getting-started.md) — terminal path
- [Architecture](docs/architecture.md) · [Projects](docs/projects.md) · [Client support](docs/client-support.md) · [Security](docs/security.md) · [all guides](docs/)

## License

MIT
