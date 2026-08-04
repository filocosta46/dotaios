# Compatibility Acceptance

DotAIOS supports agent hosts, not every model or chat product. A support claim
must identify the host that reads local files or invokes the MCP server.

## Evidence levels

Every client is measured at four separate levels:

1. **Configured:** DotAIOS wrote, linked, or printed the expected client files.
2. **Discoverable:** the client's current official documentation says it can
   discover that path or MCP server.
3. **Invoked:** the bounded probe launched the client process. The process may
   still fail because of authentication, entitlement, or another client error.
4. **Produced:** the client returned the unique marker from the generated
   context, linked skill, or deterministic MCP tool result.

Configured is never a synonym for produced. Public support requires a
reproducible receipt with `produced=yes`. Manual file upload or pasted text is
reported as manual context supplied, never connected.

## Release tiers

### Tier 1: native context, release-tested

These hosts have first-class DotAIOS context paths. A release may name them as
tested only when the current release has a fresh invocation receipt.

| Host | Configured surface | Discoverability check | Invocation check |
|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md`, global and project skill links | Start a fresh session and confirm `/context` lists the DotAIOS memory file | Run `dotaios skills probe --client claude-code --run --json`; pass only when `produced=yes` |
| Codex | `~/.codex/AGENTS.md`, `.agents/skills` | Start from a disposable project and inspect the loaded instruction chain | Run `dotaios skills probe --client codex --run --json`; pass only when `produced=yes` |
| Gemini CLI | `~/.gemini/GEMINI.md`, `.agents/skills` | Run `/memory show` in a fresh session and confirm the DotAIOS bridge | Run `dotaios skills probe --client gemini --run --json`; pass only when `produced=yes` |
| Cursor | Project `AGENTS.md`, project skill links | Open the attached project and confirm the root instructions are active | Ask a fresh project agent to return a disposable marker; preserve the transcript or screenshot |

The live probe requires the relevant client to be installed and authenticated.
An authentication or entitlement failure is a limitation receipt, not a pass.

### Tier 2: documented adapter, receipt required

These hosts have a documented path, but DotAIOS does not yet claim the same
automated invocation coverage as Tier 1.

| Host | Adapter | Required acceptance evidence |
|---|---|---|
| Antigravity IDE | Global skills under `~/.gemini/antigravity/skills`, project skills under `.agents/skills`; optional MCP in `~/.gemini/config/mcp_config.json` | Confirm the skill or MCP server appears, then return a unique skill marker or deterministic `read_working_context` value |
| Hermes | `skills.external_dirs` in `.hermes/config.yaml` | Start a fresh bounded session with a read-only toolset and invoke a disposable project skill |
| Kimi Code CLI | Shared `~/.agents/skills`; optional MCP in `~/.kimi-code/mcp.json` | Confirm a DotAIOS skill or the `dotaios` MCP server appears, then invoke one and preserve the output |
| OpenCode | Shared `~/.agents/skills`; optional MCP at `mcp.dotaios` in `~/.config/opencode/opencode.json` | Confirm the skill or MCP server appears, invoke one deterministic DotAIOS capability, and preserve the output |

Use `dotaios mcp install --dry-run --agent <client>` for the client-specific
MCP fragment, including OpenCode. The command does not edit client
configuration. `dotaios connect opencode --dry-run` previews the managed
OpenCode setup instead.

### Manual context only

Ordinary ChatGPT, Claude, Gemini, Kimi, or other browser chats cannot read a
local `~/aios` folder by themselves. Generate `dotaios brief --compact`, attach
or paste it, and label the result manual context supplied.

A hosted product with an explicitly configured remote connector is a different
integration and must be tested under that connector's own security and approval
model. The local stdio adapter is not remotely reachable.

### Model through host only

Kimi K2, Kimi K3, and Z.ai GLM are models, not shared-context integration
surfaces by themselves. Moonshot AI or Kimi and Z.ai are providers. Name the
compatible host that runs the model, such as Kimi Code CLI, Claude Code, Cline,
Hermes, or OpenCode. Do not claim native K3, Z.ai, or GLM support without a
tested host-level path.

## Release gate

For every client named in launch copy:

1. Record the client version and operating system.
2. Record configured paths or the MCP configuration hash.
3. Link the official documentation that establishes discoverability.
4. Run a fresh unique-marker or deterministic-tool invocation.
5. Store the receipt with `configured`, `discoverable`, `invoked`, and
   `produced` separate.
6. Downgrade the public claim when `produced=yes` cannot be reproduced.

Official sources, last reviewed 2026-07-28:

- Claude Code memory, skills, and MCP:
  <https://code.claude.com/docs/en/memory>,
  <https://code.claude.com/docs/en/skills>, and
  <https://code.claude.com/docs/en/mcp>
- Codex instructions, skills, and MCP:
  <https://developers.openai.com/codex/guides/agents-md.md>,
  <https://developers.openai.com/codex/skills.md>, and
  <https://developers.openai.com/codex/mcp.md>
- Gemini CLI context, skills, and MCP:
  <https://geminicli.com/docs/cli/gemini-md/>,
  <https://geminicli.com/docs/cli/skills/>, and
  <https://geminicli.com/docs/tools/mcp-server/>
- Cursor rules, skills, and MCP:
  <https://cursor.com/docs/rules>,
  <https://cursor.com/docs/skills>, and
  <https://cursor.com/docs/mcp>
- Antigravity IDE skills and MCP:
  <https://antigravity.google/docs/ide/skills> and
  <https://antigravity.google/docs/mcp>
- Kimi Code CLI instructions, skills, and MCP:
  <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html>,
  <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html>,
  and
  <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html>
- OpenCode skills and MCP:
  <https://opencode.ai/docs/skills/> and
  <https://opencode.ai/docs/mcp-servers/>
- Kimi K3 and Z.ai provider-through-host evidence:
  <https://platform.kimi.ai/docs/guide/kimi-k3-quickstart.md> and
  <https://docs.z.ai/devpack/quick-start.md>
