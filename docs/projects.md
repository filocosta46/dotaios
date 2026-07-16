# Projects Across Machines

DotAIOS keeps every project reachable without putting project repositories inside the AIOS repository.

For each project, two things are stored separately:

- `projects/<slug>/README.md` contains the durable project record: stable ID, name, status, domain, repository URL, decisions, and next steps. This can sync with the rest of AIOS.
- `~/.dotaios/projects.json` maps that stable ID to the checkout path on the current machine. This file stays local because paths differ between computers.

The project source code remains in its own repository with its own Git history.

## Add a project

```bash
dotaios project add /path/to/project
dotaios attach /path/to/project
```

The first command registers the durable record and local path. It discovers the Git remote when one exists. The second command adds project-level agent instructions and local project workflows.

DotAIOS never moves or copies the repository. It rejects repositories nested inside `~/aios`.

## Use it on another machine

After your AIOS metadata is available on the new machine, clone the project repository wherever you prefer, then reconnect that checkout:

```bash
dotaios project add /new/path/to/project --slug existing-slug
dotaios attach /new/path/to/project
```

The stable project ID and durable README remain unchanged. Only the local path mapping changes.

## Check project reach

```bash
dotaios project list
dotaios project resolve <slug-or-id>
dotaios project doctor
```

`doctor` is read-only. It reports missing local paths and Git remotes that do not match the synced project record.
