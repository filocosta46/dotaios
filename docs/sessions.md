# Saving AI Conversations

DotAIOS saves selected AI conversations as local, agent-neutral Markdown so a
later agent can find the evidence you chose to preserve.

## Authority and storage

Canonical session files live under:

```text
~/aios/memory/sessions/<date>/<timestamp>_<agent>_<id>.md
```

Each schema-1 file has closed YAML frontmatter and a bounded Markdown body.
New turn-based records declare `body_encoding: escaped-lines-v1` so a
standalone role marker inside message content round-trips without becoming a
new turn. Legacy untagged records remain readable, and `turns: 0` prepared
summaries keep their bounded Markdown body unchanged.
Those Markdown files are canonical user memory. The adjacent
`memory/sessions/index.jsonl` file is only a rebuildable projection for bounded
listing and search. It is not a second session authority.

Capture, reconciliation, search metadata, and deletion all go through one
SessionStore boundary. Do not write a session file or edit the projection by
hand as part of an agent workflow.

## How to save a conversation

From any capable local agent, ask:

```text
save this session
```

The `save-session` skill prepares a bounded schema-1 Markdown summary and sends
it on standard input to:

```bash
dotaios capture import prepared --path ~/aios
```

The command must report a saved session before the skill reports success. The
skill does not write Markdown or `index.jsonl` directly. Prepared summaries use
`turns: 0` because they preserve decisions, open threads, and action items
rather than claiming to be a raw turn transcript.

For automatic Claude Code capture:

```bash
dotaios capture enable claude-code
```

After each completed Claude Code response, the adapter submits the observed
source through SessionStore. A session with no response is not saved.

To paste a conversation from any tool:

```bash
dotaios capture import paste
```

To import an exact saved file:

```bash
dotaios capture import file /path/to/conversation.txt
```

Paste and file import support Claude.ai, ChatGPT, Gemini, and other text
exports. All capture modes publish through the same durable boundary.

## Continuations and conflicts

Capture is serialized from source observation through publication. For records
from the same source:

- A strictly longer turn sequence grows the existing session.
- An older prefix is an idempotent no-op.
- Two non-prefix versions are both preserved as conflicts for explicit
  reconciliation.

The store never silently chooses one divergent source version or deletes the
other as duplicate evidence.

## Browse and search

List recent conversations:

```bash
dotaios capture list
```

Search across saved conversations:

```bash
dotaios search "your topic"
```

Filter by tool or date:

```bash
dotaios search "launch timing" --agent claude-code --since 7d
```

These read paths validate every projection path against a proved canonical
Markdown file. They are bounded and path-free, and do not create recovery,
repair, or quarantine state. A damaged or unsafe record is refused or reported
instead of being followed outside the session tree.

## Inspect or rebuild the projection

Report drift without changing files:

```bash
dotaios capture reconcile
```

The report includes orphan Markdown; stale, malformed, or unsafe rows; invalid
Markdown; duplicate IDs or paths; duplicate or conflicting source groups; a
missing projection; and pending, poisoned, or unsafe operational state. To rebuild only
the derived projection from proved canonical Markdown:

```bash
dotaios capture reconcile --apply
```

Reconciliation preserves session evidence. It does not silently delete an
orphan, duplicate, or conflict. The CLI recommends `reconcile --apply` only for
derived-projection drift or recoverable pending work. A duplicate or conflict
instead names the exact-session deletion flow below; poisoned operational
evidence is preserved for support rather than sent through automatic repair.

## Delete one exact session

Find the full session ID with `dotaios capture list`, then run:

```bash
dotaios capture delete <session-id>
```

Deletion succeeds only when SessionStore can prove the exact requested ID owns
one canonical regular file and its projection identity agrees. It refuses
ambiguous, linked, replaced, duplicate, or outside artifacts. The deletion is
journaled, so recovery can finish the same exact operation after interruption.
Unrelated session and outside bytes are not part of the transaction.

## Recovery and refusal boundaries

Mutations use a private journal under `.dotaios/session-store/`. Canonical and
projection bytes are staged and synced before a pending transaction is
published. A later mutating store call completes an interrupted publication
idempotently under the store lock.

The store rejects invalid UTF-8, malformed or open-ended frontmatter,
duplicate/alias/nested/prototype-like metadata, oversize fields or turns,
absolute and traversing paths, symlinked components, special files, hardlinks,
source replacement, and duplicate ownership. Its portable Node checks prove
identity at supported observation boundaries; they do not claim kernel-level
immunity to a hostile same-user swap-away-and-restore completed entirely
between checks.

Capture drafts do not mint identity. SessionStore assigns every new random
session ID; the ID becomes required only in the stored canonical Markdown.

The journal is local operational state, not memory. Fresh managed mirror rules
exclude `/.dotaios/session-store/`, and mirror validation refuses the path if it
is forced or staged. Existing mirrors remain protected before their ignore
template is refreshed because the pre-add policy excludes this operational
tree. Adding the exact ignore entry makes the boundary visible to Git as well.

## Working context and promotion

At session start, use `dotaios brief --compact` instead of opening session files
directly. The canonical working-context projection asks SessionStore for up to
three bounded, canonical-backed session records alongside the same events and
signals used by other local clients. One project filter applies to all three
sources. Session inventory and reads stay inside the projection's shared
512-file, 16 MiB, and 10,000-entry accounting, and the final visible projection
stays inside its 6,000-character budget.

Use `dotaios search` for older or more detailed evidence. To turn one session
fact into durable context, preview the exact destination first:

```bash
dotaios memory promote <session-id> --to project --project my-project \
  --summary "The beta ships Friday"
```

Nothing changes during preview. Re-run with `--apply` only after the source,
destination, and appended text look right. Every applied disposition writes a
receipt to `memory/events.jsonl`. Use `--to session-only` when the session
should remain evidence without creating a knowledge file.

## MCP and read-only behavior

The optional MCP adapter still exposes exactly `read_working_context`,
`search_aios`, and `resolve_skill`. Working-context and search use the same
SessionStore read boundary as the CLI. Search retains its bounded relative
provenance label but returns no absolute machine path. Compact CLI output, hook
JSON, lean brief reads, MCP reads, and search do not launch repair, quarantine,
recovery, or detached sync work.

## Stop automatic capture

```bash
dotaios capture disable claude-code
```

Automatic capture stops immediately. Existing sessions are not deleted.

## What is and is not saved

Raw capture saves the messages you typed, the AI replies, the capture time and
tool, and inferred project attribution when available. A prepared save-session
summary saves its decisions, open threads, and action items instead of a raw
transcript.

Capture does not implicitly save files you opened or edited, terminal/search
tool output, internal reasoning, or secret files such as `.env`.

DotAIOS stores session Markdown on your machine. Your AI provider still
processes the conversation according to its terms. Optional GitHub sync copies
canonical session Markdown to your private mirror but excludes the private
SessionStore journal.

Run `dotaios capture status` to see the adapters available on the current
machine. See [adapters.md](adapters.md) for the per-tool capability matrix.
