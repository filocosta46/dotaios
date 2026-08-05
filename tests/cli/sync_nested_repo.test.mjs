import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createGit } from "../../packages/cli/src/sync/git.mjs";

const run = promisify(execFile);
const lifecycleHarness = path.resolve(
  "tests/fixtures/sync-commit-lifecycle-harness.mjs"
);

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
  await fs.writeFile(path.join(aios, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await git(aios, "add", "-A");
  await git(aios, "commit", "-q", "-m", "base");
  return aios;
}

async function crashCommit(aios, phase) {
  await assert.rejects(
    run(process.execPath, [lifecycleHarness, aios, phase]),
    (error) => error.signal === "SIGKILL",
    `the ${phase} fixture must stop at the real process boundary`
  );
}

async function createForeignCommit(aios, relativePath, content) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-foreign-commit-"));
  const scratchIndex = path.join(scratch, "index");
  const payload = path.join(scratch, "payload");
  const indexEnv = { ...process.env, GIT_INDEX_FILE: scratchIndex };
  try {
    await fs.writeFile(payload, content);
    const blob = (await git(aios, "hash-object", "-w", payload)).stdout.trim();
    const baseHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
    await run("git", ["read-tree", "HEAD"], { cwd: aios, env: indexEnv });
    await run(
      "git",
      ["update-index", "--add", "--cacheinfo", "100644", blob, relativePath],
      { cwd: aios, env: indexEnv }
    );
    const tree = (await run("git", ["write-tree"], { cwd: aios, env: indexEnv })).stdout.trim();
    return (await git(
      aios,
      "commit-tree",
      tree,
      "-p",
      baseHead,
      "-m",
      "foreign concurrent commit"
    )).stdout.trim();
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function indexTransactionArtifacts(indexPath) {
  const parent = path.dirname(indexPath);
  const prefix = `${path.basename(indexPath)}.dotaios-transaction`;
  return (await fs.readdir(parent)).filter((entry) => entry.startsWith(prefix)).sort();
}

async function indexWorkArtifacts(indexPath) {
  const parent = path.dirname(indexPath);
  const prefix = `${path.basename(indexPath)}.dotaios-`;
  return (await fs.readdir(parent)).filter((entry) => (
    entry.startsWith(prefix) && !entry.startsWith(`${prefix}transaction`)
  )).sort();
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

test("a case-aliased workspace is refused before git add can poison the real index", async () => {
  const aios = await makeAios();
  await git(aios, "config", "core.ignorecase", "false");
  const workspaceFile = path.join(aios, "Workspaces", "private.txt");
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.writeFile(workspaceFile, "private\n");
  const indexPath = path.join(aios, ".git", "index");
  const before = await fs.readFile(indexPath);

  await assert.rejects(
    createGit({ cwd: aios }).commitAll("sync"),
    /exact ignored workspaces\/ root/i
  );

  assert.deepEqual(await fs.readFile(indexPath), before, "refusal must not mutate the real index");
  assert.equal((await git(aios, "diff", "--cached", "--name-only")).stdout.trim(), "");
});

test("a nested repository with a symlinked .git marker is refused before staging", async () => {
  const aios = await makeAios();
  const project = await nestProject(aios, "projects/symlinked-git");
  const externalGit = path.join(path.dirname(aios), "symlinked-git-control");
  await fs.rename(path.join(project, ".git"), externalGit);
  await fs.symlink(externalGit, path.join(project, ".git"), "dir");
  const indexPath = path.join(aios, ".git", "index");
  const before = await fs.readFile(indexPath);

  await assert.rejects(
    createGit({ cwd: aios }).commitAll("sync"),
    /projects\/symlinked-git/i
  );

  assert.deepEqual(await fs.readFile(indexPath), before, "refusal must leave the index byte-for-byte unchanged");
});

test("commitAll refuses a portable symlink without changing HEAD or the real index", async () => {
  const aios = await makeAios();
  const outside = path.join(path.dirname(aios), "outside-events.jsonl");
  const linked = path.join(aios, "memory", "events.jsonl");
  await fs.mkdir(path.dirname(linked), { recursive: true });
  await fs.writeFile(outside, "outside-owned\n");
  await fs.symlink(path.relative(path.dirname(linked), outside), linked);

  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  const indexPath = path.join(aios, ".git", "index");
  const beforeIndex = await fs.readFile(indexPath);

  await assert.rejects(
    createGit({ cwd: aios }).commitAll("sync"),
    (error) => /symbolic links/i.test(error.message)
      && error.message.includes("memory/events.jsonl")
  );

  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.equal(await fs.readFile(outside, "utf8"), "outside-owned\n");
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
    /projects\/raced/i
  );
  assert.equal(
    (await git(aios, "ls-files", "-s", "projects/raced")).stdout.trim(),
    "",
    "DotAIOS must not leak its isolated candidate into the real index"
  );
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
    /workspaces/i
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
    /workspaces/i
  );
});

test("commitAll validates the immutable candidate when .gitignore races around isolated staging", async () => {
  const aios = await makeAios();
  const ignorePath = path.join(aios, ".gitignore");
  const safeIgnore = "/workspaces/\n# safe working-tree revision\n";
  const unsafeIgnore = "# workspace boundary removed during isolated add\n";
  await fs.writeFile(ignorePath, safeIgnore);
  await fs.writeFile(path.join(aios, "sync-change.md"), "sync me\n");
  const indexPath = path.join(aios, ".git", "index");
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  let raced = false;
  const spawnImpl = async (cmd, args, opts) => {
    if (!raced && args[0] === "add") {
      raced = true;
      await fs.writeFile(ignorePath, unsafeIgnore);
      try {
        return await realGitFailing(aios, () => false, {})(cmd, args, opts);
      } finally {
        await fs.writeFile(ignorePath, safeIgnore);
      }
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /exact \/workspaces\/ ignore rule/i
  );
  assert.equal(raced, true, "the unsafe content must exist only while the isolated index stages it");
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.equal(await fs.readFile(ignorePath, "utf8"), safeIgnore);
  assert.deepEqual(await indexTransactionArtifacts(indexPath), []);
  assert.deepEqual(await indexWorkArtifacts(indexPath), []);
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
    /origin does not match/i
  );
  assert.match((await git(aios, "show", "HEAD:projects/widget/README.md")).stdout, /acme\/widget\.git/);
});

test("commitAll returns the transaction-classified SHA without a redundant HEAD lookup", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");
  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");

  const { stdout: headBefore } = await git(aios, "rev-parse", "HEAD");
  let redundantHeadLookups = 0;
  const client = createGit({
    cwd: aios,
    spawnImpl: async (cmd, args, opts) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        redundantHeadLookups += 1;
        return { stdout: "", stderr: "fatal: cannot resolve HEAD", code: 128 };
      }
      return realGitFailing(aios, () => false, {})(cmd, args, opts);
    }
  });

  const committedSha = await client.commitAll("sync");
  const { stdout: headAfter } = await git(aios, "rev-parse", "HEAD");
  assert.notEqual(headAfter.trim(), headBefore.trim(), "Git already created the commit");
  assert.equal(committedSha, headAfter.trim(), "only the SHA classified inside the transaction may escape");
  assert.equal(redundantHeadLookups, 0, "commitAll must not re-read an unbound HEAD after cleanup");
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

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /index changed concurrently/i
  );

  const { stdout: status } = await git(aios, "status", "--porcelain");
  assert.doesNotMatch(status, /^\?\? user-staged\.md$/m, "a completed concurrent add cannot be erased");
  const { stdout: tracked } = await git(aios, "ls-files", "user-staged.md");
  assert.equal(tracked.trim(), "user-staged.md", "the concurrently staged path remains represented in Git");
});

test("commitAll preserves a concurrent assume-unchanged index flag byte-for-byte", async () => {
  const aios = await makeAios();
  const flaggedPath = path.join(aios, "flagged.md");
  await fs.writeFile(flaggedPath, "tracked\n");
  await git(aios, "add", "flagged.md");
  await git(aios, "commit", "-q", "-m", "track flagged file");
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");

  const indexPath = path.join(aios, ".git", "index");
  let racedIndex = null;
  let raced = false;
  const spawnImpl = async (cmd, args, opts) => {
    const result = await realGitFailing(aios, () => false, {})(cmd, args, opts);
    if (!raced && args[0] === "add") {
      raced = true;
      await git(aios, "update-index", "--assume-unchanged", "flagged.md");
      racedIndex = await fs.readFile(indexPath);
    }
    return result;
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /index changed concurrently/i
  );

  assert.ok(racedIndex, "the regression must inject a flag-only index rewrite");
  assert.deepEqual(await fs.readFile(indexPath), racedIndex);
  assert.match(
    (await git(aios, "ls-files", "-v", "--", "flagged.md")).stdout,
    /^h flagged\.md$/m,
    "the concurrent assume-unchanged flag must remain installed"
  );
  assert.equal((await git(aios, "ls-files", "--", "sync.md")).stdout.trim(), "");
});

test("commitAll excludes a concurrent git add for the entire commit boundary", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "intended sync change\n");
  let concurrentAddError = null;
  let attempted = false;
  const spawnImpl = async (cmd, args, opts) => {
    if (!attempted && args.includes("commit")) {
      attempted = true;
      await fs.writeFile(path.join(aios, "concurrent.md"), "must remain uncommitted\n");
      try {
        await git(aios, "add", "concurrent.md");
      } catch (error) {
        concurrentAddError = error;
      }
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };

  await createGit({ cwd: aios, spawnImpl }).commitAll("sync");

  assert.ok(concurrentAddError, "the conventional index lock must block the racing add");
  assert.doesNotMatch(
    (await git(aios, "show", "--name-only", "--format=", "HEAD")).stdout,
    /concurrent\.md/
  );
  assert.match((await git(aios, "status", "--porcelain")).stdout, /^\?\? concurrent\.md$/m);
});

test("commitAll never deletes a fresh index lock published after its sentinel is released", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "rm") return target[property];
      return async (targetPath, options) => {
        await fs.rm(targetPath, options);
        if (targetPath === lockPath) {
          await fs.writeFile(lockPath, "foreign-owner\n", { flag: "wx" });
        }
      };
    }
  });

  await createGit({ cwd: aios, filesystem: guardedFs }).commitAll("sync");
  assert.equal(await fs.readFile(lockPath, "utf8"), "foreign-owner\n");
});

test("commitAll never deletes a pre-existing foreign index lock", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  await fs.writeFile(lockPath, "foreign-owner\n", { flag: "wx" });

  await assert.rejects(createGit({ cwd: aios }).commitAll("sync"), { code: "EEXIST" });

  assert.equal(await fs.readFile(lockPath, "utf8"), "foreign-owner\n");
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.deepEqual(await indexTransactionArtifacts(indexPath), []);
});

test("commitAll leaves HEAD and the real index unchanged when candidate installation cannot rename", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "rename") return target[property];
      return async (source, destination) => {
        if (source.endsWith("/index.candidate") && destination === indexPath) {
          const error = new Error("injected candidate index rename failure");
          error.code = "EIO";
          throw error;
        }
        return fs.rename(source, destination);
      };
    }
  });

  await assert.rejects(
    () => createGit({ cwd: aios, filesystem: guardedFs }).commitAll("sync"),
    /injected candidate index rename failure/i
  );
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
});

test("commitAll restores the exact index when interrupted after candidate installation", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");
  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");

  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  let interrupted = false;
  const spawnImpl = async (cmd, args, opts) => {
    if (!interrupted && args.includes("commit")) {
      interrupted = true;
      throw new Error("injected interruption before commit");
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };

  await assert.rejects(
    () => createGit({ cwd: aios, spawnImpl }).commitAll("sync"),
    /injected interruption before commit/i
  );
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
});

test("commitAll restores its durable backup after a SIGKILL before commit", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");
  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");

  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const transactionRoot = `${indexPath}.dotaios-transaction`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();

  await crashCommit(aios, "after-candidate");

  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.notDeepEqual(await fs.readFile(indexPath), beforeIndex, "the crash occurs after candidate publication");
  assert.deepEqual(
    await fs.readFile(path.join(transactionRoot, "index.backup")),
    beforeIndex,
    "the durable backup is the exact original index"
  );
  await fs.lstat(lockPath);

  const stopAfterRecovery = async (cmd, args, opts) => {
    if (args[0] === "status" && args.includes("-z")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };
  assert.equal(
    await createGit({ cwd: aios, spawnImpl: stopAfterRecovery }).commitAll("recover only"),
    null
  );
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(transactionRoot), { code: "ENOENT" });
});

test("commitAll recovers when SIGKILL lands immediately after its bound lock is published", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const transactionRoot = `${indexPath}.dotaios-transaction`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();

  await crashCommit(aios, "after-lock");

  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  const [lockStats, claimStats] = await Promise.all([
    fs.lstat(lockPath),
    fs.lstat(path.join(transactionRoot, "index.lock-claim"))
  ]);
  assert.equal(`${lockStats.dev}:${lockStats.ino}`, `${claimStats.dev}:${claimStats.ino}`);
  assert.equal(lockStats.nlink, 2, "the conventional lock is the pre-bound claim inode");

  const stopAfterRecovery = async (cmd, args, opts) => {
    if (args[0] === "status" && args.includes("-z")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };
  assert.equal(await createGit({ cwd: aios, spawnImpl: stopAfterRecovery }).commitAll("recover"), null);
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  assert.deepEqual(await indexTransactionArtifacts(indexPath), []);
});

test("commitAll recovers a fully prepared transaction killed before atomic publication", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const canonicalRoot = `${indexPath}.dotaios-transaction`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();

  await crashCommit(aios, "after-prepared");

  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(canonicalRoot), { code: "ENOENT" });
  assert.match((await indexTransactionArtifacts(indexPath)).join("\n"), /\.preparing-/);
  assert.equal((await indexWorkArtifacts(indexPath)).length, 1, "the receipt binds the isolated work index");

  const stopAfterRecovery = async (cmd, args, opts) => {
    if (args[0] === "status" && args.includes("-z")) {
      return { stdout: "", stderr: "", code: 0 };
    }
    return realGitFailing(aios, () => false, {})(cmd, args, opts);
  };
  assert.equal(await createGit({ cwd: aios, spawnImpl: stopAfterRecovery }).commitAll("recover"), null);
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.deepEqual(await indexTransactionArtifacts(indexPath), []);
  assert.deepEqual(await indexWorkArtifacts(indexPath), []);
});

test("commitAll resumes a canonical transaction killed immediately after publication", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");
  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");

  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const canonicalRoot = `${indexPath}.dotaios-transaction`;
  const beforeIndex = await fs.readFile(indexPath);
  const beforeCachedDiff = (await git(aios, "diff", "--cached", "--binary")).stdout;
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();

  await crashCommit(aios, "after-transaction-published");

  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(
    await fs.readFile(indexPath),
    beforeIndex,
    "publishing the receipt must not change the user's exact staged index"
  );
  assert.equal((await git(aios, "diff", "--cached", "--binary")).stdout, beforeCachedDiff);
  assert.deepEqual(await fs.readFile(path.join(canonicalRoot, "index.backup")), beforeIndex);
  await fs.lstat(path.join(canonicalRoot, "receipt.json"));
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  assert.deepEqual(await indexTransactionArtifacts(indexPath), [path.basename(canonicalRoot)]);
  assert.equal((await indexWorkArtifacts(indexPath)).length, 1);

  const committedSha = await createGit({ cwd: aios }).commitAll("resume and commit");
  assert.match(committedSha, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), committedSha);
  assert.notEqual(committedSha, beforeHead);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  assert.deepEqual(await indexTransactionArtifacts(indexPath), []);
  assert.deepEqual(await indexWorkArtifacts(indexPath), []);
});

test("commitAll finalizes a verified commit after SIGKILL stops cleanup", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const transactionRoot = `${indexPath}.dotaios-transaction`;
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();

  await crashCommit(aios, "after-commit");

  const committedHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  assert.notEqual(committedHead, beforeHead, "Git published the expected commit before the stop");
  await fs.lstat(lockPath);
  await fs.lstat(transactionRoot);
  await assert.doesNotReject(() => git(aios, "diff", "--cached", "--quiet"));

  assert.equal(await createGit({ cwd: aios }).commitAll("resume"), null);
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), committedHead);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(transactionRoot), { code: "ENOENT" });
});

test("commitAll cleanup resumes from an atomically published tombstone", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const canonicalRoot = `${indexPath}.dotaios-transaction`;
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();

  await crashCommit(aios, "after-tombstone");

  const committedHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  assert.notEqual(committedHead, beforeHead);
  await assert.rejects(fs.lstat(lockPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(canonicalRoot), { code: "ENOENT" });
  assert.match((await indexTransactionArtifacts(indexPath)).join("\n"), /\.cleanup-/);

  assert.equal(await createGit({ cwd: aios }).commitAll("resume cleanup"), null);
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), committedHead);
  assert.deepEqual(await indexTransactionArtifacts(indexPath), []);
});

test("commitAll never returns or pushes a foreign HEAD installed across the cleanup tombstone boundary", async () => {
  const aios = await makeAios();
  const remote = path.join(path.dirname(aios), "remote.git");
  await run("git", ["init", "--bare", "-q", remote]);
  await git(aios, "remote", "add", "origin", remote);
  await git(aios, "push", "-q", "origin", "HEAD:refs/heads/main");
  const remoteBefore = (await git(remote, "rev-parse", "refs/heads/main")).stdout.trim();
  const foreignHead = await createForeignCommit(
    aios,
    "credentials.private",
    "must never reach the private mirror\n"
  );
  assert.match(
    (await git(aios, "ls-tree", "-r", "--name-only", foreignHead)).stdout,
    /^credentials\.private$/m,
    "the injected foreign commit must exercise the private-file boundary"
  );
  await fs.writeFile(path.join(aios, "sync.md"), "intended sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  let returnedSha = null;
  const client = createGit({
    cwd: aios,
    indexTransactionLifecycle: {
      afterTransactionTombstoned: async () => {
        await git(aios, "update-ref", "HEAD", foreignHead);
      }
    }
  });

  await assert.rejects(
    async () => {
      returnedSha = await client.commitAll("sync");
      if (returnedSha) await client.push("main", returnedSha);
    },
    /cleanup failed|cleanup boundary/i
  );

  assert.equal(returnedSha, null, "no SHA may escape after the cleanup-boundary CAS fails");
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), foreignHead);
  assert.equal(
    (await git(remote, "rev-parse", "refs/heads/main")).stdout.trim(),
    remoteBefore,
    "the foreign commit must not be pushed"
  );
  assert.match(
    (await indexTransactionArtifacts(indexPath)).join("\n"),
    /\.cleanup-/,
    "the tombstoned receipt and snapshots must remain as recovery evidence"
  );
  await assert.rejects(
    client.commitAll("must preserve evidence"),
    /live DotAIOS process is cleaning|HEAD moved outside the interrupted DotAIOS transaction/i
  );
  assert.match((await indexTransactionArtifacts(indexPath)).join("\n"), /\.cleanup-/);
});

test("valid receipt tampering cannot identify the real Git index as owned scratch state", async (t) => {
  for (const phase of ["after-prepared", "after-tombstone"]) {
    await t.test(phase, async () => {
      const aios = await makeAios();
      await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
      const indexPath = path.join(aios, ".git", "index");

      await crashCommit(aios, phase);
      const beforeIndex = await fs.readFile(indexPath);
      const indexStats = await fs.lstat(indexPath);
      const artifacts = await indexTransactionArtifacts(indexPath);
      assert.equal(artifacts.length, 1);
      const receiptPath = path.join(path.dirname(indexPath), artifacts[0], "receipt.json");
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      receipt.work_index = {
        name: path.basename(indexPath),
        dev: String(indexStats.dev),
        ino: String(indexStats.ino)
      };
      await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const tamperedReceipt = await fs.readFile(receiptPath);

      await assert.rejects(
        createGit({ cwd: aios }).commitAll("must refuse forged ownership"),
        /outside its exact owned namespace/i
      );
      assert.deepEqual(
        await fs.readFile(indexPath),
        beforeIndex,
        "the real index must remain byte-for-byte unchanged"
      );
      assert.deepEqual(await fs.readFile(receiptPath), tamperedReceipt);
      assert.deepEqual(await indexTransactionArtifacts(indexPath), artifacts);
    });
  }
});

test("commitAll refuses a tampered crash receipt without touching recovery state", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const receiptPath = `${indexPath}.dotaios-transaction/receipt.json`;

  await crashCommit(aios, "after-candidate");
  await fs.appendFile(receiptPath, "tampered\n");
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  const beforeIndex = await fs.readFile(indexPath);
  const beforeLock = await fs.readFile(lockPath);
  const beforeReceipt = await fs.readFile(receiptPath);

  await assert.rejects(
    createGit({ cwd: aios }).commitAll("must refuse"),
    /transaction receipt is unreadable/i
  );
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.deepEqual(await fs.readFile(lockPath), beforeLock);
  assert.deepEqual(await fs.readFile(receiptPath), beforeReceipt);
});

test("commitAll refuses a live crash receipt without stealing its lock", async () => {
  const aios = await makeAios();
  await fs.writeFile(path.join(aios, "sync.md"), "sync change\n");
  const indexPath = path.join(aios, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  const receiptPath = `${indexPath}.dotaios-transaction/receipt.json`;

  await crashCommit(aios, "after-candidate");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  receipt.pid = process.pid;
  receipt.work_index.name = `${path.basename(indexPath)}.dotaios-work-${process.pid}-${receipt.transaction_id}`;
  delete receipt.process_started_at;
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  const beforeIndex = await fs.readFile(indexPath);
  const beforeLock = await fs.readFile(lockPath);
  const beforeReceipt = await fs.readFile(receiptPath);

  await assert.rejects(
    createGit({ cwd: aios }).commitAll("must refuse"),
    /live DotAIOS process owns/i
  );
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.deepEqual(await fs.readFile(lockPath), beforeLock);
  assert.deepEqual(await fs.readFile(receiptPath), beforeReceipt);
});

test("a failed commit restores the exact pre-existing partially staged index", async () => {
  const aios = await makeAios();
  const notesPath = path.join(aios, "notes.md");
  await fs.writeFile(notesPath, "first: base\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await git(aios, "commit", "-q", "-m", "add notes");
  await fs.writeFile(notesPath, "first: staged\nsecond: base\n");
  await git(aios, "add", "notes.md");
  await fs.writeFile(notesPath, "first: staged\nsecond: unstaged\n");
  await fs.writeFile(path.join(aios, "new.md"), "sync me\n");

  const indexPath = path.join(aios, ".git", "index");
  const before = await fs.readFile(indexPath);
  const client = createGit({
    cwd: aios,
    spawnImpl: realGitFailing(
      aios,
      (args) => args.includes("commit"),
      { code: 1, stderr: "injected commit failure" }
    )
  });

  await assert.rejects(() => client.commitAll("sync"), /injected commit failure/i);
  assert.deepEqual(await fs.readFile(indexPath), before);
  assert.equal((await git(aios, "ls-files", "new.md")).stdout.trim(), "");
});

test("commitAll refuses an in-progress merge without changing HEAD or index", async () => {
  const aios = await makeAios();
  const baseBranch = (await git(aios, "branch", "--show-current")).stdout.trim();
  await git(aios, "checkout", "-q", "-b", "side");
  await fs.writeFile(path.join(aios, "side.md"), "side\n");
  await git(aios, "add", "side.md");
  await git(aios, "commit", "-q", "-m", "side");
  await git(aios, "checkout", "-q", baseBranch);
  await fs.writeFile(path.join(aios, "main.md"), "main\n");
  await git(aios, "add", "main.md");
  await git(aios, "commit", "-q", "-m", "main");
  await git(aios, "merge", "--no-commit", "--no-ff", "side");

  const beforeHead = (await git(aios, "rev-parse", "HEAD")).stdout.trim();
  const indexPath = path.join(aios, ".git", "index");
  const beforeIndex = await fs.readFile(indexPath);
  await assert.rejects(
    () => createGit({ cwd: aios }).commitAll("sync"),
    /Git operation MERGE_HEAD/i
  );
  assert.equal((await git(aios, "rev-parse", "HEAD")).stdout.trim(), beforeHead);
  assert.deepEqual(await fs.readFile(indexPath), beforeIndex);
  assert.equal((await fs.readFile(path.join(aios, ".git", "MERGE_HEAD"), "utf8")).trim().length, 40);
});

test("commitAll cannot be redirected by inherited repository environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-env-redirect-"));
  const intended = path.join(root, "intended");
  const wrong = path.join(root, "wrong");
  await makeRepo(intended);
  await makeRepo(wrong);
  await fs.writeFile(path.join(intended, ".gitignore"), "/workspaces/\n");
  await fs.writeFile(path.join(intended, "aios.json"), '{"schema_version":"1.2.0"}\n');
  await fs.writeFile(path.join(intended, "base.md"), "intended\n");
  await git(intended, "add", ".gitignore", "aios.json", "base.md");
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
    verifyRepositoryBinding: async () => ({ kind: "primary" }),
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
