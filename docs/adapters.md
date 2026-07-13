# Adapter Capabilities

DotAIOS saves conversations from different AI tools. Each tool has a different level of support depending on what's technically possible.

## Capability levels

| Label | What it means |
|---|---|
| **auto-save** | Conversations save automatically when you close a session. Nothing extra to do after setup. |
| **import only** | You can save past conversations by running an import command. No automatic saving. |
| **paste/import only** | Copy-paste the conversation manually. DotAIOS has no automated way to read this tool's files. |
| **not available** | The tool is not installed on your machine. |

Run `dotaios capture status` to see what's active on your machine.

---

## Giving tools your context (`connect`)

The capability levels above are about *saving conversations out of* a tool. The
`connect` commands do the opposite: they wire a tool so it *reads your DotAIOS
context in* automatically.

### Gemini CLI

```
dotaios connect gemini
```

Installs three things in `~/.gemini/`:
- a `GEMINI.md` bridge pointing Gemini at your `~/aios` folder,
- a **SessionStart hook** that injects your working-memory digest (`dotaios brief --compact`) at the start of every session, and
- an MCP server entry exposing `read_session_digest`, `read_context`, `list_skills`, and `search_memory`.

If `~/.gemini/settings.json` already exists, DotAIOS merges into it and refuses to overwrite a file that is not valid JSON (no partial install).

### OpenCode

```
dotaios connect opencode
```

Installs an MCP server entry in `~/.config/opencode/opencode.json` plus a skill stub per installed skill, so your skills appear as `/skill <name>` in OpenCode.

### Claude Code, Cursor

Use `dotaios activate` (and `dotaios mcp install`) to wire these, see the README.

### Skills: native in every tool

`dotaios activate` also installs your skills so they appear natively in the tools that support the Agent Skills standard. Each `skills/<name>/SKILL.md` is linked into the client paths that are safe for the installed tools:

- `~/.claude/skills/` for Claude Code, and
- `~/.agents/skills/` as the single shared Agent Skills path for Codex, Cursor, and Gemini CLI, and
- `~/.gemini/config/skills/` for Antigravity's documented global skill path.

For Hermes, DotAIOS adds your `~/aios/skills` folder to `skills.external_dirs` in `~/.hermes/config.yaml`.

The shared path is intentionally canonical. DotAIOS does not also populate a
second client-native path when that would make a client discover duplicate
skill names. A migration removes only old DotAIOS-owned links from retired
duplicate paths; real entries and foreign links are preserved. DotAIOS verifies
that it created the filesystem targets, but client-version discovery remains an
acceptance check for each installed tool. Surfaces that do not read a local
skills folder, such as the Claude desktop app and browser based chat, keep
using the AGENTS.md context that `activate` and `connect` set up.

When you install or remove a skill through DotAIOS, propagation happens during
that operation. If you create a skill folder manually, run `dotaios activate`
to reconcile all native locations explicitly:

```
dotaios skills install
dotaios skills doctor --json
```

`skills doctor` is read-only. It checks the generated catalogs, native-link
coverage, managed bridges, and Hermes root/profile configuration. It reports
Hermes as a native runtime without expecting a bridge file. If a temporary
setup path tries to overwrite the real global bridges, `activate` refuses it;
use a permanent AIOS folder instead.

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

Gemini CLI is installed but does not store conversation transcripts in a format DotAIOS can read automatically.

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
