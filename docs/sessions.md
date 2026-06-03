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

All data stays on your machine. Nothing is sent to any external service.

## Which tools support what

Run this to see what's available on your machine:

```
dotaios capture status
```

See [adapters.md](adapters.md) for a full breakdown by tool.
