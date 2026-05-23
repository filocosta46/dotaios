# Session Digest Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `read_session_digest` MCP tool that gives local agents a compact, token-efficient digest of recent session decisions and open threads.

**Architecture:** Three new exports in `packages/core/src/sessions.mjs` (`extractSessionDigestBlock`, `buildSessionDigest`, `touchSession`) feed a new `read_session_digest` tool in `packages/mcp/src/server.mjs`. The template `templates/AGENTS.md.hbs` gains a conditional two-line instruction under `## Memory Routing`. All reads prefer structured `<!-- digest:start/end -->` blocks written by the `save-session` skill; fallback extracts bullets from explicit headings only.

**Tech Stack:** Node 20 ESM, zero new dependencies, `node:test` + `node:assert/strict` for tests.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/sessions.mjs` | Modify | Add `extractSessionDigestBlock`, `buildSessionDigest`, `touchSession`, private `extractHeadingBullets` |
| `tests/core/sessions.test.mjs` | Modify | Add 9 tests for the 3 new exports |
| `packages/mcp/src/server.mjs` | Modify | Import new exports, add `read_session_digest` to `callTool` dispatch, `tools()` list, and `readSessionDigest` method |
| `tests/mcp/server.test.mjs` | Modify | Update existing tool-list assertion, add 4 new tests for `read_session_digest` |
| `templates/AGENTS.md.hbs` | Modify | Add conditional `read_session_digest` instruction under `## Memory Routing` |
| `docs/sessions.md` | Modify | Add one paragraph about the MCP read path |

---

### Task 1: `extractSessionDigestBlock()`

Parse structured `<!-- digest:start/end -->` blocks from session Markdown.

**Files:**
- Modify: `packages/core/src/sessions.mjs`
- Modify: `tests/core/sessions.test.mjs`

- [ ] **Step 1: Write failing tests**

Add at the end of `tests/core/sessions.test.mjs`, after the last existing test and before the final newline:

```js
// ---------- extractSessionDigestBlock ----------

test("extractSessionDigestBlock returns decisions and open_threads from a valid block", () => {
  const md = `## Summary\n\nSome text.\n\n<!-- digest:start -->\ndecisions:\n- Chose Hybrid approach\n- Deferred MCP read path\nopen_threads:\n- Browser extension timeline TBD\n<!-- digest:end -->\n\n## Notes\n`;
  const result = extractSessionDigestBlock(md);
  assert.equal(result.found, true);
  assert.deepEqual(result.decisions, ["Chose Hybrid approach", "Deferred MCP read path"]);
  assert.deepEqual(result.open_threads, ["Browser extension timeline TBD"]);
});

test("extractSessionDigestBlock returns found:false and empty arrays when block is absent", () => {
  const md = `## Summary\n\nNo digest block here.\n`;
  const result = extractSessionDigestBlock(md);
  assert.equal(result.found, false);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.open_threads, []);
});

test("extractSessionDigestBlock treats None variants as empty and does not throw on malformed block", () => {
  const md = `<!-- digest:start -->\ndecisions:\n- None recorded.\nopen_threads:\n- None.\n<!-- digest:end -->`;
  const result = extractSessionDigestBlock(md);
  assert.equal(result.found, true);
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.open_threads, []);
});
```

Also add `extractSessionDigestBlock` to the import at the top of `tests/core/sessions.test.mjs`:

```js
import {
  generateSessionId,
  contentHash,
  sessionFilename,
  sessionDateDir,
  inferTitle,
  renderSessionBody,
  renderSessionMarkdown,
  writeSession,
  readSessionIndex,
  filterSessions,
  deleteSession,
  extractSessionDigestBlock,
  SESSIONS_SUBDIR,
} from "../../packages/core/src/sessions.mjs";
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/core/sessions.test.mjs 2>&1 | grep -E "FAIL|extractSession|SyntaxError" | head -10
```

Expected: errors about `extractSessionDigestBlock` not being exported.

- [ ] **Step 3: Implement `extractSessionDigestBlock` in sessions.mjs**

Add after the `extractSnippet` private function at the bottom of `packages/core/src/sessions.mjs`:

```js
const DIGEST_START = "<!-- digest:start -->";
const DIGEST_END = "<!-- digest:end -->";
const NONE_VALUES = new Set(["none", "none.", "none recorded."]);

export function extractSessionDigestBlock(markdown) {
  const start = markdown.indexOf(DIGEST_START);
  const end = markdown.indexOf(DIGEST_END);
  if (start === -1 || end === -1 || end <= start) {
    return { found: false, decisions: [], open_threads: [] };
  }
  const block = markdown.slice(start + DIGEST_START.length, end);
  const result = { found: true, decisions: [], open_threads: [] };
  let current = null;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "decisions:") { current = "decisions"; continue; }
    if (trimmed === "open_threads:") { current = "open_threads"; continue; }
    if (current && trimmed.startsWith("- ")) {
      const bullet = trimmed.slice(2).trim();
      if (bullet && !NONE_VALUES.has(bullet.toLowerCase())) {
        result[current].push(bullet);
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/core/sessions.test.mjs 2>&1 | tail -8
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions.mjs tests/core/sessions.test.mjs
git commit -m "feat: add extractSessionDigestBlock to sessions core"
```

---

### Task 2: `buildSessionDigest()`

Assemble a compact Markdown digest from recent saved sessions.

**Files:**
- Modify: `packages/core/src/sessions.mjs`
- Modify: `tests/core/sessions.test.mjs`

- [ ] **Step 1: Write failing tests**

Add to the import in `tests/core/sessions.test.mjs`:

```js
import {
  generateSessionId,
  contentHash,
  sessionFilename,
  sessionDateDir,
  inferTitle,
  renderSessionBody,
  renderSessionMarkdown,
  writeSession,
  readSessionIndex,
  filterSessions,
  deleteSession,
  extractSessionDigestBlock,
  buildSessionDigest,
  SESSIONS_SUBDIR,
} from "../../packages/core/src/sessions.mjs";
```

Add tests after the `extractSessionDigestBlock` tests:

```js
// ---------- buildSessionDigest ----------

test("buildSessionDigest returns empty-state digest when sessions index does not exist", async () => {
  const aiosPath = tmpAios();
  const { markdown } = await buildSessionDigest(aiosPath);
  assert.match(markdown, /# Recent Session Digest/);
  assert.match(markdown, /Generated from 0 saved session/);
});

test("buildSessionDigest prefers structured digest block over heading fallback", async () => {
  const aiosPath = tmpAios();
  const session = makeSession({
    captured_at: "2026-05-18T10:00:00.000Z",
    title: "Build test",
  });
  const { filePath } = await writeSession(aiosPath, session);

  // Overwrite the file with a digest block
  const withBlock = `---\nagent: manual\n---\n\n<!-- digest:start -->\ndecisions:\n- Used Hybrid C\nopen_threads:\n- MCP read path pending\n<!-- digest:end -->\n\n## Key Decisions\n\n- Should not appear\n`;
  await fsp.writeFile(filePath, withBlock, "utf8");

  const { markdown } = await buildSessionDigest(aiosPath);
  assert.match(markdown, /Used Hybrid C/);
  assert.match(markdown, /MCP read path pending/);
  assert.ok(!markdown.includes("Should not appear"), "heading fallback must not run when digest block found");
});

test("buildSessionDigest falls back to heading bullets when no digest block", async () => {
  const aiosPath = tmpAios();
  const session = makeSession({
    captured_at: "2026-05-18T11:00:00.000Z",
    title: "Fallback test",
  });
  const { filePath } = await writeSession(aiosPath, session);

  const withHeadings = `---\nagent: manual\n---\n\n## Key Decisions\n\n- Picked ESM over CJS\n\n## Open Threads\n\n- Needs browser extension\n`;
  await fsp.writeFile(filePath, withHeadings, "utf8");

  const { markdown } = await buildSessionDigest(aiosPath);
  assert.match(markdown, /Picked ESM over CJS/);
  assert.match(markdown, /Needs browser extension/);
});

test("buildSessionDigest filters by project and respects limit", async () => {
  const aiosPath = tmpAios();

  // Write one session for project "alpha" and one for "beta"
  const sAlpha = makeSession({ captured_at: "2026-05-18T09:00:00.000Z", project: "alpha", title: "Alpha work" });
  const sBeta  = makeSession({ captured_at: "2026-05-18T10:00:00.000Z", project: "beta",  title: "Beta work" });
  await writeSession(aiosPath, sAlpha);
  await writeSession(aiosPath, sBeta);

  const { sessions } = await buildSessionDigest(aiosPath, { project: "alpha" });
  assert.equal(sessions.length, 1);

  const { sessions: all } = await buildSessionDigest(aiosPath, { limit: 1 });
  assert.equal(all.length, 1);
});

test("buildSessionDigest skips missing files and still returns valid digest", async () => {
  const aiosPath = tmpAios();
  const session = makeSession({ captured_at: "2026-05-18T12:00:00.000Z", title: "Missing file test" });
  await writeSession(aiosPath, session);

  // Manually delete the session file so it becomes a dangling index entry
  const entries = await readSessionIndex(aiosPath);
  await fsp.unlink(path.join(aiosPath, entries[0].path));

  const { markdown, sessions } = await buildSessionDigest(aiosPath);
  assert.equal(sessions.length, 0);
  assert.match(markdown, /Generated from 0 saved session/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/core/sessions.test.mjs 2>&1 | grep -E "FAIL|buildSession" | head -10
```

Expected: errors about `buildSessionDigest` not being exported.

- [ ] **Step 3: Implement `buildSessionDigest` in sessions.mjs**

Add after `extractSessionDigestBlock` in `packages/core/src/sessions.mjs`:

```js
export async function buildSessionDigest(aiosPath, { project, limit = 5, now } = {}) {
  const cap = Math.min(Math.max(1, Math.floor(limit)), 10);
  let entries = await readSessionIndex(aiosPath);
  // readSessionIndex returns [] when index does not exist (readJsonl handles ENOENT)

  if (project) entries = entries.filter((e) => e.project === project);
  entries = entries
    .slice()
    .sort((a, b) => (b.captured_at || "").localeCompare(a.captured_at || ""))
    .slice(0, cap);

  const sessions = [];
  const decisions = [];
  const open_threads = [];

  for (const entry of entries) {
    const filePath = path.join(aiosPath, entry.path);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    sessions.push({ session_id: entry.session_id, path: entry.path });
    const date = (entry.captured_at || "").slice(0, 10);
    const title = entry.title || entry.session_id;

    const parsed = extractSessionDigestBlock(content);
    if (parsed.found) {
      for (const d of parsed.decisions) decisions.push(`${date} — ${title}: ${d}`);
      for (const t of parsed.open_threads) open_threads.push(`${date} — ${title}: ${t}`);
    } else {
      for (const d of extractHeadingBullets(content, "## Key Decisions")) decisions.push(`${date} — ${title}: ${d}`);
      for (const t of extractHeadingBullets(content, "## Open Threads")) open_threads.push(`${date} — ${title}: ${t}`);
    }
  }

  const MAX_BULLETS = 20;
  const MAX_LEN = 240;
  const clamp = (arr) =>
    arr.slice(0, MAX_BULLETS).map((b) => (b.length > MAX_LEN ? `${b.slice(0, MAX_LEN - 3)}...` : b));

  const decisionLines = clamp(decisions).map((b) => `- ${b}`).join("\n") || "- None recorded.";
  const threadLines   = clamp(open_threads).map((b) => `- ${b}`).join("\n") || "- None.";
  const sessionLines  = sessions.map((s) => {
    const e = entries.find((x) => x.session_id === s.session_id);
    if (!e) return "";
    const date  = (e.captured_at || "").slice(0, 10);
    const agent = e.agent || "manual";
    const title = e.title || e.session_id;
    return `- ${date} \`${agent}\` — ${title} (\`${s.path}\`)`;
  }).filter(Boolean).join("\n") || "- None.";

  const markdown = [
    "# Recent Session Digest",
    "",
    `Generated from ${sessions.length} saved session(s).`,
    "",
    "## Recent Decisions",
    "",
    decisionLines,
    "",
    "## Open Threads",
    "",
    threadLines,
    "",
    "## Recent Sessions",
    "",
    sessionLines,
  ].join("\n");

  return { markdown, sessions };
}
```

Add this private helper immediately after `extractSnippet` (before the new exports):

```js
function extractHeadingBullets(markdown, heading) {
  const lines = markdown.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) return [];
  const bullets = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#")) break;
    if (line.startsWith("- ")) {
      const bullet = line.slice(2).trim();
      if (bullet) bullets.push(bullet);
    }
  }
  return bullets;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/core/sessions.test.mjs 2>&1 | tail -8
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions.mjs tests/core/sessions.test.mjs
git commit -m "feat: add buildSessionDigest to sessions core"
```

---

### Task 3: `touchSession()`

Update access metadata on a session index entry after it is read.

**Files:**
- Modify: `packages/core/src/sessions.mjs`
- Modify: `tests/core/sessions.test.mjs`

- [ ] **Step 1: Write failing tests**

Add `touchSession` to the import in `tests/core/sessions.test.mjs`:

```js
import {
  generateSessionId,
  contentHash,
  sessionFilename,
  sessionDateDir,
  inferTitle,
  renderSessionBody,
  renderSessionMarkdown,
  writeSession,
  readSessionIndex,
  filterSessions,
  deleteSession,
  extractSessionDigestBlock,
  buildSessionDigest,
  touchSession,
  SESSIONS_SUBDIR,
} from "../../packages/core/src/sessions.mjs";
```

Add tests:

```js
// ---------- touchSession ----------

test("touchSession increments access_count and sets last_accessed", async () => {
  const aiosPath = tmpAios();
  const session = makeSession({ captured_at: "2026-05-18T13:00:00.000Z" });
  await writeSession(aiosPath, session);

  const now = new Date("2026-05-18T14:00:00.000Z");
  const updated = await touchSession(aiosPath, session.session_id, { now });

  assert.equal(updated.access_count, 1);
  assert.equal(updated.last_accessed, "2026-05-18T14:00:00.000Z");
});

test("touchSession preserves all existing index fields", async () => {
  const aiosPath = tmpAios();
  const session = makeSession({ captured_at: "2026-05-18T13:00:00.000Z", project: "myproject" });
  await writeSession(aiosPath, session);

  const updated = await touchSession(aiosPath, session.session_id);

  assert.equal(updated.agent, "manual");
  assert.equal(updated.project, "myproject");
  assert.equal(updated.session_id, session.session_id);
  assert.ok(updated.last_accessed, "last_accessed must be set");
});

test("touchSession returns null when session_id is unknown", async () => {
  const aiosPath = tmpAios();
  const result = await touchSession(aiosPath, "nonexistent-id");
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/core/sessions.test.mjs 2>&1 | grep -E "FAIL|touchSession" | head -10
```

Expected: errors about `touchSession` not being exported.

- [ ] **Step 3: Implement `touchSession` in sessions.mjs**

Add after `buildSessionDigest` in `packages/core/src/sessions.mjs`:

```js
export async function touchSession(aiosPath, sessionId, { now } = {}) {
  const entries = await readSessionIndex(aiosPath);
  const idx = entries.findIndex((e) => e.session_id === sessionId);
  if (idx === -1) return null;

  const entry = entries[idx];
  entries[idx] = {
    ...entry,
    last_accessed: (now || new Date()).toISOString(),
    access_count: (entry.access_count || 0) + 1,
  };
  await writeSessionIndex(aiosPath, entries);
  return entries[idx];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/core/sessions.test.mjs 2>&1 | tail -8
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sessions.mjs tests/core/sessions.test.mjs
git commit -m "feat: add touchSession to sessions core"
```

---

### Task 4: MCP `read_session_digest` Tool

Expose `buildSessionDigest` and `touchSession` through a new MCP tool.

**Files:**
- Modify: `packages/mcp/src/server.mjs`
- Modify: `tests/mcp/server.test.mjs`

- [ ] **Step 1: Write failing tests**

Open `tests/mcp/server.test.mjs`. Update the existing `assert.deepEqual(tools, [...])` block to include `read_session_digest` after `read_context`:

```js
assert.deepEqual(tools, [
  "read_context",
  "read_session_digest",
  "search_memory",
  "search_vault",
  "search_aios",
  "google_status",
  "google_gmail_search",
  "google_calendar_agenda",
  "google_drive_search",
  "list_projects",
  "log_event"
]);
```

Then add a new test after the existing two tests:

```js
test("mcp read_session_digest returns compact digest from seeded session", () => {
  const { aiosPath } = setupAios();

  // Seed a session file and index entry directly (no CLI dependency)
  const sessionDir = path.join(aiosPath, "memory", "sessions", "2026-05-18");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "2026-05-18T10-00-00_save-session_abc123.md");
  fs.writeFileSync(sessionPath, [
    "---",
    "agent: save-session",
    "session_id: abc12345",
    "captured_at: 2026-05-18T10:00:00.000Z",
    "source_type: save-session",
    "turns: 0",
    'title: "DotAIOS digest design"',
    "schema: 1",
    "---",
    "",
    "<!-- digest:start -->",
    "decisions:",
    "- Chose Hybrid approach C",
    "open_threads:",
    "- Browser extension timeline TBD",
    "<!-- digest:end -->",
    "",
    "## Summary",
    "",
    "Designed the read path.",
  ].join("\n"), "utf8");

  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  fs.writeFileSync(indexPath, JSON.stringify({
    session_id: "abc12345",
    agent: "save-session",
    captured_at: "2026-05-18T10:00:00.000Z",
    source_type: "save-session",
    turns: 0,
    title: "DotAIOS digest design",
    path: "memory/sessions/2026-05-18/2026-05-18T10-00-00_save-session_abc123.md"
  }) + "\n", "utf8");

  const responses = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_session_digest", arguments: {} } }
  ]);

  const text = toolText(responses[1]);
  assert.match(text, /# Recent Session Digest/);
  assert.match(text, /Chose Hybrid approach C/);
  assert.match(text, /Browser extension timeline TBD/);
});

test("mcp read_session_digest updates access metadata in index", () => {
  const { aiosPath } = setupAios();

  const sessionDir = path.join(aiosPath, "memory", "sessions", "2026-05-18");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, "2026-05-18T11-00-00_save-session_def456.md");
  fs.writeFileSync(sessionPath, "---\nagent: save-session\nsession_id: def45678\ncaptured_at: 2026-05-18T11:00:00.000Z\nsource_type: save-session\nturns: 0\ntitle: \"Touch test\"\nschema: 1\n---\n\n<!-- digest:start -->\ndecisions:\n- None recorded.\nopen_threads:\n- None.\n<!-- digest:end -->\n", "utf8");
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  fs.writeFileSync(indexPath, JSON.stringify({ session_id: "def45678", agent: "save-session", captured_at: "2026-05-18T11:00:00.000Z", source_type: "save-session", turns: 0, title: "Touch test", path: "memory/sessions/2026-05-18/2026-05-18T11-00-00_save-session_def456.md" }) + "\n", "utf8");

  runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_session_digest", arguments: {} } }
  ]);

  const updatedIndex = fs.readFileSync(indexPath, "utf8");
  const entry = JSON.parse(updatedIndex.trim().split("\n").pop());
  assert.equal(entry.access_count, 1);
  assert.ok(entry.last_accessed, "last_accessed must be set after digest read");
});

test("mcp read_session_digest rejects invalid limit with -32602", () => {
  const { aiosPath } = setupAios();
  const responses = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_session_digest", arguments: { limit: 99 } } }
  ]);
  assert.equal(responses[1].error.code, -32602);
  assert.match(responses[1].error.message, /limit/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/mcp/server.test.mjs 2>&1 | grep -E "FAIL|deepEqual|read_session" | head -10
```

Expected: the tool-list `deepEqual` fails because `read_session_digest` is not yet in the list.

- [ ] **Step 3: Add import to server.mjs**

In `packages/mcp/src/server.mjs`, update the imports at the top to add sessions exports:

```js
import { appendEvent, searchMemory, searchVault } from "../../core/src/memory.mjs";
import { buildSessionDigest, touchSession } from "../../core/src/sessions.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../core/src/paths.mjs";
import { SEARCH_SCOPES, searchAios } from "../../core/src/search.mjs";
import { assessGwsAuth, hasGoogleConnection, resolveGwsBinary, runGws } from "../../cli/src/lib/gws.mjs";
```

- [ ] **Step 4: Add tool to `callTool` dispatch in server.mjs**

In the `callTool` method, add the new line after `if (name === "read_context")`:

```js
if (name === "read_context") return await this.readContext(args);
if (name === "read_session_digest") return await this.readSessionDigest(args);
if (name === "search_memory") return await this.searchMemory(args);
```

- [ ] **Step 5: Add `readSessionDigest` method to the server class**

Add this method in `packages/mcp/src/server.mjs` alongside the other `async` handler methods (e.g. after `readContext`):

```js
async readSessionDigest(args) {
  const limit = args.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw protocolError(-32602, "limit must be an integer between 1 and 10");
  }
  const project = typeof args.project === "string" ? args.project : undefined;

  const { markdown, sessions } = await buildSessionDigest(this.aiosPath, { project, limit });
  await Promise.all(sessions.map((s) => touchSession(this.aiosPath, s.session_id)));
  return markdown;
}
```

- [ ] **Step 6: Add tool definition to `tools()` function in server.mjs**

In the `tools()` function, insert the new entry after the `read_context` entry:

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
},
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
node --test tests/mcp/server.test.mjs 2>&1 | tail -8
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 8: Run full suite to check for regressions**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -8
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp/src/server.mjs tests/mcp/server.test.mjs
git commit -m "feat: add read_session_digest MCP tool"
```

---

### Task 5: AGENTS.md Template Instruction + Template Test

Tell MCP-capable agents to call `read_session_digest` when continuity matters.

**Files:**
- Modify: `templates/AGENTS.md.hbs`
- Modify: `tests/core/render.test.mjs` (or add a focused test in an appropriate existing test file)

- [ ] **Step 1: Write a failing test**

Open `tests/core/render.test.mjs`. Add missing imports at the top of the file (after the existing `import assert` line):

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planTemplateTree } from "../../packages/core/src/render.mjs";

const repoRootRender = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
```

Then add at the end of the file:

```js
test("generated AGENTS.md mentions read_session_digest and discourages bulk-loading sessions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-agents-tmpl-"));
  const templateRoot = path.join(repoRootRender, "templates");
  const data = {
    created_at: "2026-05-18T00:00:00.000Z",
    ai_tools: [],
    vault_path: null,
    user_name: "Test User",
    user_role: "builder",
    current_work: "Testing.",
    priorities: "Ship."
  };

  const plan = await planTemplateTree(templateRoot, tmpDir, data, {
    include: (rel) => rel === "AGENTS.md"
  });
  const agentsContent = plan[0].content;

  assert.match(agentsContent, /read_session_digest/);
  assert.match(agentsContent, /memory\/sessions\//);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/core/render.test.mjs 2>&1 | grep -E "FAIL|read_session_digest" | head -5
```

Expected: assertion failure — `read_session_digest` not yet in template.

- [ ] **Step 3: Add instruction to `templates/AGENTS.md.hbs`**

In `templates/AGENTS.md.hbs`, find the `## Memory Routing` section (lines ~41-45):

```markdown
## Memory Routing

- `memory/events.jsonl`: load the last 50 entries only.
- `memory/signals/`: load today and yesterday only.
- `memory/errors.jsonl`: load only when debugging failed operations.
- `vault/`: load on demand when the task references knowledge, companies, people, writing style, or raw sources.
```

Append two lines to the bullet list:

```markdown
## Memory Routing

- `memory/events.jsonl`: load the last 50 entries only.
- `memory/signals/`: load today and yesterday only.
- `memory/errors.jsonl`: load only when debugging failed operations.
- `vault/`: load on demand when the task references knowledge, companies, people, writing style, or raw sources.
- If MCP tools are available and the task depends on recent continuity, call `read_session_digest` once before searching or opening session files. Do not bulk-load `memory/sessions/`.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test tests/core/render.test.mjs 2>&1 | tail -8
```

Expected: all tests pass, `# fail 0`.

- [ ] **Step 5: Regenerate AGENTS.md in ~/aios/ from the updated template**

```bash
npx dotaios context --refresh
```

Expected: `[updated] .../AGENTS.md` or similar confirmation. No errors.

- [ ] **Step 6: Commit**

```bash
git add templates/AGENTS.md.hbs tests/core/render.test.mjs
git commit -m "feat: add read_session_digest guidance to AGENTS.md template"
```

---

### Task 6: Docs + Final Validation

Update `docs/sessions.md` and verify the full suite.

**Files:**
- Modify: `docs/sessions.md`

- [ ] **Step 1: Add MCP read-path paragraph to docs/sessions.md**

Open `docs/sessions.md`. Find the section that describes how agents read sessions (or append at end if no such section). Add:

```markdown
## MCP Read Path

MCP-capable local agents (Claude Code, Codex) can call `read_session_digest` to read a compact digest of recent decisions and open threads without loading raw session files. The tool prefers structured blocks written by `save-session` and falls back to explicit headings only.

Web chat agents (claude.ai, ChatGPT, Gemini web) do not have MCP access. Use `save-session` to write the summary, then paste it at the start of your next chat session.
```

- [ ] **Step 2: Run full test suite**

```bash
node --test tests/**/*.test.mjs 2>&1 | tail -10
```

Expected: all tests pass, `# fail 0`. If any test fails, fix it before proceeding.

- [ ] **Step 3: Dry-run npm pack to confirm no accidental inclusions**

```bash
npm pack --dry-run 2>&1 | grep -v "^npm"
```

Verify: no `docs/superpowers/` files in the list (they are untracked and not in `files` in package.json, but confirm).

- [ ] **Step 4: Run smoke test**

```bash
npm run smoke 2>&1 | tail -10
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add docs/sessions.md
git commit -m "docs: add MCP read path section to sessions docs"
```

---

## Post-Implementation

After all tasks complete and tests pass:

1. **Bump version** to `1.14.6` in `package.json`.
2. **Tag and publish:**
   ```bash
   git tag v1.14.6
   git push origin main --tags
   npm publish --otp <6-digit-code>
   ```
3. **Regenerate AGENTS.md** if not done in Task 5:
   ```bash
   npx dotaios context --refresh
   ```
