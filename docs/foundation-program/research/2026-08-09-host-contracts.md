# Supported-Host Contract Study

Date: 2026-08-09
Status: official-source synthesis; public support still requires live receipts

## Research receipt

The bounded six-host source report is preserved at:

`/Users/filo/aios/vault/research/deep/2026-08-09-as-of-august-2026-what-are-the-official-current-native-contr.md`

Its automated synthesis failed, but every host lane retained cited raw findings from official documentation, repositories, schemas, and release notes.

## One evidence ladder

Every host claim uses the same ordered states:

1. **configured** — DotAIOS wrote a documented host surface;
2. **discoverable** — the host reports that surface through its own inspection command/event;
3. **invoked** — a bounded host run actually selected or called it;
4. **produced** — the run returned the unique expected evidence/result.

Only `produced` supports a public “works with” claim. File presence, a valid schema, or an installed binary is not enough.

## Honest host tiers

| Host | Official portable context | Official project workflow surface | Bounded evidence surface | Honest Foundation tier before a fresh receipt |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` / `.claude/CLAUDE.md`; can import `AGENTS.md`; project rules | `.claude/skills/<name>/SKILL.md`; `.claude/commands`; project `.mcp.json` with trust | `claude -p` JSON/stream JSON, schema, max turns, init/MCP events | Eligible for validated context + skills; MCP remains trust-gated. |
| OpenAI Codex | hierarchical `AGENTS.md` / overrides, default combined cap 32 KiB | repository `.agents/skills`; trusted `.codex/config.toml` for MCP/safe defaults | `codex exec --json --output-schema`; prompt-input/debug evidence | Eligible for validated context + skills; project config remains trust-gated and version-pinned. |
| Gemini CLI | hierarchical `GEMINI.md`; project settings can include `AGENTS.md` in context filenames | workspace `.gemini/skills` or `.agents/skills` with trust/activation consent; project commands/MCP settings | headless JSON with model/tool stats and file deltas; `/memory` and `/mcp` inspection | Eligible for validated context + skills after preservation fix and fresh receipt; skill activation is consented, not automatic. |
| Cursor | root/subdirectory `AGENTS.md`; optional `.cursor/rules/*.mdc` | `.agents/skills` / `.cursor/skills`; project `.cursor/mcp.json` | CLI print JSON/stream JSON plus hook events | Documented-compatible context + skills until a fresh produced receipt. Do not imply plugins/team/cloud integration. |
| OpenCode | hierarchical `AGENTS.md`; project `opencode.json` instructions | `.opencode/skills` / `.agents/skills` in moving V2; project commands/MCP config | `opencode run --format json`, session/export events | Experimental/advanced adapter until version-pinned discovery and produced receipts pass. |
| Hermes Agent | `AGENTS.md` and other context types with one winning precedence chain | official docs prove installed `~/.hermes/skills`, not arbitrary repo-local skill discovery; MCP is profile-level | `hermes -z` or quiet one-shot with usage JSON | Portable-context only. Project-skill and DotAIOS MCP support are unproven until adapter semantics and a real receipt pass. |

## Product consequences

- The common portable denominator is a short committed instruction file, usually `AGENTS.md`, plus host-native project skill directories where official support exists.
- Startup instructions are context, not enforcement. Trust, approvals, hook policy, tool exposure, and MCP permission are host-specific.
- The first-slice acceptance must test the same user job through the core seam and at least one fresh host; adapter tests may not redefine selection or budgets.
- A host probe must reproduce production path normalization and configuration scope. The current Hermes probe does not.
- Cursor and OpenCode can be documented as compatible before they are publicly validated, but they cannot share the same badge/wording as a produced host.
- Gemini support cannot be reconciled from the iMac branch alone because the live remote contains the unique user-file preservation fix.

## Primary sources

- Claude Code: [memory](https://docs.anthropic.com/en/docs/claude-code/memory), [skills](https://docs.anthropic.com/en/docs/claude-code/skills), [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp), [headless](https://docs.anthropic.com/en/docs/claude-code/headless)
- OpenAI Codex: [AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [skills](https://developers.openai.com/codex/skills), [MCP](https://developers.openai.com/codex/mcp), [non-interactive mode](https://developers.openai.com/codex/noninteractive)
- Gemini CLI: [context files](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html), [skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md), [MCP](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html), [headless](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html)
- Cursor: [rules](https://cursor.com/docs/rules), [skills](https://cursor.com/docs/skills), [MCP](https://cursor.com/docs/mcp), [headless CLI](https://cursor.com/docs/cli/headless)
- OpenCode: [instructions](https://opencode.ai/v2/docs/instructions), [skills](https://opencode.ai/v2/docs/skills), [CLI](https://opencode.ai/docs/cli/)
- Hermes: [context files](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files), [skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills), [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [CLI](https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
