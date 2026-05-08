# DotAIOS v1.1 — Architecture & Roadmap Audit

You are auditing the DotAIOS project — an open-source CLI tool that scaffolds local-first personal context for AI agents. Think "dotfiles for AI." The package `dotaios` is live on npm. The repo is public at https://github.com/filocosta46/dotaios.

Your job is to critically evaluate the v1.1 roadmap, the architectural decisions, and the research that informed them. Prioritize efficiency, simplicity, and alignment with the project's core values. Push back on anything that adds complexity without clear value.

## Step 1 — Understand the current system

Read these files in order:

1. `docs/session-handoff.md` — current release state
2. `package.json` — root package, published to npm
3. `packages/cli/src/index.mjs` — CLI entry point (4 commands: init, status, ingest, install)
4. `packages/core/src/paths.mjs` — path utilities
5. `packages/core/src/schema.mjs` — schema versioning
6. `packages/core/src/memory.mjs` — memory primitives
7. `packages/core/src/manifest.mjs` — plugin manifest validator
8. `packages/cli/src/commands/init.mjs` — the main scaffolding command
9. `packages/cli/src/commands/status.mjs` — health check
10. `packages/cli/src/commands/ingest.mjs` — file ingestion
11. `packages/cli/src/commands/install.mjs` — plugin installer
12. `templates/CLAUDE.md.hbs` — agent entrypoint template
13. `skills/plan-today/SKILL.md` — example skill
14. `skills/audit/SKILL.md` — example skill
15. `README.md` — public-facing docs
16. `scripts/smoke.mjs` — the only test

## Step 2 — Read the product vision

17. `docs/reference/aios-product-brief-v2.md` — the consolidated product plan
18. `docs/reference/dotaios-codex-audit.md.resolved` — previous Codex audit of the v1 codebase
19. `docs/reference/dotaios-release-handoff-2026-05-07.md` — release checkpoint

## Step 3 — Read the external research

These reference materials inspired the v1.1 roadmap:

20. `docs/reference/chase-agentic-os.md` — Chase Hannegan's Agentic OS architecture (Claude Code-specific, Streamlit dashboard, skill-creator workflow)
21. `docs/reference/openclaw-gog-skill.md` — historical OpenClaw skill format for `gog` (Google Workspace CLI). Note the YAML frontmatter structure; current beta implementation uses `gws`.
22. `docs/reference/ontology-essay.md` — essay on semantics, ontology, and the "one substrate, many lenses" model for agent memory
23. Also review these repos (read their READMEs):
    - https://github.com/zilliztech/claude-context — semantic code search MCP (10.8k stars, requires Zilliz Cloud + OpenAI API key)
    - https://github.com/zilliztech/memsearch — cross-agent persistent memory backed by markdown + Milvus (1.6k stars, Python, 558MB ONNX model)
    - https://github.com/safishamsi/graphify — knowledge graph skill for AI agents (44k stars, Python, produces GRAPH_REPORT.md + graph.json)
    - https://github.com/anthropics/financial-services — Anthropic's official plugin/skill architecture for financial services (11k stars, file-based agents + skills + MCP connectors)

## Step 4 — Evaluate the proposed v1.1 plan

Three planning documents were produced by the previous agent (Antigravity/Claude). Read all:

24. `docs/v1.1-scope.md` — the v1.1 milestone scope: `aios context`, `aios upgrade`, `aios cleanup`, unit tests, docs expansion
25. `docs/memory-system-evaluation.md` — deep evaluation of memsearch, claude-context, and Chase OS against DotAIOS values. Proposes MCP server, context router, progressive retrieval layers.
26. `docs/research-round-2.md` — second research round evaluating graphify, gog skill, Anthropic FSI, and the ontology essay. Proposes:
    - YAML frontmatter for skills (from OpenClaw/graphify/Anthropic patterns)
    - A `CONTEXT_SUMMARY.md` pre-computed context router (from graphify's GRAPH_REPORT pattern)
    - Structured event schema with `domain`, `project`, `entity` fields (from ontology essay)
    - Domain-aware routing (domains as active lenses, not passive files)
    - An MCP server (`@dotaios/mcp`) as the universal tool layer for cross-agent search/write
    - SQLite FTS5 search index for vault-scale retrieval (v2.0)
    - external Google Workspace CLI as the recommended Google integration pattern instead of building googleapis ourselves; current beta path uses `gws`

## Step 5 — Your audit

Answer these questions with specific, actionable feedback. Be critical. Say what's wrong, not just what's right.

### A. Architecture audit

1. Is the current v1.0 codebase clean? Any code smells, unnecessary abstractions, or missing patterns?
2. Is the monorepo structure (root publishes, internal packages are private) the right call, or should this be a single-package CLI?
3. The CLI hand-rolls arg parsing and prompts (no commander, no inquirer). Is this sustainable for 7+ commands, or should v1.1 introduce a lightweight parser?
4. Are there any security concerns in the current file operations (init, ingest, install)?

### B. Roadmap prioritization

5. The proposed v1.1 adds 3 new commands (context, upgrade, cleanup). Is this the right priority order? Would you cut or reorder anything?
6. The research proposes YAML frontmatter for skills, a CONTEXT_SUMMARY.md router, structured event schemas, and domain-aware routing — all for v1.1. Is this scope creep? What should move to v1.2?
7. The MCP server is proposed for v1.2. Should it be v1.1 instead? The argument: MCP is the only way to make DotAIOS useful in Codex, Gemini CLI, and Cursor (they can't read CLAUDE.md from ~/.aios/).
8. Is the current `gws`-backed `dotaios connect google` beta path enough for friend testing, or should DotAIOS still plan a custom googleapis plugin later?

### C. Memory system

9. The current memory model is: context/ (always loaded) + memory/ (last 50 events, today+yesterday signals) + vault/ (on demand). The routing is static rules in CLAUDE.md. Is this sufficient, or does it need the proposed enhancements (context summary, structured events, domain routing)?
10. The ontology essay argues for "one substrate, many lenses." The proposed implementation is `context/domains/` as active routing filters. Is this the right translation of that concept, or is it overengineered for a personal tool?
11. The CONTEXT_SUMMARY.md idea (a pre-computed summary the agent reads first) — is this genuinely useful, or is it just another file that gets stale?

### D. Cross-agent compatibility

12. DotAIOS currently generates CLAUDE.md, AGENTS.md, and .cursorrules. Is this the right approach for agent universality, or is there a simpler way?
13. The MCP server would expose: search_memory, search_vault, log_event, get_context, list_projects. Is this the right tool surface, or is it too much / too little?

### E. What's missing?

14. What did the research miss? Are there patterns, tools, or architectural decisions the previous agent should have considered?
15. What's the single highest-leverage thing DotAIOS could ship in v1.1 that wasn't proposed?

## Constraints to respect

- **Local-first**: No cloud dependencies, no accounts, no servers in the core
- **Zero-dep core**: The published npm package has zero runtime dependencies. This is intentional.
- **Agent-universal**: Must work identically across Claude Code, Codex, Gemini CLI, Cursor, and any future agent
- **File-based**: Markdown and JSONL, not databases (unless optional)
- **Human-controlled**: Identity and knowledge writes require explicit human approval

## Output format

Structure your response as:

```
## Verdict: [one-line summary]

## Architecture: [pass/concerns/fail per item]
## Roadmap: [what to keep, cut, reorder]
## Memory: [what works, what's overengineered]  
## Cross-agent: [assessment]
## Missing: [what was overlooked]

## Recommended v1.1 scope (your version)
[concrete list of what to ship, in priority order]
```

Be direct. No filler. If something is good, say it in one line and move on. Spend your words on what needs to change.
