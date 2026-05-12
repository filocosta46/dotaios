# MCP Server

DotAIOS includes a local MCP server package for agent tools that speak Model Context Protocol.

The server is intentionally separate from the root CLI dependency story. It uses stdio, reads local DotAIOS files, and does not start a background daemon.

## Local Run

```bash
node packages/mcp/src/server.mjs --path ~/aios
dotaios-mcp --path ~/aios
```

Future published package shape:

```bash
npx @dotaios/mcp --path ~/aios
```

## Tools

- `read_context` — read one or all files under `context/`
- `search_memory` — search memory events, archives, and signals
- `search_vault` — search vault markdown files
- `search_aios` — search local DotAIOS scopes: memory, vault, context, skills, references, plugins, and projects when using `all`
- `google_status` — read Google Workspace connection and `gws` auth status
- `google_gmail_search` — read-only Gmail search through the approved DotAIOS wrapper
- `google_calendar_agenda` — read-only Calendar agenda through the approved DotAIOS wrapper
- `google_drive_search` — read-only Drive search through the approved DotAIOS wrapper
- `list_projects` — list local project folders
- `log_event` — append an approved structured event

## Client Config

Preview a config snippet:

```bash
npx dotaios mcp status
npx dotaios mcp install --dry-run --agent claude
npx dotaios mcp install --dry-run --agent cursor
```

DotAIOS prints the stdio config and a suggested client path. It does not edit client config automatically yet.

## Safety

- The server is local stdio only.
- It does not mutate MCP client config automatically.
- It exposes `log_event` as an explicit tool; clients should ask before durable memory writes.
- Google Workspace MCP tools are read-only and call fixed DotAIOS wrappers, never arbitrary `gws` commands.
- Write actions in Google Workspace still require explicit user approval outside MCP.
