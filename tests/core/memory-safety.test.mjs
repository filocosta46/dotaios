import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendEvent,
  appendEventRecord,
  compactEvents,
  trimSignals,
  readJsonl,
  isoDate
} from "../../packages/core/src/memory.mjs";
import { searchMemoryDir } from "../../packages/core/src/search.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-memsafe-test-"));
}

function seedEvents(filePath, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(4, "0")}Z`, type: "seed", n: i }));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return lines;
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim());
}

// Injectable fs double: throws once at the Nth call of a method, otherwise
// delegates to the real promises fs. Simulates a crash at an exact step.
function faultFs(failures) {
  const counts = {};
  const wrap = (name) => async (...args) => {
    counts[name] = (counts[name] || 0) + 1;
    counts.total = (counts.total || 0) + 1;
    if (failures[name] && counts[name] === failures[name]) {
      throw new Error(`injected-crash:${name}:${counts[name]}`);
    }
    return fsp[name](...args);
  };
  const filesystem = { ...fsp };
  for (const name of [
    "appendFile", "chmod", "link", "lstat", "mkdir", "open", "readFile",
    "readdir", "rename", "rm", "stat", "unlink", "writeFile"
  ]) {
    filesystem[name] = wrap(name);
  }
  return { filesystem, counts };
}

// --- Defect 1: crash-safe compaction ---

test("compaction survives a crash at any single step: no event lost, none duplicated", async () => {
  const scenarios = [
    { writeFile: 1 },
    { writeFile: 2 },
    { appendFile: 1 },
    { rename: 1 },
    { unlink: 1 }
  ];
  for (const failure of scenarios) {
    const dir = tmpDir();
    const eventsPath = path.join(dir, "events.jsonl");
    const archivePath = path.join(dir, "events-archive.jsonl");
    const original = seedEvents(eventsPath, 30);

    // Crashed run: allowed to reject, must never lose data.
    const fault = faultFs(failure);
    try {
      await compactEvents(eventsPath, 10, { filesystem: fault.filesystem });
    } catch (error) {
      assert.match(String(error.message), /injected-crash/, `unexpected error for ${JSON.stringify(failure)}: ${error.message}`);
    }
    assert.ok((fault.counts.total || 0) > 0, "compactEvents must honor the injectable filesystem so crashes are testable");

    // Mid-crash, every event must survive in SOME durable file: the events
    // log, the archive, or the staged pending batch.
    const midState = [
      ...readLines(eventsPath),
      ...readLines(archivePath),
      ...readLines(`${archivePath}.pending`)
    ];
    for (const line of original) {
      assert.ok(midState.includes(line), `event lost after crash ${JSON.stringify(failure)}: ${line}`);
    }

    // Clean re-run must converge with zero loss and zero duplicates.
    const result = await compactEvents(eventsPath, 10);
    assert.equal(result.skipped, undefined, `re-run refused after crash ${JSON.stringify(failure)}`);
    const kept = readLines(eventsPath);
    const archived = readLines(archivePath);
    const all = [...archived, ...kept];
    assert.equal(kept.length, 10, `kept count wrong after ${JSON.stringify(failure)}`);
    assert.equal(all.length, 30, `loss or duplication after ${JSON.stringify(failure)}: events=${kept.length} archive=${archived.length}`);
    assert.equal(new Set(all).size, 30, `duplicate lines after ${JSON.stringify(failure)}`);
    for (const line of original) {
      assert.ok(all.includes(line), `event missing after re-run ${JSON.stringify(failure)}`);
    }
  }
});

test("rotating compaction recovers every shard publication boundary without loss or duplication", async () => {
  const scenarios = [
    { link: 2 },
    { rename: 2 },
    { rename: 3 },
    { unlink: 2 },
    { unlink: 3 }
  ];
  for (const failure of scenarios) {
    const dir = tmpDir();
    const eventsPath = path.join(dir, "events.jsonl");
    const archivePath = path.join(dir, "events-archive.jsonl");
    const original = Array.from({ length: 4 }, (_, index) => JSON.stringify({
      ts: `2026-01-01T00:00:0${index}.000Z`,
      type: "rotation-crash",
      id: `event-${index}`,
      summary: index < 3 ? "x".repeat(720_000) : "kept"
    }));
    fs.writeFileSync(eventsPath, `${original.join("\n")}\n`, { mode: 0o600 });

    const fault = faultFs(failure);
    await assert.rejects(
      compactEvents(eventsPath, 1, { filesystem: fault.filesystem }),
      /injected-crash/
    );

    const durablePaths = fs.readdirSync(dir)
      .filter((name) => name === "events.jsonl"
        || name === "events-archive.jsonl"
        || /^events-archive\.\d{6}\.jsonl$/.test(name)
        || name === "events-archive.jsonl.pending")
      .map((name) => path.join(dir, name));
    const midState = durablePaths.flatMap(readLines);
    for (const line of original) {
      assert.ok(midState.includes(line), `event lost after shard crash ${JSON.stringify(failure)}`);
    }

    await compactEvents(eventsPath, 1);
    const settledPaths = fs.readdirSync(dir)
      .filter((name) => name === "events.jsonl"
        || name === "events-archive.jsonl"
        || /^events-archive\.\d{6}\.jsonl$/.test(name))
      .sort()
      .map((name) => path.join(dir, name));
    const settled = settledPaths.flatMap(readLines);
    assert.deepEqual([...settled].sort(), [...original].sort());
  }
});

test("compaction re-run on an already-compacted file is a no-op", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  seedEvents(eventsPath, 30);
  const first = await compactEvents(eventsPath, 10);
  assert.equal(first.archived, 20);
  const second = await compactEvents(eventsPath, 10);
  assert.equal(second.archived, 0);
  assert.equal(readLines(path.join(dir, "events-archive.jsonl")).length, 20);
});

test("compaction skips gracefully when another process holds the lock", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  seedEvents(eventsPath, 30);
  // A held lock must name a pid that is genuinely running: the holder is now
  // judged by liveness, not by how recent its timestamp looks. 99999 read as
  // "held" only while staleness was a stopwatch.
  fs.writeFileSync(`${eventsPath}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  const result = await compactEvents(eventsPath, 10);
  assert.equal(result.skipped, "locked");
  assert.equal(readLines(eventsPath).length, 30, "locked run must not touch the file");
});

test("compaction takes over a stale lock", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  seedEvents(eventsPath, 30);
  fs.writeFileSync(`${eventsPath}.lock`, JSON.stringify({ pid: 99999, ts: Date.now() - 10 * 60_000 }));
  const result = await compactEvents(eventsPath, 10);
  assert.equal(result.archived, 20);
});

test("event append waits for compaction and the appended record survives replacement", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const archivePath = path.join(dir, "events-archive.jsonl");
  seedEvents(eventsPath, 30);

  let releaseRename;
  let renameStarted;
  const allowRename = new Promise((resolve) => {
    releaseRename = resolve;
  });
  const atRename = new Promise((resolve) => {
    renameStarted = resolve;
  });
  const filesystem = {
    ...fsp,
    async rename(source, destination) {
      const isReplacement = path.dirname(source) === path.dirname(eventsPath)
        && path.basename(source).startsWith(`.${path.basename(eventsPath)}.`)
        && path.basename(source).endsWith(".tmp");
      if (isReplacement && destination === eventsPath) {
        renameStarted();
        await allowRename;
      }
      return fsp.rename(source, destination);
    }
  };

  const compaction = compactEvents(eventsPath, 10, { filesystem });
  await atRename;
  const appended = {
    ts: "2026-01-02T00:00:00.000Z",
    type: "concurrent",
    summary: "must survive compaction"
  };
  const append = appendEventRecord(eventsPath, appended);
  releaseRename();

  await Promise.all([compaction, append]);

  const all = [...readLines(archivePath), ...readLines(eventsPath)].map((line) => JSON.parse(line));
  assert.equal(all.length, 31);
  assert.equal(all.filter((entry) => entry.type === "concurrent").length, 1);
});

test("event append creates a missing memory directory before taking the writer lock", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "missing", "memory", "events.jsonl");
  const event = {
    ts: "2026-07-27T12:00:00.000Z",
    type: "first-event",
    summary: "create the store safely"
  };

  await appendEventRecord(eventsPath, event);

  assert.deepEqual(readLines(eventsPath).map((line) => JSON.parse(line)), [event]);
});

test("a fresh partially written event lock is treated as live", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  seedEvents(eventsPath, 1);
  fs.writeFileSync(lockPath, "");

  await assert.rejects(
    appendEventRecord(eventsPath, {
      ts: "2026-07-27T12:00:00.000Z",
      type: "must-not-steal"
    }, { lockRetryDelaysMs: [] }),
    /Timed out waiting for memory writer lock/
  );

  assert.equal(readLines(eventsPath).length, 1);
  assert.equal(fs.existsSync(lockPath), true, "the fresh partial lock still belongs to its creator");
});

test("event append surfaces a lock release failure", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  fs.writeFileSync(eventsPath, "");
  const filesystem = {
    ...fsp,
    async unlink(filePath) {
      if (filePath === lockPath) {
        const error = new Error("permission denied while releasing lock");
        error.code = "EACCES";
        throw error;
      }
      return fsp.unlink(filePath);
    }
  };

  await assert.rejects(
    appendEventRecord(eventsPath, {
      ts: "2026-07-27T12:00:00.000Z",
      type: "release-failure"
    }, { filesystem }),
    /permission denied while releasing lock/
  );

  assert.equal(readLines(eventsPath).length, 1, "the completed append stays visible");
  assert.equal(fs.existsSync(lockPath), true, "a failed release must not be reported as success");
  fs.rmSync(lockPath, { force: true });
});

test("event lock release never removes a replacement owner's lock", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  fs.writeFileSync(eventsPath, "");
  const replacement = {
    pid: process.pid,
    ts: Date.now(),
    token: "replacement-owner"
  };
  const filesystem = {
    ...fsp,
    async appendFile(filePath, content) {
      await fsp.appendFile(filePath, content);
      if (filePath === eventsPath) {
        await fsp.writeFile(lockPath, JSON.stringify(replacement));
      }
    }
  };

  await assert.rejects(
    appendEventRecord(eventsPath, {
      ts: "2026-07-27T12:00:00.000Z",
      type: "ownership-check"
    }, { filesystem }),
    /lock ownership changed/
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacement);
  fs.rmSync(lockPath, { force: true });
});

// --- Defect 2: corrupt lines are preserved and visible, never silently dropped ---

test("readJsonl quarantines a corrupt line verbatim and never returns it as data", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "events.jsonl");
  const badLine = '{"ts":"2026-01-01","type":"trunc';
  fs.writeFileSync(filePath, `{"a":1}\n${badLine}\n{"a":2}\n`);

  const entries = await readJsonl(filePath);
  assert.deepEqual(entries, [{ a: 1 }, { a: 2 }]);

  const badPath = `${filePath}.bad.jsonl`;
  assert.ok(fs.existsSync(badPath), "expected quarantine file next to the source");
  assert.deepEqual(readLines(badPath), [badLine], "bad line must be preserved verbatim");

  // Second read must not duplicate the quarantined line.
  await readJsonl(filePath);
  assert.deepEqual(readLines(badPath), [badLine], "quarantine must be idempotent across reads");
});

test("search over a memory dir with a corrupt line is non-mutating", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const eventsPath = path.join(memoryDir, "events.jsonl");
  fs.writeFileSync(eventsPath, `{"ts":"2026-01-01T00:00:00Z","type":"note","summary":"zebra sighting"}\nnot-json-at-all{\n`);

  const before = fs.readFileSync(eventsPath);
  const results = await searchMemoryDir(memoryDir, "zebra", { limit: 5 });
  assert.equal(results.length, 1, "good line must still be searchable");
  assert.equal(fs.existsSync(`${eventsPath}.bad.jsonl`), false, "read-only search must not create quarantine");
  assert.deepEqual(fs.readFileSync(eventsPath), before);
});

test("memory audit reports preserved corrupt lines", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "aios.json"), '{"schema_version":"1.2.0"}\n');
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), '{"ts":"2026-01-01T00:00:00Z","type":"note","summary":"ok"}\nbroken{\n');
  await readJsonl(path.join(memoryDir, "events.jsonl"));

  const { auditMemory } = await import("../../packages/core/src/memory-audit.mjs");
  const report = await auditMemory(dir, {});
  const finding = report.findings.find((f) => f.code === "corrupt-lines");
  assert.ok(finding, "audit must surface corrupt-line quarantine alongside its other detectors");
  assert.match(finding.message, /1 corrupt line/);
});

test("doctor memory-health check reports bad lines, last compaction, archive size", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), '{"a":1}\nbroken{\n');
  await readJsonl(path.join(memoryDir, "events.jsonl"));
  fs.writeFileSync(path.join(memoryDir, "events-archive.jsonl"), '{"a":0}\n');

  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");
  assert.equal(typeof doctor.checkMemoryHealth, "function", "doctor must expose a memory-health check");
  const check = await doctor.checkMemoryHealth(dir);
  assert.equal(check.status, "warn", "bad lines must warn, not hide");
  assert.match(check.detail, /1 bad line/);
  assert.match(check.detail, /archive/i);
});

// --- Defect 3: one signalFileDate used by read AND trim ---

test("signalFileDate is shared and prefix-aware", async () => {
  const memory = await import("../../packages/core/src/memory.mjs");
  assert.equal(typeof memory.signalFileDate, "function", "signalFileDate must be exported for all callers");
  assert.equal(memory.signalFileDate("laptop-2026-06-12.jsonl"), "2026-06-12");
  assert.equal(memory.signalFileDate("2026-06-12.jsonl"), "2026-06-12");
  assert.equal(memory.signalFileDate("notes.jsonl"), "");
});

test("trimSignals removes old machine-namespaced files and keeps undated files", async () => {
  // The signals dir must be a real memory/signals/ so the sibling archive lands
  // inside this test's tmpdir instead of the shared OS temp root.
  const dir = tmpDir();
  const signalsDir = path.join(dir, "memory", "signals");
  fs.mkdirSync(signalsDir, { recursive: true });
  const old = isoDate(new Date(Date.now() - 45 * 86400000));
  const today = isoDate(new Date());
  for (const name of [`laptop-${old}.jsonl`, `${old}.jsonl`, `laptop-${today}.jsonl`, "notes.jsonl"]) {
    fs.writeFileSync(path.join(signalsDir, name), '{"x":1}\n');
  }

  const result = await trimSignals(signalsDir, 30);
  assert.equal(result.removed, 2, "both dated old files (plain and machine-prefixed) must be trimmed");
  const remaining = fs.readdirSync(signalsDir).sort();
  assert.deepEqual(remaining, [`laptop-${today}.jsonl`, "notes.jsonl"].sort(), "within-window and undated files must survive");
});

// --- Defect 5: signal trimming must archive before it removes ---

function signalsFixture({ staleFiles = 1, linesPerFile = 1, lineBytes = 0 } = {}) {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  const signalsDir = path.join(memoryDir, "signals");
  fs.mkdirSync(signalsDir, { recursive: true });
  const archivePath = path.join(memoryDir, "signals-archive.jsonl");
  const names = [];
  for (let f = 0; f < staleFiles; f++) {
    const date = isoDate(new Date(Date.now() - (45 + f) * 86400000));
    const name = `${date}.jsonl`;
    const lines = [];
    for (let i = 0; i < linesPerFile; i++) {
      lines.push(JSON.stringify({
        ts: `${date}T00:00:00.000Z`,
        type: "signal",
        n: `${f}-${i}`,
        ...(lineBytes > 0 ? { pad: "x".repeat(lineBytes) } : {})
      }));
    }
    fs.writeFileSync(path.join(signalsDir, name), lines.join("\n") + "\n");
    names.push(name);
  }
  return { dir, memoryDir, signalsDir, archivePath, names };
}

test("trimSignals archives every line before it deletes the file", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 2, linesPerFile: 3 });

  const result = await trimSignals(signalsDir, 30);

  assert.equal(result.removed, 2, "both stale files are removed");
  assert.equal(result.archivedFiles, 2, "both stale files are accounted for as archived");
  assert.equal(result.archived, 6, "every non-empty line is archived");
  assert.equal(result.archivePath, archivePath, "the archive path is reported for the CLI and doctor");
  assert.equal(readLines(archivePath).length, 6, "the archive holds every trimmed line");
  assert.ok(result.freedBytes > 0);
});

test("the signals archive is a sibling of signals/, never inside it", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 1, linesPerFile: 2 });

  await trimSignals(signalsDir, 30);

  assert.ok(fs.existsSync(archivePath), "archive must live next to signals/, mirroring events-archive.jsonl");
  assert.deepEqual(fs.readdirSync(signalsDir), [], "nothing DotAIOS writes may land inside signals/");
});

test("re-running trimSignals never duplicates archived lines", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 2, linesPerFile: 4 });

  await trimSignals(signalsDir, 30);
  const second = await trimSignals(signalsDir, 30);

  assert.equal(second.removed, 0, "nothing left to remove");
  assert.equal(readLines(archivePath).length, 8, "the archive must not grow on a no-op run");
});

test("a crash while deleting a trimmed signal file loses no line and duplicates none", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 3, linesPerFile: 2 });
  const before = fs.readdirSync(signalsDir).sort()
    .flatMap((name) => readLines(path.join(signalsDir, name)));

  // The source unlink is the commit point; crash on the second one.
  const { filesystem } = faultFs({ unlink: 2 });
  await assert.rejects(() => trimSignals(signalsDir, 30, { filesystem }));

  await trimSignals(signalsDir, 30);

  const archived = readLines(archivePath);
  assert.deepEqual([...archived].sort(), [...before].sort(), "every line survives exactly once");
  assert.deepEqual(fs.readdirSync(signalsDir), [], "the retry finishes the removal");
});

test("a crash while publishing the signals archive keeps the source file", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 2, linesPerFile: 2 });

  const { filesystem } = faultFs({ link: 1 });
  await assert.rejects(() => trimSignals(signalsDir, 30, { filesystem }));

  assert.equal(fs.readdirSync(signalsDir).length, 2, "nothing may be deleted before the archive holds it");

  const retry = await trimSignals(signalsDir, 30);
  assert.equal(retry.removed, 2);
  assert.equal(readLines(archivePath).length, 4, "the retry archives each line exactly once");
});

test("a staged signals batch left behind by a crash is recovered, not lost", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 1, linesPerFile: 2 });

  // Crash after the archive append, before the staging file is dropped.
  const { filesystem } = faultFs({ unlink: 1 });
  await assert.rejects(() => trimSignals(signalsDir, 30, { filesystem }));
  assert.ok(fs.existsSync(`${archivePath}.pending`), "the staged batch is still on disk");

  const retry = await trimSignals(signalsDir, 30);
  assert.equal(retry.removed, 1);
  assert.equal(fs.existsSync(`${archivePath}.pending`), false, "recovery clears the staging file");
  assert.equal(readLines(archivePath).length, 2, "recovery must not duplicate the batch");
});

test("trimSignals skips when another process holds the archive lock", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 1, linesPerFile: 1 });
  fs.writeFileSync(`${archivePath}.lock`, JSON.stringify({ pid: 1, ts: Date.now() }));

  const result = await trimSignals(signalsDir, 30);

  assert.equal(result.skipped, "locked");
  assert.equal(result.removed, 0, "a live lock holder must stop the delete, not just the archive");
  assert.equal(fs.readdirSync(signalsDir).length, 1);
});

test("a signal batch larger than the dedupe window is not re-archived on retry", async () => {
  // 40 x ~10 KB = ~400 KB of staged lines, comfortably past ARCHIVE_TAIL_BYTES.
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 4, linesPerFile: 10, lineBytes: 10_000 });
  const before = fs.readdirSync(signalsDir).sort()
    .flatMap((name) => readLines(path.join(signalsDir, name)));

  const { filesystem } = faultFs({ unlink: 2 });
  await assert.rejects(() => trimSignals(signalsDir, 30, { filesystem }));
  await trimSignals(signalsDir, 30);

  const archived = readLines(archivePath);
  assert.equal(archived.length, before.length, `expected ${before.length} archived lines, got ${archived.length}`);
  assert.equal(new Set(archived).size, archived.length, "no line may appear twice");
});

test("an events batch larger than the dedupe window is not re-archived on retry", async () => {
  const dir = tmpDir();
  const eventsPath = path.join(dir, "events.jsonl");
  const archivePath = path.join(dir, "events-archive.jsonl");
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(JSON.stringify({ ts: `2026-01-01T00:00:00.${String(i).padStart(4, "0")}Z`, type: "seed", n: i, pad: "x".repeat(10_000) }));
  }
  fs.writeFileSync(eventsPath, lines.join("\n") + "\n");

  // Crash on the staging unlink inside the flush: the archive already holds the
  // ~500 KB batch, which is far larger than the dedupe tail window.
  const { filesystem } = faultFs({ unlink: 1 });
  await assert.rejects(() => compactEvents(eventsPath, 10, { filesystem }));
  await compactEvents(eventsPath, 10);

  const archived = readLines(archivePath);
  assert.equal(archived.length, 50, `expected 50 archived events, got ${archived.length}`);
  assert.equal(new Set(archived).size, archived.length, "no event may appear twice");
});

test("a trimmed signal is still findable through search", async () => {
  const { memoryDir, signalsDir } = signalsFixture({ staleFiles: 1, linesPerFile: 1 });
  const stale = fs.readdirSync(signalsDir)[0];
  fs.writeFileSync(
    path.join(signalsDir, stale),
    JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "signal", summary: "needle in a trimmed signal" }) + "\n"
  );

  await trimSignals(signalsDir, 30);

  const results = await searchMemoryDir(memoryDir, "needle");
  assert.equal(results.length, 1, "an archived signal must not become a write-only graveyard");
  assert.equal(results[0].source, "memory/signals-archive.jsonl");
});

test("the maintenance receipt proves signal files were archived, not just deleted", async () => {
  const { dir, memoryDir, signalsDir } = signalsFixture({ staleFiles: 2, linesPerFile: 3 });
  const eventsPath = path.join(memoryDir, "events.jsonl");
  seedEvents(eventsPath, 150); // force an immediate overflow run

  const memory = await import("../../packages/core/src/memory.mjs");
  await memory.maintainMemory(dir);

  const receipt = readLines(eventsPath).map((line) => JSON.parse(line))
    .find((entry) => entry.type === "memory.maintenance");
  assert.ok(receipt, "maintenance must write a receipt");
  assert.equal(receipt.signal_files_removed, 2);
  assert.equal(receipt.signal_files_archived, 2, "the receipt must prove archiving, so doctor can audit it");
  assert.equal(receipt.signal_lines_archived, 6);
  assert.equal(fs.readdirSync(signalsDir).length, 0);
  assert.equal(readLines(path.join(memoryDir, "signals-archive.jsonl")).length, 6);
});

// --- Defect 4: opportunistic maintenance ---

test("a bloated events log auto-compacts on the next appendEvent without manual cleanup", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const eventsPath = path.join(memoryDir, "events.jsonl");
  seedEvents(eventsPath, 150); // > 2× RECENT_EVENT_LIMIT (50)

  await appendEvent(eventsPath, { type: "probe", summary: "trigger" });

  const lines = readLines(eventsPath);
  assert.ok(lines.length <= 60, `expected auto-compaction, events.jsonl still has ${lines.length} lines`);
  assert.ok(fs.existsSync(path.join(memoryDir, "events-archive.jsonl")), "archive must exist after auto-compaction");
  const receipt = lines.map((l) => JSON.parse(l)).find((e) => e.type === "memory.maintenance");
  assert.ok(receipt, "maintenance must write a receipt event to events.jsonl");
});

test("maintenance runs at most once per day unless the log overflows", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const eventsPath = path.join(memoryDir, "events.jsonl");
  seedEvents(eventsPath, 5);

  const memory = await import("../../packages/core/src/memory.mjs");
  assert.equal(typeof memory.maintainMemory, "function", "maintainMemory must be the one maintenance seam");

  const t0 = Date.parse("2026-02-01T10:00:00Z");
  const first = await memory.maintainMemory(dir, { now: () => t0 });
  assert.equal(first.ran, false, "fresh folder initializes the daily clock without churning");

  const second = await memory.maintainMemory(dir, { now: () => t0 + 3600_000 });
  assert.equal(second.ran, false, "same-day re-check must not run again");

  const third = await memory.maintainMemory(dir, { now: () => t0 + 25 * 3600_000 });
  assert.equal(third.ran, true, "next day must run maintenance");

  const receipts = readLines(eventsPath).map((l) => JSON.parse(l)).filter((e) => e.type === "memory.maintenance");
  assert.equal(receipts.length, 1, "exactly one maintenance receipt after one real run");
});

// --- Defect 6: doctor must not certify a folder healthy while signals vanish ---

function receipt(daysAgo, fields) {
  return JSON.stringify({
    ts: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    type: "memory.maintenance",
    ...fields
  });
}

test("doctor warns when maintenance receipts show more signal files removed than archived", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), [
    receipt(3, { signal_files_removed: 10 }),
    receipt(2, { signal_files_removed: 11 }),
    receipt(1, { signal_files_removed: 1, signal_files_archived: 1 })
  ].join("\n") + "\n");

  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");
  const check = await doctor.checkMemoryHealth(dir);

  assert.equal(check.status, "warn", "a folder that lost signal files is not healthy");
  assert.match(check.detail, /21/, "the number of unarchived removals must be named");
  assert.ok(check.fix, "a warn without a fix is just noise");
});

test("doctor stays ok when every removed signal file was archived", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), [
    receipt(2, { signal_files_removed: 11, signal_files_archived: 11 }),
    receipt(1, { signal_files_removed: 0, signal_files_archived: 0 })
  ].join("\n") + "\n");

  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");
  const check = await doctor.checkMemoryHealth(dir);

  assert.equal(check.status, "ok");
});

test("doctor ignores maintenance receipts older than the lookback window", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "events.jsonl"),
    receipt(200, { signal_files_removed: 40 }) + "\n"
  );

  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");
  const check = await doctor.checkMemoryHealth(dir);

  assert.equal(check.status, "ok", "an old loss must stop nagging once it is out of the window");
});

test("doctor counts live signal files without opening them", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  const signalsDir = path.join(memoryDir, "signals");
  fs.mkdirSync(signalsDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), '{"a":1}\n');
  fs.writeFileSync(path.join(signalsDir, "2026-05-01.jsonl"), '{"x":1}\n');
  fs.writeFileSync(path.join(signalsDir, "2026-05-02.jsonl"), '{"x":2}\n');

  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");
  const check = await doctor.checkMemoryHealth(dir);

  assert.match(check.detail, /2 signal file/);
});

test("the memory-health check never writes to the folder it inspects", async () => {
  const dir = tmpDir();
  const memoryDir = path.join(dir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  // A corrupt line would make the shared JSONL reader write a .bad.jsonl
  // sidecar. A health check must not be the thing that mutates the folder,
  // and must not race the maintenance it is auditing.
  fs.writeFileSync(path.join(memoryDir, "events.jsonl"), '{"a":1}\nbroken{\n');
  const before = fs.readdirSync(memoryDir).sort();

  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");
  await doctor.checkMemoryHealth(dir);

  assert.deepEqual(fs.readdirSync(memoryDir).sort(), before, "no file may appear or change");
});

// --- Defect 7: staleness has to be visible, not inferred ---

function contextFolder({ ageDays = 0 } = {}) {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "context"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  const files = [
    "context/identity.md",
    "context/work.md",
    "context/priorities.md",
    "context/north-star.md",
    "memory/profile.md"
  ];
  const mtime = new Date(Date.now() - ageDays * 86400000);
  for (const relative of files) {
    const filePath = path.join(dir, relative);
    fs.writeFileSync(filePath, `# ${relative}\n`);
    fs.utimesSync(filePath, mtime, mtime);
  }
  return { dir, files };
}

test("doctor stays quiet about context a user touched recently", async () => {
  const { dir } = contextFolder({ ageDays: 5 });
  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");

  const check = await doctor.checkContextFreshness(dir);

  assert.equal(check.status, "ok");
  assert.match(check.detail, /5 day/);
});

test("doctor warns about context nobody has touched in a quarter", async () => {
  const { dir } = contextFolder({ ageDays: 200 });
  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");

  const check = await doctor.checkContextFreshness(dir);

  assert.equal(check.status, "warn");
  assert.match(check.detail, /context\/work\.md/);
  assert.match(check.detail, /200 day/);
  assert.ok(check.fix);
});

test("doctor never calls a file DotAIOS itself generated stale", async () => {
  const { dir } = contextFolder({ ageDays: 1 });
  for (const relative of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
    const filePath = path.join(dir, relative);
    fs.writeFileSync(filePath, "generated\n");
    const old = new Date(Date.now() - 400 * 86400000);
    fs.utimesSync(filePath, old, old);
  }
  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");

  const check = await doctor.checkContextFreshness(dir);

  assert.equal(check.status, "ok", "an untouched template is not a stale fact");
});

test("a future mtime reports zero days, never a negative age", async () => {
  const { dir } = contextFolder({ ageDays: -30 });
  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");

  const check = await doctor.checkContextFreshness(dir);

  assert.equal(check.status, "ok");
  assert.match(check.detail, /0 day/);
  assert.doesNotMatch(check.detail, /-\d/);
});

test("freshness is silent on a folder with no context files yet", async () => {
  const dir = tmpDir();
  const doctor = await import("../../packages/cli/src/commands/doctor.mjs");

  const check = await doctor.checkContextFreshness(dir);

  assert.equal(check.status, "ok");
});

// --- The signals lock now guards deletion of user data, so it must match the
// session index lock: atomic steal, and liveness rather than a stopwatch. ---

test("a lock held by a live process is respected however old it looks", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 1, linesPerFile: 2 });
  // Our own pid is unambiguously alive; the timestamp is far past the stale window.
  fs.writeFileSync(`${archivePath}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * 60_000 }));

  const result = await trimSignals(signalsDir, 30);

  assert.equal(result.skipped, "locked", "a long-running holder must never be overrun");
  assert.equal(fs.readdirSync(signalsDir).length, 1, "and its files must survive");
});

test("a lock left by a dead process is reclaimed without waiting out the window", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 1, linesPerFile: 2 });
  // A pid that cannot be running, with a timestamp well inside the stale window.
  fs.writeFileSync(`${archivePath}.lock`, JSON.stringify({ pid: 2147483646, ts: Date.now() }));

  const result = await trimSignals(signalsDir, 30);

  assert.equal(result.removed, 1, "a crashed holder must not wedge maintenance for five minutes");
  assert.equal(readLines(archivePath).length, 2);
});

test("a stale lock is taken over by rename, never by unlink-then-write", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 1, linesPerFile: 1 });
  fs.writeFileSync(`${archivePath}.lock`, JSON.stringify({ pid: 2147483646, ts: Date.now() }));

  const seen = [];
  const { filesystem } = faultFs({});
  const watched = new Proxy(filesystem, {
    get: (target, name) => (...args) => {
      if (typeof args[0] === "string" && args[0].includes(".lock")) seen.push(`${String(name)}:${args[0]}`);
      return target[name](...args);
    }
  });

  await trimSignals(signalsDir, 30, { filesystem: watched });

  // unlink-then-write lets two processes both delete a stale lock and both
  // acquire. rename() is atomic: exactly one winner.
  assert.ok(
    seen.some((call) => call.startsWith("rename:")),
    `the steal must be atomic; calls were ${JSON.stringify(seen)}`
  );
});

test("a signal file removed by a sync client mid-run does not abort maintenance", async () => {
  const { signalsDir, archivePath } = signalsFixture({ staleFiles: 3, linesPerFile: 2 });
  const names = fs.readdirSync(signalsDir).sort();

  // Drop the second file after its lines are staged but before the unlink loop
  // reaches it — what iCloud or Dropbox does to a folder while it is syncing.
  let reads = 0;
  const { filesystem } = faultFs({});
  const racing = new Proxy(filesystem, {
    get: (target, name) => (...args) => {
      if (name === "readFile" && String(args[0]).endsWith(".jsonl") && ++reads === 2) {
        return target.readFile(...args).then((content) => {
          fs.rmSync(path.join(signalsDir, names[1]), { force: true });
          return content;
        });
      }
      return target[name](...args);
    }
  });

  const result = await trimSignals(signalsDir, 30, { filesystem: racing });

  assert.equal(result.removed, 3, "the run must finish, not throw and leave the rest untrimmed");
  assert.equal(readLines(archivePath).length, 6, "every staged line still reaches the archive");
  assert.deepEqual(fs.readdirSync(signalsDir), []);
});
