# Follow the source behind an excerpt

Briefs and search results are excerpts. When a task depends on a rule or detail
that may have been omitted, use the returned follow reference to inspect that
same source version. Following does not change memory or approve an action.

The visible brief carries readable provenance only — one `> Source: <path>
(excerpt; sha256:…)` line per excerpt. Its follow references are published beside
the projection in `contextSources`, so the fixed visible budget is never spent on
opaque locators. Read them from the JSON envelope:

```sh
dotaios brief --compact --memory shared --json   # contextSources[].follow
dotaios search --follow '<follow reference>' --memory shared --budget 6000 --json
```

Each `contextSources` entry names the `section` it belongs to (`identity`,
`priorities`, `currentWork`, `activeProject`), its `source`, its content
`version`, and either `follow` or a `reason`. Only sections that survived the
visible budget are listed, so a reference is never offered for text the caller
cannot see. Search results still print their `> Follow:` value in text output,
and an MCP caller obtains one from `search_aios` query results — the MCP
working-context result keeps its existing fixed metadata bound and is unchanged.

For project evidence, retain the selected project scope:

```sh
dotaios search 'release policy' --scope projects --memory project --project '<id>'
dotaios search --follow '<Follow value>' --memory project --project '<id>' --json
```

The optional MCP adapter uses its existing `search_aios` tool:

```json
{"follow":"<Follow value>","memory":"project","project":"<id>","budget":6000}
```

Query and follow are mutually exclusive. Follow accepts memory scope, project,
and budget; query scope, limit, and session filters are rejected. CLI follow
always emits the compact JSON envelope, including without `--json`. Query ranking
is unchanged; eligible context and project hits now print a `> Source:` and a
`> Follow:` line beneath the excerpt. `search <query> --json` is now rejected
rather than silently ignored.

## Read and continue

A successful response has `kind: "dotaios.source-evidence/v1"`, `status: "read"`,
the memory receipt, an AIOS-relative `source`, a content `version`, literal
`text`, `coverage`, `next`, and `budget`. Coverage is a half-open range
`{kind: "range", from, to, total, unit: "utf8-byte"}`. The first follow starts at
byte zero because a transformed excerpt does not establish literal coverage.
Pass `next` back as `follow` to continue. Each page advances on a UTF-8 boundary;
`next: null` means this source version has no remaining bytes. It does not mean
that the overall task or all sources are complete.

`budget.limit` covers the entire compact serialized JSON envelope, including
references and escaping; `budget.used` records its JavaScript string length.
The default is 6,000 characters, with a 3,530 minimum and 32,000 maximum. An
insufficient budget refuses rather than returning a non-advancing page.
Use each page to establish the task-relevant coverage you need; a larger startup
brief is not a substitute for reading the omitted source.

## Scope and limits

- Shared supports eligible Markdown under `context/`.
- Project supports eligible Markdown only under the currently selected portable
  `projects/<slug>/` directory. Selection must still resolve to the same stable
  project identity. A Shared reference cannot be replayed in Project or vice versa.
- Identity, priorities, and work context headers, plus project `README.md`, have
  a 1 MiB source ceiling. Other supported Markdown has a 4 MiB ceiling.
- Dotfiles, secret-shaped names, symlinks, traversal paths, and non-regular files
  remain excluded by the contained reader and shared search eligibility policy.
- Vault, sessions, JSONL memory streams, skills, references, plugins, binaries,
  external project folders, and provider results do not gain this follow contract.
  Their existing retrieval paths remain in place.

References are derived from the accepted source read, not from a later reread.
They are root-bound locators, not permission grants or portable permanent links.
Every follow rechecks scope and membership, then validates the exact file and
content version. Replacing the AIOS root or source invalidates its references.
An unrelated sibling edit between requests does not. The first implementation
rereads and hashes the entire bounded source for each page and keeps no store.

Working context and bounded MCP query responses admit an excerpt, its source
version, and its reference together. If the pair cannot fit, the producer omits
the item and retains its existing budget/coverage accounting. Query may inspect
a source larger than its follow ceiling; such an excerpt explicitly carries
`follow: null` and `reason: "source_too_large"`. Unsupported families have no
follow reference. Source evidence marks excerpts as `coverage.kind: "excerpt"`;
it never presents excerpt length as literal coverage.

## Refusals

`status: "off"` returns the Off receipt and notice with zero filesystem access.
`status: "refused"` returns no source text and a typed `reason`, such as
`invalid_reference`, `scope_mismatch`, `source_changed`, `source_unavailable`,
`project_unavailable`, `source_too_large`, `unsupported_text`, `unsafe_source`,
or `insufficient_budget`. Refresh discovery inside the current authorized scope
when source identity, contents, or membership has changed. CLI refusals exit 2.
The filesystem containment and concurrency limits documented in
[architecture.md](architecture.md) continue to apply.
