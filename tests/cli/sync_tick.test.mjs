import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runTick as runTickImpl, acquireLock, releaseLock } from "../../packages/cli/src/sync/tick.mjs";
import { appendSyncEvent, reportTickResult, runTickCommand } from "../../packages/cli/src/sync/tick-cmd.mjs";

async function tmpLock() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-tick-"));
  return { lockPath: path.join(dir, "sync.lock"), dir };
}

function runTick(options) {
  const readConfig = options.readConfig;
  const makeGitFactory = options.makeGit;
  return runTickImpl({
    verifyRepoPrivate: async () => true,
    ...options,
    readConfig: async () => {
      const cfg = await readConfig();
      return cfg?.access_token
        ? { repo_full_name: "alice/alice-aios", ...cfg }
        : cfg;
    },
    makeGit: (factoryOptions) => {
      const client = makeGitFactory(factoryOptions);
      if (typeof client.originUrl !== "function") {
        client.originUrl = async () => "https://github.com/alice/alice-aios.git";
      }
      return client;
    }
  });
}

function makeGit({ branch = "main", dirty = false, pullResult = "up-to-date", commitSha = null, ahead = false, calls = [] } = {}) {
  return {
    async currentBranch() { calls.push(`branch-current:${branch ?? "unknown"}`); return branch; },
    async dirty() { calls.push("dirty"); return dirty; },
    async commitAll(msg) { calls.push(`commit:${msg.slice(0, 15)}`); return commitSha; },
    async push(b) { calls.push(`push:${b}`); },
    async fetch() { calls.push("fetch"); },
    async pullRebase(b) { calls.push(`pullRebase:${b}`); return pullResult; },
    async hasUnpushedCommits(b) { calls.push(`ahead:${b}`); return ahead; },
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
      readConfig: async () => ({ access_token: "T", repo_full_name: "alice/alice-aios", last_tick_at: null }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: true, pullResult: "up-to-date", commitSha: "deadbeef", calls }),
      verifyRepoPrivate: async ({ accessToken, fullName }) => {
        calls.push(`privacy:${accessToken}:${fullName}`);
        return true;
      },
      appendEvent: async () => {},
      now: () => Date.now()
    });
    assert.ok(calls.includes("pullRebase:main"));
    assert.ok(calls.includes("push:main"));
    assert.ok(calls.indexOf("privacy:T:alice/alice-aios") < calls.indexOf("dirty"), "privacy is verified before mutation");
    const commitIdx = calls.findIndex((c) => c.startsWith("commit:sync:"));
    const pullIdx = calls.indexOf("pullRebase:main");
    assert.ok(commitIdx !== -1, "must commit local work");
    assert.ok(commitIdx < pullIdx, "commit must happen before the rebase pull");
    assert.equal(result.outcome, "success", "a completed tick has the explicit success outcome");
    assert.equal(result.pushed, true);
    assert.equal(result.sha, "sha-current", "reported sha is HEAD after push, not the pre-rebase commit");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a clean tick pushes a commit left ahead of origin by the previous failed push", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null, last_push_sha: "old-sha" }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: false, pullResult: "up-to-date", ahead: true, calls }),
      appendEvent: async () => {},
      now: () => Date.now()
    });

    assert.ok(calls.includes("ahead:main"), "a clean tick checks for an unpushed local commit");
    assert.ok(calls.includes("push:main"), "the existing commit is retried");
    assert.equal(result.outcome, "success");
    assert.equal(result.pushed, true);
    assert.equal(result.sha, "sha-current");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick refuses a public repo before mutating git", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({
        access_token: "T",
        repo_full_name: "alice/alice-aios",
        last_tick_at: null
      }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: true, commitSha: "sha", calls }),
      verifyRepoPrivate: async () => {
        throw new Error("the repo alice/alice-aios is public");
      },
      appendEvent: async () => {},
      now: () => Date.now()
    });

    assert.match(result.error, /public/i);
    assert.deepEqual(calls, ["branch-current:main"], "privacy failure must precede every git mutation");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("tick fails closed when repo privacy is unknown", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const calls = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({
        access_token: "T",
        repo_full_name: "alice/alice-aios",
        last_tick_at: null
      }),
      writeConfig: async () => {},
      makeGit: () => makeGit({ dirty: true, commitSha: "sha", calls }),
      verifyRepoPrivate: async () => {
        throw new Error("could not verify that alice/alice-aios is private");
      },
      appendEvent: async () => {},
      now: () => Date.now()
    });

    assert.match(result.error, /could not verify/i);
    assert.deepEqual(calls, ["branch-current:main"], "unknown privacy must precede every git mutation");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const [label, origin] of [
  ["hostile host", "https://attacker.example/alice/alice-aios.git"],
  ["different GitHub repository", "https://github.com/mallory/public-mirror.git"],
  ["SSH transport", "git@github.com:alice/alice-aios.git"]
]) {
  test(`tick refuses a ${label} origin before creating a credentialed Git client`, async () => {
    const { lockPath, dir } = await tmpLock();
    try {
      const factoryTokens = [];
      const calls = [];
      let privacyChecks = 0;
      const result = await runTickImpl({
        lockPath,
        readConfig: async () => ({
          access_token: "SECRET",
          repo_full_name: "alice/alice-aios",
          last_tick_at: null
        }),
        writeConfig: async () => {},
        makeGit: ({ accessToken = null } = {}) => {
          factoryTokens.push(accessToken);
          return {
            currentBranch: async () => { calls.push("branch"); return "main"; },
            originUrl: async () => { calls.push("origin"); return origin; },
            dirty: async () => { calls.push("dirty"); return true; },
            pullRebase: async () => { calls.push("fetch"); return "up-to-date"; },
            push: async () => { calls.push("push"); }
          };
        },
        verifyRepoPrivate: async () => { privacyChecks += 1; return true; },
        appendEvent: async () => {},
        now: () => Date.now()
      });

      assert.match(result.error, /origin.*does not match/i);
      assert.deepEqual(factoryTokens, [null], "the sync token never enters a Git process");
      assert.deepEqual(calls, ["branch", "origin"], "no staging, fetch, or push runs");
      assert.equal(privacyChecks, 0, "the token is not sent to GitHub before origin binding");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

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

test("tick preserves the primary conflict when its event receipt cannot be written", async () => {
  const { lockPath, dir } = await tmpLock();
  try {
    const written = [];
    const result = await runTick({
      lockPath,
      readConfig: async () => ({ access_token: "T", last_tick_at: null }),
      writeConfig: async (patch) => written.push(patch),
      makeGit: () => makeGit({ dirty: false, pullResult: "conflict" }),
      appendEvent: async () => {
        throw new Error("memory writer lock timed out");
      },
      now: () => Date.parse("2026-07-15T10:00:00.000Z")
    });

    assert.equal(result.conflict, true);
    assert.equal(result.pulled, "conflict");
    assert.match(result.error, /local and remote changes overlap/i);
    assert.equal(result.event_log_error, "memory writer lock timed out");
    assert.equal(written.length, 1, "the original conflict must still be persisted to sync state");
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
  const originalExitCode = process.exitCode;
  console.log = () => {};
  try {
    await runTickCommand([]);
  } finally {
    console.log = origLog;
    process.exitCode = originalExitCode;
  }
  // reaching here = did not throw
  assert.ok(true);
});

test("sync command reporting returns non-zero for conflicts and event writer failures", () => {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    process.exitCode = 0;
    reportTickResult({
      conflict: true,
      pulled: "conflict",
      pushed: false,
      error: "local and remote changes overlap",
      event_log_error: "memory writer lock timed out"
    });

    assert.equal(process.exitCode, 1);
    assert.match(logs.join("\n"), /memory writer lock timed out/);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
});

test("sync command reporting returns non-zero when the sync lock is held", () => {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    process.exitCode = 0;
    reportTickResult({ skipped: "locked" });

    assert.equal(process.exitCode, 1);
    assert.match(logs.join("\n"), /another sync is already running/i);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
});

for (const [skip, expected] of [
  ["rate-limit-gap", /ran less than 10 seconds ago/i],
  ["not-main-branch", /not on main/i],
  ["unexpected-skip", /unexpected-skip/i]
]) {
  test(`sync command reporting fails loudly and truthfully for ${skip}`, () => {
    const originalExitCode = process.exitCode;
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => logs.push(args.join(" "));
    try {
      process.exitCode = 0;
      reportTickResult({ skipped: skip });

      assert.equal(process.exitCode, 1);
      assert.match(logs.join("\n"), expected);
      assert.doesNotMatch(logs.join("\n"), /already up to date|is synced/i);
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }
  });
}

test("sync command reports up to date only for an explicit success outcome", () => {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    process.exitCode = 0;
    reportTickResult({ outcome: "success", pushed: false });

    assert.equal(process.exitCode, 0);
    assert.match(logs.join("\n"), /already up to date/i);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
});

test("sync not configured remains an informational command result", () => {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    process.exitCode = 0;
    reportTickResult({ skipped: "no-token" });

    assert.equal(process.exitCode, 0);
    assert.match(logs.join("\n"), /not set up/i);
    assert.doesNotMatch(logs.join("\n"), /already up to date|is synced/i);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
});

test("sync command reporting treats a stalled tick as a visible failure", () => {
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    process.exitCode = 0;
    reportTickResult({
      stalled: true,
      pushed: false
    });

    assert.equal(process.exitCode, 1);
    assert.doesNotMatch(logs.join("\n"), /already up to date/i);
    assert.match(logs.join("\n"), /could not record|nothing it could record/i);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
});

test("sync event append fails loudly after the shared memory writer lock retry budget", async () => {
  const aiosPath = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-tick-event-"));
  const memoryDir = path.join(aiosPath, "memory");
  const eventsPath = path.join(memoryDir, "events.jsonl");
  const lockPath = `${eventsPath}.lock`;
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(eventsPath, "");
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));

  try {
    const eventInput = {
      type: "sync-conflict",
      summary: "preserve the existing sync schema",
      at: "2026-07-27T12:00:00.000Z"
    };
    await assert.rejects(
      appendSyncEvent(aiosPath, eventInput),
      /Timed out waiting for memory writer lock/
    );
    assert.equal(await fs.readFile(eventsPath, "utf8"), "", "sync must not append around a live writer lock");

    await fs.rm(lockPath);
    await appendSyncEvent(aiosPath, eventInput);

    const event = JSON.parse((await fs.readFile(eventsPath, "utf8")).trim());
    assert.equal(event.type, "sync-conflict");
    assert.equal(event.at, "2026-07-27T12:00:00.000Z");
    assert.equal("ts" in event, false, "sync events retain their existing at-based schema");
  } finally {
    await fs.rm(aiosPath, { recursive: true, force: true });
  }
});
