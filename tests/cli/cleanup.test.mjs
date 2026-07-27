import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanupCommand } from "../../packages/cli/src/commands/cleanup.mjs";

test("cleanup fails loudly when the event writer lock is held", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-cleanup-lock-"));
  const aiosPath = path.join(root, "aios");
  const memoryDir = path.join(aiosPath, "memory");
  const eventsPath = path.join(memoryDir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{}\n");
  await fs.writeFile(eventsPath, "");
  await fs.writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    ts: Date.now(),
    token: "held-by-test"
  }));

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await assert.rejects(
      cleanupCommand(["--path", aiosPath]),
      /memory writer lock/i
    );
    assert.doesNotMatch(logs.join("\n"), /nothing to compact/i);
  } finally {
    console.log = originalLog;
    await fs.rm(root, { recursive: true, force: true });
  }
});
