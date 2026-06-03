---
name: summarize-source
triggers: summarize this source, summarize this article, tldr this, summarize the ingested doc
description: Turn an ingested URL, PDF, transcript, call note, or raw Markdown file into a useful local summary with provenance.
---

# summarize-source

Convert raw material into a concise local summary your agents can reuse.

## What this does

- Reads a source already saved in `vault/raw/`, `vault/assets/`, or supplied by the user.
- Creates a minimal or detailed summary.
- Preserves source attribution.
- Suggests whether the summary belongs in `vault/summaries/`, `vault/wiki/`, or project notes.

## What this doesn't do

- It does not install Obsidian plugins.
- It does not transcribe audio or video by default.
- It does not auto-promote raw notes to wiki knowledge.
- It does not write durable wiki/org/context files without approval.

## How to use it

Try saying:

- "summarize this source for my AIOS"
- "make a detailed summary of vault/raw/article.md"
- "turn these call notes into a reusable project summary"

## Agent steps

1. Read the source frontmatter and content.
2. Keep provenance fields visible: source, title, ingested date, parser, and file path when present.
3. Choose summary depth:
   - minimal: key points and next actions
   - detailed: key points, evidence, decisions, risks, follow-ups
4. Recommend a destination but ask before writing.
5. If writing, use Markdown with frontmatter and `unread: true` when the user wants a review queue.

## Output

```markdown
---
kind: summary
source: ...
unread: true
---

# Summary

## Key Points

## Decisions Or Implications

## Follow-Ups
```
