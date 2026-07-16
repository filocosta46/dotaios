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
npx dotaios mcp status
npx dotaios mcp install --dry-run --agent claude
npx dotaios mcp install --dry-run --agent cursor
```

DotAIOS prints a local stdio configuration and a suggested client path. It does not edit the client configuration automatically. Restart the client after adding the configuration, then verify that the three tools are discoverable and invocable.

The adapter source can also be started directly from a repository checkout:

```bash
node packages/mcp/src/server.mjs --path ~/aios
```
