import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonlLine,
  formatJsonlEntry,
  readJsonl,
  readRecentEvents,
  filterEvents,
  appendEvent,
  appendSignal,
  compactEvents,
  trimSignals,
  searchMemory,
  RECENT_EVENT_LIMIT
} from "../../packages/core/src/memory.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-mem-test-"));
}

test("parseJsonlLine parses valid JSON and skips blanks", () => {
  assert.deepEqual(parseJsonlLine('{"a":1}'), { a: 1 });
  assert.equal(parseJsonlLine(""), null);
  assert.equal(parseJsonlLine("  "), null);
});

test("formatJsonlEntry produces newline-terminated JSON", () => {
  const result = formatJsonlEntry({ type: "test" });
  assert.equal(result, '{"type":"test"}\n');
});

test("readJsonl reads a file and returns parsed entries", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "test.jsonl");
  fs.writeFileSync(filePath, '{"a":1}\n{"a":2}\n');
  const entries = await readJsonl(filePath);
  assert.deepEqual(entries, [{ a: 1 }, { a: 2 }]);
});

test("readJsonl returns empty array for missing file", async () => {
  const entries = await readJsonl("/nonexistent/file.jsonl");
  assert.deepEqual(entries, []);
});

test("readRecentEvents returns only the last N entries", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "events.jsonl");
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({ i }));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");

  const recent = await readRecentEvents(filePath, 10);
  assert.equal(recent.length, 10);
  assert.equal(recent[0].i, 90);
  assert.equal(recent[9].i, 99);
});

test("filterEvents filters by type, project, domain, date, and query", () => {
  const events = [
    { ts: "2026-05-01T12:00:00Z", type: "ingest", project: "aios", domain: "build", summary: "Added README" },
    { ts: "2026-05-02T12:00:00Z", type: "import", project: "thesis", domain: "make", summary: "Imported notes" },
    { ts: "2026-05-03T12:00:00Z", type: "ingest", project: "aios", domain: "build", summary: "Added docs" }
  ];

  assert.equal(filterEvents(events, { type: "ingest" }).length, 2);
  assert.equal(filterEvents(events, { project: "thesis" }).length, 1);
  assert.equal(filterEvents(events, { domain: "make" }).length, 1);
  assert.equal(filterEvents(events, { from: "2026-05-02" }).length, 2);
  assert.equal(filterEvents(events, { to: "2026-05-01T23:59:59Z" }).length, 1);
  assert.equal(filterEvents(events, { query: "readme" }).length, 1);
  assert.equal(filterEvents(events, { type: "ingest", project: "aios" }).length, 2);
});

test("appendEvent writes structured entry with required fields", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const entry = await appendEvent(eventsPath, { type: "test", project: "myproject", summary: "hello" });
  assert.equal(entry.type, "test");
  assert.equal(entry.project, "myproject");
  assert.ok(entry.ts);

  const entries = await readJsonl(eventsPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "test");
});

test("appendEvent throws without type", async () => {
  const dir = tmpDir();
  await assert.rejects(() => appendEvent(path.join(dir, "e.jsonl"), { summary: "no type" }), /requires a type/);
});

test("appendSignal writes to date-named file", async () => {
  const dir = tmpDir();
  const signalsDir = path.join(dir, "signals");
  const entry = await appendSignal(signalsDir, { type: "email", summary: "Got a reply" });
  assert.ok(entry.ts);

  const today = new Date().toISOString().slice(0, 10);
  const filePath = path.join(signalsDir, `${today}.jsonl`);
  assert.ok(fs.existsSync(filePath));
  const entries = await readJsonl(filePath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "email");
});

test("compactEvents archives old entries and keeps recent", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const lines = [];
  for (let i = 0; i < 75; i++) {
    lines.push(JSON.stringify({ i, type: "test" }));
  }
  fs.writeFileSync(eventsPath, lines.join("\n") + "\n");

  const result = await compactEvents(eventsPath, 50);
  assert.equal(result.archived, 25);
  assert.equal(result.kept, 50);

  const remaining = await readJsonl(eventsPath);
  assert.equal(remaining.length, 50);
  assert.equal(remaining[0].i, 25);

  const archivePath = path.join(dir, "events-archive.jsonl");
  const archived = await readJsonl(archivePath);
  assert.equal(archived.length, 25);
  assert.equal(archived[0].i, 0);
});

test("trimSignals removes files older than retention period", async () => {
  const dir = tmpDir();
  const signalsDir = path.join(dir, "signals");
  fs.mkdirSync(signalsDir, { recursive: true });

  const oldDate = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const recentDate = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(signalsDir, `${oldDate}.jsonl`), '{"type":"old"}\n');
  fs.writeFileSync(path.join(signalsDir, `${recentDate}.jsonl`), '{"type":"new"}\n');

  const result = await trimSignals(signalsDir, 30);
  assert.equal(result.removed, 1);
  assert.ok(result.freedBytes > 0);
  assert.equal(fs.existsSync(path.join(signalsDir, `${oldDate}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(signalsDir, `${recentDate}.jsonl`)), true);
});

test("searchMemory returns matches by timestamp across events archives and signals", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  const signalsDir = path.join(memoryDir, "signals");
  fs.mkdirSync(signalsDir, { recursive: true });

  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), [
    JSON.stringify({ ts: "2026-05-02T12:00:00.000Z", type: "note", summary: "needle older current event" }),
    JSON.stringify({ ts: "2026-05-04T12:00:00.000Z", type: "note", summary: "needle newest current event" })
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(memoryDir, "events-archive.jsonl"), [
    JSON.stringify({ ts: "2026-05-05T12:00:00.000Z", type: "note", summary: "needle newest archived event" })
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(signalsDir, "2026-05-03.jsonl"), [
    JSON.stringify({ ts: "2026-05-03T12:00:00.000Z", type: "signal", summary: "needle signal event" })
  ].join("\n") + "\n");

  const results = await searchMemory(memoryDir, "needle");
  assert.deepEqual(results.map((result) => result.ts), [
    "2026-05-05T12:00:00.000Z",
    "2026-05-04T12:00:00.000Z",
    "2026-05-03T12:00:00.000Z",
    "2026-05-02T12:00:00.000Z"
  ]);
});
