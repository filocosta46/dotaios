# Optional MCP Adapter

DotAIOS includes an experimental local adapter for clients that support Model Context Protocol. It is not part of first-time setup. Supported local agents should use `AGENTS.md`, native workflow links, and `dotaios brief --compact` first.

The adapter is useful only when a local MCP-capable client cannot use those simpler paths. It does not let an ordinary browser chat open files on your computer.

## Safety boundary

- Local stdio transport only. No background daemon.
- Read-only. It cannot append memory, edit files, or run Google Workspace commands.
- Bounded output with explicit truncation metadata.
- Machine-specific paths are removed from returned search results.
- The selected AI provider may process any context returned to its client.

## Tools

The adapter exposes exactly these three read-only tool names:

- `read_working_context`: return the same bounded, project-filtered projection as `dotaios brief --compact`; accepts optional `project`, session `limit`, and character `budget`
- `search_aios`: search bounded local results by `query`, with optional `scope`, result `limit`, and character `budget`
- `resolve_skill`: match an `intent` to installed workflows, with an optional result `limit`

There are no compatibility aliases or additional MCP tools.

## Preview client configuration

```bash
npx dotaios@latest mcp status
npx dotaios@latest mcp install --dry-run --agent claude
npx dotaios@latest mcp install --dry-run --agent codex
npx dotaios@latest mcp install --dry-run --agent cursor
npx dotaios@latest mcp install --dry-run --agent gemini
npx dotaios@latest mcp install --dry-run --agent antigravity
npx dotaios@latest mcp install --dry-run --agent kimi
npx dotaios@latest mcp install --dry-run --agent opencode
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
