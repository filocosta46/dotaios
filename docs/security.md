# Security

DotAIOS is local-first, but local files can still contain sensitive data. The safest rule is simple: memory files are for context, not secrets.

## Secrets

Users should store secrets in:

```text
~/aios/.env
```

Generated AIOS folders include a `.gitignore` that ignores:

- `.env`
- `.env.*`
- `credentials.*`
- `token.*`
- `*.pem`
- `*.key`

`.env.example` is safe to commit because it contains placeholders only.

Agents should never ask users to paste API keys, passwords, tokens, private keys, or OAuth client secrets into chat. They should name the required variable and ask the user to edit `.env` locally.

## Session memory boundary

Session Markdown under `memory/sessions/<date>/` is canonical user evidence.
`memory/sessions/index.jsonl` is a rebuildable search projection and cannot
authorize a read, update, or delete by itself. Capture, reconciliation, bounded
search metadata, and exact deletion enter through one SessionStore interface.

The schema-1 codec decodes input as strict UTF-8 and accepts only closed,
flat frontmatter. It refuses duplicate keys, aliases, tags, nested values,
control characters, prototype-like keys, malformed turns, and inputs beyond
fixed document, field, body, turn-count, and turn-size limits. Every projection
path is parsed as a relative canonical-session path before use. Absolute,
traversing, duplicate, linked, special, hardlinked, replaced, and outside
artifacts are refused rather than normalized or followed.

Capture observes and parses a source inside the same store lock that publishes
the result. Same-source prefixes are idempotent, strict growth extends the
record, and non-prefix versions remain visible as conflicts requiring explicit
reconciliation. Reconciliation reports orphan Markdown, stale, malformed, or
unsafe rows, invalid Markdown, duplicate IDs or paths, duplicate or conflicting
source groups, and operational poison without deleting evidence.
Delete requires the exact full session ID and proved ownership of the canonical
regular file before either canonical or derived bytes change.

Mutations use a bounded private journal under `.dotaios/session-store/`.
Staging is synced before pending publication, and recovery completes a pending
capture, projection rebuild, or delete idempotently under the store lock.
The mutation deadline includes prerequisite recovery, so expired work cannot
begin a new capture after an unbounded recovery pass. Cleanup detaches and
re-proves each owned child before deletion; a replacement is restored and the
transaction is poison-preserved.
Read-only search, listing, reconciliation reports, working-context, promotion
preview, and MCP paths do not create recovery, repair, or quarantine artifacts.
Public search results retain bounded relative provenance but expose no absolute
machine paths, and internal failures remain path-free.

Fresh managed mirror rules exclude `/.dotaios/session-store/`; mirror content
validation also refuses that exact tree, including case aliases, if it is
forced or staged. An established mirror remains protected before its ignore
template is refreshed because the pre-add policy excludes the operational
tree. Adding the exact ignore entry makes that boundary visible to Git as well.
Canonical session Markdown remains eligible for the private personal mirror;
the derived index and operational state are not new memory authorities.

These protections use portable Node identity and containment observations.
They detect changes at supported boundaries but do not claim native
directory-handle-relative immunity to a hostile same-user swap-away-and-restore
completed entirely between checks. Access-time metadata managed by the
filesystem is also outside byte-level zero-write claims.

## Project restore

`dotaios project restore` accepts only credential-free HTTPS and SSH project
remotes. It invokes Git with the user's normal project credentials and a
sanitized process environment. The private AIOS mirror token is removed from
that environment and is never used to clone a project.

Managed checkouts live under the root-ignored `workspaces/` directory. Before
sync, DotAIOS verifies that the outer repository tracks nothing under that root
and that every workspace is registered, complete, and bound to the expected
safe remote. This prevents project contents, Gitlinks, and clone residue from
entering the personal-context mirror.

## Project source consent and receipts

Project-source paths, grants, revocation state, and access receipts are
machine-local. A portable declaration carries only source identity, label,
type, and purpose beneath its owning project. Add, bind, grant, and revoke
commands preview by default; apply requires the displayed operation ID and plan
fingerprint from that exact state. An explicit future expiry and exact purpose
are mandatory. Neither task text nor the read-only MCP adapter can grant
consent.

Each grant is limited to one project, source, read operation, purpose, portable
source revision, binding generation, and root identity. Missing, mismatched,
expired, stale, or revoked authorization refuses before the external root is
opened. Those decisions append one bounded, path-free machine-local receipt;
receipt publication failure withholds the refusal result as well as successful
references. Unknown future authorization-state versions are refused in place
and are never rewritten as an older format.

Local authorization and receipt state accepts only same-user regular files and
directories with restrictive permissions and stable identities. Links, special
nodes, extra-linked files, unsafe owners or modes, unknown lock fields, and
replaced lock owners fail closed without permission repair. Grant/revoke and
receipt publication keep a durable in-flight guard; directory-sync uncertainty
reinstates that guard or retains a non-reclaimable poisoned owner lock before
authorization can resume.

Retrieval opens no source-content bytes and returns no absolute roots or local
state paths. It emits only complete source-relative metadata after containment
and identity rechecks, then syncs one guarded append-only receipt before
returning. Receipt uncertainty poisons later access rather than repairing or
truncating historical bytes. Root, directory, and file identities use BigInt
metadata observations; linked or special entries and every exceeded traversal,
path, output, or receipt bound fail closed with empty references. Node's
portable checks detect changes at observed boundaries; they are not a claim of
native directory-handle-relative race immunity and cannot exclude a hostile
swap-away-and-restore completed entirely between observations.

## Optional Connections

Google Workspace auth remains inside `gws`. DotAIOS requests the fixed read-only Gmail, Calendar, and Drive service set, and does not expose full, custom-scope, or custom-service login options. `gws auth status` does not verify the scopes of an existing grant, so broader grants must be revoked or re-authorized in `gws`. Google and `gws` process requested Workspace data. DotAIOS connection records contain neither OAuth material nor absolute binary paths. Google commands are not exposed through the read-only DotAIOS MCP adapter.

Lightpanda is never downloaded as an unattended default. Interactive setup requires confirmation, and non-interactive setup requires `--install-lightpanda`. Downloads use a pinned release and per-platform SHA-256 digest, stay non-executable while being verified, and move atomically into place only after verification. A failed or declined install leaves plain web fetch available.

## Plugins

DotAIOS installs plugins and raw skills only from reviewed local folders. Remote
URL inputs are refused. If a source lives in Git, acquire and pin the revision
outside DotAIOS, review that local checkout, then pass its folder to the CLI.
The manifest declares permissions, and the CLI prints them before install, but
DotAIOS does not sandbox plugin code.

Current rule:

- Install only plugins you trust and have reviewed locally.
- Use `--dry-run` before install.
- Do not treat the current plugin system as a public marketplace.
- Install with `dotaios install <local-plugin-path> --dry-run`, then repeat
  without `--dry-run` only after the source and permission preview are acceptable.

## Integration Safety Lanes

Use these lanes for Google Workspace, MCP tools, schedules, plugins, and agent workflows:

- Green: local DotAIOS reads such as context, search, schedules, skills, and memory inspection.
- Yellow: read external data into terminal or agent output, with source attribution and no automatic durable write.
- Red: send, edit, delete, move, label, archive, create events, or write durable context/wiki/org/CRM memory. Ask first.
- Black: OAuth secrets, refresh tokens, credential files, private keys, passwords, and API keys. Never paste these into chat or memory.
