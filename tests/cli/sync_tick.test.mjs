import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runTick, acquireLock, releaseLock } from "../../packages/cli/src/sync/tick.mjs";
import { runTickCommand } from "../../packages/cli/src/sync/tick-cmd.mjs";

async function tmpLock() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-tick-"));
  return { lockPath: path.join(dir, "sync.lock"), dir };
}

function makeGit({ branch = "main", dirty = false, pullResult = "up-to-date", commitSha = null, calls = [] } = {}) {
  return {
    async currentBranch() { calls.push(`branch-current:${branch ?? "unknown"}`); return branch; },
    async dirty() { calls.push("dirty"); return dirty; },
    async commitAll(msg) { calls.push(`commit:${msg.slice(0, 15)}`); return commitSha; },
    async push(b) { calls.push(`push:${b}`); },
    async fetch() { calls.push("fetch"); },
    async pullRebase(b) { calls.push(`pullRebase:${b}`); return pullResult; },
    async currentSha() { return "sha-current"; }
  };
}

test("tick skips without mutating a non-main checkout", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const written = [];
    const events = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async (patch) => written.push(patch),
      makeGit: () => makeGit({ branch: "codex/portable-skills-propagation", dirty: true, pullResult: "conflict", calls }),
      appendEvent: async (event) => events.push(event),
      now: () => Date.now()
    });
    assert.equal(result.skipped, "not-main-branch");
    assert.deepEqual(calls, ["branch-current:codex/portable-skills-propagation"]);
    assert.deepEqual(written, []);
    assert.deepEqual(events, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick skips without mutating when the checkout branch is unknown", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const written = [];
    const events = [];
    const git = makeGit({ dirty: true, pullResult: "conflict", calls });
    git.currentBranch = async () => {
      calls.push("branch-current:unknown");
      throw new Error("not a worktree");
    };
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async (patch) => written.push(patch),
      makeGit: () => git,
      appendEvent: async (event) => events.push(event),
      now: () => Date.now()
    });
    assert.equal(result.skipped, "not-main-branch");
    assert.deepEqual(calls, ["branch-current:unknown"]);
    assert.deepEqual(written, []);
    assert.deepEqual(events, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick skips without mutating a detached HEAD", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const written = [];
    const events = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async (patch) => written.push(patch),
      makeGit: () => makeGit({ branch: null, dirty: true, pullResult: "conflict", calls }),
      appendEvent: async (event) => events.push(event),
      now: () => Date.now()
    });
    assert.equal(result.skipped, "not-main-branch");
    assert.deepEqual(calls, ["branch-current:unknown"]);
    assert.deepEqual(written, []);
    assert.deepEqual(events, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick skips when no config", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const result = await runTick({
      lockPath,
      readConfig: async () => null,
      writeConfig: async () => {},
      makeGit: () => makeGit(),
      appendEvent: async () => {},
      now: () => Date.now()
    });
    assert.equal(result.skipped, "no-token");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick skips when within 10s of last tick", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: new Date(1000).toISOString() }),
      writeConfig: async () => {},
      makeGit: () => makeGit(),
      appendEvent: async () => {},
      now: () => 5000 // 4 seconds later
    });
    assert.equal(result.skipped, "rate-limit-gap");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick skips with 'locked' when lock already held", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    // pre-create a fresh (non-stale) lock
    await fs.writeFile(lockPath, JSON.stringify({ pid: 99999, at: Date.now() }));
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: true }),
      appendEvent: async () => {},
      now: () => Date.now()
    });
    assert.equal(result.skipped, "locked");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick commits before pulling, then pushes when dirty and remote up-to-date", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: true, pullResult: "up-to-date", commitSha: "deadbeef", calls }),
      appendEvent: async () => {},
      now: () => Date.now()
    });
    assert.ok(calls.includes("pullRebase:main"));
    assert.ok(calls.includes("push:main"));
    const commitIdx = calls.findIndex((c) => c.startsWith("commit:sync:"));
    const pullIdx = calls.indexOf("pullRebase:main");
    assert.ok(commitIdx !== -1, "must commit local work");
    assert.ok(commitIdx < pullIdx, "commit must happen before the rebase pull");
    assert.equal(result.pushed, true);
    assert.equal(result.sha, "sha-current", "reported sha is HEAD after push, not the pre-rebase commit");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick releases lock after a successful run", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: false }),
      appendEvent: async () => {},
      now: () => Date.now()
    });
    // lock file must be gone after the run
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick fails closed on a rebase conflict without changing local state", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const events = [];
    const written = [];
    const now = Date.parse("2026-07-15T10:00:00.000Z");
    const summary = "Sync stopped because local and remote changes overlap. Your pre-existing edits were preserved. DotAIOS recorded the conflict locally and did not create a recovery branch, reset files, or push. Ask your agent to resolve it safely, then run `dotaios sync now` again.";
    const result = await runTick({
      lockPath,
      readConfig: async () => ({
        access_token: "T",
        last_tick_at: null,
        last_pull_at: "2026-07-14T10:00:00.000Z",
        last_push_sha: "previous-sha"
      }),
      writeConfig: async (patch) => written.push(patch),
      makeGit: () => makeGit({ dirty: true, pullResult: "conflict", commitSha: "newsha", calls }),
      appendEvent: async (e) => events.push(e),
      now: () => now
    });
    assert.deepEqual(calls, [
      "branch-current:main",
      "dirty",
      "commit:sync: 2026-07-1",
      "pullRebase:main"
    ]);
    assert.deepEqual(events, [{
      type: "sync-conflict",
      summary,
      at: "2026-07-15T10:00:00.000Z"
    }]);
    assert.deepEqual(written, [{
      last_tick_at: "2026-07-15T10:00:00.000Z",
      last_error: summary
    }], "conflict state must not overwrite the last successful pull or push receipt");
    assert.deepEqual(result, {
      conflict: true,
      pulled: "conflict",
      pushed: false,
      sha: null,
      error: summary
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick does NOT branch on a clean rebase even when remote was ahead", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: true, pullResult: "rebased", commitSha: "newsha", calls }),
      appendEvent: async () => {},
      now: () => Date.now()
    });
    assert.ok(!calls.some((c) => c.startsWith("branch:")), "no orphan branch on a clean rebase");
    assert.ok(!calls.includes("reset:main"), "no hard reset on a clean rebase");
    assert.ok(calls.includes("push:main"), "rebased local commit still pushed");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick writes last_error on git failure and does not throw", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const written = [];
    const failingGit = {
      currentBranch: async () => "main",
      dirty: async () => true,
      commitAll: async () => "sha",
      push: async () => { throw new Error("network down"); },
      fetch: async () => {},
      pullRebase: async () => "up-to-date",
      currentSha: async () => "sha"
    };
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async (patch) => written.push(patch),
      makeGit: () => failingGit,
      appendEvent: async () => {},
      now: () => Date.now()
    });
    assert.equal(result.error, "network down");
    assert.ok(written.some((p) => p.last_error?.includes("network down")));
    // lock released even on failure
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("acquireLock steals a stale lock older than staleMs", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    // write a lock timestamped 10 minutes ago
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 10 * 60 * 1000 }));
    const got = await acquireLock(lockPath, { now: () => Date.now(), staleMs: 5 * 60 * 1000 });
    assert.equal(got, true);
    await releaseLock(lockPath);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("acquireLock returns false when a fresh lock is held", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now() }));
    const got = await acquireLock(lockPath, { now: () => Date.now(), staleMs: 5 * 60 * 1000 });
    assert.equal(got, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick does not throw when writeConfig/appendEvent reject in error path", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const failingGit = {
      currentBranch: async () => "main",
      dirty: async () => true,
      commitAll: async () => "sha",
      push: async () => { throw new Error("network down"); },
      fetch: async () => {},
      pullRebase: async () => "up-to-date",
      currentSha: async () => "sha"
    };
    // both side-effect writers reject — runTick must still resolve, not throw
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async () => { throw new Error("disk full"); },
      makeGit: () => failingGit,
      appendEvent: async () => { throw new Error("events.jsonl unwritable"); },
      now: () => Date.now()
    });
    assert.equal(result.error, "network down");
    // lock still released despite all the failures
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("acquireLock: two racers on a stale lock — exactly one wins", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    // pre-write a stale lock (10 min old)
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 10 * 60 * 1000 }));
    const opts = { now: () => Date.now(), staleMs: 5 * 60 * 1000 };
    const [a, b] = await Promise.all([
      acquireLock(lockPath, opts),
      acquireLock(lockPath, opts)
    ]);
    // exactly one true, one false
    assert.equal([a, b].filter(Boolean).length, 1);
    await releaseLock(lockPath);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("runTickCommand resolves without throwing when sync not enabled", async () => {
  // With no sync.json configured, runTick returns { skipped: "no-token" }.
  // runTickCommand must simply resolve — no throw, no crash.
  const origLog = console.log;
  console.log = () => {};
  try {
    await runTickCommand([]);
  } finally { console.log = origLog; }
  // reaching here = did not throw
  assert.ok(true);
});
