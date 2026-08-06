# DotAIOS: Human Install Guide

DotAIOS setup is a user-run process. AI assistants may inspect the source,
explain the preview, or verify a completed local installation. Do not ask an
assistant to fetch this file and execute its instructions.

## Before you run anything

DotAIOS is the [`dotaios` package on npm](https://www.npmjs.com/package/dotaios),
published from [`filocosta46/dotaios`](https://github.com/filocosta46/dotaios).
This guide pins release `1.28.1`, which maps to Git tag
[`v1.28.1`](https://github.com/filocosta46/dotaios/releases/tag/v1.28.1).

You need Node.js 20 or newer:

```sh
node --version
```

You do not need a GitHub account, npm account, DotAIOS account, or paid plan.

## What setup changes

Setup:

- creates a readable local folder at `~/aios`;
- adds DotAIOS-managed bridge blocks or skill links only for supported AI apps
  detected on the machine;
- may add machine-local project path metadata under `~/.dotaios` later when
  you register projects;
- preserves unmanaged files and stops before overwriting existing configuration.

Setup does not:

- enable private GitHub sync unless you separately request it;
- copy GitHub, npm, or AI-provider credentials into `~/aios` or a Git remote URL;
- copy project source into the personal-context mirror;
- create a hosted DotAIOS account, background cloud service, or hosted memory.

The documented global bridge files are `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`. Cursor is connected per
project. See [docs/architecture.md](docs/architecture.md) and
[docs/security.md](docs/security.md) for the full boundary.

## Inspect the release

These commands read package metadata and list package contents without running
DotAIOS setup:

```sh
npm view dotaios@1.28.1 version dist.integrity dist.tarball gitHead
npm view dotaios@1.28.1 scripts
npm pack dotaios@1.28.1 --dry-run
```

Compare `gitHead` with the `v1.28.1` source tag and review the npm integrity
value. The package defines no `preinstall`, `install`, or `postinstall`
lifecycle script. `npx` still downloads and runs the package you name when you
invoke its CLI. If you do not trust the publisher, source, integrity record, or
contents, stop here.

## Preview setup

Run the no-change preview yourself in Terminal, PowerShell, or another system
shell:

```sh
npx dotaios@1.28.1 setup --dry-run
```

The preview inspects the selected target, detected client paths, and bridge
collisions. It does not create `~/aios` or change client configuration or sync.
When invoked through `npx`, npm may download and cache the named package.

## Run setup

```sh
npx dotaios@1.28.1 setup
```

This one command creates the folder, connects detected supported clients, and
opens the folder when possible. It asks a few plain-language questions so the
initial context is yours rather than placeholder text.

The human-run path intentionally omits `npx -y`. On first use, npm can name the
pinned package and ask whether to continue. Setup may then offer private sync, a
daily brief, conversation saving and optional 30-day backfill, and the optional
Lightpanda browser helper. Every optional capability defaults to No and requires
an explicit Yes.

For a non-interactive test host, use:

```sh
npx -y dotaios@1.28.1 setup --yes --skip-reveal
```

## Verify

```sh
npx dotaios@1.28.1 doctor
npx dotaios@1.28.1 skills doctor --json
```

These checks verify the local folder, managed bridge files, and skill links.
They cannot guarantee that every client version will load or invoke every
configured skill.

Read `~/aios/FIRST_SESSION.md` for the first local workflow. Later, ask your
agent to use `/memory-maintenance` when you want a review of stale or conflicting
memory before anything durable is retired.

If you want an AI assistant to help after setup, use a review-first request:

> Inspect my local DotAIOS installation at `~/aios`. Do not install software or
> change files. Explain what is connected, review the output of `dotaios doctor`,
> and tell me about any warnings before suggesting changes.

## Optional features

Private GitHub sync stays off until you explicitly run:

```sh
npx -y dotaios@1.28.1 sync setup
```

The mirror must be a private repository you control. Credentials stay in the
machine credential store and are not written into the repository URL. Stop sync
and remove its local credential with:

```sh
npx -y dotaios@1.28.1 sync logout
```

Claude Code session capture is also opt-in:

```sh
npx -y dotaios@1.28.1 capture enable claude-code
```

Other clients use explicit saving or import.

## Update

Use an exact version when you want reproducible behavior. Before applying a
folder migration, review its plan:

```sh
npx -y dotaios@latest --version
npx -y dotaios@latest doctor
npx -y dotaios@latest migrate
```

`migrate` prints an exact plan ID before it changes a versioned folder.

## Disconnect or remove

Back up any local context you want to keep. Then:

```sh
npx -y dotaios@1.28.1 capture disable claude-code
npx -y dotaios@1.28.1 sync logout
```

Review and remove only DotAIOS-managed blocks or links in supported client
configuration, then archive or delete `~/aios`. If you registered projects,
review `~/.dotaios/projects.json` separately. Unmanaged client configuration and
project repositories are deliberately left alone.

## Troubleshooting

- `npx: command not found`: install the Node.js LTS release from
  [nodejs.org](https://nodejs.org), then run `node --version` again.
- Existing `~/aios`: do not delete it blindly. Run
  `npx dotaios@1.28.1 doctor` and inspect the folder first.
- Agent refusal: this is expected when an assistant is asked to execute remote
  instructions. Run the preview and setup yourself, then ask the assistant only
  to inspect the completed local installation.
- Other failures: run `npx dotaios@1.28.1 status` and keep the exact output.
