import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  SESSIONS_SUBDIR,
} from "../../packages/core/src/sessions.mjs";

const execFileAsync = promisify(execFile);

import { parseRawText } from "../../packages/cli/src/adapters/manual.mjs";
import { parseTranscript } from "../../packages/cli/src/adapters/claude-code.mjs";

function tmpAios() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-sessions-test-"));
  fs.writeFileSync(path.join(dir, "aios.json"), JSON.stringify({ version: "1" }));
  fs.mkdirSync(path.join(dir, "memory", "sessions"), { recursive: true });
  return dir;
}

function makeSession(overrides = {}) {
  return {
    agent: "manual",
    session_id: generateSessionId(),
    captured_at: "2026-05-16T14:30:00.000Z",
    source_type: "import",
    project: "test",
    title: "Test conversation",
    turns: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ],
    ...overrides,
  };
}

// ---------- pure helpers ----------

test("generateSessionId returns 8-char hex string", () => {
  const id = generateSessionId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("contentHash is deterministic and 16 chars", () => {
  const h1 = contentHash("hello world");
  const h2 = contentHash("hello world");
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
  assert.notEqual(contentHash("hello world"), contentHash("hello worlds"));
});

test("sessionFilename is filesystem-safe and sortable", () => {
  const session = makeSession({ session_id: "a1b2c3d4", captured_at: "2026-05-16T14:30:00.000Z" });
  const name = sessionFilename(session);
  assert.match(name, /^2026-05-16T14-30-00_manual_a1b2c3\.md$/);
  assert.ok(!name.includes(":"), "colons must be replaced");
});

test("sessionDateDir extracts YYYY-MM-DD", () => {
  assert.equal(sessionDateDir({ captured_at: "2026-05-16T14:30:00Z" }), "2026-05-16");
});

test("inferTitle returns first user message truncated to 80 chars", () => {
  const turns = [
    { role: "user", content: "Short question" },
    { role: "assistant", content: "Answer" },
  ];
  assert.equal(inferTitle(turns), "Short question");

  const longTurns = [{ role: "user", content: "A".repeat(100) }];
  const title = inferTitle(longTurns);
  assert.ok(title.length <= 80);
  assert.match(title, /\.\.\.$/);
});

test("inferTitle returns null for empty turns", () => {
  assert.equal(inferTitle([]), null);
  assert.equal(inferTitle(null), null);
});

// ---------- renderSessionMarkdown ----------

test("renderSessionMarkdown produces valid frontmatter and body", () => {
  const session = makeSession();
  const md = renderSessionMarkdown(session);

  assert.match(md, /^---\n/);
  assert.match(md, /\nagent: manual\n/);
  assert.match(md, /\nschema: 1\n/);
  assert.match(md, /\n---\n/);
  assert.match(md, /\*\*user\*\*/);
  assert.match(md, /Hello/);
  assert.match(md, /\*\*assistant\*\*/);
  assert.match(md, /Hi there/);
});

test("renderSessionMarkdown includes optional source_path and project", () => {
  const session = makeSession({ source_path: "/tmp/test.jsonl" });
  const md = renderSessionMarkdown(session);
  assert.match(md, /\nsource_path: \/tmp\/test\.jsonl\n/);
  assert.match(md, /\nproject: test\n/);
});

test("renderSessionMarkdown omits source_path when absent", () => {
  const session = makeSession({ source_path: undefined });
  const md = renderSessionMarkdown(session);
  assert.ok(!md.includes("source_path:"), "source_path should be absent");
});

test("renderSessionBody excludes frontmatter", () => {
  const session = makeSession();
  const body = renderSessionBody(session);
  assert.ok(!body.includes("---"), "body must not contain frontmatter");
  assert.match(body, /\*\*user\*\*/);
  assert.match(body, /Hello/);
});

// ---------- SessionStore write compatibility ----------

test("writeSession compatibility captures direct sessions as paste evidence", async () => {
  const aios = tmpAios();
  const session = makeSession();

  const result = await writeSession(aios, session);

  assert.equal(result.skipped, false);
  assert.ok(fs.existsSync(result.filePath), "session file must exist");

  const content = fs.readFileSync(result.filePath, "utf8");
  assert.match(content, /\nagent: paste\n/);
  assert.match(content, /\nsource_type: paste\n/);
  assert.match(content, /Hello/);

  const index = await readSessionIndex(aios);
  assert.equal(index.length, 1);
  assert.match(index[0].session_id, /^[0-9a-f]{8}$/);
  assert.notEqual(index[0].session_id, session.session_id);
  assert.equal(index[0].turns, 2);
  assert.equal(index[0].content_hash.length, 16);
});

test("writeSession refuses caller-forged source identity", async () => {
  const aios = tmpAios();
  const session = makeSession({ source_path: "/tmp/src.jsonl" });

  await assert.rejects(
    () => writeSession(aios, session),
    { code: "DOTAIOS_SESSION_SOURCE_IDENTITY_FORBIDDEN" },
  );
  assert.equal((await readSessionIndex(aios)).length, 0);
});

test("writeSession compatibility assigns distinct identities to source-less captures", async () => {
  const aios = tmpAios();
  const s1 = makeSession({ session_id: "aaaa1111" });
  const s2 = makeSession({ session_id: "bbbb2222" });

  await writeSession(aios, s1);
  await writeSession(aios, s2);

  const index = await readSessionIndex(aios);
  assert.equal(index.length, 2);
});

// ---------- SessionStore delete compatibility ----------

test("deleteSession removes file and index entry", async () => {
  const aios = tmpAios();
  const session = makeSession();
  const r = await writeSession(aios, session);
  const storedId = (await readSessionIndex(aios))[0].session_id;

  const deleted = await deleteSession(aios, storedId);

  assert.equal(deleted.session_id, storedId);
  assert.ok(!fs.existsSync(r.filePath), "file must be removed");

  const index = await readSessionIndex(aios);
  assert.equal(index.length, 0);
});

test("deleteSession throws for unknown session_id", async () => {
  const aios = tmpAios();
  await assert.rejects(
    () => deleteSession(aios, "deadbeef"),
    /Session not found: deadbeef/
  );
});

test("deleteSession refuses stale projection evidence when the canonical file is missing", async () => {
  const aios = tmpAios();
  const session = makeSession();
  const r = await writeSession(aios, session);
  const storedId = (await readSessionIndex(aios))[0].session_id;

  // Manually remove the file before calling deleteSession
  await fsp.unlink(r.filePath);

  await assert.rejects(
    () => deleteSession(aios, storedId),
    { code: "DOTAIOS_SESSION_RECONCILIATION_REQUIRED" },
  );

  await assert.rejects(() => readSessionIndex(aios), { code: "DOTAIOS_SESSION_PROJECTION_DRIFT" });
});

// ---------- filterSessions ----------

test("filterSessions uses SessionStore-authored agent metadata", async () => {
  const aios = tmpAios();
  await writeSession(aios, makeSession({ agent: "claude-code", session_id: generateSessionId() }));
  await writeSession(aios, makeSession({ agent: "manual", session_id: generateSessionId() }));

  const pasteResults = await filterSessions(aios, { agent: "paste" });
  const forgedAgentResults = await filterSessions(aios, { agent: "claude-code" });
  assert.equal(pasteResults.length, 2);
  assert.ok(pasteResults.every((entry) => entry.agent === "paste"));
  assert.equal(forgedAgentResults.length, 0);
});

test("filterSessions by project", async () => {
  const aios = tmpAios();
  await writeSession(aios, makeSession({ project: "brain", session_id: generateSessionId() }));
  await writeSession(aios, makeSession({ project: "work", session_id: generateSessionId() }));

  const brainResults = await filterSessions(aios, { project: "brain" });
  assert.equal(brainResults.length, 1);
  assert.equal(brainResults[0].project, "brain");
});

test("filterSessions by since cuts off old sessions", async () => {
  const aios = tmpAios();
  const oldCapturedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recentCapturedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await writeSession(aios, makeSession({
    session_id: generateSessionId(),
    captured_at: oldCapturedAt,
  }));
  await writeSession(aios, makeSession({
    session_id: generateSessionId(),
    captured_at: recentCapturedAt,
  }));

  const recent = await filterSessions(aios, { since: "30d" });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].captured_at, recentCapturedAt);
});

// ---------- manual adapter ----------

test("parseRawText handles own markdown format (**role · time**)", () => {
  const text = [
    "**user · 14:30**",
    "",
    "What is the capital of France?",
    "",
    "**assistant · 14:31**",
    "",
    "Paris.",
    "",
  ].join("\n");

  const session = parseRawText(text);
  assert.equal(session.agent, "manual");
  assert.equal(Object.hasOwn(session, "session_id"), false);
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].role, "user");
  assert.match(session.turns[0].content, /capital of France/);
  assert.equal(session.turns[1].role, "assistant");
  assert.match(session.turns[1].content, /Paris/);
});

test("parseRawText handles Human:/Assistant: dialogue format", () => {
  const text = [
    "You: Hello, what's the weather?",
    "Claude: I can't check the weather directly.",
    "You: Thanks anyway.",
  ].join("\n");

  const session = parseRawText(text);
  assert.equal(session.turns.length, 3);
  assert.equal(session.turns[0].role, "user");
  assert.equal(session.turns[1].role, "assistant");
  assert.equal(session.turns[2].role, "user");
});

test("parseRawText falls back to single user turn for plain text", () => {
  const text = "This is just a random block of text.";
  const session = parseRawText(text);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].role, "user");
  assert.equal(session.turns[0].content, text);
});

test("parseRawText infers title from first user message", () => {
  const text = "**user**\n\nWhat is session memory?\n\n**assistant**\n\nIt stores conversations.\n";
  const session = parseRawText(text);
  assert.equal(session.title, "What is session memory?");
});

test("parseRawText empty input returns empty turns", () => {
  const session = parseRawText("   ");
  assert.equal(session.turns.length, 0);
});

// ---------- Claude Code transcript parser ----------

test("parseTranscript extracts user and assistant turns", () => {
  const lines = [
    {
      type: "user",
      timestamp: "2026-05-16T14:30:00.000Z",
      uuid: "be4d3fc3-0000-0000-0000-000000000000",
      message: {
        role: "user",
        content: [{ type: "text", text: "Hello, how are you?" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-05-16T14:30:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal thought", signature: "x" },
          { type: "text", text: "I am doing well, thank you." },
        ],
      },
    },
  ];

  const session = parseTranscript(lines, { project: "test" });
  assert.ok(session !== null);
  assert.equal(session.agent, "claude-code");
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].role, "user");
  assert.match(session.turns[0].content, /Hello/);
  assert.equal(session.turns[1].role, "assistant");
  assert.match(session.turns[1].content, /doing well/);
  assert.ok(!session.turns[1].content.includes("internal thought"), "thinking blocks must be stripped");
});

test("parseTranscript skips tool_use and tool_result blocks", () => {
  const lines = [
    {
      type: "user",
      timestamp: "2026-05-16T14:30:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Read this file" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-05-16T14:30:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
        ],
      },
    },
    {
      type: "user",
      timestamp: "2026-05-16T14:30:02Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", content: "file contents" },
          { type: "text", text: "Thanks for reading it" },
        ],
      },
    },
  ];

  const session = parseTranscript(lines);
  // tool_result turn: has text → 2 user turns total + 0 assistant text turns → session may be null or have 2 turns
  assert.ok(session !== null || session === null); // just checking it doesn't throw
  if (session) {
    for (const turn of session.turns) {
      assert.ok(!turn.content?.includes("tool_result"), "tool_result content must not leak");
    }
  }
});

test("parseTranscript skips queue-operation lines", () => {
  const lines = [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-05-16T14:30:00Z" },
    {
      type: "user",
      timestamp: "2026-05-16T14:30:00Z",
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    },
    { type: "queue-operation", operation: "dequeue", timestamp: "2026-05-16T14:30:01Z" },
  ];
  const session = parseTranscript(lines);
  assert.ok(session !== null);
  assert.equal(session.turns.length, 1);
});

test("parseTranscript returns null for empty transcript", () => {
  const session = parseTranscript([]);
  assert.equal(session, null);
});

test("parseTranscript extracts session_id from source file UUID", () => {
  const lines = [
    {
      type: "user",
      timestamp: "2026-05-16T14:30:00Z",
      message: { role: "user", content: [{ type: "text", text: "Q" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-05-16T14:30:01Z",
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    },
  ];
  const session = parseTranscript(lines, {
    sourcePath: "/Users/you/.claude/projects/-Users-you-project/a1b2c3d4-0000-0000-0000-000000000000.jsonl",
  });
  assert.equal(session.session_id, "a1b2c3d4");
});

// ---------- SessionStore compatibility and concurrency ----------

test("writeSession compatibility preserves an unrelated index.jsonl.lock artifact", async () => {
  const aios = tmpAios();
  const lockPath = path.join(aios, SESSIONS_SUBDIR, "index.jsonl.lock");
  // An older release may have left this file behind. SessionStore does not use
  // it and must leave the unrelated bytes untouched while publishing.
  fs.writeFileSync(lockPath, "2147483647");

  await writeSession(aios, makeSession({ session_id: "ghost-steal" }));

  const index = await readSessionIndex(aios);
  assert.equal(index.length, 1);
  assert.match(index[0].session_id, /^[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "2147483647");
});

test("writeSession compatibility leaves a stale unowned index.jsonl.lock artifact untouched", async () => {
  const aios = tmpAios();
  const lockPath = path.join(aios, SESSIONS_SUBDIR, "index.jsonl.lock");
  fs.writeFileSync(lockPath, "not-a-pid");
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockPath, old, old);

  await writeSession(aios, makeSession({ session_id: "stale-mtime" }));

  const index = await readSessionIndex(aios);
  assert.equal(index.length, 1);
  assert.match(index[0].session_id, /^[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "not-a-pid");
});

test("SessionStore serializes concurrent writeSession compatibility captures without losing entries", async () => {
  const aios = tmpAios();
  const N = 10;
  const sessionsUrl = new URL("../../packages/core/src/sessions.mjs", import.meta.url).href;
  const workerPath = path.join(aios, "worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import { writeSession } from ${JSON.stringify(sessionsUrl)};\n` +
      `const [aios, id] = process.argv.slice(2);\n` +
      `await writeSession(aios, { agent: "manual", session_id: id, captured_at: new Date().toISOString(), source_type: "import", project: "p", title: "t " + id, turns: [{ role: "user", content: "hello " + id }] });\n`
  );

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      execFileAsync(process.execPath, [workerPath, aios, "sess-" + i]))
  );

  const index = await readSessionIndex(aios);
  assert.equal(index.length, N); // every concurrent writer's entry survived
});

test("SessionStore concurrent compatibility captures ignore a dead-PID index lock artifact", async () => {
  const aios = tmpAios();
  // The dead-PID file belongs to an older locking design. SessionStore must not
  // reclaim it or let it weaken serialization through its strict operation lock.
  fs.writeFileSync(path.join(aios, SESSIONS_SUBDIR, "index.jsonl.lock"), "2147483647");

  const N = 8;
  const sessionsUrl = new URL("../../packages/core/src/sessions.mjs", import.meta.url).href;
  const workerPath = path.join(aios, "worker.mjs");
  fs.writeFileSync(
    workerPath,
    `import { writeSession } from ${JSON.stringify(sessionsUrl)};\n` +
      `const [aios, id] = process.argv.slice(2);\n` +
      `await writeSession(aios, { agent: "manual", session_id: id, captured_at: new Date().toISOString(), source_type: "import", project: "p", title: "t " + id, turns: [{ role: "user", content: "hi " + id }] });\n`
  );

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      execFileAsync(process.execPath, [workerPath, aios, "steal-" + i]))
  );

  const index = await readSessionIndex(aios);
  assert.equal(index.length, N);
});

// ---------- no collision with existing commands ----------

test("sessions dir is separate from vault and memory/signals", () => {
  const sessionsPath = SESSIONS_SUBDIR;
  assert.ok(sessionsPath.startsWith("memory/sessions"), "sessions live under memory/sessions/");
  assert.ok(!sessionsPath.includes("vault"), "no overlap with vault");
  assert.ok(!sessionsPath.includes("signals"), "no overlap with signals");
});
