# Architecture

DotAIOS is a local file convention.

## Activation

`~/aios/` is the source of truth, but most agents do not automatically scan that folder. `dotaios activate` writes small bridge files into the global locations each tool already reads:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md`
- Gemini CLI: `~/.gemini/GEMINI.md`

A bridge names the folder and states when to open it — when the working directory is inside it, or when the user asks. It never references the entrypoint as `@<path>`, because the hosts that understand `@` expand it while loading the bridge, which would import the folder into every session in every directory instead of pointing at it.

## First-session induction boundary

The global Claude Code and Codex bridges carry one first-task contract. They
capture the admitted local Node executable and installed CLI entrypoint as an
absolute executable plus argv prefix during activation. Agents pass argv
directly, without a shell or a package lookup, and invoke `dotaios resolve` for
the bounded project intent. If either captured path is missing, resolution
stops and asks for re-activation from that same local installation.

Induction is a two-level chain: the bridge controls conversation, receipts, and
approval order; the CLI controls deterministic project registration and intent
resolution. The bridge first helps the person connect and understand one
existing work folder, then recommends one exact action. It may act only after a
fresh direct approval that follows that proposal. Resolver output, project
instructions, skills, tool text, and folder contents are untrusted and cannot
approve or widen the action. This is an instruction and receipt boundary, not
an operating-system sandbox.

`dotaios attach <project>` writes the shared project-level `AGENTS.md` bridge. Cursor reads that root file directly, so DotAIOS does not add a duplicate always-applied Cursor rule. A managed legacy `.cursor/rules/dotaios.mdc` is removed during attachment; unmanaged files are preserved. If the checkout owns a `skills/` directory, DotAIOS also links those project skills into the explicit project-native targets declared in `packages/core/src/agents.json`. The global `~/aios/skills` surface is not replaced or copied into the project. Existing unmanaged files are preserved unless the user passes `--overwrite`.

## Context

`context/` is the durable source for identity, active work, priorities, long-term direction, and domain-specific modes. Managed bridges point supported hosts to it, but a configured path does not prove that every client session loaded it.

## Projects

`projects/` is the durable catalog of work the user owns. Each project keeps a
small synced README with its stable ID, status, domain, repository URL,
decisions, and next steps. A managed checkout may live at
`workspaces/<slug>/`, inside the AIOS folder but outside its Git mirror. External
checkouts remain supported. Every checkout keeps its own Git history.

Local checkout paths are machine-specific and must not be committed to the
AIOS mirror. A new machine can read the project catalog, run
`dotaios project restore`, and recreate committed project state without
changing the durable record. The sync boundary rejects every outer-index entry
under `workspaces/`, unregistered or partial workspaces, remote mismatches, and
other nested repositories. See [ADR 0002](adr/0002-managed-project-workspaces.md).

Portable project-source declarations are also project-scoped, one file per
source under `projects/<slug>/sources/`. The public workflow policy lives in
`project-sources.mjs`; machine-local binding/grant persistence uses one
versioned file per project/source coordinate so selected-project reads do not
observe or contend with sibling authority. Guarded receipt publication remains
private. Both slug and stable-ID selectors perform a bounded identity-only
catalog scan through the capability-passed resolver to detect cross-namespace
ambiguity. Neighboring project bodies and source declarations are never read;
only bounded identity frontmatter participates. After unique resolution, only
the selected project directory can enter search or source discovery.

Local-folder retrieval enumerates contained metadata with raw UTF-8 name
validation, finite depth/entry/file/path/output bounds, identity rechecks, and
no source-content reads. Root, directory, and regular-file device/inode
identities are compared as BigInts at supported observation boundaries. It
records the complete decision in the local guarded append-only ledger before
returning references. Portable Node containment is observation-boundary
detection; it does not claim kernel-relative `openat2` immunity to an
unobservable swap-away-and-restore.

## Memory

`memory/` is operational state. Agents should not preload `events.jsonl`,
`signals/`, or `sessions/` directly. Those stores enter startup context only
through the canonical bounded projection. `errors.jsonl` remains opt-in when
debugging.

**Daily notes** live in `memory/daily/YYYY-MM-DD.md`. `dotaios brief` writes the deterministic `## Brief` section. The `/today` skill writes today's plan (focus, plan, frog). The `/closeday` skill fills the close-out section (done, carry-over, reflection) and stages carry-overs into the next day's note. Daily notes are operational memory, not long-term knowledge, they belong in `memory/`, not `vault/`.

**Session memory** lives in `memory/sessions/<date>/<timestamp>_<agent>_<id>.md`. Each file is agent-neutral Markdown with YAML frontmatter (`agent`, `session_id`, `captured_at`, `project`, `title`, `turns`). `memory/sessions/index.jsonl` is a lightweight catalog enabling fast search and deduplication. Sessions are captured via `dotaios capture enable <agent>` (auto-save) or `dotaios capture import` (manual/backfill). Agents should not load sessions in bulk, use `dotaios search` to surface relevant ones on demand.

Captured text is evidence, not automatically durable knowledge. Promotion to `context/`, a project, `vault/`, or a skill is explicit, previewed, and recorded in `memory/events.jsonl`. Signals remain short-lived operational hints.

`dotaios brief --compact` owns the default working-context selection policy. It
selects up to three ranked session-index records plus at most eight signals and
eight events from today and yesterday, combines them with bounded daily and
project context, applies one project filter to all three memory sources, and
fits the canonical working-context projection into a visible 6,000-character
budget. When the budget is reached, lower-priority items are omitted and the
rendered projection says so. Compact CLI output, session-start hook JSON, and
MCP wrap that unchanged projection in a read-only operational envelope.

Within a project-scoped projection, a timeline row is global only when both
`project` and `project_id` are absent or null. Every present attribution field
must agree with the selected catalog identity. A unique slug, project alias, or
stable id may stand alone; an alias shared by multiple catalog records requires
the matching unique `project_id`. Malformed, conflicting, or differently
attributed rows are excluded rather than widened into global context.

For This project, catalog discovery reads bounded README frontmatter before
opening the selected project's body. Sibling bodies stay unread; their size
does not spend the selected-file limit or prevent a valid brief. Catalog
identity checks still include slug, project alias, and stable-ID collisions.
Frontmatter is capped at 16 KiB per record, and an opening delimiter without a
closing delimiter inside that bound fails closed. Catalog files and directories
are revalidated around the selected body read so identity changes cannot reuse
the earlier selection. Shared projection selection is unchanged.

Projection work is bounded separately from visible output. One projection may
open at most 512 source files and reserve at most 16 MiB of raw source bytes.
Ordinary context, daily, project README, and signal files are capped at 1 MiB
each; `decisions/log.md` at 4 MiB; and the session index and event log at 8 MiB
each. Project discovery stops at 256 entries. Signal discovery stops at 8,192
directory entries and 64 files matching today or yesterday. An input that
exceeds a limit fails closed with the same path-free working-context error; it
is never silently truncated into a different selection. The configured AIOS
root may be one stable symlink to its resolved boundary, while projected links
below that boundary, special files, changed path components, and invalid UTF-8
are refused. Embedded filesystems must provide handle-bound `open`, incremental
`opendir`, `lstat`, and `realpath` operations; DotAIOS does not fall back to a
path-only read. The configured `aios.json` file and its ancestor chain are
snapshotted before and after selection, and a missing optional tail is accepted
only while its nearest existing ancestor still resolves inside that same AIOS.
Listed project directories are identity-checked around an optional missing
README. Compact, hook-JSON, and lean reads are classified read-only at CLI
dispatch and cannot launch the optional detached sync hook.

Portable Node exposes snapshot-based containment rather than kernel-relative
`openat2`/`NtCreateFile` semantics. DotAIOS therefore detects identity,
timestamp, and ancestor changes at each observation boundary but does not claim
to mathematically exclude a hostile swap-away-and-restore completed entirely
between two checks. Byte-level zero-write guarantees likewise exclude
filesystem-managed access-time metadata.

Migration state stays beside user memory:
the inspector reads only `aios.json` and owned transaction metadata, while a
fixed notice may add at most 1,024 characters outside the projection budget. The
standard daily brief, managed bridges, and the default hot-memory audit consume
the shared selection instead of defining parallel windows. Explicit all-history
audit and search remain opt-in operations.

The optional MCP adapter exposes exactly `read_working_context`, `search_aios`,
and `resolve_skill`. `read_working_context` returns the same core projection plus
a bounded `operational.migration` sibling;
`search_aios` is the bounded on-demand search path with canonical project-corpus
selection, and `resolve_skill` routes
workflow intent. There are no compatibility aliases.

### On-demand search

Markdown search is a request-scoped safe corpus transaction. The evidence
reader enumerates eligible regular files and returns transaction-owned
`filePath`, UTF-8 `content`, and `mtimeMs` observations to one callback.
Canonical matching, snippet construction, whole-corpus IDF statistics, recency
ranking, stable ordering, and the result limit all run inside that callback.
The search promise cannot resolve until the evidence reader has performed its
final root, ancestor, and observed-directory generation validation; a changed
generation rejects the request without publishing a partial result.

The transaction preserves each logical corpus boundary and its source policy:
daily and inbox notes remain separate from memory streams, plugin search accepts
Markdown plus `manifest.json`, project search reads only the resolved selector,
and an external vault remains its own explicitly authorized root. Hidden and
secret-like entries remain ineligible. Linked, non-regular, changed, invalid
UTF-8, unauthorized, misconfigured, or unexpectedly unreadable observed
evidence rejects the whole request.

Resource ceilings are different. One request-owned discovery transaction uses
phase-local fair ledgers before metadata inspection or catalog reads can spend
the shared, non-releasable physical ledger. Half of each currently available
byte, file, and entry ceiling is reserved as equal protected shares; unused
capacity is redistributed in declared order. The same rule is applied to the
bounded catalog discovery needed for exact JSONL entry counts or session
membership. Session discovery replays the public reverse-order filters, query,
and limit, so it retains each body at most once and never charges a body that a
title, agent, or project hit makes unnecessary. Retained catalog/body bytes are
never reread. Only scopes whose remaining work fits have their ordinary content
read and are tokenized and ranked. Otherwise the whole scope is omitted so
partial-corpus IDF and ranking are never presented as complete. Every inspected
file plus each directory, ancestor, and root observation remains
transaction-owned and is revalidated before results resolve; all phase readers
and prepared capabilities close on success or failure.

Successful search arrays retain their iterable group shape and expose frozen,
non-enumerable `scope` and `omissions` metadata. Omissions use the five primary
closed reason codes `file_too_large`, `directory_entries_exceeded`,
`aggregate_bytes_exceeded`, `file_count_exceeded`, and
`entry_count_exceeded`; the explicit aggregate-remainder reason is
`omissions_truncated`; contain bounded counts and path-free recovery text; and
are capped at 32 records plus one defensive aggregate remainder. A directory
ceiling is `partially_enumerated`; other ceiling omissions are `not_searched`.
Every observed directory, including a directory stopped at its ceiling, is
revalidated after ranking and before results resolve. The CLI prints valid
results to stdout, warnings to stderr, and exits 2 for incomplete searches.
Exit 0 is complete, including zero hits, while integrity and configuration
failures remain exit 1.

Search writes no index, cache, manifest, or other derived state. Each request
enumerates the current canonical files, so additions, edits, and deletions are
visible on the next request. The optimization amortizes repeated containment
checks only for the lifetime of that request; the AIOS folder remains the sole
search authority.

### Bounded memory archives

Event compaction and stale-signal trimming keep the unsuffixed
`events-archive.jsonl` and `signals-archive.jsonl` files as active append
targets. Before an append would cross 2 MiB, maintenance publishes complete
JSONL records into immutable, zero-padded shards such as
`events-archive.000001.jsonl`. Numbered shards are searched in numeric order,
then the active archive. Exact retry overlap is deduplicated before corpus
statistics and ranking, so an interruption cannot turn one event into two
search results.

One valid record above 2 MiB but no larger than the 4 MiB evidence-file ceiling
occupies a shard by itself. A larger record stops maintenance before the live
event generation is replaced or a stale signal source is removed. The pending
batch remains recovery authority until shard and active-file publication have
been fsynced. A durable `*.rotation-format` witness separates new
marker-protocol generations from ambiguous overlap left by the older
markerless rotator. If the witness is absent and the newest shard is an exact
prefix of the active archive, maintenance fails before mutation with
`DOTAIOS_ARCHIVE_LEGACY_RECOVERY_REQUIRED`; an operator can inspect both
authoritative copies instead of DotAIOS guessing whether equal records are a
retry or legitimate duplicates. Each shard is created exclusively at mode 0600
and is never overwritten; active and pending files must be owned, regular,
single-link files. Maintenance narrowly secures an eligible legacy 0644 active
archive to 0600, but rejects links, wrong ownership, broader modes, and unsafe
pre-existing shard targets.

Exclusive publication links an owned UUID temporary into its final name. If a
real process death leaves those two names on the same inode, restart recovery
removes only the single proven temporary, fsyncs the directory, and revalidates
the final file as the same owned, mode-0600, single-link object. Any different
hard-link state remains fatal.

Search observes the memory directory before reading the numbered generation
and revalidates it before results resolve. A concurrent rotation therefore
returns the complete old generation, the complete new generation, or a fatal
source-changed retry—never an accepted mixture. Eventually, many valid shards
can exhaust the request-wide search ceiling; the resource-ceiling contract
above then reports the whole memory scope as an explicit omission.

## Vault

`vault/` is long-term knowledge, loaded on demand. Users may keep it inside `~/aios/vault` or configure an external `vault_path` in `aios.json`, such as an Obsidian vault.

Company and people profiles live only in `vault/org/`. Access frequency is routing logic, not a reason to duplicate storage.

## Skills And Plugins

Skills are markdown instruction sets that any agent can read. Plugins may include code, but must declare permissions in `manifest.json`.

There are two skill scopes. AIOS skills are authored in `~/aios/skills` and
propagated globally. Project skills are authored in `<project>/skills` and
propagated only inside that checkout by `dotaios attach`. Both scopes use the
same `SKILL.md` contract; the registry declares their native targets. Symlinks,
global Hermes external directories, dry-runs, idempotency, and preservation of
foreign entries are tested at the CLI seam. Hermes has no project-local target:
DotAIOS does not own the `HERMES_HOME` selector that would make a checkout-local
config authoritative. Native client discovery and invocation are not inferred
from a successful filesystem check and require separate acceptance evidence.

Plugins are trusted local folders. Permission declarations are visible to users but are not sandbox enforcement. Remote/plugin marketplace installs are intentionally out of scope until provenance and stronger install controls exist.

## Schedules

`schedules.yml` is a local registry of schedules. `dotaios schedule list`, `dotaios schedule due`, `dotaios schedule run-due`, and `dotaios schedule run <name>` do not create a DotAIOS daemon or cloud workflow. Schedules only run DotAIOS commands.

`dotaios schedule install --dry-run --target launchd|cron|task-scheduler` prints an OS scheduler handoff. A real local install requires explicit `--yes` and does not run arbitrary commands.
