# Adapter Capabilities

DotAIOS saves conversations from different AI tools. Each tool has a different level of support depending on what's technically possible.

## Capability levels

| Label | What it means |
|---|---|
| **auto-save** | Once enabled, the conversation is saved incrementally after each completed supported response. |
| **import only** | You can save past conversations by running an import command. No automatic saving. |
| **paste/import only** | Copy-paste the conversation manually. DotAIOS has no automated way to read this tool's files. |
| **not available** | The tool is not installed on your machine. |

Run `dotaios capture status` to see what's active on your machine.

---

## Giving tools your context (`connect`)

The capability levels above are about *saving conversations out of* a tool. The
`connect` commands do the opposite: they wire a tool so it *reads your DotAIOS
context in* automatically.

When connected tools request startup continuity, events, signals, and saved
sessions come through the same bounded projection produced by
`dotaios brief --compact`; adapters do not define their own raw-memory window.
Compatibility state stays in a fixed operational envelope beside that user
memory, never inside the canonical projection or its budget.
Where the optional MCP adapter is used, it exposes exactly
`read_working_context`, `search_aios`, and `resolve_skill`.

### Gemini CLI

```
dotaios connect gemini
```

Installs three things in `~/.gemini/`:
- a `GEMINI.md` bridge that preserves surrounding user instructions and points
  Gemini at your AIOS folder,
- a version-pinned `dotaios-context-hook.sh` command that selects the session
  memory policy from Gemini's first user prompt and then produces bounded
  working-context JSON, and
- a guarded `settings.json` merge that activates that command as a
  **BeforeAgent hook**. Discovery and invocation remain client-version
  dependent.

`Private chat` returns **Memory: Off** from the hook before the pinned DotAIOS
command or AIOS folder is opened. An attached project defaults to **Memory:
This project**; `Use my memory` explicitly selects Shared. Gemini's own bounded
session transcript supplies the first-prompt lock on later turns. If the hook
cannot verify that transcript, it leaves automatic memory closed instead of
guessing. Updating a managed older connection migrates only DotAIOS's
SessionStart hook and preserves foreign hooks.

DotAIOS preflights all three files before writing and activates settings last.
It refuses unsafe or ambiguous paths, malformed managed markers, foreign hook
scripts, invalid UTF-8 or JSON, incompatible hook shapes, and concurrent edits.
Existing settings fields and bytes outside the one managed `GEMINI.md` block
are preserved; a failed preflight leaves every artifact untouched.

Native workflow links are installed separately by `dotaios activate` and
checked with `dotaios skills doctor`.

### OpenCode

```
dotaios connect opencode
```

Installs a local MCP server entry at `mcp.dotaios` in `~/.config/opencode/opencode.json`. Native skills use the shared `~/.agents/skills` target created by `dotaios activate`. Use `read_working_context` for startup continuity; use `search_aios` only for an explicit lookup and `resolve_skill` to route a workflow.

### Claude Code, Cursor

Use `dotaios activate` to wire these, see the README. The optional MCP adapter is an advanced integration, not part of first-time setup.

### Workflows in supported local tools

`dotaios activate` also installs your skills so they appear natively in the tools that support the Agent Skills standard. Each `skills/<name>/SKILL.md` is linked into the client paths that are safe for the installed tools:

- `~/.claude/skills/` for Claude Code, and
- `~/.agents/skills/` as the single shared Agent Skills path for Codex, Cursor, Gemini CLI, Kimi Code CLI, and OpenCode, and
- `~/.gemini/config/skills/` for Antigravity's documented global skill path.

Antigravity documents exactly two skill discovery paths: the workspace
`<workspace-root>/.agents/skills/` and the global `~/.gemini/config/skills/`.
`~/.gemini/antigravity/` is where the IDE keeps its own state, which is how
DotAIOS detects it, but it is not a directory Antigravity reads skills from.
Earlier releases projected there; that path is now a retired target, and
retiring it never deletes what is already inside it.

For Hermes, DotAIOS adds your `~/aios/skills` folder to
`skills.external_dirs` in the existing `~/.hermes/config.yaml` and every
discovered profile config under `~/.hermes/profiles/`. These are user-owned
files: malformed or structurally ambiguous YAML is preserved and reported for
manual review. DotAIOS also refuses symlinked or non-regular config targets,
invalid UTF-8, and unsafe ancestor paths. A recoverable per-file lock serializes
DotAIOS writers; external changes observed at guarded checkpoints are preserved.
The final replacement is atomic and retains an exact-byte backup, although an
external editor that does not honor the lock still has a narrow final
check-to-rename race.

The shared path is intentionally canonical. DotAIOS does not also populate a
second client-native path when that would make a client discover duplicate
skill names. A migration removes only old DotAIOS-owned links from retired
duplicate paths; real entries and foreign links are preserved. DotAIOS verifies
that it created the filesystem targets, but client-version discovery remains an
acceptance check for each installed tool. Browser chats cannot open these local
paths. Attach the relevant file or paste a bounded, reviewed brief instead.

When you install or remove a skill through DotAIOS, propagation happens during
that operation. If you create a skill folder manually, run `dotaios activate`
to reconcile all native locations explicitly:

```
dotaios skills install
dotaios skills doctor --json
```

`skills doctor` is read-only. It checks the generated catalogs, native-link
projection coverage, managed bridges, and Hermes root/profile configuration. It reports
Hermes as a native runtime without expecting a bridge file. If a temporary
setup path tries to overwrite the real global bridges, `activate` refuses it;
use a permanent AIOS folder instead.

Configuration is not invocation proof. For a bounded acceptance check, run the
explicit client probe against a disposable project fixture:

```bash
npx dotaios@2.0.18 skills probe --client codex --path ~/aios --dry-run
npx dotaios@2.0.18 skills probe --client codex --path ~/aios --run \
  --receipt /tmp/dotaios-codex-invocation.json
```

The probe defaults to dry-run and requires `--client` plus `--run` before it
starts a model process. It links one temporary project skill through the
registry-declared project target, runs the client with its safest bounded mode,
and records a `dotaios.skill-invocation.v1` receipt. The receipt keeps
`configured`, `discoverable`, `invoked`, and `produced` separate, includes the
client version and `SKILL.md` SHA-256, and requires an exact marker line from
the skill output. Unsupported or unsafe client surfaces are recorded as
limitations, never as green invocation evidence.

The probe is disposable and read-only with respect to the source AIOS folder.
It is not a replacement for `skills doctor`, and a doctor report alone still
cannot prove that a client used a skill.

The doctor also reports managed aliases separately from foreign collisions. A
managed alias is a symlink whose basename matches a skill's `name` in
frontmatter while its target is that skill's canonical directory. Ordinary
activation preserves these links. If a client reports duplicate skill names,
preview an explicit cleanup first, then apply it only after review:

```
dotaios skills install --dry-run --prune-aliases
```

The global prune flag is preview-only in this release. ManagedSkillStore does
not accept historical alias shape as deletion authority, so a real prune
refuses with proof-first guidance. Project-local aliases remain separate
project authority. Foreign real-directory collisions still require an explicit
ownership decision.

### Project-owned skill adapters

DotAIOS has two deliberately separate skill scopes:

- **AIOS scope:** `~/aios/skills/` is the user's canonical cross-project skill
  library. `dotaios activate` exposes it globally.
- **Project scope:** `<project>/skills/` is the project's own portable skill
  library. `dotaios attach <project>` (or `dotaios activate --project
  <project>`) exposes it only inside that checkout.

The bundled project targets are:

- `<project>/.claude/skills/` for Claude Code;
- `<project>/.agents/skills/` for Codex, Cursor, Gemini CLI, Kimi Code CLI,
  OpenCode, and Antigravity IDE.

Each target is a symlink pointing to the project's own `skills/` folder.
Editing a project skill therefore does not change the global
AIOS skills. Existing real entries and foreign links are preserved, repeated
attachment is idempotent, and `--dry-run` previews changes without writing.
Attachment fails closed when a target root is an unmanaged symlink, and a
later attach removes only owned dangling skill links if the project deletes
its `skills/` directory.
Projects without a readable `skills/` directory are a no-op for this layer.

DotAIOS does not configure a project-local Hermes file. Hermes reads
`$HERMES_HOME/config.yaml`, and `attach` neither changes `HERMES_HOME` nor owns
a project launcher that selects a checkout-local configuration. Writing
`<project>/.hermes/config.yaml` would therefore look configured while remaining
inert in an ordinary launch. Project-local Hermes support stays disabled until
DotAIOS satisfies all re-entry gates in the accepted
[Hermes support boundary](internal/foundation-program/decisions/2026-08-09-hermes-support-boundary.md):
an owned selector, version/capability policy, safe host mode, produced receipt,
and one shared production/health/probe resolver.

```bash
npx dotaios@2.0.18 attach /path/to/project --path ~/aios
npx dotaios@2.0.18 attach /path/to/project --path ~/aios --dry-run
```

This proves filesystem/configuration propagation. It does not claim that every
client version will discover or invoke a skill; native runtime acceptance is a
separate client-level check.

### Project-owned runtime adapters

An AIOS folder may include an optional `agents.json` when it needs to add a
runtime that is not in the bundled registry. Entries are merged by agent name
and can declare a native skill target:

```json
{
  "agents": [
    {
      "name": "Custom Runner",
      "detect": ".custom-runner",
      "bridge": null,
      "skills": { "mode": "symlink", "dir": ".custom/skills" }
    }
  ]
}
```

Run `dotaios activate --path ~/aios` after adding or changing this file. The
same source skill tree is then propagated to the custom target, and
`dotaios skills doctor --path ~/aios --json` reports its coverage. This is
filesystem propagation; the custom runtime still needs its own client-level
acceptance check to prove that it discovers and invokes the Agent Skills
directory. A custom Hermes-style runtime may instead use
`"mode": "config-external-dir"` with a home-relative `configFile` and
`"key": "skills.external_dirs"`; activation and `skills doctor` include that
configuration surface as well.

For a project-local custom runtime, only an explicit symlink-mode `project`
target is currently supported. Project `config-external-dir` targets are
ignored because the registry does not yet define or own the runtime selector
that would load them.

---

## Claude Code

**Status:** auto-save (once enabled)

Claude Code stores session transcripts locally. DotAIOS can read them directly.

Enable automatic saving:
```
dotaios capture enable claude-code
```

The Stop hook fires after each Claude Code response, so your conversation is saved incrementally. If the same transcript grows across responses, the saved file is updated in place, no duplicate entries.

Import past sessions (last 30 days):
```
dotaios capture import claude-code
```

Import all sessions ever:
```
dotaios capture import claude-code --all
```

---

## Gemini CLI

**Status:** paste/import only

Gemini CLI stores local sessions under `~/.gemini/tmp/<project_hash>/chats/`,
but DotAIOS does not currently import or capture those session files
automatically.

To save a Gemini conversation:
1. Copy the conversation from the terminal.
2. Run: `dotaios capture import paste`
3. Paste into the editor, save, and close.

Automatic saving for Gemini CLI is planned for a future release.

---

## Cursor

**Status:** paste/import only

Cursor conversations are stored in a SQLite database that is private to the Cursor process. DotAIOS does not read it.

To save a Cursor conversation:
1. Copy the conversation from the Cursor chat pane.
2. Run: `dotaios capture import paste`
3. Paste into the editor, save, and close.

Automatic saving for Cursor is planned for a future release.

---

## Any tool

You can always save any conversation manually, regardless of which tool you used:

```
dotaios capture import paste
```

Or from a saved file:

```
dotaios capture import file /path/to/conversation.txt
```
