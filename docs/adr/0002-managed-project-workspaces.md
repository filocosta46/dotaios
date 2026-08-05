---
status: accepted
---

# Keep managed project workspaces inside AIOS but outside its mirror

DotAIOS stores portable project records in tracked `projects/<slug>/README.md`
files. When a checkout is missing on a machine, `dotaios project restore`
clones it into `workspaces/<slug>/`. The outer AIOS repository root-ignores
`/workspaces/`; every checkout keeps its own Git history, branch, and remote.
External checkouts remain supported.

This is not a submodule design. The AIOS mirror must contain no index entry
under `workspaces/`, especially no Gitlink. Before every sync, DotAIOS verifies
the root ignore, the empty outer-index boundary, the durable project ID, the
workspace path, a complete checkout, and a safe origin matching the catalog.
It refuses unregistered workspaces, partial clones, symlinks, remote mismatches,
and every other nested repository.

Restore uses the user's normal project Git credentials. It never reuses the
AIOS mirror token. It accepts credential-free HTTPS and SSH remotes and clones
into a hidden, owner-marked sibling transaction under `workspaces/`. DotAIOS
verifies a resolved commit and matching origin there before publishing the
checkout at `workspaces/<slug>/`, then saves only the machine-local path outside
AIOS. A normal clone failure removes only that command's owned staging tree, so
the same restore can be retried. After an abrupt process exit, a retry may clean
or publish a transaction only when its exact project, remote, destination,
canonical owner marker, and dead process identity all verify. Live matching
transactions return busy, and malformed or ambiguous staging residue is never
deleted automatically. A raced final destination is left untouched. If the
checkout was published and only cleanup or mapping failed, rerunning restore
verifies it, removes exact dead transaction debris, and repairs the mapping
without cloning again.

Existing folders must complete the preview-first schema 1.1 to 1.2 migration
before restore. That migration preserves custom `.gitignore` bytes, adds the
exact anchored `/workspaces/` rule, commits `aios.json` last, and can recover an
interruption without leaving the mirror boundary half-installed.

Only committed remote state can be restored. Uncommitted files, ignored files,
local branches, stashes, and credentials remain local to their original
checkout. DotAIOS does not claim automatic shared-memory collaboration for
teams; the verified scope is a private personal AIOS mirror plus independent
project repositories.

Rejected alternatives:

- Project repositories under tracked `projects/`: the outer repository records
  Gitlinks instead of their contents.
- Git submodules: they add detached-head and credential complexity without
  solving local path ownership.
- An external managed root: safe, but it removes the one-folder visibility that
  managed workspaces are meant to provide.
