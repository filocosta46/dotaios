# Projects Across Machines

DotAIOS keeps project context and source code reachable from one folder without
putting project repositories inside the AIOS Git mirror.

For each project, three things are stored separately:

- `projects/<slug>/README.md` contains the durable project record: stable ID, name, status, domain, repository URL, decisions, and next steps. This can sync with the rest of AIOS.
- `~/.dotaios/projects.json` maps that stable ID to the checkout path on the current machine. This file stays local because paths differ between computers.
- `workspaces/<slug>/` is the optional managed checkout on this machine. The
  AIOS mirror ignores this entire root; each project remains a normal repository.

The project source code remains in its own repository with its own Git history.

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
