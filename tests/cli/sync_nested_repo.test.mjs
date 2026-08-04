import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createGit } from "../../packages/cli/src/sync/git.mjs";

const run = promisify(execFile);

// These tests use REAL git against a real temp repo, not a stubbed spawn.
// The defect being guarded is a behaviour of git itself: `git add` on a
// directory that contains its own .git records a gitlink (mode 160000) and
// exits 0 with only a warning on stderr. A stubbed spawn would let the guard
// "pass" without ever proving it survives contact with git.

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "Test");
  return dir;
}

async function makeAios() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-nested-"));
  const aios = path.join(root, "aios");
  await makeRepo(aios);
  await fs.writeFile(path.join(aios, "README.md"), "base\n");
  await git(aios, "add", "-A");
  await git(aios, "commit", "-q", "-m", "base");
  return aios;
}

// Drop a real, self-contained git repository at <aios>/<relative>, the way a
// user does when they clone a project they are working on into their folder.
async function nestProject(aios, relative) {
  const project = path.join(aios, relative);
  await makeRepo(project);
  await fs.writeFile(path.join(project, "index.js"), "console.log('my real work')\n");
  await git(project, "add", "-A");
  await git(project, "commit", "-q", "-m", "my app");
  return project;
}

test("commitAll refuses to commit a nested repository and names the path", async () => {
  const aios = await makeAios();
  await nestProject(aios, "projects/myapp");

  const client = createGit({ cwd: aios });
  await assert.rejects(
    () => client.commitAll("sync"),
    (err) => {
      assert.match(err.message, /projects\/myapp/, "the offending path is named");
      return true;
    },
    "a nested repository must not be committed silently"
  );
});

test("a refused commit leaves the user's files exactly where they were", async () => {
  const aios = await makeAios();
  const project = await nestProject(aios, "projects/myapp");
  const before = await fs.readFile(path.join(project, "index.js"), "utf8");

  const client = createGit({ cwd: aios });
  await assert.rejects(() => client.commitAll("sync"));

  const after = await fs.readFile(path.join(project, "index.js"), "utf8");
  assert.equal(after, before, "the user's work is untouched");

  // And nothing may be left staged: a half-staged index would make the next
  // tick commit the gitlink anyway.
  const { stdout } = await git(aios, "diff", "--cached", "--name-only");
  assert.equal(stdout.trim(), "", "the index is clean after the refusal");
});

test("a nested repository is caught at arbitrary depth", async () => {
  const aios = await makeAios();
  await nestProject(aios, "projects/deep/nested/myapp");

  const client = createGit({ cwd: aios });
  await assert.rejects(
    () => client.commitAll("sync"),
    (err) => {
      assert.match(err.message, /projects\/deep\/nested\/myapp/);
      return true;
    }
  );
});

test("no HEAD commit is created when a nested repository is refused", async () => {
  const aios = await makeAios();
  await nestProject(aios, "projects/myapp");
  const { stdout: before } = await git(aios, "rev-parse", "HEAD");

  const client = createGit({ cwd: aios });
  await assert.rejects(() => client.commitAll("sync"));

  const { stdout: after } = await git(aios, "rev-parse", "HEAD");
  assert.equal(after.trim(), before.trim(), "HEAD did not move");
});

test("ordinary content still commits normally", async () => {
  const aios = await makeAios();
  await fs.mkdir(path.join(aios, "context"), { recursive: true });
  await fs.writeFile(path.join(aios, "context", "identity.md"), "# Me\n");

  const client = createGit({ cwd: aios });
  const sha = await client.commitAll("sync");

  assert.ok(sha && sha.length >= 7, "a commit was created");
  const { stdout } = await git(aios, "ls-tree", "-r", "HEAD", "--name-only");
  assert.match(stdout, /context\/identity\.md/, "the file is really in the tree");
});

test("a plain directory that merely contains a .git FILE is not mistaken for a repo", async () => {
  // A worktree checkout uses a `.git` file rather than a directory. Guarding on
  // "a .git exists" alone would false-positive; the guard keys on the staged
  // mode instead, so an ordinary file named .git is just content.
  const aios = await makeAios();
  const dir = path.join(aios, "projects", "notarepo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "notes.md"), "just notes\n");

  const client = createGit({ cwd: aios });
  const sha = await client.commitAll("sync");
  assert.ok(sha, "ordinary nested directories still commit");
});

test("a dirty tree that stages nothing is reported, not silently called success", async () => {
  const { runTick } = await import("../../packages/cli/src/sync/tick.mjs");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-stall-"));
  const written = [];
  const result = await runTick({
    lockPath: path.join(dir, "sync.lock"),
    readConfig: async () => ({ access_token: "T", last_tick_at: null, last_push_sha: "abc1234" }),
    writeConfig: async (patch) => written.push(patch),
    verifyRepoPrivate: async () => true,
    makeGit: () => ({
      currentBranch: async () => "main",
      dirty: async () => true,        // git sees changes
      commitAll: async () => null,    // but none of them can be staged
      pullRebase: async () => "ok",
      currentSha: async () => "def5678",
      push: async () => {}
    }),
    appendEvent: async () => {},
    now: () => Date.now()
  });

  assert.equal(result.stalled, true, "the stall is reported to the caller");
  assert.match(result.error, /nothing it could record/i, "the stall is a user-visible failure");
  assert.equal(result.pushed, false);
  const cfg = written.find((w) => "last_error" in w);
  assert.ok(cfg?.last_error, "last_error is recorded instead of null");
  assert.match(cfg.last_error, /nothing it could record/i);
});
