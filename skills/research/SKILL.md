---
name: research
triggers: deep research, research this, look this up properly, compare the options, what's the latest on, find out everything about
description: Deep research on any question — break it into parts, search the web across all of them, and write back one clear report with sources. Use when a question needs real, current answers from many places, not a single quick search.
---

# research

Ask a real question, get a real answer — searched across many sources and written up with links, the way a good analyst would do it. No setup, no accounts.

## Start here (non-technical)

Just say what you want to know, in plain words. For example:
- "Research the best budget espresso machines in 2026."
- "Find out everything about that company before my interview."
- "Compare the options for a small-business accounting tool."

You'll get back a short report: the answer up front, the details with links you can click, and an honest note on anything that's unclear. It gets saved so you can find it later.

## How the agent runs this

When the user wants something researched properly (current facts, a real
comparison, "look this up across many sources"), do NOT fire one search and
stop. Do this:

1. **Plan.** Break the question into 3–6 focused, non-overlapping sub-questions
   that together answer it (more for broad topics, fewer for narrow).
2. **Search each** sub-question with web search. Pull the best 5–8 findings —
   real numbers, names, dates — each with its source URL.
3. **Write one report** with these sections:
   - `## TL;DR` — 3–5 bullets, the answer first, each with its `[url]`
   - `## Key findings` — grouped, every claim keeps its `[url]`
   - `## Open questions & caveats` — what's uncertain or conflicting
   - `## Sources` — the deduplicated list of URLs used
4. **Save it** (if you can write files) to
   `vault/research/deep/<YYYY-MM-DD>-<slug>.md` with simple frontmatter
   (`created`, `query`, `tags: [deep-research]`), then show it to the user.

## Two rules that keep it good

- **Cite everything.** Every fact carries the URL it came from. No source →
  drop it or mark it uncertain. Trust is the whole point.
- **Stay bounded.** Plan once, search the sub-questions once, write once. Never
  start a loop that keeps spawning more searches — it wastes time and money for
  no extra quality. Need more depth? Add a couple more sub-questions, or run a
  second focused pass.

## When NOT to use

A single quick fact → just search once. Saving or digesting ONE known article
or source → use `ingest` then `summarize-source`. `research` is for the case
where you need to search *across many sources* and synthesize one cited answer.
