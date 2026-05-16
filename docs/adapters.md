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

## Claude Code

**Status:** auto-save (once enabled)

Claude Code stores session transcripts locally. DotAIOS can read them directly.

Enable automatic saving:
```
dotaios capture enable claude-code
```

The Stop hook fires after each Claude Code response, so your conversation is saved incrementally. If the same transcript grows across responses, the saved file is updated in place — no duplicate entries.

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
