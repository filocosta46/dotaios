# Research that another agent can continue

An authorized agent can retain research in an ordinary work folder, write a
cited result, and leave its progress ready for another agent. The bundled
`research` skill starts by inspecting the current work; the owner does not need
to know a checkpoint name or supply the previous conversation.

The host supplies search, browsing and execution tools. DotAIOS preserves and
checks the files those tools produce. It does not launch a background worker or
establish that an external action succeeded. [Exact source follow](source-follow.md)
lets an agent expand a clipped memory excerpt before applying its constraints.

## Work-folder commands

Use the admitted CLI executable and argument prefix with these arguments:

```text
plan inspect --workdir <folder> --json
plan start --workdir <folder> --input research/inputs/start.json --json
ingest https://commonmark.org/ --workdir <folder> --json
plan checkpoint --workdir <folder> --input research/inputs/progress.json --expected <revision> --json
```

`start` takes `{goal, limits: [], nextAction}`. `checkpoint` accepts completed
steps, source paths and origins, output paths and their source dependencies,
unresolved items, status and next action. `plan --help` lists the exact fields.
Input JSON must already be inside the work folder and is limited to 64 KiB.

`ingest` returns both `original` and `source` file references with byte counts
and SHA-256 digests. Register both paths, using `source.origin`, then bind an
authored result to the originals and readable copies it used. Source files live
under `research/sources/`; authored results live under `research/results/`.
Repeated identical captures preserve existing bytes. Edited retained files are
refused rather than overwritten.

The current entry occupies one marked JSON section of root `plan.md`.
Surrounding user prose remains intact. Completed steps append, and writes require
the last observed revision. Cooperating writers use a lock and publish the whole
plan atomically. After an interruption or uncertain save, inspect before retrying;
an abandoned staging file is never the current plan.

## What verification means

Inspection returns the goal, limits, progress and next action plus a verification
state. Changed or missing sources/results and stale output dependencies produce
`needs-attention`. Completion requires a result, current local evidence and no
unresolved items. An agent must still assess whether the result satisfies the
goal: hashes establish file continuity, not factual correctness or remote effects.

One folder holds one current research plan. A different goal must be reconciled
with the owner before replacing the agreed destination. This first workflow is
bounded to 32 source files, 32 outputs and 64 completed steps; each referenced
file is at most 16 MiB. It is not a general task database.

## Scope and source limits

Explicit `--workdir` mode is independent of AIOS `--path` mode. It does not read,
write or sync ambient personal memory; mixed scope flags are refused. Saving
research into durable personal memory still needs explicit user authorization.

Work-folder URL ingestion accepts public HTTP(S), HTML/XHTML or plain UTF-8 text.
It rejects credentials, private/reserved destinations, compressed responses and
unsupported content. DNS answers and every redirect are checked, and each socket
uses a validated address. Fetching allows five redirects, at most 2 MiB and a
10-second default deadline spanning DNS through body delivery. `--timeout` can
set at most 120 seconds. A dry run checks URL syntax and literal destinations;
it makes no DNS or HTTP request and reports `network: not_checked`.

Extraction can omit material on dynamic or unusual pages. Inspect the retained
original when a claim needs it; a successful capture does not prove completeness.
Existing vault ingestion and the older AIOS plan mode retain their own behavior.
This change does not qualify every existing adapter or certify every agent host.
