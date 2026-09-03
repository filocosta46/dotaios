# Optional MCP Adapter

DotAIOS includes an experimental local adapter for clients that support Model Context Protocol. It is not part of first-time setup. Supported local agents should use `AGENTS.md`, native workflow links, and `dotaios brief --compact` first.

The adapter is useful only when a local MCP-capable client cannot use those simpler paths. It does not let an ordinary browser chat open files on your computer.

## Safety boundary

- Local stdio transport only. No background daemon.
- Read-only. It cannot append memory, edit files, or run Google Workspace commands.
- Every tool accepts `memory: shared | project | off` and returns a visible
  memory receipt. Off returns before the configured AIOS folder is inspected.
  Project requires a selector and exposes only project files plus explicitly
  attributed session/event/signal evidence. Skills remain capabilities, but
  Off still avoids reading the AIOS skill catalog.
- Bounded canonical Markdown with explicit truncation metadata. Rendered
  operational notices and non-Markdown response metadata are separately capped
  at 1,024 characters.
- Machine-specific paths are removed from returned search results.
- Working-context project filters must be nonblank after trimming, contain no
  Unicode `Cc` control characters, and be at most 200 Unicode code points.
  Search project selectors use the narrower canonical slug/stable-ID contract:
  no separators, dot segments, controls, malformed Unicode, or surrounding
  whitespace. Supplied wrong-type, malformed, unknown, or ambiguous selectors
  are specific input errors rather than unscoped reads.
- Tool arguments are runtime-validated as the advertised object shape: integer
  fields are not coerced from strings or booleans, unknown keys are rejected,
  and error messages never echo an unbounded key.
- Working-context source work uses the same 16 MiB / 512-file projection budget
  and per-shelf file and directory limits documented in
  [Architecture](architecture.md). Internal read failures do not return absolute
  local paths.
- The selected AI provider may process any context returned to its client.

## Tools

The adapter exposes exactly these three read-only tool names:

- `read_working_context`: return the same bounded projection as `dotaios brief
  --compact`; accepts `memory`, optional `project`, session `limit`, and
  character `budget`
- `search_aios`: search bounded local results by `query`, with optional `scope`,
  canonical project `project`, result `limit`, and a complete-response character
  `budget` from 3,530 to 32,000 (default 6,000); project-only scope requires the
  selector, while all-scope search without it omits projects as selection metadata
- `resolve_skill`: match an `intent` to installed workflows, with `memory`, an
  optional project selector for a project-mode receipt, optional
  result `limit` and character `budget` from 256 to 32,000 (default 6,000);
  the complete serialized response, including budget metadata, stays within it

There are no compatibility aliases or additional MCP tools.
External project-source retrieval and finite consent remain CLI-only because
they publish machine-local receipts and require the same user's explicit shell
apply. Task text and MCP calls cannot approve a grant.

`search_aios` has a higher budget floor than the other two tools because its
smallest honest incomplete response must retain the full omission objects. The
3,530-character floor is mechanically derived from the closed field bounds,
the largest selectable response: eight Shared logical scopes (Project mode has
three). A public MCP fixture exercises that maximum set at the exact floor. A
budget from 256 through 3,529 is therefore a
specific input error for `search_aios`, while `read_working_context` and
`resolve_skill` continue to accept 256. Callers that do not need a custom limit
should omit `budget` and use the 6,000-character default.

This is an explicit compatibility correction: the full named omission schema
is retained instead of adding a second compact encoding whose recovery meaning
would depend on an out-of-band decoder. Clients that previously sent a
`search_aios` budget below 3,530 must raise it or omit it. A future incompatible
omission encoding requires a separately versioned contract rather than a silent
shape switch.

`search_aios` returns `complete: true` only when every selected logical scope
was inspected. A skippable resource ceiling returns valid results from admitted
scopes, `complete: false`, and the same logical omission records used by core and
the CLI; it remains a successful tool call with `isError: false`. Each omission
contains only `scope`, a closed `reason`, bounded `observed` counts,
`inspection` (`not_searched` or `partially_enumerated`), and a path-free
`recovery` code/message. The five ceiling reasons are `file_too_large`,
`directory_entries_exceeded`, `aggregate_bytes_exceeded`,
`file_count_exceeded`, and `entry_count_exceeded`. At most 32 omissions plus one
defensive `omissions_truncated` remainder are returned by the shared collector;
the current MCP policy can produce at most eight omissions in one call.
Linked or non-regular
evidence, unsafe paths, unauthorized roots, invalid UTF-8 or configuration,
observed mutation, and unexpected I/O remain failed tool calls.

The response `budget.truncated` flag describes only result transport truncation;
it never changes corpus `complete` or removes omission metadata. A complete
zero-hit search is `complete: true` with an empty `results` array.

For `read_working_context`, `budget` describes the canonical Markdown
working-context projection, not operational compatibility metadata. The
response keeps that Markdown unchanged in `markdown` and returns
`operational.migration` beside it with one of
four bounded states: `current`, `schema_outdated`, `transaction_present`, or
`inspection_failed`. Every state includes fixed `severity` and `action` fields;
the latter is either `null` or an object containing `command` and
`path_scope: "configured_aios"`. The command must be run against the same AIOS
folder configured for this adapter; no machine path is returned. A transaction
directory proves only that metadata is present, not that its writer is dead, so
the session-start envelope never instructs blind recovery.

The 1,024-character allowance is measured over non-`markdown` metadata, not the
JSON-encoded response. JSON escaping and protocol framing are representation
costs and are not subtracted from the canonical projection budget. A valid
bounded projection is never rejected merely because JSON escaping expands it.

## Preview client configuration

```bash
npx dotaios@2.0.19 mcp status
npx dotaios@2.0.19 mcp install --dry-run --agent claude
npx dotaios@2.0.19 mcp install --dry-run --agent codex
npx dotaios@2.0.19 mcp install --dry-run --agent cursor
npx dotaios@2.0.19 mcp install --dry-run --agent gemini
npx dotaios@2.0.19 mcp install --dry-run --agent antigravity
npx dotaios@2.0.19 mcp install --dry-run --agent kimi
npx dotaios@2.0.19 mcp install --dry-run --agent opencode
```

DotAIOS prints a client-specific local stdio fragment and the documented user
configuration path:

| Client | Suggested target | Output format |
|---|---|---|
| Claude Code | `~/.claude.json` | JSON |
| Codex | `~/.codex/config.toml` | TOML |
| Cursor | `~/.cursor/mcp.json` | JSON |
| Gemini CLI | `~/.gemini/settings.json` | JSON |
| Antigravity IDE | `~/.gemini/config/mcp_config.json` | JSON |
| Kimi Code CLI | `~/.kimi-code/mcp.json` | JSON |
| OpenCode | `~/.config/opencode/opencode.json` | JSON |

Merge the fragment into an existing configuration instead of replacing the
file. For OpenCode, `dotaios connect opencode` performs the same guarded merge
and refuses unrecognized same-name entries. DotAIOS does not edit other client
configurations automatically. Restart the
client after adding it, confirm that the server and its three tools appear,
then invoke one tool and record the returned value. A valid configuration file
proves configuration only. It does not prove the client invoked the server.

Generated fragments use a version-pinned `npx --package` launcher so they do
not retain a disposable npm cache path. The adapter source can also be started
directly from a repository checkout:

```bash
node packages/mcp/src/server.mjs --path ~/aios
```

See [Compatibility acceptance](compatibility-acceptance.md) for the release
evidence required before a client is described as tested.
