# Projects Across Machines

DotAIOS keeps project context and source code reachable from one folder without
putting project repositories inside the AIOS Git mirror.

For each project, three things are stored separately:

- `projects/<slug>/README.md` contains the durable project record: stable ID, name, status, domain, repository URL, decisions, and next steps. This can sync with the rest of AIOS.
- `~/.dotaios/projects.json` maps that stable ID to the checkout path on the current machine. This file stays local because paths differ between computers.
- `workspaces/<slug>/` is the optional managed checkout on this machine. The
  AIOS mirror ignores this entire root; each project remains a normal repository.

The project source code remains in its own repository with its own Git history.

## Reach a connected folder

Connect a folder once, then let the assistant open it:

```bash
dotaios project source locate acme-campaign --task "the campaign assets for that client"
```

It answers with the folder, not its contents:

```
Campaign assets (acme-campaign/campaign-assets)
Folder: /Users/you/Clients/Acme/assets
For: Launch campaign assets
Open it directly — read only what the task needs.
Receipt: rcpt-...
```

That is the whole handoff. The assistant already reads local folders natively,
so once it knows where the folder is it opens only the files the task needs,
and nothing spends tokens on files nobody asked for.

`locate` costs the same whether the folder holds four files or forty thousand:
it resolves the connection and stops, so **no folder is too large**. The
`--task` text routes between your connected folders by matching their label and
purpose, exactly as retrieval does. Consent is unchanged — an ungranted or
revoked source refuses, and a refusal never names the folder.

Use `retrieve` below only when you specifically want a recorded listing of file
metadata. It is bounded, and on any sizeable folder it refuses; see the bounds
section for why that ceiling is structural.

## Retrieve references from a local project source

A project may declare the meaning of a local folder without putting its path or
contents into the portable AIOS. Source declarations live beneath the owning
project at `projects/<slug>/sources/<source-id>.md`; the absolute binding,
finite grant, and access receipts remain beneath
`~/.dotaios/project-sources/` on this machine.

The guided form is `dotaios project source connect <project> <folder>`. It
previews the folder binding and complete finite read consent together:

```bash
dotaios project source connect acme-campaign /path/to/assets \
  --source-id campaign-assets \
  --label "Campaign assets" \
  --purpose "Launch campaign assets" \
  --expires-at 2099-01-01T00:00:00.000Z \
  --json
```

The preview writes nothing and names the project, source, read scope, exact
purpose, approval timing, and UTC expiry. Re-run the same values with `--yes`
to connect and grant access without copying operation IDs or fingerprints. An
exact rerun is idempotent; a matching source whose grant was not completed can
resume, while mismatched or unowned existing state refuses.

The lower-level `add`, `bind`, `grant`, and `revoke` commands remain available
for scripts and recovery. They keep their exact preview/apply proof contract:

```bash
dotaios project source add acme-campaign /path/to/assets \
  --source-id campaign-assets \
  --label "Campaign assets" \
  --purpose "Launch campaign assets" \
  --json

dotaios project source grant acme-campaign campaign-assets \
  --purpose "Launch campaign assets" \
  --expires-at 2099-01-01T00:00:00.000Z \
  --json
```

Ordinary task text never grants consent. Once the exact grant preview is
applied by the same shell user, it is bound to the selected project, source,
read operation, exact portable purpose, source revision, binding generation,
and explicit expiry. Revoke that grant with its returned `grant_id`; revoke is
also preview-first and changes only machine-local authorization state:

```bash
dotaios project source revoke acme-campaign campaign-assets \
  --grant-id <grant-id> \
  --json
```

Apply only the displayed revoke operation ID and plan fingerprint. Revocation
does not alter earlier access receipts, and every later retrieval refuses.
Retrieval remains an explicit CLI operation:

```bash
dotaios project source retrieve acme-campaign \
  --task "retrieve the campaign assets for that client." \
  --json
```

Retrieval returns sorted source-relative regular-file references with size,
nanosecond freshness, project/source identity, resolution time, and receipt
identity. It reads metadata rather than file contents, never copies or edits
the source, and publishes one machine-local receipt before exposing success.
The MCP adapter deliberately has no retrieval or consent tool.

The listing is all-or-nothing. A missing, moved, inaccessible, linked, replaced,
or otherwise unsafe root requires reconnection; an unsafe nested link, hardlink,
special entry, unsupported raw name, or observed identity change refuses the
whole result with no partial references. One retrieval may descend at most 16
levels, observe 4,096 entries and 256 regular files, use source-relative paths
of at most 1,024 UTF-8 bytes, and serialize at most 32,000 characters. It
refuses instead of truncating when any independent bound is exceeded. The
machine-local append-only receipt line must itself fit within 32,000 UTF-8
bytes; if receipt publication cannot complete, DotAIOS withholds the result.

Read the 256-file figure as a ceiling rather than a capacity: a retrieval
refuses on size long before it reaches 256 files. The two 32,000 limits above
are independent and measure different things — the serialized result is capped
at 32,000 characters, while the receipt line is capped at 32,000 UTF-8 bytes —
and the receipt is the tighter of the two. It carries every reference the result
carries plus the task, grant, and identity fields, and it is counted in bytes,
so non-ASCII names cost more there than they do in the result.

Measured on this tree, connecting one flat folder and retrieving once per file
count, the last accepted retrieval was:

| Filenames | Files | Result characters | Receipt bytes |
|---|---|---|---|
| `Proposta lampade Acme 2026 - rev 12.key` | 112 | 31,349 | 31,734 |
| `a1.key` | 127 | 31,470 | 31,855 |

In both cases the next file refuses, and in both the receipt is the bound that
runs out first. Names outside ASCII reach it sooner: 90 files named
`Presentazione café 90 🚀.key` already spend 24,886 receipt bytes against 24,231
result characters. Deeper paths lower every one of these numbers.

This is why the ceiling is structural rather than a tunable. A receipt records
every reference it returns, so a retrieval can never return more files than one
receipt line can hold, and that line is re-validated against the ledger on every
append.

Connecting a folder is not subject to any of this. A folder of any size connects
and grants normally; the bounds apply only to what a single retrieval returns.

For search, `--project` selects the portable project corpus by slug or stable
ID. `--session-project` filters session tags only. Older commands that used
`--project` as a session attribution filter should migrate to
`--session-project`.

## Add a project

Start with a preview:

```bash
dotaios project add /path/to/project
```

The preview is read-only. It shows the exact `projects/<slug>/README.md` change, but it does not create the README or save a local path mapping.

When the preview looks right, apply the same command explicitly:

```bash
dotaios project add /path/to/project --apply
```

`--yes` is an explicit alias for `--apply` for scripts. Neither option is implied, so an unattended command without one of them remains read-only.

Applying the plan writes two separate records:

- Portable project truth goes to `projects/<slug>/README.md` inside AIOS.
- The checkout path for this computer goes to `~/.dotaios/projects.json` outside AIOS.

The command discovers the Git remote when one exists. It never moves or copies
the repository. It accepts an external checkout or that project's exact managed
path under `workspaces/<slug>/`, and rejects every other checkout nested in AIOS.

After registration, connect the repository to project-level agent instructions and local workflows if needed:

```bash
dotaios attach /path/to/project
```

### Machine-readable output

Use `--json` with either preview or apply:

```bash
dotaios project add /path/to/project --json
dotaios project add /path/to/project --apply --json
```

The JSON object contains `plan`, `receipt`, and `machine_local` sections. The plan contains portable project metadata and the README preview. The receipt contains the operation, relative durable path, and hashes. Absolute checkout and state paths appear only under `machine_local`.

Re-adding an existing checkout keeps its stable project ID. You can update its metadata in place by previewing and applying new options, for example:

```bash
dotaios project add /path/to/project --status paused
dotaios project add /path/to/project --status paused --apply
```

## Use it on another machine

After your AIOS metadata is available on the new machine, restore every missing
project into the managed workspace root:

```bash
dotaios migrate
dotaios project restore
```

Migration is a read-only preview. If the folder predates schema 1.2, apply the
exact plan ID it prints before restore. DotAIOS will not clone into a folder
whose `/workspaces/` privacy boundary is missing.

Or restore one project by slug or stable ID:

```bash
dotaios project restore <slug-or-id>
```

Preview either operation with `--dry-run`; use `--json` for a structured
receipt. Restore refuses unsafe remotes and never uses the AIOS sync token.
Existing external checkouts remain available and are not duplicated.

Restore clones into an owner-marked hidden staging transaction beside the final
workspace. A reported clone failure cleans only that owned staging tree, so the
same command can be retried without deleting a final project folder. After an
abrupt process exit, a retry automatically recovers only an exact transaction
whose project, remote, destination, owner marker, and dead process identity all
verify. A live matching restore reports busy; malformed or ambiguous staging
residue is left untouched for inspection. A concurrently created final folder
is never intentionally removed or overwritten. If the checkout was already
published and only cleanup or the local mapping failed, rerunning restore
verifies the checkout, cleans exact dead transaction debris, and repairs the
mapping without cloning again.

If you prefer another location, clone the repository there and reconnect it:

```bash
dotaios project add /new/path/to/project --slug existing-slug
dotaios project add /new/path/to/project --slug existing-slug --apply
dotaios attach /new/path/to/project
```

The first command previews the reconnection. The second command saves it. The stable project ID and durable README remain unchanged. Only the local path mapping changes.

Restore recreates committed remote state only. Uncommitted files, local
branches, ignored files, stashes, and credentials do not travel through AIOS.

## Check project reach

```bash
dotaios project list
dotaios project resolve <slug-or-id>
dotaios project doctor
```

`doctor` is read-only. It reports missing local paths, unsafe or mismatched
remotes, and workspace layouts that cannot cross the sync boundary safely.

See [ADR 0002](adr/0002-managed-project-workspaces.md) for the enforced
architecture and failure rules.
