---
name: update-skills
triggers: update my skills, update skills, check for skill updates, are my skills up to date, refresh my skills, keep my skills updated, is everything connected, connection check, aggiorna le skill, è tutto collegato, skill updates
description: Check that everything is connected, look for updates to installed skills, packs, and plugins, apply the safe ones, and refresh the skill links every AI tool reads. Run it about once a week.
---

# update-skills

Keep the user's skills and packs fresh without them touching a terminal.

## What this does

- Checks the health of the skills setup and the links into each AI tool.
- Finds installed packs and plugins that came from an external source (a Git repository or a marketplace listing) and checks whether the source has newer content.
- Reinstalls updated packs through the normal guarded install path, never by hand-editing files.
- Refreshes the skill catalog and native links so every connected tool sees the same, current set.
- Records when the check ran, so the next session knows whether a week has passed.

## What this doesn't do

- It does not install anything from a source the user never installed before; new sources always need the user's explicit OK.
- It does not modify the user's own hand-written skills; only content that came from an external source is refreshed.
- It does not run in the background. An agent runs it when asked, or when it notices the last check is more than a week old.

## How to use it

Try saying:

- "Update my skills"
- "Are my skills up to date?"
- "Check for skill updates"

## Agent steps

1. Run `npx dotaios@latest skills doctor` and read the report. Fix what it flags (stale `INDEX.md`/`RESOLVER.md`, broken links) by running `npx dotaios activate`. If the user only asked whether everything is connected, stop here and report the result in plain words.
2. Look for externally sourced content:
   - `plugins/` entries with a `manifest.json` that names a source repository or marketplace id.
   - Pack install notes in `memory/` or `connections/registry.md` that record a source URL (packs bought as a paste-in prompt record their source there when installed).
3. For each source found, check for updates: for a Git source, clone or fetch it to a temporary folder and compare; for a marketplace id, use `npx dotaios market info <id>`. When the source has changed, reinstall it with `npx dotaios install <source>` (or `npx dotaios market install <id>`), which applies the usual safety guards.
4. Run `npx dotaios activate` once at the end so catalogs and native links are regenerated, then `npx dotaios skills doctor` to confirm everything reports healthy.
5. Append one line to `memory/events.jsonl` recording the check (event `skills-update`, plus what was updated or "no updates"). If more than 5 things changed, summarize instead of listing.
6. Tell the user in one short paragraph what was updated, what was already current, and anything that needs their decision. Plain words, no file paths unless something needs fixing.

If the last `skills-update` event in `memory/events.jsonl` is older than 7 days, it is worth offering this check at the start of a session: "Want me to check your skills for updates? It has been over a week."

## Output

- What was updated (or "everything already current")
- Anything skipped because it needs the user's OK
- Confirmation that the connection check passes
