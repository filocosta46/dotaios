---
name: memory-maintenance
triggers: is my memory still accurate, clean up my memory, my context is out of date, retire stale facts, memory maintenance, curate my memory
description: Find claims in this AIOS that have gone stale or contradict each other, then retire them by superseding — so memory stays true instead of just growing.
when_to_use: is my memory still accurate · clean up my memory · my context is out of date · retire stale facts · memory maintenance · curate my memory
---

# memory-maintenance

Memory that nobody curates stops being worth reading. This finds what stopped
being true and fixes it in place.

## What this does

- Runs `dotaios memory audit --all-memory` and works from what it reports: hot files over
  budget, conflicting promoted blocks, stale signals, corrupt lines.
- Reads the flagged claims and decides, per claim, whether it is still true.
- Retires the ones that are not, with `--operation supersede`, which is
  non-destructive: the old block stays on the page with a superseded-by marker
  under it, so the record shows what was believed and when.
- Promotes anything durable that is still sitting in short-lived memory.

## What this doesn't do

- It does not erase a claim. Superseding keeps the history; only the user may
  decide a claim should never have been recorded at all.
- It does not rewrite `context/`, `projects/`, or `vault/` without showing the
  preview first and getting a yes.
- It does not invent a replacement fact. If you cannot tell whether a claim is
  still true, ask the user in one sentence.
- It does not run itself. `dotaios schedule` only runs DotAIOS commands, so
  schedule `dotaios memory audit --all-memory` and run this skill on what it reports.

## How to use it

Try saying:

- "use memory-maintenance"
- "is anything in my memory out of date?"
- "clean up my context"

## Agent steps

1. Run `dotaios memory audit --all-memory`. Treat its findings as the work list; do not go
   hunting through files it did not flag.
2. Run `dotaios capture list` and note the session id you will attribute each
   change to. Every promotion needs one — there is no free-text promotion.
3. For each stale or contradicted claim, preview the retirement:
   ```bash
   dotaios memory promote <session-id> --to context \
     --destination context/work.md --operation supersede \
     --match "<the old fact, verbatim>" --summary "<what is true now>"
   ```
   `--match` takes the old block's content hash or its summary text, exactly,
   and only resolves blocks that `dotaios memory promote` itself wrote. A fact
   typed into a file by hand has nothing to match: edit that file directly and
   state in one line what changed.
4. Show the previews, at most 5 at a time. Re-run with `--apply` once the user
   says yes.
5. If a durable fact is sitting in `memory/signals/`, promote it to `context`,
   `project`, or `vault` — signals leave the routed window after 30 days.
6. Report anything you could not decide, as a question, not a change.

## Output

- What is no longer true, and what replaced it
- What was promoted out of short-lived memory
- What you could not verify, as questions for the user
- Nothing written without an approved preview
