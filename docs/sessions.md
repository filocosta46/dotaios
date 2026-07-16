# Saving AI Conversations

DotAIOS can save your AI conversations locally so every agent on your machine can remember what you've talked about.

## Where conversations are saved

All saved conversations live in:

```
~/aios/memory/sessions/
```

Each conversation is a plain text file, you can open it in any text editor. The files are named by date and agent, so they're easy to browse.

## How to save a conversation

**From any capable AI agent** (clean summary, no CLI needed):

Ask:

```
save this session
```

The `save-session` skill writes a readable summary into `~/aios/memory/sessions/` with decisions, open threads, and action items. This is best when you want the next agent to understand what happened without storing a full raw transcript.

**From Claude Code** (saves automatically once enabled):

```
dotaios capture enable claude-code
```

This sets up automatic saving. After each Claude Code response, the conversation is saved to your AIOS folder. If you start a session and never see a response, nothing is saved.

**From any AI tool** (paste in manually):

```
dotaios capture import paste
```

Your text editor opens. Paste the conversation, save, and close. Works with Claude.ai, ChatGPT, Gemini, or anything else. Use this when the tool cannot write local files or you want a fuller transcript.

**From a saved file:**

```
dotaios capture import file /path/to/conversation.txt
```

## How to browse saved conversations

List recent conversations:

```
dotaios capture list
```

Search across all saved conversations:

```
dotaios search "your topic"
```

Filter by tool or date:

```
dotaios search "launch timing" --agent claude-code --since 7d
```

## How saved conversations become working context

At session start, use `dotaios brief --compact` rather than opening session
files directly. The canonical projection selects up to three bounded records
from `memory/sessions/index.jsonl` alongside the same events and signals used by
other local clients, and applies one project filter to all three sources when a
project is requested. It does not inject full saved transcripts. Use
`dotaios search` when you need older or more detailed evidence.

With the optional MCP adapter, `read_working_context` returns that same startup
projection, `search_aios` performs the on-demand lookup, and `resolve_skill`
routes a request to an installed workflow. Those are the adapter's only tools.

## Promote something that should last

A saved session is evidence, not automatic truth. To turn one fact into durable
context, preview the exact destination first:

```bash
dotaios memory promote <session-id> --to project --project my-project \
  --summary "The beta ships Friday"
```

Nothing changes during the preview. Re-run with `--apply` only after the source,
destination, and appended text look right. Every applied disposition writes a
receipt to `memory/events.jsonl`. Use `--to session-only` when the session should
remain evidence without creating a knowledge file.

## How to delete a saved conversation

First, find the conversation ID with `dotaios capture list`. It's the 8-character code on the left.

Then delete it:

```
dotaios capture delete <id>
```

This removes the file and its entry from the index.

## How to turn off auto-saving

```
dotaios capture disable claude-code
```

Auto-saving stops immediately. Past saved conversations are not deleted.

## What gets saved

- The messages you typed and the AI's replies.
- The date and which tool you were using.
- The project folder you were working in (inferred automatically).
- For `save-session`, a summary with decisions, open threads, and action items instead of a raw transcript.

## What does NOT get saved

- Files you opened or edited during the session.
- Tool outputs like search results or terminal commands.
- Thinking blocks or internal reasoning steps.
- Anything in `.env` or other secret files.

DotAIOS stores these saved files on your machine. Your AI provider still processes the conversation you have with it, according to that provider's terms and settings. Optional GitHub sync copies the saved files to your own private repository.

## Which tools support what

Run this to see what's available on your machine:

```
dotaios capture status
```

See [adapters.md](adapters.md) for a full breakdown by tool.
