# Changelog

All notable changes to DotAIOS will be documented in this file.

## [Unreleased]

## [2.0.15] - 2026-08-31

### Changed

- Registered-project discovery now bounds concurrent metadata inspection,
  performs one bounded Git query per project, and reuses deterministic shared
  serialization helpers across the core.

### Fixed

- Project routing now requires a recognized leading action verb outside every
  distinct selected-project handle, so bare noun matches and vague reference
  questions fail closed without suppressing explicit commands such as
  `review review` or `Code Review: review this`.
- Untrusted local Markdown and text fields now use bounded escaping helpers,
  while adversarial token parsing remains linear.
- Exact project routes now report that location identity was revalidated during
  exact resolution instead of implying a second pre-entry validation step.

## [2.0.14] - 2026-08-30

### Added

- Task-first resolution now returns one structured local result for verified
  project context and any matching governing skill, or for an explicitly
  configured read-only tool.
- Approval-bound project routing discovers an explicitly registered project,
  binds the exact approved action and project conventions, and returns advisory
  instructions for one fresh host context rooted at that project.

### Fixed

- Project routing now fails closed when identity, conventions, approval, or
  client capabilities drift, while preserving compact refusal authority and
  actionable upgrade guidance.

## [2.0.13] - 2026-08-29

### Fixed
- Prebuilt npm tarballs now carry the exact reviewed source commit in their
  publication manifest, and local package admission refuses a mismatched
  manifest before release. Product behavior is unchanged from 2.0.12.

## [2.0.12] - 2026-08-29

### Added
- First-session induction now carries a browser-chat user through a local agent,
  explicit project registration, one connected existing folder, and one useful
  action that runs only after approval.
- Release admission binds the candidate invocation, source commit, dependency
  graph, compressed package hash, canonical payload hash, and packed black-box
  induction evidence to one exact artifact.

### Fixed
- Global skill activation always maintains the shared Agent Skills projection,
  but creates client-specific Claude Code, Antigravity, and Grok projections
  only for detected clients unless `--all` is explicit. Setup and activation
  now share that target plan across preview and apply, including custom
  registries and `CLAUDE_CONFIG_DIR`, without deleting previously managed
  targets merely because a client is no longer detected.
- Activation and attachment dry runs now identify themselves as previews instead
  of reporting that DotAIOS was activated or attached when no writes occurred.

## [2.0.11] - 2026-08-26

### Added
- `dotaios upgrade` previews, approves, applies, and verifies updates to managed
  instructions, official skills, and generated schedules without replacing
  unmanaged content.
- `dotaios capture save-summary` gives assistants one bounded interface for an
  intentional session save.

### Fixed
- Managed surfaces use the exact installed DotAIOS release, and upgrades repair
  package-generated 2.0.9 and 2.0.10 schedule commands without changing custom
  schedule bytes.
- Claude Code activation, skill projection, and diagnostics honor an absolute
  `CLAUDE_CONFIG_DIR` instead of writing or checking only `~/.claude`.

## [2.0.10] - 2026-08-18

### Changed
- First-time setup uses `dotaios@latest` and the unversioned GitHub paste line.
  The page is no longer rewritten every release just to bump a number.

### Added
- Grok is a detected skill host. `activate` links the AIOS catalog into
  `~/.grok/skills`, the directory Grok always scans. This is not a Grok
  installer.

## [2.0.9] - 2026-08-18

### Added
- `dotaios project source locate` answers "where is that folder?" instead of
  "what is in it?", so a connected folder can be reached at any size. Retrieval
  records every reference it returns in one 32,000-byte receipt line, so it can
  never return more files than that line holds — about 110-120 ordinary names —
  and past that a folder that connected successfully refused every retrieval
  forever. `locate` resolves the connection and stops: same project routing,
  same grant, same refusals, no listing. It costs the same for four files as for
  forty thousand (measured: a 7,000-file nested folder resolves in 0.13s, where
  retrieval refuses at a few hundred). The assistant then opens the folder with
  its own file tools and reads only what the task needs, so nothing spends
  tokens on files nobody asked for. The receipt carries no references, which is
  the shape a refusal already writes, so the closed receipt schema is unchanged
  and older versions keep reading the ledger.

### Fixed
- `context --refresh` now fills the same command name and release that `init`
  writes. It had been reprinting the router with empty commands and dead doc
  links, and `doctor` called that healthy. `doctor` now fails on an empty
  command name and points at `context --refresh`, not `init --overwrite`.
- A refused folder listing now says what happened and what to do next, in
  words. Size refusals point at `locate`. The machine reason stays in `--json`.
  The receipt is unchanged.
- Parent `project` help lists `locate` above `retrieve`, so the one-step path
  is the one that gets read.
- Connecting a folder no longer asks for a deadline. `connect` and `grant`
  default to a far stored date so older CLIs can still read the grant. Access
  stays open until you revoke it.
- Compact `brief` now includes **Current Work** from `context/work.md`. Setup
  already asked for it and then hid it from every session start.

### Changed
- The first file a new person reads (`FIRST_SESSION.md`) is now in their
  language, not the product's internals.

## [2.0.8] - 2026-08-17

Thanks to Roberto Tomada, who ran a genuinely clean first install on a Mac that
had never seen DotAIOS and reported both of these from the other side of it
(#94, #95).

### Fixed
- The assistant now finishes an install by telling you what you can do, not
  what it did. It used to close with file paths, version numbers, shell
  profiles and "not running in a terminal" — its own plumbing, explained to
  someone who asked for none of it. It now leaves you with three things: where
  your folder is, what is in it because you said so, and one thing to try next
  (#94).
- A `doctor` warning about an app you do not have is no longer handed to you as
  a task. Setup creates `~/.gemini/config/skills`, which creates `~/.gemini`,
  which is exactly how Gemini is detected — so the check could tell someone
  they had software they never installed. The assistant now offers a named fix
  only when the thing it names is actually there. The detection rule itself is
  still wrong and is a separate change (#94).
- The line you paste is one short sentence again, with a link that cannot go
  stale: `Please set up DotAIOS on my computer:
  https://github.com/filocosta46/dotaios`. It had become a versioned deep link
  into a file path — a developer artefact handed to the person least likely to
  tolerate one, and it pinned anyone who saved it to that release forever. The
  pin moved into the page, where each release keeps it current, so an assistant
  still reads instructions that match the package it installs (#95).
- The install no longer asks what matters most this week. People answered it
  with the sentence they had just given for what they are working on, so asking
  read as not having listened — and it was the one answer with an expiry
  written into it: "this week", landing in a file this product promises is
  durable, that nothing ever came back to refresh. Three questions instead of
  four. `dotaios interview` still asks it, at a moment you choose.

## [2.0.7] - 2026-08-17

### Fixed
- The assistant can now install Node on macOS without an administrator
  password, by extracting the official LTS tarball into the person's own home
  and prepending it to `PATH` on each command. The previous instruction sent
  Apple Silicon users to a `.pkg` that nodejs.org does not publish for arm64
  (#92).
- The install no longer asks which AI tools you use. The answer configured
  nothing — clients are connected by detection, not by that list — and asking
  contradicted the product's own promise that you switch tools freely and your
  context follows. Four questions instead of five, and the pasted request is
  one sentence a person would actually say (#91).

## [2.0.6] - 2026-08-16

Thanks to Roberto Tomada, who found and fixed the Node bootstrap route on a new
Mac (#87), and reported the Antigravity skills path (#88) — the fix that shipped
here in #89 is his finding.

### Added
- OpenCode now gets a context bridge at `~/.config/opencode/AGENTS.md`, the
  global instructions file OpenCode documents. It was reached only through
  OpenCode's Claude Code compatibility fallback on `~/.claude/CLAUDE.md`, which
  a person turns off with one environment variable and which loses to any
  nearer `AGENTS.md`, because the first matching file wins rather than
  combining. The bridge is written only for a machine that actually runs
  OpenCode, and the uninstall steps name the new file, because a bridge the
  removal contract does not list is one nobody can fully undo.

### Fixed
- The Node.js route the assistant was given could not work on a new Mac. It
  named `brew install node`, but Homebrew is not on a fresh machine, the guide
  never said how to get it, and where brew does exist that formula installs the
  current release — several majors ahead of anything tested. `nvm` was no better:
  it is a shell function rather than a program, so a Node it installs is gone by
  the assistant's next command. The guide now names the nodejs.org LTS installer,
  which lands on the default path, and CI tests that release line instead of
  assuming it.
- The install command in INSTALL.md could not run as written. It sits inside a
  numbered list, so its heredoc terminator carried three spaces, and a heredoc
  only closes on an unindented delimiter — setup received the terminator and
  everything after it as part of the answers, reported invalid JSON, and
  created nothing. It rendered correctly on github.com, where the indentation
  is stripped, and failed for every assistant that read the source, which is
  the audience the section is written for.
- `dotaios interview --answers` accepted a repeated JSON key that `init` and
  `setup` both refuse by name. JSON keeps the last value, so the earlier answer
  disappeared without a word through the one door that did not check.
- `status` and `doctor` told a person to run `dotaios init` to restore a
  missing file, and init refuses against any live AIOS folder, so the named
  action could never run. They now name `dotaios context --refresh`, which
  restores the generated entrypoints, and say plainly that files under
  `context/` are your own Markdown that no command rewrites.
- `doctor` and the FIRST_SESSION.md written into the folder still sent an
  assistant to `dotaios interview --review`, which needs a terminal, in the
  same release that gave interview a terminal-free route.
- Five places where the documentation contradicted the product: the preview
  gate forbade re-running setup in the one case setup itself asks you to,
  the friend-setup guide gave an assistant a command that cannot run without a
  terminal and never mentioned `--answers`, it excluded Windows, the client
  matrix understated what Cursor receives globally, and the `AGENTS.md` written
  into the folder pointed at a `docs/` directory that install never creates.
- Global skills were projected to `~/.gemini/antigravity/skills`, which is not
  a path Antigravity reads. It publishes two discovery paths — the workspace
  `.agents/skills/` and the global `~/.gemini/config/skills/` — and the latter
  was on the retired-cleanup list at the same time, so the live target was
  being cleaned while the dead one was written to. Skills now land where
  Antigravity looks. `~/.gemini/antigravity/skills` becomes a retired target,
  which migrates future installs without removing anything already there:
  retiring a directory never deletes real files, foreign symlinks, or, for
  global targets, anything at all.

## [2.0.5] - 2026-08-16

### Fixed
- INSTALL.md said piping answers into setup meant a person's name and work
  "never touch the disk". They do, and they are meant to: they are written into
  the AIOS folder, which is the reason to run the command at all, and the
  assistant's own history keeps whatever was typed to it like any other
  message. The benefit is narrower and now stated as what it is — no separate
  answers file is left behind. A privacy claim in an install document has to be
  the literal truth or it is worth less than no claim.


## [2.0.4] - 2026-08-16

**An assistant can now install DotAIOS for you without a terminal.** The
advertised path — paste one request into Claude Code, Codex, or another local
assistant — could not complete: setup needed an interactive terminal, and an
assistant runs commands through a pipe. `--answers` lets the assistant ask the
five questions in the conversation and pass your own words through, so the
folder it creates is yours rather than a placeholder.

The same rules that protect those answers now apply at every door into your
context files: the terminal prompt, which had none, and `dotaios import`,
which had none. An imported timestamp can no longer name a file outside your
AIOS folder, and imported text can no longer carry invisible characters into
the files agents read first.

### Fixed
- `dotaios init` and `dotaios setup` accept `--answers <file|->`, so an
  assistant can complete the install it is told to run.
- The terminal prompt validates what you type and asks again instead of
  accepting a value that renders as a blank field.
- `dotaios import` refuses a signal timestamp that would write outside the
  AIOS folder, including through a symlink, and refuses payload text carrying
  control characters or a heading that would shadow a section.
- Re-running `dotaios import` no longer stacks duplicate blocks, and its
  preview now exits the way the apply it previews would.
- An empty bullet no longer swallows the line below it in a context file.
- A relative or `~`-prefixed `vault_path` resolves against the AIOS folder
  rather than the current working directory.
- The release check confirms the tag points at the commit npm published.


## [2.0.3] - 2026-08-14

**You can now decide what DotAIOS may remember in each session.** `Use my
memory` selects **Memory: Shared**. `Only this project` selects **Memory: This
project** and excludes personal, unscoped, and other-project material before it
is searched or rendered. `Private chat` selects **Memory: Off** before any
subsequent DotAIOS file or tool reads, searches, saves, or captures; the AIOS
router may already have been opened. The receipt is visible, and DotAIOS says
plainly that the AI app may still keep its own chat history.

**One AIOS folder is the memory.** Agent instruction files, MCP responses,
search data, and client hooks are bounded views of that user-owned folder, not
new memory stores. One explicit save appears as one conceptual result when a
second agent finds it; two separate saves remain two memories.

**Setup now starts with one request to a local assistant.** The assistant checks
Node.js, previews the exact folder and app changes, leaves the meaningful
privacy choices to the person, verifies the result, and shows the one AIOS
folder. The pinned Terminal commands remain available as the recovery path.

**Private material has a clearer boundary.** DotAIOS is not a password manager.
Provider credentials belong in the provider or operating-system credential
store; `.env` remains an ignored, local fallback. `doctor` checks its ownership
and permissions without reading its contents, while search, context, MCP, and
sync continue to exclude it.

**Search worked again.** On a folder with real material in it, every search had
been failing — not returning nothing, but refusing outright with "could not read
the evidence corpus safely", on every query, including ones that should have
matched nothing. Search was being held to the size limit meant for the small
summary your assistant reads at the start of a session, so the moment your notes
outgrew that limit, searching them stopped working. Assistants asking through the
optional MCP adapter hit the same wall. The limits now fit a folder someone has
actually been using, and when one is genuinely reached the message says what
stopped and what to do about it.

**Your assistants no longer read your whole personal folder every time they
start.** Connecting Claude Code or Gemini CLI used to put a line in its settings
file that loaded all of `~/aios` at the beginning of every conversation,
including conversations in unrelated projects. That line now says where the
folder is and when to open it. (Codex was never affected; its bridge already
pointed at the folder rather than importing it.)

**`doctor` now tells you when your connection is out of date** and names the one
command that updates it. It used to report an older connection as healthy, so
anyone who had already installed DotAIOS would never have found out.

**Saving an article can no longer write outside your vault.** If a shelf file or
folder was a shortcut pointing somewhere else, `ingest` followed it and wrote
there while telling you it had saved to the vault. It now refuses.

**Gemini setup no longer undoes itself.** `activate` and `connect gemini` wrote
different blocks into the same place, so whichever you ran last silently replaced
the other, and `doctor` then reported the result as wrong. Gemini continuity now
uses a prompt-aware `BeforeAgent` hook instead of the earlier `SessionStart`
shape. Existing Gemini users should rerun `dotaios connect gemini` to migrate
their managed hook.

**Installing is less likely to dead-end.** If Node.js is missing, an assistant
helping you install now sets it up and tells you what it did, instead of handing
you a question you had no way to answer. The questions that are actually yours —
private sync, daily brief, saving conversations, the browser helper — are still
asked one at a time and still default to No.

Nothing in your folder changed. To pick up the connection fix, run
`npx dotaios activate` once; `doctor` will tell you if you still need to.

## [2.0.2] - 2026-08-12

Same DotAIOS as 2.0.1. This release exists so you can check where it came from.

INSTALL.md asks you to compare the published package's `gitHead` against the
matching source tag before you run anything. On 2.0.1 that field was missing, so
the check you were told to make returned nothing. 2.0.2 carries it, and the
instructions work as written.

If you already installed 2.0.1 there is nothing to redo — the two releases
contain the same files.

## [2.0.1] - 2026-08-12

Fixes for the first ten minutes: installing DotAIOS, connecting your AI tools,
and checking that it worked. Nothing you already have changes, and there is
nothing to run after updating.

### Fixed

- Setup no longer gets stuck when you already have a `CLAUDE.md` of your own.
  That ordinary situation could leave a half-made folder that no documented
  command would finish — including running setup again exactly as it told you to.
- One folder DotAIOS cannot write to no longer costs you the rest. The run used
  to stop there, so tools further down the list were never set up, and nothing
  told you which ones had worked.
- When a file cannot be written, DotAIOS now names that file and the reason,
  instead of a temporary name of its own that no longer exists by the time you
  read the message.
- `dotaios doctor` no longer reports tools you never installed as working.
- `dotaios doctor` no longer gives a clean report when the folder it points at
  is gone — including the case where the folder is still there but the file your
  AI tools actually read has been deleted.
- The install preview now lists every folder the real install writes to. It used
  to name one and write three.

## [2.0.0] - 2026-08-12

Your adopted Agent Skills now have exactly one owner: your AIOS folder. Native
client folders became projections of it. Everything you already have keeps
working and nothing is deleted, but the rule about who may write what has
changed, which is why this is a 2 and not a 1.29.

### If you are upgrading

- **Nothing is required of you.** Existing skill folders stay where they are and
  stay readable. There is no migration to run and no file to hand-edit.
- **Skills adopted into `~/.claude/skills` or `~/.agents/skills` are now
  projections.** The real skill lives in `AIOS/skills/<name>/SKILL.md`. Native
  folders that were never adopted stay visible and untouched, reported as
  discovered-unmanaged rather than silently taken over.
- **Run the read-only checks first.** `dotaios doctor`, then
  `dotaios skills doctor`. Both report without writing.

### Added

- Search now covers `memory/daily/` and `memory/inbox/`. A note captured on a
  phone and filed into the inbox was not in the corpus at all: a term that
  appeared only there returned "No results found".
- Search now finds a note when you ask for it in a different tense or number.
  A conversation filed as "Meeting with Racing Bulls" was unreachable from
  "what meetings did I have". Exact matches still rank first; a matched
  inflection ranks below every literal kind.

- Managed Agent Skill adoption is now preview-first and exact-proof. AIOS real
  skill directories are canonical; native folders are projections. Inventory
  separates owned, discovered-unmanaged, and excluded-unsafe entries, while
  bounded bundle adoption preserves opaque assets, inventories scripts without
  running them, journals catalog/projection publication, and supports guarded
  reconcile and receipt-backed whole-root removal.
- Project sources now have a guided `project source connect` preview and one
  `--yes` confirmation that combines the portable source declaration,
  machine-local folder binding, and finite read grant without asking the user
  to copy operation IDs or fingerprints. Exact live reruns are idempotent, and
  matching source-only completion can resume safely.

### Changed

- CI runs push builds only on `main`. Every commit previously triggered the
  full matrix twice, once for the push and once for the pull request.

- Raw/single-skill local install and removal now delegate to
  `ManagedSkillStore`; plugin-package copying and registry-only deletion are
  retired. Multi-skill and code-only plugin packages refuse before mutation.
  Google connection setup no longer creates a skill or writes skill inventory.
- Skill health reports configuration and filesystem projection separately from
  unprobed discovery, invocation, and produced-output evidence.
- `search --project` now selects the portable project corpus by slug or stable
  ID; `--session-project` remains the session-tag filter for the pre-existing
  session attribution behavior.
- Compact CLI, Gemini hook JSON, and MCP working-context reads now share one
  operational migration envelope beside the unchanged canonical working-context
  projection. The cheap session-start inspector reads only compatibility
  metadata, reports
  `current`, `schema_outdated`, `transaction_present`, or path-free
  `inspection_failed`,
  and never inventories protected memory shelves.
- `dotaios connect gemini` now preflights all three managed artifacts and writes
  `settings.json` last as the SessionStart activation point. Its generated hook
  invokes the exact shipped DotAIOS package version instead of allowing an
  opened project's local `dotaios` binary to shadow the command.
- Project attachment no longer writes `<project>/.hermes/config.yaml`. Hermes
  loads the config selected through `HERMES_HOME`, and DotAIOS does not own that
  selector, so the earlier project target could look configured while remaining
  inert in an ordinary launch. Existing checkout Hermes files are preserved.
  Global `~/.hermes/config.yaml` and discovered profile registration remain
  available as configuration evidence only.

### Fixed

- Newly created project READMEs use ordinary block frontmatter. They were
  written as a single-line YAML flow mapping, so any tool that added a key of
  its own produced an unparseable file. `dotaios export-okf` did exactly that
  and exported nothing.

- Canonical working-context reads no longer create corrupt-JSONL quarantine
  files, follow projected sources outside the AIOS boundary, echo unbounded
  project filters, or return absolute machine paths in internal MCP errors.
  Source work is capped at 16 MiB and 512 files with fixed per-shelf and
  directory limits; concurrent path-component changes and unsafe path-only
  filesystem adapters fail closed. Opaque project IDs within the nonblank,
  control-free, 200-Unicode-code-point boundary remain valid, while invalid or
  ambiguous selectors can no longer silently widen scope. MCP integer fields
  reject coercion and unknown argument names return one bounded generic error.
  Scoped timeline rows are global only when both `project` and `project_id` are
  absent; malformed or conflicting attribution is excluded, and an ambiguous
  catalog alias requires a matching unique stable project id.
  A handle-bound `aios.json` authority snapshot brackets each selection;
  initially missing optional sources remain valid only under unchanged contained
  ancestors. Compact, hook-JSON, and lean reads cannot launch the optional sync
  hook after producing output.
  Projection budgets retain their existing meaning; rendered operational notices
  and non-projection MCP metadata have a separate fixed 1,024-character bound.
  JSON escaping and protocol framing are representation costs, not operational
  context, and are not subtracted from the projection budget.
- Gemini connection now preserves every byte outside its one managed
  `GEMINI.md` block, refuses malformed ownership markers, unsafe paths, foreign
  hook scripts, invalid UTF-8 and incompatible settings shapes, and detects
  concurrent edits before atomic replacement. It quotes hook paths containing
  spaces, repairs one stale named DotAIOS hook, refuses ambiguous duplicates or
  legacy MCP entries, preserves recovery-file permissions, and surfaces hook
  failures instead of silently returning empty context.
- The global Hermes YAML adapter now fails closed on invalid or ambiguous
  documents, preserves comments and indentation, quotes punctuation-heavy
  paths, rejects multiline injection and unsupported YAML shapes, and validates
  the exact resulting path before writing. It rejects symlinked or non-regular
  config targets and invalid UTF-8, serializes competing DotAIOS writers, and
  detects external changes observed at guarded checkpoints. The live config
  remains visible until an atomic replacement, and an exact-byte backup is
  retained. An external editor that does not honor the DotAIOS lock still has a
  narrow final check-to-rename race. Health inspection uses the same safe YAML
  reader and registry key as activation. Custom external-directory adapters
  now reject malformed dotted keys and control-character config paths instead
  of normalizing a typo into a different key or crashing health inspection.
## [1.28.4] - 2026-08-06

### Added

- An AI assistant can walk you through installation again. `INSTALL.md` now
  carries a section addressed to the assistant that tells it to preview first,
  explain in plain language, and ask before anything on your computer changes —
  and to follow you rather than this repository if the two ever disagree. A
  tester's assistant previously refused the install, correctly, because the old
  guide told it to write without asking while the user had asked it not to.
- `dotaios activate --merge` keeps an existing global instructions file and adds
  the DotAIOS block below it. Anyone who has ever asked their assistant to
  remember a preference already has one of these files; activation left it alone
  and, unless they found `--overwrite`, the assistant was never told who they
  were. The default is unchanged: a file DotAIOS does not own is still left
  untouched and reported, and project bridges still fail closed.

### Fixed

- Setup opens the folder after printing what to do next, instead of before four
  optional questions. The window used to appear while the terminal was still
  waiting behind it, so people believed setup had finished and never saw the
  remaining steps.
- Re-running setup on a finished installation reports that it is already set up
  and changes nothing, instead of failing and offering a destructive option
  beside a safe one. Interrupted installations still resume, and a folder that
  needs a migration still says so.

## [1.28.3] - 2026-08-06

### Fixed

- Doctor now validates one complete, correctly ordered managed bridge block.
  Duplicate, reversed, or incomplete markers can no longer appear healthy.
- Setup and initialization preserve concurrent foreign changes to generated
  skill catalogs and stop with a non-zero result instead of overwriting them or
  reporting a partial client connection as complete.
- Upgrade guidance now reviews registry metadata first, keeps one exact version
  through migration and activation, re-verifies skills, refreshes an enabled
  Claude Code capture hook, and regenerates version-pinned MCP fragments for
  manual reapplication.

This release also includes all setup, plugin-source, removal, and Windows
distribution safety changes listed under 1.28.1 and 1.28.2 below.

## [1.28.2] - 2026-08-06

### Fixed

- Setup preview and activation now share one managed-block parser, so malformed
  or reversed markers are preserved and reported consistently.
- First-time guides pin every setup path and distinguish deliberate later
  `@latest` maintenance commands.
- Remote plugin URLs are refused. Plugins must be downloaded at a pinned
  revision, inspected, previewed, and installed from a local folder.
- Removal guidance now names every managed surface and preserves unmanaged
  client configuration.

### Removed

- The unbuilt, unsigned Windows MSI launcher and its manual build workflow.
  The launcher bypassed the preview-first pinned install contract and was not a
  supported distribution path.

## [1.28.1] - 2026-08-06

### Added

- `dotaios setup --dry-run` now previews the local folder, managed client
  bridges, sync boundary, credential boundary, verification, and removal path
  without creating files or changing client configuration.

### Fixed

- First-time onboarding is now explicitly human-run and pins the published
  package version. Public guides no longer tell an AI assistant to fetch remote
  instructions or execute installation commands. Package provenance, contents,
  integrity inspection, post-install verification, and rollback are visible
  before setup. Human commands retain npm's package confirmation, while private
  sync, local schedules, conversation capture or backfill, and optional browser
  downloads now all default to No and require an explicit opt-in.

## [1.28.0] - 2026-08-05

### Added

- **Managed project restore across machines.** Portable records remain in
  tracked `projects/`, while `dotaios project restore [slug-or-id]` recreates
  committed project state under ignored `workspaces/` using the project's own
  Git credentials. External checkouts remain supported.
- **Folder schema 1.2 migration.** Existing schema 1.1 folders get a
  preview-first, receipted upgrade that preserves custom `.gitignore` content,
  adds the anchored `/workspaces/` boundary, and commits `aios.json` last so an
  interrupted upgrade can be recovered safely before project restore.

### Fixed

- **Project repositories cannot leak into the AIOS mirror.** Sync verifies the
  root workspace ignore, refuses every outer-index entry under `workspaces/`,
  validates each registered workspace's stable ID, complete checkout, and safe
  matching origin, and still rejects every other nested repository.

- **Sync no longer reports success when Git cannot mirror a nested project.**
  Gitlink pointers are refused before commit, an index inspection failure stops
  safely, and a dirty tree that cannot stage content now exits non-zero instead
  of printing “already up to date.”
- **Every manual sync re-verifies that the GitHub mirror is private.** A mirror
  changed to public—or whose visibility cannot be confirmed—is rejected before
  DotAIOS commits, pulls, or pushes personal context. The verified repository
  must also match the checkout's real Git origin; credential helpers are bound
  to that exact GitHub path, URL rewrites and hooks are disabled for token-bearing
  network operations, and a failed safety check preserves the user's staged work.
- **Sync operations are bound to the exact AIOS repository.** Setup and normal
  sync refuse enclosing repositories, redirected Git files, and linked Git
  configuration before credentials or mutation. Logout removes only the origin
  named by the private sync config and refuses shared linked-worktree origins.
- **Sync preserves the user's exact Git staging state across races and failures.**
  DotAIOS builds its commit in isolation, holds Git's normal index boundary for
  the final transaction, recovers an interrupted owned transaction on the next
  run, and refuses concurrent index changes without erasing flags or partial
  staging. Portable mirrors also reject symbolic links, which prevents synced
  memory paths from escaping the owned AIOS folder.
- **Setup now reports activation failures to callers.** Step-one and step-two
  failures exit non-zero, failed activation is recorded as a failed install,
  and an ownership marker makes interrupted first installs recoverable only when
  every existing generated path still matches. Legacy 1.27.1 residue remains
  recoverable; arbitrary, modified, symlinked, or extra user content fails closed.
- **Activation preserves user-authored bridge content.** DotAIOS replaces only
  its managed block, keeps surrounding bytes intact, and writes the original
  bridge to a one-time `.dotaios-backup` before the first splice. Global bridge
  writes now reject symlinked bridge files and use the same safe replacement
  path as generated setup files.
- **Generated files no longer follow unsafe overwrite or preserve targets.**
  Initialization preflights its complete scaffold, rejects linked roots,
  generated parents, files, and skill catalogs, preserves existing file modes,
  and installs the packaged `.gitignore` boundary on clean npm hosts.
- **Interrupted project restore and folder migration are retryable.** Owned
  restore transactions resume verified clones without recloning, while migration
  rollback resumes only exact single-link staging residue and refuses anything
  changed, linked, or foreign without touching user files.

### Removed

- Commercial delivery, license verification, catalog, and internal pilot gate
  machinery no longer ship in the public repository or npm package. The public
  core contains only the local-first foundation and its generic plugin installer.

## [1.27.1] - 2026-08-04

### Removed

- The marketing site source no longer ships in the public repository, and the
  release checklist and CI no longer run its build and verify steps. The site is
  built and deployed from its own repository.

### Added

- `dotaios skills sync-triggers` writes routing phrases into the `when_to_use`
  frontmatter field that hosts actually read. It previews by default and only
  writes with `--apply`. All 15 bundled skills are backfilled. `triggers:`
  remains authoritative for DotAIOS's own resolver.

### Fixed

- **The trigger writer no longer corrupts frontmatter.** It emitted an unquoted
  YAML scalar through a string replacement. A phrase containing `": "` or `" #"`
  made the whole frontmatter unparseable, so the skill vanished from the host
  listing; `$&` and `` $` `` expanded as replacement patterns and spliced the
  frontmatter into itself; CRLF files came back with mixed line endings. Bundled
  skills were unaffected — this hit skills you author yourself.
- **Resolver ranking no longer rewards trigger count.** Scores were summed across
  every declared trigger, so a skill with more phrases outranked a better match.
  It now scores on the best single trigger, and the sort tiebreak no longer
  rewards count either.
- The CLI test suite spawned without an isolated `env`, so running `npm test`
  wrote the developer's real `~/.dotaios/projects.json`, and concurrent runs
  raced on it.
- Antigravity IDE skills now use Google's documented
  `~/.gemini/antigravity/skills/` global path and `.agents/skills/` workspace
  path. The previous `.gemini/config/skills` project path was not documented for
  any current Antigravity surface.
- `dotaios connect opencode` now writes OpenCode's current `mcp.dotaios` local
  server schema with a version-pinned `npx --package` command. Native skills use
  the shared `.agents/skills` target, avoiding duplicate same-name discovery.
  Recognizable legacy DotAIOS entries migrate safely; foreign or malformed
  same-name entries fail closed. New files use private permissions and atomic
  replacement.
- MCP fragments now use the published package launcher instead of a source path
  that may live in a disposable npm cache.
- Invocation receipts now preserve a bounded, redacted client diagnostic when a
  probe cannot run. A marker counts as produced only when the client exits
  successfully, and dry runs do not launch a version probe.
- Project attachment uses root `AGENTS.md` as Cursor's single context bridge and
  removes only a managed legacy `.cursor/rules/dotaios.mdc`.

### Changed

- **`confidence` now means separation, not raw score.** `dotaios skills resolve`
  previously reported `Math.min(1, score)`, which saturated at 1.00 for a clear
  win and a near-tie alike. It is now the winner's share against the runner-up,
  so the number can discriminate. Note the CLI's own match header still prints
  the old value; the new definition is exposed through `resolveIntent`.
- Compatibility documentation now names Antigravity IDE specifically, records
  Kimi Code CLI and OpenCode on the documented shared Agent Skills surface, and
  keeps Kimi K2, Kimi K3, and Z.ai GLM claims at the model-through-host level.
- Compatibility receipts now state all four evidence fields explicitly:
  configured, discoverable, invoked, and produced. Public support requires
  reproducible `produced=yes`.
- Client support references were refreshed against official OpenAI, Anthropic,
  Google, Cursor, Kimi, OpenCode, Moonshot, and Z.ai documentation on
  2026-07-28.
- Public launch copy now promises continuity across supported local agents and
  states the current capture boundary instead of implying every AI or every
  session is automatically connected.

### Tests

- Added CLI stdout regression coverage for every JSON MCP client alongside the
  existing Codex TOML coverage.
- Added regression coverage for Antigravity IDE skill targets, stable user
  overrides, OpenCode MCP migration, foreign-server preservation, runtime
  health rows, atomic private config writes, probe false positives, dry-run
  process isolation, client-version sanitization, and diagnostic redaction.
- `tests/core/core-is-offline.test.mjs` fails on any URL literal, `fetch` call,
  or `node:http` import added to `packages/core`, so the offline rule is
  enforced rather than documented.
- Added coverage for reversed purchases, for frontmatter phrases containing YAML
  punctuation and `$` replacement patterns, and for CRLF line-ending
  preservation.

## [1.27.0] - 2026-07-25
### Fixed
- **Stale signals are archived instead of deleted.** `trimSignals` previously `unlink`ed any `memory/signals/*.jsonl` older than 30 days with no archive, and it runs unattended as part of routine maintenance. Every line now lands in `memory/signals-archive.jsonl` before its source file is removed, using the same staged-append, crash-safe, idempotent path as event compaction. Archived signals stay searchable. Covered by crash-injection, idempotency, and lock-contention tests. If you kept your folder outside version control, this is data you were losing silently.
- **`dotaios doctor` now reports the signal store instead of ignoring it.** The memory-health check reports the live signal-file count, and warns when it finds a maintenance receipt showing signal files removed without an archive. To be precise about what that second part buys you: every receipt 1.27 writes archives what it removes, so in practice this warning detects deletions performed by **1.26 and earlier**. Two further limits, stated plainly: it can only see receipts still present in `memory/events.jsonl`, so once those compact into the archive the warning stops firing; and it only catches losses from the automatic maintenance path, because 1.26's manual `dotaios cleanup` wrote no receipt at all. It is a best-effort upgrade check, not an ongoing integrity guarantee. Previously the check returned `ok` unless a corrupt-line sidecar existed, so unarchived deletion was invisible either way.
- Event compaction no longer re-archives a batch larger than the dedupe tail window when a crash interrupts the staging cleanup.
- **The memory lock is judged by process liveness, and taken over atomically.** It previously called a lock stale purely on age, so a maintenance run lasting longer than five minutes could have its lock pulled by another process, and a crashed holder wedged maintenance until the window expired. Taking over was also a delete-then-recreate, which let two processes both claim an abandoned lock — an interleaving that could drop signal lines. Liveness now decides, and the takeover is a single atomic rename, matching the session index lock.
- Signal trimming survives a file disappearing mid-run. A folder synced by iCloud or Dropbox could remove a file between the read and the delete, throwing an unhandled error that silently aborted the whole maintenance pass and wrote no receipt.

- **The promotion preview shows the real change.** For `replace`, `remove` and `supersede` it printed the last twelve lines of the file before and the last twelve after, as two unaligned tail windows dressed up as a diff. A block removed from the top of a long file produced no visible deletion at all, while untouched lines at the bottom appeared as both removed and added. Since the product's safety model is preview-then-apply, a preview that does not show the change was manufacturing consent. It now diffs the actual edited region and marks any truncation.
- **Installing a raw skill can no longer replace an existing one.** `dotaios install <repo>` deleted and overwrote any skill whose folder name collided — including a shipped built-in — with no prompt, and `--dry-run` did not mention it. Skills are instructions your agents follow, so replacing `ingest` silently redirects what happens the next time you save a link. It now refuses, as the plugin path already did, and the dry run says so.
- `dotaios capture enable claude-code` shell-quotes the AIOS path. A home directory containing a space split the hook command, so capture failed on every session with no visible error.
- `dotaios connect gemini` no longer claims your context is injected automatically. Writing a hook file proves configuration, not invocation, and `docs/client-support.md` records that Gemini CLI could not produce an invocation receipt. The wording now matches the evidence.
- `dotaios memory audit` no longer reports the documented supersede workflow as a conflict. The check folded promotions in whatever order they arrived, so a supersede seen before the block it replaces produced a phantom conflict and advised removing one of the two — talking a user out of the correction they had just made. It now replays in timestamp order.

### Added
- **The scaffolded `AGENTS.md` now tells agents to maintain memory.** Agents are directed to promote a fact that should outlive the session, and to supersede a fact they find contradicted, rather than leaving both versions in place. The promotion lifecycle shipped in earlier releases but nothing ever invoked it, so context accumulated and went stale by design.
- New shipped skill `memory-maintenance`: find stale or contradicted facts in `context/` and `projects/`, propose supersedes, apply only what the user approves.
- `dotaios doctor` warns when hot context files have not been touched in a long time, using file mtime only — no frontmatter or schema change. Generated files are never reported as stale.

### Changed
- Every install and run command in the shipped docs is pinned to `dotaios@latest`. Several pages still used a bare `npx dotaios`, which resolves whatever npx has cached — so a reader following them could silently get a pre-1.27 build, including the signal deletion this release exists to fix.
- The three shipped skills that were missing a `LICENSE` file (`export-okf`, `research`, `skillify`) now carry the same MIT grant as the other twelve.
- **The capture hook is pinned to the installed version and repairs itself on upgrade.** It resolved `dotaios@latest`, so every session end ran whatever was newest on npm rather than the build you installed and reviewed; it is now pinned, which also makes the npx cache hit deterministic so the hook keeps working offline after its first run. Enabling over a hook written by an earlier release used to print "already configured" and leave it in place — and since 1.26's hook never resolved on the npx install path, upgrading users stayed silently broken. It now rewrites the command and shows you what changed.
- The shipped `memory-maintenance` skill and weekly schedule call `dotaios memory audit --all-memory`. Plain `audit` defaults to an eight-entry window, where even a genuine conflict returns nothing — the detector was effectively off everywhere the product invoked it.
- **The Claude Code capture hook now runs through `npx`.** It was written as a bare `dotaios capture hook claude-code`, which does not resolve on the npx-only path the install guide prescribes — so on a machine without a global install, every session silently failed to capture. Hooks written by earlier releases are still recognised and are not duplicated.
- `dotaios capture enable claude-code` creates `~/.claude` when it does not exist instead of failing with a raw `ENOENT`, and now refuses to run when `settings.json` exists but cannot be parsed, rather than replacing the file with a fresh one. The previous behaviour could overwrite an entire Claude Code configuration.
- Session capture moved into the main setup flow in `INSTALL.md`. It was previously listed under "optional extras, do not run these during first-time setup" — which left a new user with a folder that recorded nothing unless they ran a command by hand. Capture is Claude Code only today and the docs now say so plainly.
- `dotaios memory promote` states the 30-day signal retention window in the preview and the help text, lists durable destinations first, and no longer uses `--to signal` as its first worked example. Promoting a durable fact to `signal` previously looked like the default and expired within a month.

## [1.26.0] - 2026-07-22
### Added
- Opt-in update check surfaced by `dotaios doctor`: tells you when a newer release is published. Foreground only — it runs because you asked for a health check. One plain GET to the npm registry, no request body, no identifiers, no background updater, no telemetry. Fail-open by design: offline, timeout, bad status, malformed payload, or an unreadable local version all degrade to a quiet skip, and an available update is a warning that never sets a non-zero exit code. Disable with `DOTAIOS_NO_UPDATE_CHECK=1`.

### Changed
- Install and upgrade documentation standardizes on `npx dotaios@latest` (INSTALL.md, docs/getting-started.md) so re-running always fetches the newest release instead of a cached older copy.
- README gains an **Updating** section covering how to upgrade, how you find out a new version exists, and versioned folder migration across releases.

## [1.25.0] - 2026-07-20
### Added
- Crash-safe memory compaction with corrupt-line quarantine, shared signal date parsing, and opportunistic daily auto-maintenance.
- Shared search ranking with BM25-style in-memory IDF and day-bucketed recency decay (exact phrase tier stays above decay).
- Live OKF `index.md` / project `log.md` projection with searchable decisions scope.
- Release-freshness CI gate (`npx dotaios@latest --version` vs tagged release) and syntax-check over all source files.

### Changed
- Sync GitHub PAT no longer lands in `.git/config`; network ops authenticate via a per-invocation credential helper (status parity included).
- Website CSP staged as Content-Security-Policy-Report-Only (enforcing flip deferred).
- Project context emitter: catalog-only match helper, one projection timestamp, inert `--tool` removed; operational window documented as today + yesterday.

### Notes
- npm publish left to the maintainer. Install with `npx dotaios@latest` after publish.

## [1.24.0] - 2026-07-16
### Added
- End-to-end project identity binding: registered slugs and stable IDs now flow through bridges, writers, Claude live hooks, and scoped briefs.
- Identity and priorities are included in the bounded `brief --compact` projection.
- Promotion truth lifecycle with duplicate no-op receipts, replace/remove/supersede operations, persisted preview plans, and audit findings for conflicting blocks.
- Safety contracts for README-first project registration, orphan-aware project doctor, AIOS-root export rejection, and stale persisted-plan refusal.
- Committed client invocation receipts for Codex, Claude Code, and Gemini CLI, with Cursor documented as configured but invocation-unproven.

### Changed
- Explicit project references now resolve through the catalog and fail closed when unknown; attach creates a durable registration before stamping project bridges.
- Shipped skills route working-memory reads through `dotaios brief --compact`, including the corrected `plan-today` workflow.

## [1.23.0] - 2026-07-16
### Added
- Project catalog commands: `project add`, `list`, `resolve`, and `doctor`. Durable project metadata and repository URLs sync inside `projects/`, while checkout paths stay machine-local in `~/.dotaios/projects.json`.
- One deterministic, project-filtered working-context projection shared by the compact brief and MCP digest, with a visible character budget.
- Preview-first `memory promote` workflow for signal, context, project, vault, skill, and session-only dispositions, with structured receipts.

### Changed
- Cross-device sync is manual by default through `dotaios sync now`. The legacy automatic hook requires an explicit opt-in in a controlled main worktree. Rebase conflicts stop safely without creating recovery branches, resetting files, or pushing.
- Setup distinguishes a ready folder from an actually configured local client and defaults optional GitHub sync to off.
- Public copy now distinguishes local storage, provider processing, supported session capture, and browser-chat limitations.
- MCP is now an optional advanced adapter with three bounded read-only tools. Gemini uses its simpler SessionStart hook without duplicate MCP configuration.

### Fixed
- OKF export rejects every source/output overlap, parses YAML strictly, resolves links deterministically, stages atomically, and preserves an existing export on failure.
- Removed the visual-editing dependency that produced nine moderate website audit findings and an unnecessary 541 kB chunk.
- Stable project IDs now resolve to canonical slugs before working-context filtering.
- `dotaios skills probe --path <dir>` now actually probes the given AIOS folder. The CLI passed the option as `path` while the probe library expected `aiosPath`, so probes silently fell back to `~/aios`; on machines without a populated home folder (CI runners) every probe failed with "No readable skills found". This is why the merge-ref CI run went red on 2026-07-14.

### Removed
- Removed the bundled `update-skills` workflow and weekly update claim until package ownership, update, and rollback are implemented and tested.
- Removed direct MCP memory writes, Google command wrappers, and MCP from beginner help and Gemini setup.


## [1.22.0] - 2026-07-14
### Added
- **`dotaios skills doctor`** — health report for configured, discoverable, and
  invoked skills across Claude Code, Agent Skills, Antigravity, Hermes, and
  project targets. Surfaces source/bridge/native-link/Hermes evidence with
  explicit canonical presence separate from warnings.
- **`dotaios skills probe`** — bounded, disposable client invocation probe
  with JSON receipt schema (`--client`, `--receipt`, `--dry-run`/`--run`) to
  prove a skill is actually invocable on Codex, Gemini, Claude Code, Hermes,
  Cursor, or Antigravity.
- **Project-owned skill propagation.** `dotaios attach <project>` and
  `dotaios activate --project <project>` expose a checkout's own `skills/`
  directory to explicit Claude Code, Agent Skills, Antigravity, and Hermes
  project targets while preserving the global AIOS skill library and foreign
  entries.
- **Remote sync parity in status.** `dotaios sync status` now verifies local
  state against the remote branch so drift is visible before a tick runs.

### Fixed
- **Sync fail-closed outside `main`.** `dotaios sync tick` refuses writes when
  the checkout is not on the exact `main` branch, preventing detached or
  feature-branch sync from mutating the canonical AIOS remote.
- **Unsafe project skill source guards.** Attachment fails closed on foreign
  symlinked target roots and Hermes configs, rejects skill roots/files that
  resolve outside the project, and refuses overlapping custom targets.
- Project attachment cleans owned dangling links after a project removes its
  skills, honors registry-provided Hermes skill keys, and does not overwrite
  foreign symlinked bridge files.
- Disabled unsafe detached sync hook path that could run outside controlled
  worktree context.

## [1.21.0] - 2026-07-07
### Added
- **Flagship: native agent skills-routing.** `dotaios skills resolve "<intent>"` ranks the installed skill that fits a free-text intent, with no embeddings, network, or model calls. Plain-text scoring over each skill's declared `triggers:` and `description`: exact-name hit, trigger token overlap, description overlap, specificity tiebreak. Prints the top match (name, dir, confidence, triggers, `SKILL.md` path); `--full` also prints the `SKILL.md` body, `--all` prints the ranked list, `--json` returns the documented shape for fleet and MCP callers. Exit 2 when nothing clears the bar so fleet scripts can branch on "no skill fits, hand-roll." The scoring lives in a new shared `packages/core/src/skill-resolver.mjs` so the CLI and MCP server use one function.
- **MCP `resolve_skill` tool.** IDE agents (Cursor, Claude Code) call `resolve_skill` with the user's intent at boot or before acting, and get the same ranked payload as `dotaios skills resolve --json`. The MCP `instructions` now tell agents to resolve a skill first and only hand-roll when nothing matches.
- **`dotaios skills resolve --boot-context`** prints a Markdown `## Skills first` prompt block (the resolver rule plus the live catalog) for fleet scripts and any non-IDE consumer. Capture it as text with `BOOT_CONTEXT="$(dotaios skills resolve --boot-context)"`, then append that variable to the agent prompt. The generated block stays in sync with installed skills.
- **`dotaios activate --skills-first`** persists a preference in `aios.json` that makes the managed bridge block INLINE `skills/INDEX.md` + `skills/RESOLVER.md` into every agent entrypoint, so agents that do not auto-follow file references (headless fleet workers, MCP-only clients, browser-paste users) still see the catalog at boot. Default stays pointer-mode to keep bridge files small; `--no-skills-first` switches back.
- **`dotaios brief --lean`** prints a small high-signal surface to stdout: identity, priorities, north-star, today's daily note, and the first active project README. The rest of `memory/` stays opt-in, the lean default load the push-memory thesis asks for. No file write.
- **`dotaios plan "<title>"`** writes a lightweight `memory/plans/YYYY-MM-DD-<slug>.md` artifact (goal, checkbox steps, status, open questions) an agent can pick up across sessions, and logs a `plan` event so it surfaces in the session digest. `--print` prints instead of writing; `--steps` and `--project` tag it.
- **`dotaios memory audit`**, a local skills-over-memory review that checks hot agent memory against a 200-line budget, classifies routed memory entries, and can write `memory/skill-patches/queue.md` with stable IDs for skill-tied lessons. The command is read-only by default, supports `--all-memory` for forensic scans, and `--apply-skills` can append explicit lessons into existing `skills/<name>/SKILL.md` files without creating missing skills or routing uncertain items.
- **`docs/gitsync-mobile.md`** documents reading and capturing notes into your AIOS from a phone via GitSync (iOS) / MGit (Android) against the same private GitHub repo `dotaios sync setup` creates. No new services.

### Changed
- `dotaios sync` now stages changed paths explicitly. `commitAll` enumerates `git status --porcelain -z` and runs `git add -- <path>` per entry instead of `git add -A`, so the commit surface is explicit and a future caller can filter paths (skip large files, secrets). Deletions and renames still stage by naming the destination path. Conflict handling (rebase, branch-and-reset escape hatch) is unchanged.

## [1.20.2] - 2026-06-15
### Added
- New default skill: **`research`** — deep research on any question. The agent breaks it into sub-questions, searches the web across all of them, and writes back one cited report (TL;DR · key findings · open questions · sources), saved to `vault/research/deep/`. Fully portable: any agent runs it with its own web search, no servers, accounts, or keys. Bounded by design (plan once, search once, synthesize once — no runaway sub-agent loops). Added to the default skill registry so new AIOS folders get it, and it auto-routes via RESOLVER on intents like "deep research", "compare the options", "what's the latest on".
- `dotaios export-okf` — export your knowledge (context, vault, projects, decisions, connections) into an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) (OKF v0.1) bundle: plain markdown + YAML frontmatter, git-shaped, readable by any OKF tool. It injects the OKF-required `type` field at export, generates a progressive-disclosure `index.md` per directory plus a bundle-root `index.md` declaring `okf_version`, and rewrites resolvable `[[wikilinks]]` to absolute `/path.md` links. Read-only — your source files are never modified. OKF is treated as portable plumbing: the bundle is a disposable projection, not a migration, and is produced locally only (sharing it is your decision). Ships with an `export-okf` skill and `docs/okf.md`.

## [1.20.1] - 2026-06-11
### Fixed
- Fresh installs are warning-free again. The web scraper now uses linkedom for HTML cleanup instead of cheerio, removing the deprecated `whatwg-encoding` transitive dependency that printed an npm deprecation warning on every first `npx dotaios` run — and 12 transitive packages with it. Ingest output is unchanged.
- `dotaios init` validates `--vault-path` before writing anything. A vault path that cannot be created (nested under a file, or in an unwritable location) now fails up front with a clear message instead of leaving a half-created AIOS folder behind.

### Changed
- The README command list now mentions `dotaios brief --compact`, the compact working-memory digest that AGENTS.md tells agents to use.

## [1.20.0] - 2026-06-08
### Added
- Native skills in every tool. `dotaios activate` now installs your `skills/<name>/SKILL.md` workflows as first-class native skills, not only the resolver convention. It symlinks each skill into `~/.claude/skills` (Claude Code) and `~/.agents/skills`, the shared Agent Skills standard folder read by Codex, Cursor 2.5+, Gemini, Warp, and VS Code, and registers your `~/aios/skills` folder in Hermes via `skills.external_dirs`. Edit a skill once and every tool that supports the standard sees it. Surfaces that do not read a local skills folder, like the Claude desktop app and browser chat, keep using the AGENTS.md paste convention. DotAIOS manages only the links it created, and cleans up a link when its source skill is removed.

### Fixed
- The Hermes config writer matches an exact list line instead of a substring, so a path like `/aios/skills` is not treated as already present when only `/aios/skills-backup` is listed. Symlink comparisons now resolve both sides so they stay correct on Windows.
- Removed a hardcoded personal path from a test fixture.

## [1.19.0] - 2026-06-03
### Added
- Skill resolver. Skills now declare `triggers:` (the phrases a user would naturally say) in their `SKILL.md` frontmatter, and DotAIOS auto-generates `skills/RESOLVER.md`, a routing table that maps intent to the skill that handles it. Connected agents match a request against the resolver instead of guessing from descriptions, so the right skill fires even when you don't know which skill you have. All bundled skills ship with triggers.
- `skillify` skill. Turn a workflow you keep repeating into a reusable skill: it drafts the skill (with trigger phrases) and saves it only after you approve. No evals, no auto-save, plain markdown.

### Fixed
- Date helpers unified on local time. Ingest signal placement and `cleanup`'s dry-run cutoff computed the day in UTC while signals are written under local dates, so near local midnight they could name a different day-file than where data actually lives. Both now use the canonical local `isoDate`.

## [1.18.0] - 2026-05-30
### Added
- Onboarding now ends with a short, honest reflective recap, your name, what you're working on, this week's priority, and one concrete thing to start today, instead of just listing features. Applies to the agent-led `INSTALL.md` flow and to `dotaios interview`.

### Fixed
- Search tolerates a corrupt line in a JSONL memory file instead of crashing, this also protects the session digest and the agent SessionStart hook that inject your working context.
- `connect gemini` shell-escapes the AIOS path in the generated hook script (no command execution via an unusual path).
- `install --subdir` rejects path traversal (`..` / absolute) from an untrusted plugin or marketplace entry.
- The MCP server never executes a client-supplied `gws` binary, it is resolved only from `DOTAIOS_GWS_BIN` or `PATH`.
- The session index lock is now crash-safe: it records the holder's PID, reclaims a crashed holder's lock, and never runs unlocked. Index entries are appended atomically, so concurrent captures can't drop an entry.

### Changed
- Search reads and scores files concurrently, faster on large vaults, with identical results.

### Docs
- Backfilled the missing `[1.15.0]` changelog entry; documented `read_session_digest` and the `connect` SessionStart hook; made the cold-start install steps followable on a fresh machine (single-shell Node install, the `npx` first-run prompt, a beginner-followable fallback); added a repo `CLAUDE.md`.

## [1.17.0] - 2026-05-28
### Added
- **Cross-agent context continuity.** `read_session_digest` MCP tool and `dotaios brief --compact` produce a compact working-memory digest (today's focus, carry-overs, recent signals, recent sessions) so any agent can get up to speed at session start without loading everything.
- `dotaios connect gemini`, install a Gemini CLI SessionStart hook + MCP server entry so context is injected automatically each session.
- `dotaios connect opencode`, install an OpenCode MCP server entry + per-skill stubs.
- `list_skills` MCP tool.
- Session access tracking (`access_count`, `last_accessed`) used to rank recent sessions in the digest.
- Frequency-weighted relevance ranking for search (phrase matches rank above multi-term matches; repeated hits rank higher). Note: this is term-frequency scoring, not full BM25.

### Changed
- `connect gemini`/`connect opencode` merge into existing agent config, refuse to overwrite a config file that exists but is not valid JSON, and run the merge before writing any other files (no partial install on failure).
- Session index mutations are serialized with a cross-process lock and written atomically (temp file + rename), so concurrent appends and digest-driven rewrites can't drop entries.

### Removed
- Unused adapter-first memory backend scaffolding (`memory-backend.mjs`, `MEMORY_BACKEND_KIND`), it was never wired into any command. It will return when adapters are actually integrated.
- Internal design-history docs under `docs/superpowers/` (still preserved in git history).

## [1.16.0] - 2026-05-28
### Added
- Internal scaffolding for a future adapter-first memory backend (resolver + contract). Note: not wired into any command in this release; the running product still uses the existing local file-based memory.
- **Local setup instrumentation**, `dotaios setup`, `search`, and `capture` emit best-effort, non-blocking metrics to `memory/metrics/pilot.jsonl` (`install_start/end`, `setup_phase_start/end`, `search_run`, `capture_saved/deleted`).

### Removed
- Stale `HANDOVER.md` internal handoff doc.

## [1.15.0] - 2026-05-23
### Added
- **Agent-carried onboarding.** Collapsed the install funnel to a single step: paste one sentence into any AI agent and it reads the repo, runs setup, connects your tools, and interviews you, no terminal commands required. This is now the primary install path in the README.
- **Private GitHub sync (`dotaios sync`).** Optional, opt-in sync of your `~/aios` folder to a private GitHub repo you own, so your context follows you across devices.
  - `dotaios sync setup`, guided setup using a pasted GitHub Personal Access Token (no OAuth app, no device flow).
  - `dotaios sync status`, `dotaios sync repo`, `dotaios sync logout`.
  - Rebase-model tick (commit → pull --rebase → push) fired after CLI commands via a hook; conflicts are surfaced, not silently resolved.
  - Phone-write inbox: drop notes from any device into the synced repo; the `process-inbox` skill files them into the right place.
- GitHub sync offered as an optional step during `dotaios setup`.

### Changed
- `dotaios sync` stamps its own DotAIOS git identity for sync commits, so it never depends on or modifies your global git config.

### Security
- `dotaios sync logout` strips the Personal Access Token from `.git/config` as well as `sync.json`, leaving no token behind.

## [1.14.0] - 2026-05-16
### Added
- **Session memory**, DotAIOS can now save your AI conversations locally so every agent on your machine can remember them. All sessions saved to `~/aios/memory/sessions/` as plain Markdown files.
- `dotaios capture` command tree, `import`, `list`, `delete`, `status`, `enable`, `disable`, `hook`.
- `dotaios capture import file <path>`, save any conversation file.
- `dotaios capture import paste`, paste a conversation in your editor; any tool supported.
- `dotaios capture import claude-code [--all]`, backfill past Claude Code sessions (last 30 days by default).
- `dotaios capture list [--agent] [--project] [--since]`, browse saved conversations in plain English.
- `dotaios capture delete <id>`, remove a saved conversation.
- `dotaios capture enable claude-code`, enable automatic saving when a Claude Code session closes.
- `dotaios capture disable claude-code`, turn off automatic saving.
- `dotaios capture status`, per-tool capability: auto-save / import only / paste only.
- `dotaios search` now searches saved sessions in addition to memory, vault, and context.
- `dotaios search --agent`, `--project`, `--since`, filter session results.
- Universal session format: agent-neutral Markdown + YAML frontmatter, one file per conversation, human-readable in any editor.
- `memory/sessions/index.jsonl`, lightweight catalog enabling fast search and deduplication across all saved sessions.
- `docs/sessions.md`, plain-English guide: where conversations save, how to delete, how to turn off.
- `docs/adapters.md`, per-tool capability levels in plain English.

### Changed
- `dotaios init` now creates `memory/sessions/` in the base folder tree.
- Help text updated to include `capture` command.
- README updated with session memory section.

## [1.13.1] - 2026-05-15
### Fixed
- `brief.mjs`: yesterday calculation broke at month boundaries (day 1 → day 0); now uses `getTime() - 86400000`
- `memory.mjs`: malformed JSONL line crashed all memory reads; invalid lines now skipped silently
- `files.mjs`: malformed `aios.json` crashed every command; now returns fallback value instead
- `init.mjs`: `memory/daily/` not created at init time; caused silent failures in brief, closeday, and today commands on fresh installs

## [1.13.0] - 2026-05-15
### Added
- `dotaios update [text]`, log a quick update (decision, meeting, note) directly to memory. Writes to `memory/signals/<date>.jsonl` and `memory/events.jsonl`. With no argument, prompts interactively. Designed for non-technical users who should not need to know which file to edit.
- `dotaios skills [name]`, list all installed skills with one-line descriptions. `dotaios skills <name>` prints the full skill instructions. Works with any agent, not just Claude Code.
- `closeday` skill now opens with an optional capture step: "anything to capture before we close?", agent appends the note directly to signals, no CLI required.

### Changed
- `dotaios setup` now asks once after onboarding whether to enable the daily brief schedule (Y/n), enables it in `schedules.yml`, and prints `dotaios schedule install` as the next step for full OS automation. Default: yes.
- `dotaios setup` prints a preview of the top 3 installed skills and how to invoke them after setup completes.
- Setup completion message is now agent-agnostic, names Claude Code, Codex, Gemini CLI, and Cursor, and uses plain English prompts that work with any of them.
- `skills/INDEX.md` preamble updated: removed Claude Code-specific `/skillname` slash syntax; invocation examples now read "use the audit skill" or "run plan-today" so any agent understands. Added: "When the user seems stuck or asks what you can help with, suggest a relevant skill."

## [1.12.0] - 2026-05-14
### Added
- `dotaios brief`, writes today's deterministic local brief into `memory/daily/YYYY-MM-DD.md` as a `## Brief` section. It reads priorities, recent open loops, and carry-over; no LLM or external service required.
- New AIOS folders now include a disabled daily brief schedule in `schedules.yml` (`dotaios brief`, daily), so the output loop is visible and can be enabled once.
- `dotaios ingest --to raw|wiki|company|person|signal`, route an ingested item to a shelf by purpose instead of always landing in `vault/raw`. `--name <name>` sets the record name (required for `company`/`person`, optional for `wiki`).
- Interactive shelf routing: `dotaios ingest <input>` with no `--to` in a Terminal now asks one plain question (rough source / lasting reference / company / person / working note); Enter defaults to `vault/raw`.
- `--apply` flag on `ingest`. Durable shelves (`wiki`, `company`, `person`) require approval: a non-interactive caller (an agent or script) gets a preview and writes nothing unless `--apply` is passed. A human picking the shelf interactively counts as approval.
- `packages/cli/src/ingest/placement.mjs`, shared shelf router used by the web, document, and text ingest paths.

### Changed
- `dotaios ingest` with no `--to` and no Terminal (agent/script) keeps today's behavior, saves to `vault/raw`, and prints a note pointing at `--to`.
- Ingesting onto a durable shelf that already has a record for that name now **appends** the new content under a dated heading instead of overwriting.
- `--to signal` appends a working note to `memory/signals/<date>.jsonl`; long parsed documents are preserved as markdown in `vault/raw` and linked from the signal.
- `skills/ingest/SKILL.md` documents `--to`, `--name`, `--apply`, and the durable-shelf approval gate so every agent routes by purpose.

### Removed
- Removed the overlapping `daily-brief` and `morning-digest` skills. `dotaios brief` is now the single brief path, and it writes the result down instead of printing into the void.

## [1.11.0] - 2026-05-14
### Added
- `skills/INDEX.md`, an auto-generated, agent-neutral list of every installed skill with a one-line description and run instructions. Regenerated on `init`, `activate`, raw-skill install, and `skill remove`, so every connected agent (not just Claude Code) can discover and run skills.
- `packages/core/src/agents.json`, editable registry of supported AI tools (name, detect path, bridge path, include syntax). Extendable per-user via `<aios>/agents.json`, merged by name. Adding a new AI tool no longer requires a code change.
- `dotaios activate --all`, connect every known AI tool even when not detected on the machine.
- `dotaios activate` and `dotaios doctor` print a copy-paste line for AI tools not in the registry: "Read <aios>/AGENTS.md first and follow it."

### Changed
- `dotaios activate` now connects only AI tools actually installed on the machine (detected by their config folder), and reports skipped tools clearly. Use `--all` to override.
- `AGENTS.md` inside the AIOS folder is now the single canonical, agent-neutral front door, folder map, read order, memory routing, rules, and skills. `CLAUDE.md` shrinks to a one-line pointer at it. Every agent bridge points at `AGENTS.md`.
- `dotaios doctor` and `dotaios status` report not-installed AI tools as informational, not warnings.

## [1.10.0] - 2026-05-14
### Added
- `dotaios setup`, one-shot onboarding wizard (init + activate + reveal).
- `dotaios doctor`, single health-check command that reports Node version, Terminal state, AIOS folder, and agent bridges with fix-lines per warning.
- `dotaios skill add|list|remove`, friendly alias surface for plugin management.
- `install` accepts git URLs (`https://...git`, `git@host:owner/repo`) and `--subdir <path>` for monorepo plugins.
- Windows installer source under `installers/windows/` (WiX 4 `.wxs`), GitHub Actions workflow at `.github/workflows/release-installers.yml` that builds an MSI on tag push and attaches it to the release.

### Changed
- `dotaios --version` now reads from `package.json` instead of a hardcoded constant. Removes the version-drift bug that left users on stale CLI metadata.
- `dotaios init` prints a clear "open the Terminal app" error when run without a TTY, instead of silently falling back to placeholders.
- `core/src/files.mjs:readJson` and `core/src/memory.mjs:readJsonl` now re-throw non-ENOENT errors. Corrupt `events.jsonl` surfaces immediately instead of looking empty.
- Sensitive-term pattern in `import` extended to catch OpenAI `sk-...`, AWS `AKIA...`, Google `ya29...`, Slack `xox*-`, GitHub `ghp_`/`github_pat_`, PEM private-key headers, and `bearer` tokens.
- README and `docs/friend-setup.md` now lead with explicit "open Terminal first" guidance to fix the most common ICP friction (pasting CLI commands into a chat window).

## [1.9.0] - 2026-05-12
### Added
- Official static landing page deployed via Vercel (`website/` directory)
- Support for installing third-party raw skills (without manifests)
- Taught agents how to install plugins directly from repository URLs
- Removed dashes and hyphens from README to simplify reading for non-technical users

## [1.8.0] - 2026-05-12
### Added
- Agent-native onboarding via `INSTALL.md`
- Progressive `init` command that generates empty hint-based context files instead of placeholder strings
- Added `LICENSE` files to all built-in skills

### Fixed
- Fixed timezone inaccuracy in signal generation (now uses local timezone instead of UTC)
- Added debug warnings when vault search encounters unreadable files

## [1.7.0] - 2026-05-12
### Added
- Refined non-technical `README.md`
- Audited system packaging and test suite

## [1.6.0] - 2026-05-11
### Added
- Browser Use integration blueprint
- Stabilized plugin manifest formats

## [1.5.0] - 2026-05-11
### Added
- `today` and `closeday` writeback skills to introduce a new daily-note convention
- `interview` command and `review` helpers for guided context updates

## [1.4.0] - 2026-05-10
### Added
- Universal Knowledge Router (`dotaios ingest`)
- Support for web URLs, PDFs, and local document ingestion directly to vault
- Lazy-loading architecture and chunked extraction

## [1.2.0] - 2026-05-08
### Added
- `search` command for multi-layered keyword retrieval
- `cleanup` command for memory maintenance
- Centralized `memory.mjs` module supporting event logging and signal trimming

## [1.0.0] - 2026-05-04
### Added
- Initial public release of the local-first AIOS core
- Memory, context, projects, and skills directories
- CLI commands (`init`, `activate`, `attach`)
