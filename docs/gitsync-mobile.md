# GitSync on mobile (read your AIOS from a phone)

DotAIOS sync mirrors your `~/aios` folder to a private GitHub repo. That repo is
plain Markdown, so any git client on a phone can read and edit it. This page
covers the two apps that work well for that flow, with the settings that keep
conflict surface small. No new services, no servers, no extra accounts beyond
the GitHub repo `dotaios sync setup` already created.

## Why this works

`dotaios sync` commits and pushes your AIOS folder as plain Markdown and JSONL.
A phone git client clones that repo, so you can read your context, daily notes,
projects, and vault from anywhere, and capture a quick note by editing a file
and pushing it back. The next `dotaios sync now` on your laptop pulls your
phone edits down with a rebase, so the two stay in sync without a second
service.

## Pick a client

- **GitSync** (iOS) supports GitHub OAuth, an in-app editor, and scheduled
  background sync.
- **MGit** (Android) is a manual git client. It can clone, fetch, pull, commit,
  and push, but it does not include a text editor, automatic background sync,
  or the same GitHub OAuth flow. Pair it with an Android editor that supports
  Content Providers and use one of MGit's supported HTTPS or SSH
  authentication methods.

## One-time setup

1. Run `dotaios sync setup` on your laptop first. This creates the private repo
   and pushes the first mirror.
2. In GitSync, sign in to GitHub with OAuth. In MGit, configure HTTPS or SSH
   authentication for the private repo.
3. Clone your DotAIOS repo. It is the URL `dotaios sync repo` prints.
4. In GitSync, open Markdown in the in-app editor. With MGit, open the cloned
   files in a separate Android editor that supports Content Providers.

## Day-to-day flow

- **Read:** open any file under `context/`, `memory/daily/`, `projects/`, or
  `vault/`. Nothing on the laptop changes until you pull.
- **Capture a quick note:** edit `memory/inbox/<timestamp>.md` (create the file
  in the app), commit with a short message, and push. At the start of your next
  laptop session the `process-inbox` skill files the note into the right place
  and deletes the inbox file. This is the intended capture path from a phone.
- **Let the laptop reconcile:** run `dotaios sync now` on the laptop, or use a
  dedicated scheduled sync worktree. The tick pulls your phone commit by
  rebasing the local state on top of it, then pushes the combined history back.
  Your phone receives the result on GitSync's next scheduled or manual sync. In
  MGit, fetch and pull manually.

## Sync safety boundary

DotAIOS does not detach a sync tick from ordinary commands by default. A
feature checkout must never be able to commit, rebase, push, or reset itself
because an unrelated command ran. Use the dedicated scoped sync wrapper or
run `dotaios sync now` explicitly from the intended sync worktree.

The legacy detached hook is available only with the explicit
`DOTAIOS_ALLOW_AUTO_SYNC_HOOK=1` opt-in. Set that variable only in a controlled
main sync worktree. Do not set it in a normal project checkout.

## Keeping conflicts small

- Edit only one file per phone session, usually an inbox note. Avoid editing
  `memory/events.jsonl` or `memory/signals/*.jsonl` from the phone, those are
  append-only and written by the laptop on a schedule.
- Commit and push immediately after a small edit. Do not batch several edits
  across files and push them all at once.
- The laptop sync commits local changes before pulling. If the phone and laptop
  changed the same lines, sync stops without creating branches, resetting
  files, or pushing. Your pre-existing edits are preserved, and DotAIOS records
  the conflict locally. Ask your agent to resolve it safely, then run
  `dotaios sync now` again.

## If the app reports a conflict

For an inbox note, the simplest resolution is to keep both versions (yours and
the laptop's) and let the laptop tick clean it up. For any other file, resolve
the conflict on the laptop, then commit and push the result.

## Private repo access

The repo `dotaios sync setup` creates is private. GitSync's GitHub OAuth access
can be reviewed or revoked from GitHub > Settings > Applications without
affecting laptop sync. MGit does not provide equivalent OAuth sign-in, so
review and revoke the HTTPS credential or SSH key you configured for it
separately. Laptop sync uses its own token stored in
`~/.dotaios/sync.json`.

## How the laptop token is stored and how to rotate it

`~/.dotaios/sync.json` is written with owner-only permissions (`0600`) inside a
`0700` directory, so no other account on the machine can read it. The token is
**never** written into your repository's `.git/config`: the git remote stays a
plain `https://github.com/<you>-aios.git` URL, and DotAIOS authenticates each
push/fetch through a per-invocation git credential helper that reads the token
from the environment for that one command. Older installs that embedded the
token in the remote URL are healed to the plain URL automatically on the next
sync.

To rotate the token:

1. Create a new fine-grained GitHub token (repo contents: read/write on the
   `<you>-aios` repo only), the same scope `dotaios sync setup` requested.
2. Run `dotaios sync setup` again and paste the new token — it overwrites
   `sync.json` in place at `0600`.
3. Revoke the old token from GitHub > Settings > Developer settings > Tokens.

To stop syncing entirely, run `dotaios sync logout`, which removes the stored
token, and then revoke it on GitHub.
