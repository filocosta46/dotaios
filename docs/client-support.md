# Client Support

DotAIOS separates four different claims:

1. **Configured:** DotAIOS wrote or linked the expected local files.
2. **Discoverable:** the client can find those files through its documented native behavior.
3. **Invoked:** the bounded probe launched the client process, which may still fail.
4. **Produced:** the client returned the unique marker or deterministic result that proves use of the expected context or workflow.

A successful file write proves only configured. Public support requires a reproducible receipt with `produced=yes`.

| Client | Context path | Skills or MCP path | Public claim |
|---|---|---|---|
| Claude Code | Global `~/.claude/CLAUDE.md` bridge | Global and project `skills/` links | Configured locally; verify invocation in the client |
| Codex | Global `~/.codex/AGENTS.md` bridge | Native shared Agent Skills links | Configured locally; verify invocation in the client |
| Gemini CLI | Global `~/.gemini/GEMINI.md` bridge | Native shared Agent Skills links | Configured locally; optional session hook has separate setup |
| Cursor | Project `AGENTS.md` from `dotaios attach` | Project Agent Skills links | Configured locally; project-scoped production is not proven by the bounded probe |
| Antigravity IDE | No always-on context bridge | Global `.gemini/antigravity/skills`, project `.agents/skills`; optional MCP | Documented adapter; requires an invocation receipt |
| Hermes | No always-on context bridge | `skills.external_dirs` in Hermes config | Documented adapter; requires a bounded read-only invocation receipt |
| Kimi Code CLI | No Kimi-specific DotAIOS instruction bridge | Native shared `.agents/skills`; optional MCP through `.kimi-code/mcp.json` | Configured and documented; requires an invocation receipt |
| OpenCode | No always-on context bridge | Native shared `.agents/skills`; optional MCP through `~/.config/opencode/opencode.json` | Configured and documented; requires an invocation receipt |
| Browser chats | No local filesystem access | No native local skill path | Attach files or paste a bounded brief explicitly |
| Kimi and Z.ai models | Host-specific | Host-specific | Model-through-host only; name and test the host |
| Other runtimes | Runtime-specific | Runtime-specific | Optional and experimental until proven |

Run `dotaios activate --dry-run` to preview global changes, `dotaios attach <project> --dry-run` for a project, and `dotaios skills doctor` for filesystem-level diagnostics. These checks remain honest about the difference between a configured path and an invoked workflow.

The 2026-07-16 bounded invocation receipts are committed under `docs/probes/`. Codex produced the probe marker. Claude Code and Gemini CLI processes were invoked but could not produce it in this environment because their clients rejected authentication or support-tier access. Those receipts are evidence of the limitation, not a stronger claim.

The complete release matrix and required receipts are in
[Compatibility acceptance](compatibility-acceptance.md).
