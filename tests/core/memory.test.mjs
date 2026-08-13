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

const ARCHIVE_ROTATE_BYTES = 2 * 1024 * 1024;
const ARCHIVE_LINE_MAX_BYTES = 4 * 1024 * 1024;

function archiveEvent(index, payloadBytes) {
  return {
    ts: `2026-05-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    type: "archive-fixture",
    summary: `archive-${index}-${"x".repeat(payloadBytes)}`
  };
}

function readEventsArchiveGeneration(dir) {
  return fs.readdirSync(dir)
    .filter((name) => /^events-archive(?:\.\d{6})?\.jsonl$/.test(name))
    .sort((left, right) => {
      if (left === "events-archive.jsonl") return 1;
      if (right === "events-archive.jsonl") return -1;
      return left.localeCompare(right);
    })
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
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

  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const filePath = path.join(signalsDir, `${localDate}.jsonl`);
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

test("compactEvents rotates complete JSONL lines into immutable numbered shards", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const events = [
    archiveEvent(0, 720_000),
    archiveEvent(1, 720_000),
    archiveEvent(2, 720_000),
    archiveEvent(3, 16)
  ];
  fs.writeFileSync(eventsPath, events.map(formatJsonlEntry).join(""), { mode: 0o600 });

  await compactEvents(eventsPath, 1);

  const shardPath = path.join(dir, "events-archive.000001.jsonl");
  const activePath = path.join(dir, "events-archive.jsonl");
  assert.equal(fs.existsSync(shardPath), true);
  assert.equal(fs.existsSync(activePath), true);
  assert.ok(fs.statSync(shardPath).size <= ARCHIVE_ROTATE_BYTES);
  assert.ok(fs.statSync(activePath).size <= ARCHIVE_ROTATE_BYTES);
  assert.equal(fs.statSync(shardPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(activePath).mode & 0o777, 0o600);
  const archived = [...await readJsonl(shardPath), ...await readJsonl(activePath)];
  assert.deepEqual(archived.map(({ summary }) => summary.slice(0, 9)), ["archive-0", "archive-1", "archive-2"]);
});

test("legacy over-target active archive normalizes before compacting a pending batch", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const archivePath = path.join(dir, "events-archive.jsonl");
  const legacy = [archiveEvent(0, 720_000), archiveEvent(1, 720_000), archiveEvent(2, 720_000)];
  const pending = [archiveEvent(3, 16), archiveEvent(4, 16)];
  const live = archiveEvent(5, 16);
  fs.writeFileSync(archivePath, legacy.map(formatJsonlEntry).join(""), { mode: 0o600 });
  fs.writeFileSync(eventsPath, [...pending, live].map(formatJsonlEntry).join(""), { mode: 0o600 });

  const result = await compactEvents(eventsPath, 1);

  assert.deepEqual(result, { archived: 2, kept: 1 });
  assert.equal(fs.existsSync(path.join(dir, "events-archive.000001.jsonl")), true);
  assert.deepEqual(readEventsArchiveGeneration(dir), [...legacy, ...pending]);
  assert.deepEqual(await readJsonl(eventsPath), [live]);
});

test("normal rotations preserve legitimate byte-identical event records", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const repeated = {
    ts: "2026-05-01T12:00:00.000Z",
    type: "repeated-event",
    summary: "x".repeat(1_100_000)
  };
  const firstTail = { ts: "2026-05-02T12:00:00.000Z", type: "tail", id: 1 };
  const secondTail = { ts: "2026-05-03T12:00:00.000Z", type: "tail", id: 2 };
  fs.writeFileSync(
    eventsPath,
    `${formatJsonlEntry(repeated).repeat(3)}${formatJsonlEntry(firstTail)}`,
    { mode: 0o600 }
  );

  await compactEvents(eventsPath, 1);
  fs.appendFileSync(eventsPath, formatJsonlEntry(secondTail));
  await compactEvents(eventsPath, 1);

  const stored = fs.readdirSync(dir)
    .filter((name) => /^events-archive(?:\.\d{6})?\.jsonl$/.test(name))
    .sort((left, right) => {
      if (left === "events-archive.jsonl") return 1;
      if (right === "events-archive.jsonl") return -1;
      return left.localeCompare(right);
    })
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
  stored.push(...await readJsonl(eventsPath));

  assert.deepEqual(
    stored.map((entry) => entry.type === "repeated-event" ? "repeated" : `tail-${entry.id}`),
    ["repeated", "repeated", "repeated", "tail-1", "tail-2"]
  );
});

test("one valid line above the rotation target occupies its own shard", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const huge = archiveEvent(0, ARCHIVE_ROTATE_BYTES + 4096);
  const kept = archiveEvent(1, 16);
  fs.writeFileSync(eventsPath, `${formatJsonlEntry(huge)}${formatJsonlEntry(kept)}`, { mode: 0o600 });

  await compactEvents(eventsPath, 1);

  const shardPath = path.join(dir, "events-archive.000001.jsonl");
  assert.deepEqual((await readJsonl(shardPath)).map(({ summary }) => summary.slice(0, 9)), ["archive-0"]);
  assert.ok(fs.statSync(shardPath).size > ARCHIVE_ROTATE_BYTES);
  assert.ok(fs.statSync(shardPath).size <= ARCHIVE_LINE_MAX_BYTES);
  assert.deepEqual(await readJsonl(path.join(dir, "events-archive.jsonl")), []);
});

test("rotation never overwrites a preexisting immutable shard", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const firstShard = path.join(dir, "events-archive.000001.jsonl");
  const preserved = formatJsonlEntry({ ts: "2026-04-01T00:00:00.000Z", type: "preserved-shard" });
  fs.writeFileSync(firstShard, preserved, { mode: 0o600 });
  fs.writeFileSync(eventsPath, [
    archiveEvent(0, 1_100_000),
    archiveEvent(1, 1_100_000),
    archiveEvent(2, 16)
  ].map(formatJsonlEntry).join(""), { mode: 0o600 });

  await compactEvents(eventsPath, 1);

  assert.equal(fs.readFileSync(firstShard, "utf8"), preserved);
  assert.equal(fs.existsSync(path.join(dir, "events-archive.000002.jsonl")), true);
});

test("an archive line above the read ceiling fails before signal source removal", async () => {
  const dir = tmpDir();
  const signalsDir = path.join(dir, "signals");
  fs.mkdirSync(signalsDir);
  const oldDate = "2020-01-01";
  const sourcePath = path.join(signalsDir, `${oldDate}.jsonl`);
  fs.writeFileSync(sourcePath, formatJsonlEntry({
    type: "oversized",
    summary: "x".repeat(ARCHIVE_LINE_MAX_BYTES)
  }));

  await assert.rejects(
    () => trimSignals(signalsDir, 30),
    (error) => error?.code === "DOTAIOS_ARCHIVE_LINE_TOO_LARGE"
  );
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(path.join(dir, "signals-archive.jsonl")), false);
  assert.equal(fs.existsSync(path.join(dir, "signals-archive.000001.jsonl")), false);
});

test("archive maintenance narrows an eligible legacy active file from 0644 to 0600", async () => {
  if (process.platform === "win32") return;
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const archivePath = path.join(dir, "events-archive.jsonl");
  fs.writeFileSync(archivePath, formatJsonlEntry(archiveEvent(0, 16)), { mode: 0o644 });
  fs.chmodSync(archivePath, 0o644);
  fs.writeFileSync(
    eventsPath,
    `${formatJsonlEntry(archiveEvent(1, 16))}${formatJsonlEntry(archiveEvent(2, 16))}`,
    { mode: 0o600 }
  );

  await compactEvents(eventsPath, 1);

  assert.equal(fs.statSync(archivePath).mode & 0o777, 0o600);
  assert.deepEqual((await readJsonl(archivePath)).map(({ summary }) => summary.slice(0, 9)), [
    "archive-0",
    "archive-1"
  ]);
});

test("unsafe archive identities and modes fail before trimmed signal deletion", async (t) => {
  if (process.platform === "win32") return;
  for (const fixture of ["hard-link-active", "linked-shard", "writable-active"]) {
    await t.test(fixture, async () => {
      const dir = tmpDir();
      const signalsDir = path.join(dir, "signals");
      const sourcePath = path.join(signalsDir, "2020-01-01.jsonl");
      const archivePath = path.join(dir, "signals-archive.jsonl");
      const outsidePath = path.join(dir, "outside.jsonl");
      fs.mkdirSync(signalsDir);
      fs.writeFileSync(sourcePath, '{"type":"must-survive"}\n');
      fs.writeFileSync(outsidePath, '{"type":"outside"}\n', { mode: 0o600 });
      if (fixture === "hard-link-active") fs.linkSync(outsidePath, archivePath);
      if (fixture === "linked-shard") fs.symlinkSync(outsidePath, path.join(dir, "signals-archive.000001.jsonl"));
      if (fixture === "writable-active") {
        fs.writeFileSync(archivePath, '{"type":"legacy"}\n', { mode: 0o666 });
        fs.chmodSync(archivePath, 0o666);
      }
      const outsideBefore = fs.readFileSync(outsidePath);

      await assert.rejects(() => trimSignals(signalsDir, 30));

      assert.equal(fs.existsSync(sourcePath), true);
      assert.deepEqual(fs.readFileSync(outsidePath), outsideBefore);
    });
  }
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

  const archived = await readJsonl(path.join(dir, "signals-archive.jsonl"));
  assert.deepEqual(archived, [{ type: "old" }], "a trimmed signal is moved to the archive, never dropped");
});

test("concurrent signal maintenance converges without loss or duplicate archive lines", async () => {
  const dir = tmpDir();
  const signalsDir = path.join(dir, "signals");
  fs.mkdirSync(signalsDir);
  const sourcePath = path.join(signalsDir, "2020-01-01.jsonl");
  fs.writeFileSync(sourcePath, '{"type":"one"}\n{"type":"two"}\n');

  await Promise.all([trimSignals(signalsDir, 30), trimSignals(signalsDir, 30)]);

  assert.equal(fs.existsSync(sourcePath), false);
  assert.deepEqual(await readJsonl(path.join(dir, "signals-archive.jsonl")), [
    { type: "one" },
    { type: "two" }
  ]);
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

test("searchMemory discovers numbered shards in numeric order and deduplicates retry overlap", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir);
  const older = { ts: "2026-05-01T12:00:00.000Z", type: "note", summary: "sharded needle older" };
  const overlap = { ts: "2026-05-02T12:00:00.000Z", type: "note", summary: "sharded needle overlap" };
  const active = { ts: "2026-05-03T12:00:00.000Z", type: "note", summary: "sharded needle active" };
  fs.writeFileSync(path.join(memoryDir, "events-archive.000002.jsonl"), formatJsonlEntry(overlap), { mode: 0o600 });
  fs.writeFileSync(path.join(memoryDir, "events-archive.000001.jsonl"), formatJsonlEntry(older), { mode: 0o600 });
  fs.writeFileSync(
    path.join(memoryDir, "events-archive.jsonl"),
    `${formatJsonlEntry(overlap)}${formatJsonlEntry(active)}`,
    { mode: 0o600 }
  );

  const results = await searchMemory(memoryDir, "sharded needle");

  assert.deepEqual(results.map(({ summary }) => summary), [
    "sharded needle active",
    "sharded needle overlap",
    "sharded needle older"
  ]);
  assert.equal(results.filter(({ summary }) => summary.endsWith("overlap")).length, 1);
  assert.match(results.find(({ summary }) => summary.endsWith("older")).source, /000001/);
});

test("searchMemory preserves legitimate identical records outside retry overlap", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  const signalsDir = path.join(memoryDir, "signals");
  fs.mkdirSync(signalsDir, { recursive: true });
  const duplicate = {
    ts: "2026-05-06T12:00:00.000Z",
    type: "note",
    summary: "legitimate duplicate needle"
  };
  const shardDuplicate = {
    ts: "2026-05-05T12:00:00.000Z",
    type: "note",
    summary: "legitimate duplicate needle across immutable shards"
  };
  const serialized = formatJsonlEntry(duplicate);
  const serializedShard = formatJsonlEntry(shardDuplicate);

  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), `${serialized}${serialized}`);
  fs.writeFileSync(path.join(memoryDir, "events-archive.jsonl"), serialized, { mode: 0o600 });
  fs.writeFileSync(path.join(memoryDir, "events-archive.000001.jsonl"), serializedShard, { mode: 0o600 });
  fs.writeFileSync(path.join(memoryDir, "events-archive.000002.jsonl"), serializedShard, { mode: 0o600 });
  fs.writeFileSync(path.join(memoryDir, "signals-archive.jsonl"), serialized, { mode: 0o600 });
  fs.writeFileSync(path.join(signalsDir, "laptop-2026-05-06.jsonl"), serialized);
  fs.writeFileSync(path.join(signalsDir, "mini-2026-05-06.jsonl"), serialized);

  const results = await searchMemory(memoryDir, "legitimate duplicate needle", { limit: 10 });

  assert.equal(results.length, 6, "one event retry copy is suppressed without collapsing canonical duplicates");
  assert.equal(results.filter(({ source }) => source === "memory/events.jsonl").length, 2);
  assert.deepEqual(
    results.filter(({ source }) => source.includes("events-archive.00000")).map(({ source }) => source).sort(),
    [
      "memory/events-archive.000001.jsonl",
      "memory/events-archive.000002.jsonl"
    ]
  );
  assert.deepEqual(
    results.filter(({ source }) => source.startsWith("memory/signals/")).map(({ source }) => source).sort(),
    [
      "memory/signals/laptop-2026-05-06.jsonl",
      "memory/signals/mini-2026-05-06.jsonl"
    ]
  );
  assert.equal(results.some(({ source }) => source === "memory/signals-archive.jsonl"), false);
});
