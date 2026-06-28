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
and pushing it back. The next `dotaios sync tick` on your laptop pulls your
phone edits down with a rebase, so the two stay in sync without a second
service.

## Pick a client

- **GitSync** (iOS) and **MGit** (Android) are the common choices. Both do
  background fetch, OAuth for private GitHub repos, and a basic conflict view.
  Any git client that supports GitHub OAuth and a commit+push flow works; the
  steps below are the same.
- Use the GitHub OAuth sign-in the app offers. Do not paste a personal access
  token into a phone app if OAuth is available, OAuth scopes are narrower and
  revocable from GitHub directly.

## One-time setup

1. Run `dotaios sync setup` on your laptop first. This creates the private repo
   and pushes the first mirror.
2. On the phone, sign in to GitHub through the git client (OAuth).
3. Clone your DotAIOS repo. It is the URL `dotaios sync repo` prints.
4. Open files in the app's built-in editor. Markdown renders readably in both
   GitSync and MGit.

## Day-to-day flow

- **Read:** open any file under `context/`, `memory/daily/`, `projects/`, or
  `vault/`. Nothing on the laptop changes until you pull.
- **Capture a quick note:** edit `memory/inbox/<timestamp>.md` (create the file
  in the app), commit with a short message, and push. At the start of your next
  laptop session the `process-inbox` skill files the note into the right place
  and deletes the inbox file. This is the intended capture path from a phone.
- **Let the laptop reconcile:** run `dotaios sync tick` on the laptop (it runs
  automatically on a hook). The tick pulls your phone commit by rebasing the
  local state on top of it, then pushes the combined history back. Your phone
  fetches the result on its next background sync.

## Keeping conflicts small

- Edit only one file per phone session, usually an inbox note. Avoid editing
  `memory/events.jsonl` or `memory/signals/*.jsonl` from the phone, those are
  append-only and written by the laptop on a schedule.
- Commit and push immediately after a small edit. Do not batch several edits
  across files and push them all at once.
- The laptop tick already commits local changes before pulling, so a rebase
  conflict only happens when the phone and laptop edit the same file at the
  same time. If that happens, the tick parks your local commit on a
  `local-<timestamp>` branch and aligns `main` with the remote, so nothing is
  lost. Resolve the conflict on the laptop, then push.

## If the app offers a conflict view

Both GitSync and MGit show a conflict marker view. For an inbox note, the
simplest resolution is to keep both versions (yours and the laptop's) and let
the laptop tick clean it up. For any other file, prefer the laptop's version,
it is the one running the skills and the sync discipline.

## Private repo access

The repo `dotaios sync setup` creates is private. OAuth through the phone app
scopes to that one repo (or your account), and you can revoke the app's access
from GitHub > Settings > Applications at any time without affecting the laptop
sync, which uses its own token stored in `~/.dotaios/sync.json`.
