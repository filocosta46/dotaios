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
| Gemini CLI | Global `~/.gemini/GEMINI.md` bridge | Native shared Agent Skills links | Configured locally; individual accounts now hit `IneligibleTierError` since Google ended Gemini Code Assist for individuals |
| Cursor (global) | No always-on context bridge | Global shared Agent Skills links | Configured locally; verify invocation in the client |
| Cursor (project) | Project `AGENTS.md` from `dotaios attach` | Project Agent Skills links | Configured locally; project-scoped production is not proven by the bounded probe |
| Antigravity IDE | No always-on context bridge | Global `.gemini/config/skills`, project `.agents/skills`; optional MCP | Documented adapter; requires an invocation receipt |
| Hermes | No always-on context bridge | Global `skills.external_dirs` in `~/.hermes/config.yaml`; no project-local adapter | Global configuration adapter only; invocation remains unverified |
| Grok | No always-on context bridge | Global and project `~/.grok/skills` links; also reads `~/.agents/skills` and `~/.claude/skills` natively | Configured locally; verify invocation in the client |
| Kimi Code CLI | No Kimi-specific DotAIOS instruction bridge | Native shared `.agents/skills`; optional MCP through `.kimi-code/mcp.json` | Configured and documented; requires an invocation receipt |
| OpenCode | Global `~/.config/opencode/AGENTS.md`, the instructions file OpenCode documents | Native shared `.agents/skills`; optional MCP through `~/.config/opencode/opencode.json` | Configured and documented; requires an invocation receipt |
| Browser chats | No local filesystem access | No native local skill path | Attach files or paste a bounded brief explicitly |
| Kimi and Z.ai models | Host-specific | Host-specific | Model-through-host only; name and test the host |
| Other runtimes | Runtime-specific | Runtime-specific | Optional and experimental until proven |

Run `dotaios activate --dry-run` to preview global changes, `dotaios attach <project> --dry-run` for a project, and `dotaios skills doctor` for filesystem-level diagnostics. These checks remain honest about the difference between a configured path and an invoked workflow.

Bounded invocation receipts are committed under `docs/probes/`. On 2026-08-30,
Codex 0.149.1 produced the project-native probe marker from a disposable fresh
project root containing `AGENTS.md` and a repository skill. The receipt keeps
the client warnings as a limitation rather than hiding them. On 2026-08-08,
Claude Code 2.1.220 also produced its marker with `exitCode: 0`; the earlier
2026-07-16 Claude Code and Gemini CLI attempts were blocked by authentication
or support-tier access. Each receipt records what happened in one environment,
not a stronger claim.

The complete release matrix and required receipts are in
[Compatibility acceptance](compatibility-acceptance.md).

Hermes project-local support is intentionally absent. Hermes loads the config
selected by `HERMES_HOME`; `dotaios attach` does not own that selector, and the
bounded probe therefore reports project configuration and discovery as `no`
instead of blessing an inert `<project>/.hermes/config.yaml`.
