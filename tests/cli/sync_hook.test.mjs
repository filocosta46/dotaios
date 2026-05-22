import test from "node:test";
import assert from "node:assert/strict";
import { fireSyncHook } from "../../packages/cli/src/lib/sync-hook.mjs";

test("fireSyncHook returns immediately when sync not enabled", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "ingest",
    isSyncEnabled: async () => false,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook does not spawn when command is 'sync'", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "sync",
    isSyncEnabled: async () => true,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook spawns dotaios sync tick when enabled", async () => {
  let args = null;
  await fireSyncHook({
    command: "ingest",
    isSyncEnabled: async () => true,
    spawnImpl: (cmd, a) => { args = [cmd, ...a]; return { unref: () => {} }; }
  });
  assert.ok(args[args.length - 2] === "sync");
  assert.ok(args[args.length - 1] === "tick");
});

test("fireSyncHook swallows any error", async () => {
  await fireSyncHook({
    command: "ingest",
    isSyncEnabled: async () => { throw new Error("boom"); },
    spawnImpl: () => {}
  });
  // no throw → pass
});
