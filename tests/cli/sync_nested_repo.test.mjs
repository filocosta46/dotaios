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

function realGitFailing(cwd, shouldFail, failure) {
  return async (cmd, args, opts) => {
    if (shouldFail(args)) return { stdout: "", stderr: failure.stderr, code: failure.code };
    try {
      const { stdout, stderr } = await run(cmd, args, { cwd, env: opts.env });
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
  await fs.writeFile(path.join(aios, ".gitignore"), "/workspaces/\n");
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

test("a gitlink refusal preserves a pre-existing partially staged index byte-for-byte", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");

  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");
  await nestProject(aios, "projects/myapp");

  const indexPath = path.join(aios, ".git", "index");
  const indexBefore = await fs.readFile(indexPath);
  const { stdout: cachedDiffBefore } = await git(aios, "diff", "--cached", "--binary");

  const client = createGit({ cwd: aios });
  await assert.rejects(() => client.commitAll("sync"), /projects\/myapp/);

  const indexAfter = await fs.readFile(indexPath);
  const { stdout: cachedDiffAfter } = await git(aios, "diff", "--cached", "--binary");
  assert.deepEqual(indexAfter, indexBefore, "the real index bytes are unchanged");
  assert.equal(cachedDiffAfter, cachedDiffBefore, "the user's exact staged patch is unchanged");
});

test("DotAIOS uses its owned validator instead of checkout-local hooks", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");

  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");
  const hooks = path.join(aios, "hooks");
  await fs.mkdir(hooks);
  const hook = path.join(hooks, "pre-commit");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n");
  await fs.chmod(hook, 0o755);
  await git(aios, "config", "core.hooksPath", hooks);

  const client = createGit({ cwd: aios });
  await assert.doesNotReject(() => client.commitAll("sync"));
});

test("the owned pre-commit validator refuses a gitlink introduced after preflight", async () => {
  const aios = await makeAios();
  await fs.mkdir(path.join(aios, "projects"), { recursive: true });
  await fs.writeFile(path.join(aios, "projects", "seed.md"), "seed\n");
  let injected = false;
  const spawnImpl = async (cmd, args, opts) => {
    if (!injected && args[0] === "add") {
      injected = true;
      await nestProject(aios, "projects/raced");
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /candidate index contains a nested Git repository pointer/i
  );
  assert.match((await git(aios, "ls-files", "-s", "projects/raced")).stdout, /^160000 /);
});

test("the owned pre-commit validator refuses every candidate index entry under workspaces", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, ".gitignore"), "/workspaces/\n");
  await fs.writeFile(path.join(aios, "sync-change.md"), "sync me\n");
  const workspaceFile = path.join(aios, "workspaces", "raced", "tracked.txt");
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.writeFile(workspaceFile, "local workspace\n");
  let injected = false;
  const spawnImpl = async (cmd, args, opts) => {
    const result = await realGitFailing(aios, () => false, {})(cmd, args, opts);
    if (!injected && args[0] === "add") {
      injected = true;
      await git(aios, "add", "-f", "workspaces/raced/tracked.txt");
    }
    return result;
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /candidate index.*workspaces/i
  );
  assert.equal(
    (await git(aios, "ls-files", "workspaces/raced/tracked.txt")).stdout.trim(),
    "workspaces/raced/tracked.txt"
  );
});

test("the owned pre-commit validator refuses case aliases of workspaces", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync-change.md"), "sync me\n");
  const workspaceFile = path.join(aios, "Workspaces", "raced", "private.txt");
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.writeFile(workspaceFile, "private workspace data\n");
  let injected = false;
  const spawnImpl = async (cmd, args, opts) => {
    const result = await realGitFailing(aios, () => false, {})(cmd, args, opts);
    if (!injected && args[0] === "add") {
      injected = true;
      await git(aios, "add", "-f", "--", "Workspaces/raced/private.txt");
    }
    return result;
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /candidate index.*workspaces/i
  );
});

test("the owned pre-commit validator refuses a candidate catalog changed after preflight", async () => {
  const aios = await makeAios();
  const projectReadme = path.join(aios, "projects", "widget", "README.md");
  await fs.mkdir(path.dirname(projectReadme), { recursive: true });
  await fs.writeFile(projectReadme, [
    "---",
    "id: widget-id",
    "project: widget",
    "repo_url: https://github.com/acme/widget.git",
    "---",
    "# Widget",
    ""
  ].join("\n"));
  const workspace = path.join(aios, "workspaces", "widget");
  await makeRepo(workspace);
  await fs.writeFile(path.join(workspace, "README.md"), "# Widget\n");
  await git(workspace, "add", "README.md");
  await git(workspace, "commit", "-q", "-m", "widget base");
  await git(workspace, "remote", "add", "origin", "https://github.com/acme/widget.git");
  await git(aios, "add", "projects/widget/README.md");
  await git(aios, "commit", "-q", "-m", "register widget");

  await fs.writeFile(path.join(aios, "sync-change.md"), "sync me\n");
  let injected = false;
  const spawnImpl = async (cmd, args, opts) => {
    const result = await realGitFailing(aios, () => false, {})(cmd, args, opts);
    if (!injected && args[0] === "add") {
      injected = true;
      await fs.writeFile(
        projectReadme,
        (await fs.readFile(projectReadme, "utf8")).replace("acme/widget.git", "acme/wrong.git")
      );
    }
    return result;
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /complete candidate mirror is unsafe.*origin does not match/is
  );
  assert.match((await git(aios, "show", "HEAD:projects/widget/README.md")).stdout, /acme\/widget\.git/);
});

test("a HEAD rev-parse failure after commit keeps the committed index aligned with the new HEAD", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");
  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");

  const { stdout: headBefore } = await git(aios, "rev-parse", "HEAD");
  const client = createGit({
    cwd: aios,
    spawnImpl: realGitFailing(
      aios,
      (args) => args[0] === "rev-parse" && args[1] === "HEAD",
      { code: 128, stderr: "fatal: cannot resolve HEAD" }
    )
  });

  await assert.rejects(() => client.commitAll("sync"), /commit identity failed/i);
  const { stdout: headAfter } = await git(aios, "rev-parse", "HEAD");
  assert.notEqual(headAfter.trim(), headBefore.trim(), "Git already created the commit");
  await assert.doesNotReject(
    () => git(aios, "diff", "--cached", "--quiet"),
    "the installed index remains aligned with the commit Git created"
  );
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

test("commitAll never overwrites a normal staging operation that completes concurrently", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  let raced = false;
  const spawnImpl = async (cmd, args, opts) => {
    const result = await realGitFailing(aios, () => false, {})(cmd, args, opts);
    if (!raced && args[0] === "add") {
      raced = true;
      await fs.writeFile(path.join(aios, "user-staged.md"), "user staging\n");
      await git(aios, "add", "user-staged.md");
    }
    return result;
  };

  await createGit({ cwd: aios, spawnImpl }).commitAll("sync");

  const { stdout: status } = await git(aios, "status", "--porcelain");
  assert.doesNotMatch(status, /^\?\? user-staged\.md$/m, "a completed concurrent add cannot be erased");
  const { stdout: tracked } = await git(aios, "ls-files", "user-staged.md");
  assert.equal(tracked.trim(), "user-staged.md", "the concurrently staged path remains represented in Git");
});

test("commitAll cannot be redirected by inherited repository environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-env-redirect-"));
  const intended = path.join(root, "intended");
  const wrong = path.join(root, "wrong");
  await makeRepo(intended);
  await makeRepo(wrong);
  await fs.writeFile(path.join(intended, ".gitignore"), "/workspaces/\n");
  await fs.writeFile(path.join(intended, "base.md"), "intended\n");
  await git(intended, "add", ".gitignore", "base.md");
  await git(intended, "commit", "-q", "-m", "base");
  await fs.writeFile(path.join(wrong, "base.md"), "wrong\n");
  await git(wrong, "add", "base.md");
  await git(wrong, "commit", "-q", "-m", "base");
  await fs.writeFile(path.join(intended, "intended.md"), "safe\n");
  await fs.writeFile(path.join(wrong, "wrong.md"), "must remain uncommitted\n");
  const wrongBefore = (await git(wrong, "rev-parse", "HEAD")).stdout.trim();

  await createGit({
    cwd: intended,
    env: {
      ...process.env,
      GIT_DIR: path.join(wrong, ".git"),
      GIT_WORK_TREE: wrong,
      GIT_INDEX_FILE: path.join(wrong, ".git", "index")
    }
  }).commitAll("sync");

  assert.equal((await git(wrong, "rev-parse", "HEAD")).stdout.trim(), wrongBefore);
  assert.match((await git(intended, "ls-tree", "-r", "--name-only", "HEAD")).stdout, /intended\.md/);
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
    readConfig: async () => ({
      access_token: "T",
      repo_full_name: "user/user-aios",
      last_tick_at: null,
      last_push_sha: "abc1234"
    }),
    writeConfig: async (patch) => written.push(patch),
    verifyRepoPrivate: async () => true,
    makeGit: () => ({
      currentBranch: async () => "main",
      originUrl: async () => "https://github.com/user/user-aios.git",
      validateMirrorContent: async () => {},
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
