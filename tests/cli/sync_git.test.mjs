import test from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../../packages/cli/src/sync/git.mjs";

function fakeSpawn(plan) {
  // plan: array of { match: RegExp|string, stdout: "", stderr: "", code: 0 }
  return (cmd, args /*, opts */) => {
    const full = [cmd, ...args].join(" ");
    const hit = plan.find((p) =>
      typeof p.match === "string" ? full.includes(p.match) : p.match.test(full)
    );
    if (!hit) throw new Error(`unstubbed git call: ${full}`);
    return Promise.resolve({
      stdout: hit.stdout ?? "",
      stderr: hit.stderr ?? "",
      code: hit.code ?? 0
    });
  };
}

test("dirty() true when porcelain has lines", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{ match: "status --porcelain", stdout: " M file.md\n" }])
  });
  assert.equal(await git.dirty(), true);
});

test("dirty() false when porcelain empty", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{ match: "status --porcelain", stdout: "" }])
  });
  assert.equal(await git.dirty(), false);
});

test("ffPull() returns 'up-to-date' when origin matches HEAD", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "0\n" }
    ])
  });
  assert.equal(await git.ffPull("main"), "up-to-date");
});

test("ffPull() returns 'fast-forwarded' when remote ahead and merge succeeds", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "3\n" },
      { match: "rev-list --count origin/main..HEAD", stdout: "0\n" },
      { match: "merge --ff-only origin/main", stdout: "" }
    ])
  });
  assert.equal(await git.ffPull("main"), "fast-forwarded");
});

test("ffPull() returns 'diverged' when both ahead", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "2\n" },
      { match: "rev-list --count origin/main..HEAD", stdout: "5\n" }
    ])
  });
  assert.equal(await git.ffPull("main"), "diverged");
});

test("commitAll() returns null when nothing staged", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "add -A", stdout: "" },
      { match: "diff --cached --quiet", code: 0 }
    ])
  });
  assert.equal(await git.commitAll("sync"), null);
});

test("commitAll() returns sha when commit made", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "add -A", stdout: "" },
      { match: "diff --cached --quiet", code: 1 }, // changes present
      { match: "commit -m", stdout: "" },
      { match: "rev-parse HEAD", stdout: "abc123\n" }
    ])
  });
  assert.equal(await git.commitAll("sync"), "abc123");
});

test("branchFromSha() creates named branch pointing at given sha", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  });
  await git.branchFromSha("local-2026", "abc123");
  assert.ok(calls.some((c) => c.includes("branch local-2026 abc123")));
});

test("push() redacts embedded token from error message", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{
      match: "push origin main",
      code: 1,
      stderr: "fatal: Authentication failed for 'https://x-access-token:ghu_SECRET123@github.com/u/u-aios.git'"
    }])
  });
  await assert.rejects(git.push("main"), (err) => {
    assert.ok(!err.message.includes("ghu_SECRET123"), "token must not appear in error");
    assert.ok(err.message.includes("x-access-token:***@"), "token should be redacted");
    return true;
  });
});

test("fetch() redacts embedded token from error message", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{
      match: "fetch origin",
      code: 1,
      stderr: "fatal: could not read from 'https://x-access-token:ghu_LEAK@github.com/u/u-aios.git'"
    }])
  });
  await assert.rejects(git.fetch(), (err) => {
    assert.ok(!err.message.includes("ghu_LEAK"), "token must not appear in error");
    return true;
  });
});
