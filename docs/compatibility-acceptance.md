# Compatibility Acceptance

DotAIOS supports agent hosts, not every model or chat product. A support claim
must identify the host that reads local files or invokes the MCP server.

## Evidence levels

Every client is measured at three separate levels:

1. **Configured:** DotAIOS wrote, linked, or printed the expected client files.
2. **Discoverable:** the client's current official documentation says it can
   discover that path or MCP server.
3. **Invoked:** a fresh acceptance run used a unique marker from the generated
   context, a linked skill, or a deterministic MCP tool result.

Configured is never a synonym for invoked. Manual file upload or pasted text is
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
| Cursor | Project `AGENTS.md`, `.cursor/rules/dotaios.mdc`, project skill links | Open the attached project and confirm the rule is active | Ask a fresh project agent to return a disposable marker; preserve the transcript or screenshot |

The live probe requires the relevant client to be installed and authenticated.
An authentication or entitlement failure is a limitation receipt, not a pass.

### Tier 2: documented adapter, receipt required

These hosts have a documented path, but DotAIOS does not yet claim the same
automated invocation coverage as Tier 1.

| Host | Adapter | Required acceptance evidence |
|---|---|---|
| Antigravity | Skills under `.gemini/config/skills`; optional MCP in `~/.gemini/config/mcp_config.json` | Confirm the skill or MCP server appears, then return a unique skill marker or deterministic `read_working_context` value |
| Hermes | `skills.external_dirs` in `.hermes/config.yaml` | Start a fresh bounded session with a read-only toolset and invoke a disposable project skill |
| Kimi Code CLI | Optional MCP in `~/.kimi-code/mcp.json` | Confirm the `dotaios` MCP server and three tools appear, then invoke one tool and preserve the output |

Use `dotaios mcp install --dry-run --agent <client>` for the client-specific
MCP fragment. The command does not edit client configuration.

### Manual context only

Ordinary ChatGPT, Claude, Gemini, Kimi, or other browser chats cannot read a
local `~/aios` folder by themselves. Generate `dotaios brief --compact`, attach
or paste it, and label the result manual context supplied.

A hosted product with an explicitly configured remote connector is a different
integration and must be tested under that connector's own security and approval
model. The local stdio adapter is not remotely reachable.

### Model through host only

Kimi models and Z.ai GLM models are model providers, not shared-context
integration surfaces by themselves. Name the compatible host that runs the
model, such as Kimi Code CLI, Claude Code, Cline, or OpenCode. Do not claim
native Z.ai or GLM support without a tested host-level path.

## Release gate

For every client named in launch copy:

1. Record the client version and operating system.
2. Record configured paths or the MCP configuration hash.
3. Link the official documentation that establishes discoverability.
4. Run a fresh unique-marker or deterministic-tool invocation.
5. Store the receipt with `configured`, `discoverable`, and `invoked` separate.
6. Downgrade the public claim when the invocation cannot be reproduced.

Current official references:

- Claude Code memory and MCP:
  <https://code.claude.com/docs/en/memory> and
  <https://code.claude.com/docs/en/mcp>
- Codex instructions, skills, and MCP:
  <https://developers.openai.com/codex/guides/agents-md>,
  <https://developers.openai.com/codex/skills>, and
  <https://learn.chatgpt.com/docs/extend/mcp>
- Gemini CLI context and MCP:
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md>
  and
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md>
- Cursor rules and MCP:
  <https://cursor.com/docs/rules> and <https://cursor.com/docs/mcp>
- Antigravity plugins and MCP:
  <https://antigravity.google/docs/plugins> and
  <https://antigravity.google/docs/mcp>
- Kimi Code CLI plugins and MCP:
  <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html>
  and
  <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html>
