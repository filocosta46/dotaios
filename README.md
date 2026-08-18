# DotAIOS

**Stop starting from zero every time you change AI tools.**

DotAIOS gives your assistants one readable folder for the context that should
stay with you: who you are, what matters now, what you are working on, and what
was decided. You keep that folder on your computer. There is no DotAIOS account
and no hosted DotAIOS memory service.

## Who this is for

An independent consultant or freelancer who already moves between AI chats
and local agents, and does not want to build a memory system.

The expensive part of changing tools is not the new interface. It is having
to retell the useful context again.

The free core is available now.

### How it stays with you

1. **Install** and **personalize** one folder with the context you choose.
2. **Save** a useful preference, decision, or piece of work on purpose.
3. **Switch** to another connected assistant and retrieve it with its source.
4. Choose **privacy** for the work in front of you: Shared, This project, or Off.

## Install with one request

Open Claude Code, Codex, Cursor, or another local assistant that can run
commands, and paste:

> Please set up DotAIOS on my computer: https://github.com/filocosta46/dotaios

That link stays the same next year.

If you are the assistant reading this page, follow
[INSTALL.md for the current release](https://github.com/filocosta46/dotaios/blob/v2.0.9/INSTALL.md),
under “If an AI assistant is helping you”. That file is pinned to the release
you are about to install.

### What the assistant does

- Checks for Node.js 20 or newer, and installs it for you if it is missing
- On a Mac and on Linux, that does not need your password
- Previews the folder and app changes
- Asks you three questions that become your starting context
- Runs setup, verifies it, and says what happened in plain language

The questions reach you in the conversation, not at a shell prompt. You do
not need a GitHub or DotAIOS account.

### If you prefer Terminal

Use Terminal, PowerShell, or another system shell. DotAIOS requires Node.js 20
or newer. The first command previews without creating `~/aios` or changing app
configuration; the second runs the same pinned release:

npm may download and cache the named package.

```sh
npx dotaios@2.0.9 setup --dry-run
npx dotaios@2.0.9 setup
```

Setup creates `~/aios`, then connects supported AI apps detected on the
machine. It preserves unmanaged files and stops before replacing existing
configuration. Private GitHub sync is off by default.

Afterward, verify the local installation with:

```sh
npx dotaios@2.0.9 doctor
```

## Choose what your AI can remember

Your AIOS folder is what they read. Start a connected local-agent session
with one of these phrases:

- `Use my memory` — **Memory: Shared** uses your personal continuity.
- `Only this project` — **Memory: This project** uses only that explicitly
  registered project's files and attributed continuity. It excludes personal,
  unscoped, and other-project memory.
- `Private chat` — **Memory: Off** tells DotAIOS operations to perform no read,
  search, save, or capture. Your AI app may still keep its own chat history.

### What Off actually does

Gemini's managed hook preserves the first-message choice. Codex and Claude Code
rely on their bridge instructions to forward Off on every DotAIOS operation and
show the receipt; they do not independently enforce a host-wide session lock.
Off also cannot undo instructions or context the AI app may already have loaded
before your first message, so begin a Private chat outside the AIOS folder or an
attached project.

Saving stays deliberate: one explicit save becomes one conceptual memory
result, and another connected assistant can show where it came from.

## What you have afterward

- One place for your identity and priorities
- A clear home for projects and next steps
- Recent notes and conversations you chose to save
- Long-term knowledge, sources, and trusted workflows
- A readable history you can inspect, back up, or move

Your context stays in a local `~/aios` folder: readable, portable, and yours.
DotAIOS does not keep an endless transcript or turn every chat into permanent
memory. You save the important parts on purpose, in the right place.

### Good to know

- A browser-only chat cannot open local files by itself.
- Each assistant uses local context in its own way.
  [Client support](docs/client-support.md) records what has been observed.
- Claude Code supports managed automatic session capture today. Other clients
  use explicit capture, import, or the bundled `save-session` workflow.
- Optional sync sends the selected Git mirror to your own private GitHub
  repository. The free core does not upload context to a DotAIOS service.

### The promise

- **Private by default.** DotAIOS does not run a hosted memory service.
- **Yours to keep.** Your context lives in readable local files, not inside a
  locked-in account.
- **Works with the assistants you choose.** Models are rented. Your context
  is owned.

## Technical reference

Verify the package, connect projects, update a release, or remove DotAIOS.
You do not need this to use the product.

### Verify before running

The package is [`dotaios` on npm](https://www.npmjs.com/package/dotaios),
published from the [`filocosta46/dotaios` repository](https://github.com/filocosta46/dotaios).
Release `2.0.9` maps to Git tag
[`v2.0.9`](https://github.com/filocosta46/dotaios/releases/tag/v2.0.9).

These commands inspect registry provenance and packaged contents without
running DotAIOS setup:

```sh
npm view dotaios@2.0.9 version dist.integrity dist.tarball gitHead _npmUser.name
npm view dotaios@2.0.9 scripts
npm pack dotaios@2.0.9 --dry-run
```

Those three commands show you the registry publisher (`_npmUser.name`), the
integrity record, and every file in the package before anything runs. The
package defines no `preinstall`, `install`, or `postinstall` script, so nothing
executes until you invoke the CLI yourself. The commands above omit `npx -y`
on purpose, so npm still asks you to confirm the pinned package. Interactive
setup then offers private sync, a daily brief, conversation saving/backfill,
and the optional Lightpanda helper; every one of them defaults to No.
[INSTALL.md](INSTALL.md) has the full sequence and
[the security model](docs/security.md) has the package and permission
boundaries.

### What setup connects

Activation may add a DotAIOS-managed block to `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, or
`~/.config/opencode/AGENTS.md`, plus documented skill links for detected
clients. Cursor connects per project. Machine-local project path mappings live
in `~/.dotaios/projects.json`. Existing unmanaged content is preserved.

Claude Code can use managed session capture; other clients use explicit
saving or import. [Client support](docs/client-support.md) records what each
client has actually been observed to do.

When you use an AI client, that provider processes the context you send it.
You can optionally sync selected AIOS files privately between your own
devices.

Project records sync with AIOS. Managed project repositories sit under its
ignored `workspaces/` root with their own history and credentials, so source
code never enters the personal-context mirror.

### Projects and workspaces

Register an existing repository without changing it, inspect the plan, then
apply it:

```sh
npx -y dotaios@latest project add /path/to/project
npx -y dotaios@latest project add /path/to/project --apply
npx -y dotaios@latest attach /path/to/project --dry-run
npx -y dotaios@latest attach /path/to/project
```

The portable project record lives in `~/aios/projects`. The checkout stays
where it is. On another machine, restore a missing checkout into the ignored
workspace shelf with:

```sh
npx -y dotaios@latest project restore <slug-or-id> --dry-run
npx -y dotaios@latest project restore <slug-or-id>
```

DotAIOS never copies a project's source code into the personal-context mirror.

### Optional private sync

Sync is opt-in and uses a private GitHub repository you control:

```sh
npx -y dotaios@latest sync setup
npx -y dotaios@latest sync now
npx -y dotaios@latest sync status
```

Credentials stay on the machine and are not written into the Git remote URL.
Managed project checkouts, external vault contents, secrets, and ignored
local state are outside the mirror. Stop syncing and remove the local sync
credential with `npx -y dotaios@latest sync logout`; the private repository
remains in your GitHub account.

### Managed Agent Skills

Canonical skills live at `skills/<name>/SKILL.md`. Native agent folders are
derived projections. Linked shelf entries and skills found only in native
folders stay unroutable until you adopt them.

```sh
dotaios skills inventory --json
dotaios skills adopt /reviewed/local/skill --json
dotaios skills adopt /reviewed/local/skill \
  --apply <operation-id> --fingerprint <sha256>
dotaios skills reconcile --json
dotaios skills remove <name> --json
```

Preview commands write nothing. Apply needs both exact tokens from the
matching preview. Adoption copies the complete bounded regular-file bundle,
never executes scripts, and refuses links, special or hardlinked files, stale
proofs, unsafe parents, and foreign collisions.

## Updating

First inspect the newest release metadata without executing it:

```sh
npm view dotaios@latest version dist.integrity dist.tarball gitHead scripts dependencies
```

Review the returned source tag, integrity, scripts, and dependencies. Replace
`<version>` below with that exact reviewed version and keep it identical in
every command:

```sh
npx dotaios@<version> --version
npx dotaios@<version> doctor
npx dotaios@<version> migrate
npx dotaios@<version> migrate --apply <plan-id>
npx dotaios@<version> activate
npx dotaios@<version> skills doctor
npx dotaios@<version> capture enable claude-code
npx dotaios@<version> mcp config --agent <agent>
```

`migrate` is a read-only preview. Run the `migrate --apply <plan-id>` line only
when the preview prints that exact plan, using the same release. Re-run capture
only if Claude Code capture was already enabled. For every configured MCP
client, run `mcp config --agent <agent>`, merge the printed fragment into that
client's existing configuration, and restart it. DotAIOS MCP does not edit
client config automatically. Do not replace `<version>` with `latest`.

## Disconnecting or removing

DotAIOS has no hosted account or background service to cancel. Before removing
local data, make a backup of anything you want to keep.

```sh
npx -y dotaios@latest capture disable claude-code
npx -y dotaios@latest sync logout
```

Those commands stop managed capture and private sync. The last step is
deliberately yours: review the DotAIOS-managed bridge blocks and links in your
client configuration, remove those, then archive or delete `~/aios`. There is
no one-command wipe, because the same command would have to guess which parts
of your client configuration are ours — and anything unmanaged is left exactly
as you wrote it.

## Docs

- [INSTALL.md](INSTALL.md) — assistant-guided install, manual recovery, and removal
- [Getting started](docs/getting-started.md) — product walkthrough
- [Architecture](docs/architecture.md) · [Projects](docs/projects.md) · [Client support](docs/client-support.md) · [Security](docs/security.md) · [all guides](docs/)

## License

MIT
