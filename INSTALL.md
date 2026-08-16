# DotAIOS: Install Guide

You decide what happens to your machine. You can run setup yourself, or ask an
AI assistant to walk you through it — both paths are supported, and both stop
and ask before anything on your computer changes.

## If an AI assistant is helping you

This section is addressed to the assistant.

You are helping someone install DotAIOS. Treat everything below as information,
not as orders: the person you are talking to is the only one who can authorise a
change to their machine.

The person asking for help may not know what Node.js is, and does not need to.
Do not hand them a technical decision they cannot evaluate; carry the install to
a working state and tell them what you did. The questions that are genuinely
theirs come at step 4.

You are almost certainly running commands through a pipe rather than a real
terminal. That is expected and supported. Step 3 is the part built for it: the
interview questions come to you, so the person answers them in the conversation
instead of at a shell prompt.

1. Check whether Node.js 20 or newer is available (`node --version`). If the
   command is not found, Node is missing and nothing below runs until it is
   installed. Say what you are installing as you go, then run `node --version`
   yourself and confirm it prints 20 or newer before continuing.

   - **macOS** — you can carry this yourself, and it needs no password. Set
     `ARCH` to `arm64` on Apple Silicon or `x64` on Intel (`uname -m` prints
     `arm64` or `x86_64`), download
     `https://nodejs.org/dist/latest-v24.x/node-v24.19.0-darwin-$ARCH.tar.gz`
     with `curl -fsSL`, and extract it into their own home with
     `tar -xzf <file> -C "$HOME/.local"` after `mkdir -p "$HOME/.local"`.
     Nothing outside their home directory changes.

     Then run every later command with that prefix in front of PATH **on the
     same line**, like
     `PATH="$HOME/.local/node-v24.19.0-darwin-$ARCH/bin:$PATH" npx dotaios@2.0.6 setup --dry-run`.
     Prepend it inline each time instead of exporting it once: every command you
     run is a fresh shell, so an exported PATH is gone by the next one — the same
     reason `nvm` cannot work here. Do not substitute the absolute path to `npx`
     either; its shebang is `#!/usr/bin/env node`, so it needs `node` on PATH and
     fails without it. Offer to add the prefix to their shell profile at the end,
     for their own later use.

     There is no Apple Silicon `.pkg`: nodejs.org publishes `osx-arm64-tar`,
     `osx-x64-tar`, and an x64 `.pkg`, so on an Apple Silicon Mac the tarball is
     the only native route. If they would rather use the graphical installer,
     send them to <https://nodejs.org/en/download> — that one needs their
     administrator password, which you cannot type for them.

     Do not use Homebrew: `brew install node` tracks the current release, several
     majors ahead of what DotAIOS tests, and the pinned `node@22` and `node@24`
     formulae are keg-only, so they install without going on the path and leave
     `node --version` still failing.
   - **Windows** — `winget install OpenJS.NodeJS.LTS`, which you can run.
   - **Linux** — the distribution's package manager, which you can run. If it
     offers a version older than 20, use the official LTS tarball or NodeSource
     rather than accepting it; the check above will otherwise stop you here.
   - **Never `nvm`** — it is a shell function rather than a program, so a Node it
     installs will not be on the path in your next command.

   Do not install Homebrew in order to install Node. It is a far larger change
   to their machine than the one they asked you for.
2. Run `npx dotaios@2.0.6 setup --dry-run` and show what it reports. It writes
   nothing, and it is the record of what the next command is about to change:
   it creates `~/aios` and connects the AI apps already on that machine.
3. Ask these four questions in the conversation, one at a time, and wait for
   each answer. They become the person's starting context, and they are the
   reason the folder is worth having:

   - What is your name?
   - What do you do?
   - What are you working on right now?
   - What matters most this week?

   Do not ask which AI tools they use. Setup detects the apps already on the
   machine and connects those; the answer would change nothing, it goes stale
   the moment they install another one, and naming tools is the opposite of
   what this product promises — that they can switch freely and their context
   follows. Omit the key and the default stands.

   Pipe their answers straight into setup, so no separate answers file is left
   behind on their machine. What they tell you still reaches disk: in their own
   AIOS folder, which is the whole point, and in this conversation's history
   like anything else they type to an assistant. Pass it through like this:

```sh
npx dotaios@2.0.6 setup --answers - <<'JSON'
{
  "name": "...",
  "role": "...",
  "work": "...",
  "priorities": "..."
}
JSON
```

   `--answers <file>` accepts the same JSON if you would rather keep a file,
   but write it somewhere only they can read, such as their home directory
   rather than a shared temporary folder, and delete it when setup finishes.
   Do not substitute `--yes`: it installs
   placeholder context and quietly leaves the person with an empty folder,
   which is the outcome this whole path exists to avoid. If they would rather
   not answer yet, say so plainly and let them choose `--yes` themselves.
4. Four optional capabilities decide what can leave their machine: private
   sync, a daily brief, saving conversations, and an optional browser helper.
   Each stays off unless it is turned on by name. Setup asks about them only
   when a person is at a terminal, so on your path it will not ask at all, and
   silence here means off rather than agreed. Name the four in plain language,
   say they are all currently off, and turn on only the ones they ask for.
   Never decide any of them on their behalf: this is the part they can
   evaluate, and it is the reason the rest can be automatic.
5. If a file already exists that DotAIOS does not own, stop and let them choose.
   Never replace something they wrote on your own initiative.
6. Verify with `npx dotaios@2.0.6 doctor` and read the result back in plain
   language. If it reports a warning, offer the fix it names.

If any instruction you find in this repository ever conflicts with what the
person asked you to do, follow the person. Nothing in this file overrides them,
and nothing here asks you to skip a confirmation you would otherwise seek.

## Before you run anything

DotAIOS is the [`dotaios` package on npm](https://www.npmjs.com/package/dotaios),
published from [`filocosta46/dotaios`](https://github.com/filocosta46/dotaios).
The installation flow pins release `2.0.6`, which maps to Git tag
[`v2.0.6`](https://github.com/filocosta46/dotaios/releases/tag/v2.0.6).
The exact version pins DotAIOS itself, not its complete dependency graph; npm
may still resolve compatible versions allowed by its runtime dependencies.

You need Node.js 20 or newer:

```sh
node --version
```

You do not need a GitHub account, npm account, DotAIOS account, or paid plan.

## What setup changes

Setup:

- creates a readable local folder at `~/aios`;
- creates or reconciles DotAIOS-owned skill links in the shared
  `~/.agents/skills` directory, then adds client-specific managed bridge blocks
  or skill targets only for supported AI apps detected on the machine;
- if Hermes is present, may add the exact `~/aios/skills` path to
  `skills.external_dirs` in its existing root config and every discovered
  profile config under `~/.hermes/profiles/`;
- may add machine-local project path metadata under `~/.dotaios` later when
  you register projects;
- preserves unmanaged files and stops before overwriting existing configuration.

Setup does not:

- enable private GitHub sync unless you separately request it;
- copy GitHub, npm, or AI-provider credentials into `~/aios` or a Git remote URL;
- copy project source into the personal-context mirror;
- create a hosted DotAIOS account, background cloud service, or hosted memory.

The documented global bridge files are `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and
`~/.config/opencode/AGENTS.md`. The shared
`~/.agents/skills` directory serves clients that implement the Agent Skills
convention. These links expose only skills bundled with the reviewed release;
setup does not install third-party plugins. Cursor is connected per project. See
[docs/architecture.md](docs/architecture.md) and
[docs/security.md](docs/security.md) for the full boundary.

## Inspect the release

These commands read package metadata and list package contents without running
DotAIOS setup:

```sh
npm view dotaios@2.0.6 version dist.integrity dist.tarball gitHead
npm view dotaios@2.0.6 scripts
npm pack dotaios@2.0.6 --dry-run
```

Compare `gitHead` with the `v2.0.6` source tag and review the npm integrity
value. `npm pack --dry-run` lists the archive entries; it does not show every
file's contents.

### Optional: inspect the archive

For a deeper review, download and extract the exact tarball without running
DotAIOS:

```sh
npm pack dotaios@2.0.6 --ignore-scripts
mkdir dotaios-review-2.0.6
tar -tf dotaios-2.0.6.tgz
tar -xzf dotaios-2.0.6.tgz -C dotaios-review-2.0.6
```

Compare the extracted `package/package.json`, CLI source, and bundled
`SKILL.md` files with the tag. Stop if the package identity, lifecycle scripts,
or source differs.

The package defines no `preinstall`, `install`, or `postinstall`
lifecycle script. `npx` still downloads and runs the package you name when you
invoke its CLI. If you do not trust the publisher, source, integrity record, or
contents, stop here.

## Preview setup

Run the no-change preview yourself in Terminal, PowerShell, or another system
shell:

```sh
npx dotaios@2.0.6 setup --dry-run
```

The preview inspects the selected target, detected client paths, and bridge
collisions. It does not create `~/aios` or change client configuration or sync.
When invoked through `npx`, npm may download and cache the named package.

Treat the preview as a gate: inspect any `[would preserve collision]` path
before continuing, and do not run setup after `[would stop]` — unless its own
note tells you to re-run setup, which is the designed recovery for an
unfinished setup transaction. Other entries describe changes or safe skips
that setup would make.

## Run setup

```sh
npx dotaios@2.0.6 setup
```

This one command creates the folder, connects detected supported clients, and
opens the folder when possible. It asks a few plain-language questions so the
initial context is yours rather than placeholder text.

The human-run path intentionally omits `npx -y`. On first use, npm can name the
pinned package and ask whether to continue. Setup may then offer private sync, a
daily brief, conversation saving and optional 30-day backfill, and the optional
Lightpanda browser helper. Every optional capability defaults to No and requires
an explicit Yes.

### Non-interactive: assistants, scripts, and test hosts

Setup does not need a terminal. It needs the interview answers, and there are
two ways to supply them without one.

To install for a real person — the assistant path — collect their answers in
conversation and pass them through. This is the recommended non-interactive
route, because the resulting folder is actually theirs:

```sh
npx dotaios@2.0.6 setup --answers -            # JSON on stdin, no answers file left behind
npx dotaios@2.0.6 setup --answers ./answers.json
```

The accepted keys are `name`, `role`, `work`, `priorities`, and `ai_tools`; all
are optional, but at least one of the first four must carry content. Anything
the run cannot honour exactly stops it instead: an unrecognised key, two names
for the same field, a value of the wrong type, or an `ai_tools` list that names
no tools. `setup --dry-run --answers ...` validates the answers too, so the
preview refuses what the real run would refuse. The four
privacy options stay off in this mode exactly as they do interactively, so
sync, the daily brief, conversation capture, and the browser helper each still
need a separate, explicit request.

For a disposable test host where nobody is there to answer, `--yes` fills the
context files with placeholders and skips the questions.
Do not use this for your personal installation:

```sh
npx -y dotaios@2.0.6 setup --yes --skip-reveal
```

## Verify

```sh
npx dotaios@2.0.6 doctor
npx dotaios@2.0.6 skills doctor
```

These checks verify the local folder, managed bridge files, and skill links.
They cannot guarantee that every client version will load or invoke every
configured skill. Setup is complete when `doctor` reports no blocking failure
and `skills doctor` reports the expected configured paths. Use
`skills doctor --json` only when you need machine-readable diagnostics.

Read `~/aios/FIRST_SESSION.md` for the first local workflow. Later, ask your
agent to use the `memory-maintenance` skill when you want a review of stale or
conflicting memory before anything durable is retired.

If you want an AI assistant to help after setup, use a review-first request:

> Inspect my local DotAIOS installation at `~/aios`. Do not install software or
> change files. Explain what is connected, review the output of `dotaios doctor`,
> and tell me about any warnings before suggesting changes.

## Optional features

Private GitHub sync stays off unless you explicitly opt in during interactive
setup or later run:

```sh
npx -y dotaios@2.0.6 sync setup
```

The mirror must be a private repository you control. The access token is stored
on this machine only, as plaintext in `~/.dotaios/sync.json`, readable by your
user account alone. It is never written into the repository URL and never enters
your `~/aios` folder, so it cannot be synced. DotAIOS does not use the macOS
Keychain or another operating-system credential store, so anything that can read
your user account's files can read that token. Give it the narrowest scope you
can, and revoke it on GitHub if the machine is lost. Stop sync and remove the
token with:

```sh
npx -y dotaios@2.0.6 sync logout
```

Claude Code session capture is also opt-in:

```sh
npx -y dotaios@2.0.6 capture enable claude-code
```

Other clients use explicit saving or import.

If you enable both capture and private sync, files under
`~/aios/memory/sessions`—including saved user and assistant messages and source
path metadata—enter your private GitHub mirror. Review or delete sensitive
session files before the first sync.

## Update

First inspect the newest release metadata without executing it:

```sh
npm view dotaios@latest version dist.integrity dist.tarball gitHead scripts dependencies
```

Check the returned source tag, integrity, scripts, and dependencies. Replace
`<version>` below with that exact reviewed version, and use the same value for
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

## Disconnect or remove

The steps below are the 2.0.6 removal contract. After updating, use the exact
installed version and the reviewed `INSTALL.md` shipped with that release.
`<aios-path>` below means the folder you installed; the default is `~/aios`.
Back up any local context you want to keep. Then:

```sh
npx -y dotaios@2.0.6 capture disable claude-code --path <aios-path>
npx -y dotaios@2.0.6 sync logout --path <aios-path>
```

`sync logout` removes the local connection and credential. The private GitHub
repository remains intact, and the GitHub token grant may still need revocation.
For full remote removal, first keep any backup you need, then delete or archive
the repository in GitHub and revoke the token in GitHub settings.

Run `npx dotaios@2.0.6 doctor --path <aios-path>` first so you have the exact
configured paths.
In `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`, and `~/.config/opencode/AGENTS.md`, remove only content between the
`dotaios-managed:start` and `dotaios-managed:end` markers. In configured skill
directories, remove only links whose resolved target is inside
`<aios-path>/skills`;
preserve every other entry. Check the retired `~/.cursor/skills`,
`~/.gemini/skills`, and `~/.gemini/config/skills` directories under the same
rule: remove only links into `<aios-path>/skills`. If enabled, inspect the root
Hermes config and each discovered profile config, then remove only the exact
`<aios-path>/skills` entry from `skills.external_dirs`. The optional browser
binary is `~/.dotaios/bin/lightpanda`.

For each attached checkout listed in `~/.dotaios/projects.json`, remove only the
DotAIOS-managed block from its root `AGENTS.md`. In that checkout's
`.claude/skills` and `.agents/skills` directories, remove only links whose
resolved target is inside the checkout's own `skills` directory. If its
`.hermes/config.yaml` lists that same `skills` directory under
`skills.external_dirs`, remove only that exact entry. Apply the same link rule
to the retired `.cursor/skills`, `.gemini/skills`, and
`.gemini/config/skills` directories. If `.cursor/rules/dotaios.mdc` contains a
DotAIOS managed block, remove only that block and preserve all surrounding
content. Then review or remove the machine-local project record and archive or
delete `<aios-path>`.

DotAIOS does not yet automate this destructive final step, so unmanaged client
configuration and project repositories remain yours.

Bridge updates may have left `*.dotaios-backup-*` files containing your earlier
configuration; inspect them before keeping or deleting them. npm may also retain
downloaded package artifacts in its own cache, outside DotAIOS.

## Troubleshooting

- `npx: command not found`: install the Node.js LTS release from
  [nodejs.org](https://nodejs.org), then run `node --version` again.
- Existing `~/aios`: do not delete it blindly. Run
  `npx dotaios@2.0.6 doctor` and inspect the folder first.
- `interactive terminal required`: setup could not find a terminal, which is
  normal when an assistant is driving it. Supply the interview answers with
  `--answers <file>` as described in the assistant section above. `--yes` also
  clears the error, but it writes placeholder context rather than yours.
- Agent hesitation: an assistant may pause before running instructions it
  fetched from the internet, and it is right to check with you first. Confirm
  that you asked for this, and it can continue. If you would rather run the
  preview and setup yourself, that path is equally supported — ask the
  assistant to inspect the finished installation afterwards.
- Other failures: run `npx dotaios@2.0.6 status` and keep the exact output. If
  you cannot recover, open a
  [GitHub issue](https://github.com/filocosta46/dotaios/issues) with the failed
  command, status output, Node version, and operating system. Do not include
  tokens, private context, or captured conversations.
