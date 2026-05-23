# Session Digest Read Path Spec

> Status: draft for user review  
> Date: 2026-05-18  
> Applies after: `dotaios@1.14.5` save-session write path

## Summary

DotAIOS now has a write path for session memory: the `save-session` skill can create clean Markdown summaries with a structured digest block. The missing read path is a compact MCP tool that gives capable local agents recent decisions and open threads without loading raw session history.

Build this as a small, additive feature:

- parse `<!-- digest:start -->` / `<!-- digest:end -->` blocks from saved session Markdown
- assemble a short recent-session digest from the latest saved sessions
- expose it through a read-only MCP tool named `read_session_digest`
- tell MCP-capable agents in `AGENTS.md` to call it when continuity matters

This is not a browser-extension substitute. Web chat users still need paste/manual workflows until the browser extension exists.

## Goals

- Give MCP-capable agents quick continuity from recent session summaries.
- Prefer structured digest blocks written by `save-session`.
- Keep the digest deterministic, local, and zero-dependency.
- Avoid bulk-loading raw transcripts.
- Keep the implementation isolated from search scoring, `isoDate()`, ingest, and Google tools.

## Non-Goals

- No new CLI command.
- No automatic web-chat injection.
- No LLM summarization inside core or MCP.
- No changes to `search_aios`, `search_memory`, or session search ranking.
- No migration of old session files.
- No new dependency, database, or background indexer.

## Current State

- Session files live in `memory/sessions/YYYY-MM-DD/<timestamp>_<agent>_<id>.md`.
- `memory/sessions/index.jsonl` stores lightweight metadata.
- `save-session` summaries include a structured digest block:

```markdown
<!-- digest:start -->
decisions:
- <decision>
open_threads:
- <open thread>
<!-- digest:end -->
```

- Raw/manual imports may not contain a digest block.
- MCP currently exposes context, search, Google read tools, project listing, and event logging. It does not expose session digest retrieval.

## Proposed Design

### Core Session Helpers

Add the read-path helpers in `packages/core/src/sessions.mjs`. Keep them beside existing session index/file helpers so they can reuse `SESSIONS_SUBDIR`, `readSessionIndex()`, and path conventions.

New exports:

- `extractSessionDigestBlock(markdown)`
- `buildSessionDigest(aiosPath, options)`
- `touchSession(aiosPath, sessionId, options)`

`extractSessionDigestBlock(markdown)` returns:

```js
{
  found: true,
  decisions: ["..."],
  open_threads: ["..."]
}
```

If the block is missing or malformed, return:

```js
{
  found: false,
  decisions: [],
  open_threads: []
}
```

Parsing rules:

- Only read content between exact markers `<!-- digest:start -->` and `<!-- digest:end -->`.
- Recognize only two labels: `decisions:` and `open_threads:`.
- Collect `- ` bullets under the current label.
- Trim whitespace.
- Ignore empty bullets.
- Treat `None`, `None.`, and `None recorded.` as empty.
- Do not parse arbitrary YAML.
- Do not throw on malformed blocks; return best-effort parsed content.

`buildSessionDigest(aiosPath, options)` returns:

```js
{
  markdown: "<digest markdown>",
  sessions: [{ session_id, path }]
}
```

Options:

```js
{
  project?: string,
  limit?: number, // default 5, max 10
  now?: Date      // tests only
}
```

Selection rules:

- Read `memory/sessions/index.jsonl`. If the file does not exist, return an empty-state digest without throwing.
- Filter by exact `project` when provided.
- Sort by `captured_at` descending.
- Read at most `limit` existing session files.
- Skip missing or unreadable files.
- Prefer structured digest blocks.
- For sessions without a digest block, use a safe fallback:
  - include title, date, agent, project, and path
  - extract bullets from existing `## Key Decisions`, `## Action Items`, or `## Open Threads` sections if those headings exist
  - otherwise do not infer decisions or open threads from raw transcript text

Digest Markdown shape:

```markdown
# Recent Session Digest

Generated from <N> saved session(s).

## Recent Decisions

- <YYYY-MM-DD> — <title>: <decision>

## Open Threads

- <YYYY-MM-DD> — <title>: <open thread>

## Recent Sessions

- <YYYY-MM-DD> `<agent>` — <title> (`memory/sessions/...md`)
```

If no decisions or open threads exist, include one empty-state bullet in that section. Keep output under roughly 8 KB by limiting bullets per section to 20 and truncating individual bullets to 240 characters.

`touchSession(aiosPath, sessionId, options)` updates the matching index entry:

- `last_accessed`: ISO timestamp
- `access_count`: previous count + 1

Rules:

- Preserve every existing index field.
- If the session is missing, return `null` and do not throw.
- Use `now` option for tests.
- Do not use `access_count` for ranking in this version. Recency stays the only ranking input.

### MCP Tool

Add `read_session_digest` to `packages/mcp/src/server.mjs`.

Tool schema:

```js
{
  name: "read_session_digest",
  title: "Read Session Digest",
  description: "Read a compact digest of recent DotAIOS session decisions and open threads.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Optional exact project filter."
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 5
      }
    }
  }
}
```

Call behavior:

1. Validate AIOS folder with existing `assertAios()`.
2. Validate `limit` as integer 1-10.
3. Pass optional `project` and `limit` to `buildSessionDigest()`.
4. Call `touchSession()` for every returned session id.
5. Return the digest Markdown directly as MCP text content.

Do not return JSON for the digest body. The tool exists to give the agent ready-to-read context.

### AGENTS.md Instruction

Add a short instruction to `templates/AGENTS.md.hbs` under `## Memory Routing`:

```markdown
- If MCP tools are available and the task depends on recent continuity, call
  `read_session_digest` once before searching or opening session files. Do not
  bulk-load `memory/sessions/`.
```

Keep it conditional. Simple tasks should not force a session-digest call.

### Docs

Update `docs/sessions.md` with one short paragraph:

- MCP-capable local agents can call `read_session_digest` to read recent decisions/open threads.
- Web chat still uses `save-session` fallback or manual paste until browser extension support exists.

No README expansion is required unless user testing shows confusion.

## Test Plan

### Core Tests

Add tests in `tests/core/sessions.test.mjs`:

- `extractSessionDigestBlock()` parses decisions and open threads from a valid block.
- Missing digest block returns `found: false` and empty arrays.
- Malformed digest block does not throw.
- `buildSessionDigest()` uses structured digest blocks before fallback content.
- `buildSessionDigest()` filters by project and respects `limit`.
- `buildSessionDigest()` skips missing files but still returns a valid empty-state digest.
- `touchSession()` increments `access_count` and sets `last_accessed`.
- `touchSession()` preserves existing index fields.
- `touchSession()` returns `null` for unknown session id.

### MCP Tests

Update `tests/mcp/server.test.mjs`:

- Tool list includes `read_session_digest`.
- Calling `read_session_digest` returns Markdown containing a seeded decision/open thread.
- The call updates `last_accessed` and `access_count` in `memory/sessions/index.jsonl`.
- Invalid `limit` values fail with `-32602`.

### Template Tests

Add or extend a render/init test:

- Generated `AGENTS.md` mentions `read_session_digest`.
- The instruction says not to bulk-load `memory/sessions/`.

### Regression Checks

Run:

```bash
node --test tests/**/*.test.mjs
npm pack --dry-run
npm run smoke
```

Expected result: all tests pass; npm package contents unchanged except source/docs/test edits.

## Implementation Plan

1. Add digest parsing helpers and tests first.
2. Add `buildSessionDigest()` with project/limit filtering and tests.
3. Add `touchSession()` with tests.
4. Add MCP tool and update MCP tests.
5. Add the conditional `AGENTS.md` instruction and template test.
6. Add the short docs note.
7. Run full validation.

Keep each commit narrow:

- core digest helpers
- MCP tool
- template/docs

Do not revive PR #1. Start from current `main`.

## Acceptance Criteria

- MCP-capable agents can call `read_session_digest` and receive compact Markdown.
- The digest prefers structured `save-session` blocks.
- Raw transcripts are not summarized heuristically beyond explicit headings.
- Session access metadata updates only after the MCP read tool returns sessions.
- Generated `AGENTS.md` guides agents to use the tool conditionally.
- No search, ingest, date, Google, or CLI behavior changes.
- Full tests pass.

## Risks And Mitigations

- **Risk: agents over-call the tool.** Mitigation: AGENTS instruction says only when recent continuity matters.
- **Risk: digest becomes noisy.** Mitigation: use structured blocks first; cap sessions, bullets, and text length.
- **Risk: fallback invents decisions.** Mitigation: no inference from raw transcript prose.
- **Risk: access metadata changes ranking accidentally.** Mitigation: explicitly keep recency-only ranking in this version.
- **Risk: web-chat users think this solves injection.** Mitigation: docs state this is MCP-only and browser extension remains separate.

## Self-Review

- **Issue found:** Original brainstorm implied calling `read_session_digest` at every session start.  
  **Fix applied:** Spec makes the AGENTS instruction conditional on recent-continuity needs.

- **Issue found:** Original stale PR scored sessions with `access_count`, creating ranking feedback risk.  
  **Fix applied:** Spec records `access_count` but forbids using it for ranking in v1.

- **Issue found:** Fallback heuristics could hallucinate decisions from raw transcripts.  
  **Fix applied:** Spec allows fallback only from explicit headings and session metadata.

- **Issue found:** Returning JSON from MCP makes the agent do extra parsing.  
  **Fix applied:** Spec returns ready-to-read Markdown as MCP text content.

- **Issue found:** Read-path work could sprawl into browser extension or CLI scope.  
  **Fix applied:** Spec explicitly excludes CLI, browser injection, search changes, and migrations.
