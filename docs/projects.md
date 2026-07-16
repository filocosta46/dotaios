# Projects Across Machines

DotAIOS keeps every project reachable without putting project repositories inside the AIOS repository.

For each project, two things are stored separately:

- `projects/<slug>/README.md` contains the durable project record: stable ID, name, status, domain, repository URL, decisions, and next steps. This can sync with the rest of AIOS.
- `~/.dotaios/projects.json` maps that stable ID to the checkout path on the current machine. This file stays local because paths differ between computers.

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

The command discovers the Git remote when one exists. It never moves or copies the repository, and it rejects repositories nested inside `~/aios`.

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

After your AIOS metadata is available on the new machine, clone the project repository wherever you prefer, then reconnect that checkout:

```bash
dotaios project add /new/path/to/project --slug existing-slug
dotaios project add /new/path/to/project --slug existing-slug --apply
dotaios attach /new/path/to/project
```

The first command previews the reconnection. The second command saves it. The stable project ID and durable README remain unchanged. Only the local path mapping changes.

## Check project reach

```bash
dotaios project list
dotaios project resolve <slug-or-id>
dotaios project doctor
```

`doctor` is read-only. It reports missing local paths and Git remotes that do not match the synced project record.
