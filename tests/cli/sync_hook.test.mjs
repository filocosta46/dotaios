import test from "node:test";
import assert from "node:assert/strict";
import {
  fireSyncHook,
  skipsPortableMirrorSync
} from "../../packages/cli/src/lib/sync-hook.mjs";

test("project commands only request outer sync after an applied catalog change", () => {
  for (const args of [
    ["restore"],
    ["restore", "client", "--dry-run"],
    ["list"],
    ["resolve", "client"],
    ["doctor"],
    ["context", "client"],
    ["add", "/tmp/client"]
  ]) {
    assert.equal(skipsPortableMirrorSync("project", args), true, args.join(" "));
  }
  assert.equal(skipsPortableMirrorSync("project", ["add", "/tmp/client", "--apply"]), false);
  assert.equal(skipsPortableMirrorSync("project", ["add", "/tmp/client", "--yes"]), false);
  assert.equal(skipsPortableMirrorSync("project", ["source", "add", "client", "/tmp/assets"]), true);
  assert.equal(skipsPortableMirrorSync("project", ["source", "add", "client", "/tmp/assets", "--apply"]), false);
  assert.equal(skipsPortableMirrorSync("project", ["source", "bind", "client", "assets", "/tmp/assets", "--apply"]), true);
  assert.equal(skipsPortableMirrorSync("project", ["source", "grant", "client", "assets", "--apply"]), true);
  assert.equal(skipsPortableMirrorSync("project", ["source", "retrieve", "client", "--task", "assets"]), true);
});

test("compact, hook JSON, and lean briefs are classified read-only and never spawn sync", async () => {
  for (const args of [
    ["--compact"],
    ["--compact", "--json"],
    ["--lean"]
  ]) {
    const readOnly = skipsPortableMirrorSync("brief", args);
    assert.equal(readOnly, true, args.join(" "));
    let spawned = false;
    await fireSyncHook({
      allowAutoSync: true,
      command: "brief",
      isSyncEnabled: async () => true,
      readOnly,
      spawnImpl: () => { spawned = true; },
      testContext: null
    });
    assert.equal(spawned, false, args.join(" "));
  }
});

test("search and skill lookup surfaces are classified read-only while skill writers are not", async () => {
  const readOnlyCommands = [
    ["search", ["continuity"]],
    ["skills", []],
    ["skills", ["audit"]],
    ["skills", ["resolve", "plan my day"]],
    ["skills", ["resolve", "--boot-context"]],
    ["skills", ["sync-triggers"]],
    ["skill", ["list"]]
  ];

  for (const [command, args] of readOnlyCommands) {
    const readOnly = skipsPortableMirrorSync(command, args);
    assert.equal(readOnly, true, `${command} ${args.join(" ")}`);
    let spawned = false;
    await fireSyncHook({
      allowAutoSync: true,
      command,
      isSyncEnabled: async () => true,
      readOnly,
      spawnImpl: () => { spawned = true; },
      testContext: null
    });
    assert.equal(spawned, false, `${command} ${args.join(" ")}`);
  }

  assert.equal(skipsPortableMirrorSync("skills", ["install", "/tmp/reviewed"]), false);
  assert.equal(skipsPortableMirrorSync("skills", ["sync-triggers", "--apply"]), false);
  assert.equal(skipsPortableMirrorSync("skill", ["add", "/tmp/reviewed"]), false);
  assert.equal(skipsPortableMirrorSync("skill", ["remove", "reviewed"]), false);
});

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

test("fireSyncHook does not spawn after a dry-run command", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "activate",
    dryRun: true,
    isSyncEnabled: async () => true,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook does not spawn inside the Node test runner", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "activate",
    testContext: "child-v8",
    isSyncEnabled: async () => true,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook does not spawn after an explicitly read-only command", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "skills",
    readOnly: true,
    testContext: null,
    isSyncEnabled: async () => true,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook refuses automatic sync without explicit worktree opt-in", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "ingest",
    testContext: null,
    isSyncEnabled: async () => true,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook spawns dotaios sync tick when enabled", async () => {
  let args = null;
  await fireSyncHook({
    command: "ingest",
    testContext: null,
    allowAutoSync: true,
    isSyncEnabled: async () => true,
    spawnImpl: (cmd, a) => { args = [cmd, ...a]; return { unref: () => {} }; }
  });
  assert.ok(args[args.length - 2] === "sync");
  assert.ok(args[args.length - 1] === "tick");
});

test("fireSyncHook swallows any error", async () => {
  await fireSyncHook({
    command: "ingest",
    testContext: null,
    isSyncEnabled: async () => { throw new Error("boom"); },
    spawnImpl: () => {}
  });
  // no throw → pass
});
