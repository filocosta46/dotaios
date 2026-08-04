import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { importCommand } from "../../packages/cli/src/commands/import.mjs";

test("event import fails loudly after the shared memory writer lock retry budget", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-import-event-"));
  const aiosPath = path.join(root, "aios");
  const memoryDir = path.join(aiosPath, "memory");
  const eventsPath = path.join(memoryDir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  const sourcePath = path.join(root, "import.json");
  const existing = {
    ts: "2026-07-26T12:00:00.000Z",
    type: "existing",
    summary: "must remain"
  };
  const imported = {
    ts: "2026-07-27T12:00:00.000Z",
    type: "imported-decision",
    summary: "must wait for compaction"
  };

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{}\n");
  await fs.writeFile(eventsPath, `${JSON.stringify(existing)}\n`);
  await fs.writeFile(sourcePath, `${JSON.stringify({ events: [imported] })}\n`);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));

  try {
    await assert.rejects(
      importCommand([sourcePath, "--path", aiosPath, "--apply"]),
      /Timed out waiting for memory writer lock/
    );
    assert.equal(
      await fs.readFile(eventsPath, "utf8"),
      `${JSON.stringify(existing)}\n`,
      "import must not append around a live writer lock"
    );

    await fs.rm(lockPath);
    await importCommand([sourcePath, "--path", aiosPath, "--apply"]);

    const events = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "existing");
    assert.equal(events[1].type, "imported-decision");
    assert.equal(events[1].ts, imported.ts, "imports retain their existing ts-based schema");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
