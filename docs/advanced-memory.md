# Advanced Memory

DotAIOS works fully without anything on this page. The folder, the context
files, the skills, the search: none of it needs a server, an account, a
database, or an always-on machine. This page is the ladder you can climb when
you want more, one optional rung at a time.

Every rung is opt-in, off by default, and reversible. Skip this page entirely
and you still have the whole product.

## Rung 1: The folder (you already have this)

`~/aios` with your context, memory, vault, and skills. Plain files. Every
connected tool reads it. This is the product.

## Rung 2: Phone sync

Mirror your folder to a private GitHub repository that only you can see, so
you can read your memory from your phone and drop notes into it from anywhere.

```bash
npx dotaios sync setup
```

Notes you save from another device land in `memory/inbox/`, and the
`process-inbox` skill files them into the right place next time you sit down.
Turn it off any time with `dotaios sync logout`, which also removes the access
token it used.

## Rung 3: Saved conversations

Let DotAIOS keep your AI sessions as local Markdown, so every tool on your
machine can remember what you and another tool talked about.

```bash
npx dotaios capture enable claude-code   # save sessions automatically
npx dotaios capture import paste         # or paste one in from any tool
```

Everything lands in `memory/sessions/` as readable files you can open, edit,
or delete. See [Saving conversations](sessions.md).

## Rung 4: A brief on a schedule

Your folder ships with a pre-wired daily brief. It uses your computer's own
scheduler, not a service of ours.

```bash
npx dotaios schedule install --dry-run   # shows what it would do, changes nothing
```

## Rung 5: Recipes for a deeper brain (entirely optional)

Some users point heavier, self-hosted systems at the same folder. Two that the
author runs himself:

- **Hermes**, an agent runtime with scheduled jobs and a task board. If it is
  installed, `dotaios activate` registers your skills folder with it, and that
  is the only integration DotAIOS does. DotAIOS never installs or requires it.
- **GBrain**, a local semantic index built on top of the same files. The files
  stay the source of truth; the index is derived and rebuildable. DotAIOS does
  not depend on it, talk to it, or know it exists.

These are recipes, not features. They need their own setup, their own
hardware, and a tolerance for tinkering. DotAIOS will never make them
mandatory, and nothing in the core product changes whether you run them or
not. If you never climb past rung 1, you are using DotAIOS exactly as
intended.
