import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGit, parsePorcelainZ } from "../../packages/cli/src/sync/git.mjs";

const execFileAsync = promisify(execFile);

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

const MAIN_SHA = "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1";
const MAIN_REF = `${MAIN_SHA}\trefs/heads/main\n`;
const SAFE_REMOTE_TREE = [
  "100644 blob e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\t.gitignore",
  "100644 blob e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\taios.json",
  ""
].join("\0");
const SAFE_REMOTE_TREE_STUBS = [
  { match: "rev-parse --git-path", code: 1 },
  { match: "rev-parse --verify refs/remotes/origin/main^{commit}", stdout: `${MAIN_SHA}\n` },
  { match: `ls-tree -r -z --full-tree ${MAIN_SHA}`, stdout: SAFE_REMOTE_TREE },
  { match: `cat-file blob ${MAIN_SHA}:.gitignore`, stdout: "/workspaces/\n" },
  { match: `cat-file blob ${MAIN_SHA}:aios.json`, stdout: '{"schema_version":"1.2.0"}\n' },
  { match: "-c init.templateDir= init --quiet" },
  { match: "check-ignore --no-index -q -- workspaces/" }
];

async function makeRealMirror(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-sync-git-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
  await fs.writeFile(path.join(cwd, ".gitignore"), "/workspaces/\n");
  await fs.writeFile(path.join(cwd, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await fs.writeFile(path.join(cwd, "file.md"), "base\n");
  await execFileAsync("git", ["add", ".gitignore", "aios.json", "file.md"], { cwd });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd });
  return cwd;
}

function recordingRealSpawn(cwd, calls, fail = () => null) {
  return async (cmd, args, options) => {
    calls.push(args);
    const injected = fail(args);
    if (injected) return injected;
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd,
        env: options.env
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        code: Number.isInteger(error.code) ? error.code : 1
      };
    }
  };
}

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
      ...SAFE_REMOTE_TREE_STUBS,
      { match: `rev-list --count HEAD..${MAIN_SHA}`, stdout: "0\n" }
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
      ...SAFE_REMOTE_TREE_STUBS,
      { match: `rev-list --count HEAD..${MAIN_SHA}`, stdout: "2\n" },
      { match: `merge-tree --write-tree ${MAIN_SHA} HEAD`, stdout: `${"f".repeat(40)}\n` },
      { match: `ls-tree -r -z --full-tree ${"f".repeat(40)}`, stdout: SAFE_REMOTE_TREE },
      { match: `cat-file blob ${"f".repeat(40)}:.gitignore`, stdout: "/workspaces/\n" },
      { match: `cat-file blob ${"f".repeat(40)}:aios.json`, stdout: '{"schema_version":"1.2.0"}\n' },
      { match: `rebase ${MAIN_SHA}`, stdout: "", code: 0 }
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
      if (full.includes(`rebase ${MAIN_SHA}`)) return Promise.resolve({ stdout: "", stderr: "CONFLICT (content)", code: 1 });
      if (full.includes(`rev-list --count HEAD..${MAIN_SHA}`)) return Promise.resolve({ stdout: "2\n", stderr: "", code: 0 });
      if (full.includes("merge-tree --write-tree")) return Promise.resolve({ stdout: "", stderr: "CONFLICT", code: 1 });
      if (full.includes("ls-remote origin")) return Promise.resolve({ stdout: MAIN_REF, stderr: "", code: 0 });
      if (full.includes("rev-parse --verify refs/remotes/origin/main^{commit}")) return Promise.resolve({ stdout: `${MAIN_SHA}\n`, stderr: "", code: 0 });
      if (full.includes(`ls-tree -r -z --full-tree ${MAIN_SHA}`)) return Promise.resolve({ stdout: SAFE_REMOTE_TREE, stderr: "", code: 0 });
      if (full.includes(`cat-file blob ${MAIN_SHA}:.gitignore`)) return Promise.resolve({ stdout: "/workspaces/\n", stderr: "", code: 0 });
      if (full.includes(`cat-file blob ${MAIN_SHA}:aios.json`)) return Promise.resolve({ stdout: '{"schema_version":"1.2.0"}\n', stderr: "", code: 0 });
      return Promise.resolve({ stdout: "", stderr: "", code: 0 }); // fetch
    }
  });
  assert.equal(await git.pullRebase("main"), "conflict");
  assert.ok(calls.some((c) => c.includes("rebase --abort")), "must abort the failed rebase");
});

test("validateFetchedMirrorTree refuses Gitlinks and workspace aliases", async () => {
  for (const [label, tree] of [
    ["repository pointer", `160000 commit e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\tprojects/nested\0${SAFE_REMOTE_TREE}`],
    ["symbolic link", `120000 blob e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\tmemory/events.jsonl\0${SAFE_REMOTE_TREE}`],
    ["workspace", `${SAFE_REMOTE_TREE}100644 blob e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1\tWorkspaces/private.txt\0`]
  ]) {
    const git = createGit({
      cwd: "/x",
      spawnImpl: fakeSpawn([{ match: "ls-tree", stdout: tree }])
    });
    await assert.rejects(git.validateFetchedMirrorTree("main"), new RegExp(label, "i"));
  }
});

test("validateFetchedMirrorTree refuses project catalog directory leaves", async () => {
  for (const projectLeaf of ["projects", "projects/widget", "Projects/widget"]) {
    const tree = `${SAFE_REMOTE_TREE}100644 blob ${"d".repeat(40)}\t${projectLeaf}\0`;
    const git = createGit({
      cwd: "/x",
      spawnImpl: fakeSpawn([{ match: "ls-tree", stdout: tree }])
    });
    await assert.rejects(
      () => git.validateFetchedMirrorTree("main"),
      /non-directory project catalog path/i
    );
  }
});

test("validateFetchedMirrorTree requires the exact remote ignore boundary", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "ls-tree", stdout: SAFE_REMOTE_TREE },
      { match: "cat-file", stdout: "node_modules/\n" }
    ])
  });
  await assert.rejects(git.validateFetchedMirrorTree("main"), /exact \/workspaces\/ ignore rule/i);
});

test("validateFetchedMirrorTree refuses a later rule that cancels the workspace boundary", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "ls-tree", stdout: SAFE_REMOTE_TREE },
      { match: "cat-file", stdout: "/workspaces/\n!/workspaces/\n" },
      { match: "-c init.templateDir= init --quiet" },
      { match: "check-ignore --no-index -q -- workspaces/", code: 1 }
    ])
  });
  await assert.rejects(git.validateFetchedMirrorTree("main"), /does not effectively ignore \/workspaces\//i);
});

test("validateFetchedMirrorTree requires a current, readable root configuration", async () => {
  for (const [label, response, expected] of [
    ["missing", { code: 128, stderr: "missing" }, /readable root aios\.json/i],
    ["malformed", { stdout: "not-json\n" }, /invalid aios\.json/i],
    ["future", { stdout: '{"schema_version":"9.0.0"}\n' }, /unsupported folder schema 9\.0\.0/i]
  ]) {
    const git = createGit({
      cwd: "/x",
      spawnImpl: fakeSpawn([
        { match: "ls-tree", stdout: SAFE_REMOTE_TREE },
        { match: ".gitignore", stdout: "/workspaces/\n" },
        { match: "-c init.templateDir= init --quiet" },
        { match: "check-ignore --no-index -q -- workspaces/" },
        { match: "aios.json", ...response }
      ])
    });
    await assert.rejects(
      () => git.validateFetchedMirrorTree("main"),
      expected,
      label
    );
  }
});

test("commitAll() returns null when nothing staged", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "rev-parse --git-path index", stdout: "/x/.git/index\n" },
      { match: "rev-parse --git-path", code: 1 },
      { match: "status --porcelain -z", stdout: "" }
    ])
  });
  assert.equal(await git.commitAll("sync"), null);
});

test("commitAll() creates the first commit in an initialized mirror", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-sync-unborn-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd });
  await fs.writeFile(path.join(cwd, ".gitignore"), "/workspaces/\n");
  await fs.writeFile(path.join(cwd, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await fs.writeFile(path.join(cwd, "README.md"), "first mirror\n");

  const sha = await createGit({ cwd }).commitAll("Initial DotAIOS mirror");

  assert.match(sha, /^[0-9a-f]{40}$/);
  const { stdout } = await execFileAsync("git", ["rev-list", "--parents", "-n", "1", sha], { cwd });
  assert.deepEqual(stdout.trim().split(/\s+/), [sha], "the initial mirror commit has no parent");
});

test("commitAll() stages explicit paths (never git add -A) and returns sha", async (t) => {
  const cwd = await makeRealMirror(t);
  await fs.writeFile(path.join(cwd, "file.md"), "changed\n");
  const calls = [];
  const git = createGit({
    cwd,
    spawnImpl: recordingRealSpawn(cwd, calls)
  });
  assert.match(await git.commitAll("sync"), /^[0-9a-f]{40}$/);
  const addCall = calls.find((args) => args[0] === "add");
  assert.ok(addCall, "must stage with an explicit `git add --` call");
  assert.deepEqual(addCall, ["add", "--", "file.md"], "must name the changed path explicitly");
  assert.ok(!calls.some((args) => args[0] === "add" && args.includes("-A")), "must never use `git add -A`");
  assert.ok(
    calls.some((args) => args.includes("commit") && !args.includes("-a")),
    "unattended mirror commits must not inherit a signing prompt"
  );
});

test("commitAll() refuses when the staged-index probe fails", async (t) => {
  const cwd = await makeRealMirror(t);
  await fs.writeFile(path.join(cwd, "file.md"), "changed\n");
  const calls = [];
  const git = createGit({
    cwd,
    spawnImpl: recordingRealSpawn(cwd, calls, (args) => (
      args[0] === "ls-files" && args.includes("-s")
        ? { stdout: "", stderr: "fatal: x-access-token:ghu_SECRET@ probe failed", code: 128 }
        : null
    ))
  });

  await assert.rejects(git.commitAll("sync"), (error) => {
    assert.match(error.message, /index inspection failed/i);
    assert.ok(!error.message.includes("ghu_SECRET"), "probe errors must redact tokens");
    return true;
  });
  assert.ok(!calls.some((args) => args[0] === "reset"), "the real index is never reset on refusal");
  assert.ok(!calls.some((args) => args.includes("commit")), "unknown index state must not commit");
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
      match: "push origin aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/main",
      code: 1,
      stderr: "fatal: Authentication failed for 'https://x-access-token:ghu_SECRET123@github.com/u/u-aios.git'"
    }])
  });
  await assert.rejects(git.push("main", "a".repeat(40)), (err) => {
    assert.ok(!err.message.includes("ghu_SECRET123"), "token must not appear in error");
    assert.ok(err.message.includes("x-access-token:***@"), "token should be redacted");
    return true;
  });
});

test("push() sends the exact validated commit to the sync branch", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  });

  const validatedSha = "b".repeat(40);
  await git.push("main", validatedSha);
  assert.deepEqual(calls, [`git push origin ${validatedSha}:refs/heads/main`]);
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
    spawnImpl: fakeSpawn([
      { match: "rev-parse --git-path", code: 1 },
      { match: "ls-remote origin", stdout: "" }
    ])
  });

  assert.equal(await git.pullRebase("main", { lastPushSha: null }), "empty");
});

test("pullRebase refuses a missing main when another remote ref exists", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{
      match: "rev-parse --git-path", code: 1
    }, {
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
    spawnImpl: fakeSpawn([
      { match: "rev-parse --git-path", code: 1 },
      { match: "ls-remote origin", stdout: "" }
    ])
  });

  await assert.rejects(
    () => git.pullRebase("main", { lastPushSha: "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1" }),
    /previously pushed|unexpected/i
  );
});
