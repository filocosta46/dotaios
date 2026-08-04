import test from "node:test";
import assert from "node:assert/strict";
import { createGit, parsePorcelainZ } from "../../packages/cli/src/sync/git.mjs";

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

function fakeIndexFilesystem() {
  return {
    copyFile: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    rename: async () => {},
    rm: async () => {}
  };
}

const MAIN_REF = "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\trefs/heads/main\n";

test("createGit stamps a DotAIOS git identity into the spawn env", async () => {
  let capturedEnv;
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args, opts) => {
      capturedEnv = opts.env;
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  });
  await git.dirty();
  assert.equal(capturedEnv.GIT_AUTHOR_NAME, "DotAIOS Sync");
  assert.equal(capturedEnv.GIT_AUTHOR_EMAIL, "sync@dotaios.local");
  assert.equal(capturedEnv.GIT_COMMITTER_NAME, "DotAIOS Sync");
  assert.equal(capturedEnv.GIT_COMMITTER_EMAIL, "sync@dotaios.local");
});

test("createGit removes every inherited Git control variable", async () => {
  let capturedEnv;
  const git = createGit({
    cwd: "/x",
    env: {
      PATH: process.env.PATH,
      HOME: "/safe-home",
      GIT_DIR: "/wrong/repo/.git",
      GIT_WORK_TREE: "/wrong/tree",
      GIT_INDEX_FILE: "/wrong/index",
      GIT_OBJECT_DIRECTORY: "/wrong/objects",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/wrong/hooks"
    },
    spawnImpl: (cmd, args, opts) => {
      capturedEnv = opts.env;
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  });

  await git.dirty();
  assert.equal(capturedEnv.HOME, "/safe-home");
  assert.deepEqual(
    Object.keys(capturedEnv).filter((key) => key.startsWith("GIT_")).sort(),
    [
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME"
    ],
    "only DotAIOS-controlled Git identity may reach a Git process"
  );
});

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

test("pullRebase() returns 'up-to-date' when origin matches HEAD", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "ls-remote origin", stdout: MAIN_REF },
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "0\n" }
    ])
  });
  assert.equal(await git.pullRebase("main"), "up-to-date");
});

test("pullRebase() returns 'rebased' when remote ahead and rebase succeeds", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "ls-remote origin", stdout: MAIN_REF },
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "2\n" },
      { match: "rebase origin/main", stdout: "", code: 0 }
    ])
  });
  assert.equal(await git.pullRebase("main"), "rebased");
});

test("hasUnpushedCommits() detects commits ahead of the fetched origin branch", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{
      match: "rev-list --count origin/main..HEAD",
      stdout: "1\n"
    }])
  });
  assert.equal(await git.hasUnpushedCommits("main"), true);
});

test("pullRebase() aborts and returns 'conflict' when rebase fails", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      const full = [cmd, ...args].join(" ");
      calls.push(full);
      if (full.includes("rebase --abort")) return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      if (full.includes("rebase origin/main")) return Promise.resolve({ stdout: "", stderr: "CONFLICT (content)", code: 1 });
      if (full.includes("rev-list --count HEAD..origin/main")) return Promise.resolve({ stdout: "2\n", stderr: "", code: 0 });
      if (full.includes("ls-remote origin")) return Promise.resolve({ stdout: MAIN_REF, stderr: "", code: 0 });
      return Promise.resolve({ stdout: "", stderr: "", code: 0 }); // fetch
    }
  });
  assert.equal(await git.pullRebase("main"), "conflict");
  assert.ok(calls.some((c) => c.includes("rebase --abort")), "must abort the failed rebase");
});

test("commitAll() returns null when nothing staged", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "status --porcelain -z", stdout: "" }
    ])
  });
  assert.equal(await git.commitAll("sync"), null);
});

test("commitAll() stages explicit paths (never git add -A) and returns sha", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      const full = [cmd, ...args].join(" ");
      calls.push(full);
      if (full.includes("status --porcelain -z")) {
        return Promise.resolve({ stdout: " M file.md\0", stderr: "", code: 0 });
      }
      if (full.startsWith("git add --")) {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (full.includes("ls-files -s")) {
        // An ordinary blob, not a gitlink — the nested-repo guard lets it pass.
        return Promise.resolve({ stdout: "100644 abc123 0\tfile.md\n", stderr: "", code: 0 });
      }
      if (full.includes(" commit -a -m")) {
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      }
      if (full.includes("rev-parse HEAD")) {
        return Promise.resolve({ stdout: "abc123\n", stderr: "", code: 0 });
      }
      throw new Error(`unstubbed git call: ${full}`);
    }
  });
  assert.equal(await git.commitAll("sync"), "abc123");
  const addCall = calls.find((c) => c.startsWith("git add --"));
  assert.ok(addCall, "must stage with an explicit `git add --` call");
  assert.ok(/git add -- file\.md/.test(addCall), "must name the changed path explicitly");
  assert.ok(!calls.some((c) => c.includes("add -A")), "must never use `git add -A`");
  assert.ok(
    calls.some((c) => c.includes("-c commit.gpgSign=false commit -a -m")),
    "unattended mirror commits must not inherit a signing prompt"
  );
});

test("commitAll() refuses when the staged-index probe fails", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      const full = [cmd, ...args].join(" ");
      calls.push(full);
      if (full.includes("status --porcelain -z")) {
        return Promise.resolve({ stdout: " M file.md\0", stderr: "", code: 0 });
      }
      if (full.includes("ls-files -s")) {
        return Promise.resolve({
          stdout: "100644 abc123 0\tfile.md\n",
          stderr: "fatal: x-access-token:ghu_SECRET@ probe failed",
          code: 128
        });
      }
      throw new Error(`unstubbed git call: ${full}`);
    }
  });

  await assert.rejects(git.commitAll("sync"), (error) => {
    assert.match(error.message, /index inspection failed/i);
    assert.ok(!error.message.includes("ghu_SECRET"), "probe errors must redact tokens");
    return true;
  });
  assert.ok(!calls.some((call) => call.startsWith("git reset")), "the real index is never reset on refusal");
  assert.ok(!calls.some((call) => call.includes(" commit -a -m")), "unknown index state must not commit");
});

test("parsePorcelainZ stages rename destinations and skips the source field", () => {
  // R  new.md\0old.md\0 M other.md\0
  const stdout = "R  new.md\0old.md\0 M other.md\0";
  const paths = parsePorcelainZ(stdout);
  assert.deepEqual(paths, ["new.md", "other.md"]);
});

test("push() redacts embedded token from error message", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{
      match: "push origin HEAD:main",
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

test("push() sends the checked-out HEAD to the sync branch", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  });

  await git.push("main");
  assert.deepEqual(calls, ["git push origin HEAD:main"]);
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

test("remoteHead() reads the configured sync branch without exposing credentials", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return Promise.resolve({
        stdout: "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\trefs/heads/main\n",
        stderr: "",
        code: 0
      });
    }
  });

  assert.equal(await git.remoteHead("main"), "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1");
  assert.deepEqual(calls, ["git ls-remote origin refs/heads/main"]);
});

test("pullRebase classifies a remote with no refs and no receipt as empty", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{ match: "ls-remote origin", stdout: "" }])
  });

  assert.equal(await git.pullRebase("main", { lastPushSha: null }), "empty");
});

test("pullRebase refuses a missing main when another remote ref exists", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{
      match: "ls-remote origin",
      stdout: "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\trefs/heads/dev\n"
    }])
  });

  await assert.rejects(
    () => git.pullRebase("main", { lastPushSha: null }),
    /main.*missing.*other refs|unexpected/i
  );
});

test("pullRebase refuses an empty remote after a prior push receipt", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{ match: "ls-remote origin", stdout: "" }])
  });

  await assert.rejects(
    () => git.pullRebase("main", { lastPushSha: "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1" }),
    /previously pushed|unexpected/i
  );
});
