# Client Support

DotAIOS separates three different claims:

1. **Configured:** DotAIOS wrote or linked the expected local files.
2. **Discoverable:** the client can find those files through its documented native behavior.
3. **Invoked:** an acceptance test proved the client used the expected context or workflow.

A successful file write proves only configured. It does not prove that a particular client version invoked the file.

| Client | Context path in v1.24 | Skills path in v1.24 | Public claim |
|---|---|---|---|
| Claude Code | Global `~/.claude/CLAUDE.md` bridge | Global and project `skills/` links | Configured locally; verify invocation in the client |
| Codex | Global `~/.codex/AGENTS.md` bridge | Native shared Agent Skills links | Configured locally; verify invocation in the client |
| Gemini CLI | Global `~/.gemini/GEMINI.md` bridge | Native shared Agent Skills links | Configured locally; optional session hook has separate setup |
| Cursor | Project `AGENTS.md` and `.cursor/rules/dotaios.mdc` from `dotaios attach` | Project Agent Skills links | Configured locally; project-scoped invocation is not proven by the bounded probe |
| Antigravity | No always-on context bridge | Global and project `.gemini/config/skills` links; optional MCP | Documented adapter; requires an invocation receipt |
| Hermes | No always-on context bridge | `skills.external_dirs` in Hermes config | Documented adapter; requires a bounded read-only invocation receipt |
| Kimi Code CLI | No native DotAIOS bridge | Optional MCP through `.kimi-code/mcp.json` | Documented adapter; requires an MCP invocation receipt |
| Browser chats | No local filesystem access | No native local skill path | Attach files or paste a bounded brief explicitly |
| Kimi and Z.ai models | Host-specific | Host-specific | Model-through-host only; name and test the host |
| Other runtimes | Runtime-specific | Runtime-specific | Optional and experimental until proven |

Run `dotaios activate --dry-run` to preview global changes, `dotaios attach <project> --dry-run` for a project, and `dotaios skills doctor` for filesystem-level diagnostics. These checks remain honest about the difference between a configured path and an invoked workflow.

The 2026-07-16 bounded invocation receipts are committed under `docs/probes/`. Codex produced the probe marker. Claude Code and Gemini CLI were invoked but could not produce it in this environment because their clients rejected authentication/support-tier access; those receipts are evidence of the limitation, not a stronger claim.

The complete release matrix and required receipts are in
[Compatibility acceptance](compatibility-acceptance.md).
