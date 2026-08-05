import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runLogout } from "../../packages/cli/src/sync/logout-cmd.mjs";
import { createGit } from "../../packages/cli/src/sync/git.mjs";
import { withOperationLock } from "../../packages/cli/src/sync/operation-lock.mjs";

async function silenced(fn) {
  const origLog = console.log;
  console.log = () => {};
  try { await fn(); } finally { console.log = origLog; }
}

test("runLogout removes the token-bearing origin remote and the config file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-"));
  try {
    const repo = path.join(tmp, "aios");
    await fs.mkdir(repo);
    const cfgPath = path.join(tmp, "sync.json");
    await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "u/u-aios" }));

    const git = createGit({ cwd: repo });
    await git.init();
    await git.addRemote("https://x-access-token:ghp_SECRET@github.com/u/u-aios.git");
    assert.equal((await git.raw(["remote"])).stdout.trim(), "origin");

    await silenced(() => runLogout(["--path", repo], { configPath: cfgPath }));

    assert.equal((await git.raw(["remote"])).stdout.trim(), "", "origin remote removed");
    await assert.rejects(fs.stat(cfgPath), { code: "ENOENT" }, "sync config removed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runLogout removes a credential-free origin only when it matches sync config", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-plain-origin-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "aios");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(repo);
  const git = createGit({ cwd: repo });
  await git.init();
  await git.addRemote("https://github.com/u/u-aios.git");
  await fs.writeFile(cfgPath, JSON.stringify({
    access_token: "ghp_SECRET",
    repo_full_name: "u/u-aios"
  }));

  await silenced(() => runLogout(["--path", repo], { configPath: cfgPath }));
  assert.equal((await git.raw(["remote"])).stdout.trim(), "");
  await assert.rejects(fs.stat(cfgPath), { code: "ENOENT" });
});

test("runLogout keeps an unrelated repository origin and the sync config", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-origin-mismatch-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "aios");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(repo);
  const git = createGit({ cwd: repo });
  await git.init();
  await git.addRemote("https://github.com/example/unrelated.git");
  const config = { access_token: "ghp_SECRET", repo_full_name: "u/u-aios" };
  await fs.writeFile(cfgPath, JSON.stringify(config));

  await assert.rejects(
    silenced(() => runLogout(["--path", repo], { configPath: cfgPath })),
    /origin does not match.*sync config was kept/i
  );
  assert.equal(await git.originUrl(), "https://github.com/example/unrelated.git");
  assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), config);
});

test("runLogout refuses a hardlinked sync config without removing either link", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-config-hardlink-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const aiosPath = path.join(tmp, "aios");
  const external = path.join(tmp, "external-sync.json");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(aiosPath);
  const content = JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "u/u-aios" });
  await fs.writeFile(external, content);
  await fs.link(external, cfgPath);

  await assert.rejects(
    silenced(() => runLogout(["--path", aiosPath], { configPath: cfgPath })),
    /sync config is not a private regular file.*kept/i
  );
  assert.equal(await fs.readFile(external, "utf8"), content);
  assert.equal(await fs.readFile(cfgPath, "utf8"), content);
});

test("runLogout is best-effort when the AIOS folder is not a git repo", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-"));
  try {
    const cfgPath = path.join(tmp, "sync.json");
    await fs.writeFile(cfgPath, "{}");
    await silenced(() =>
      runLogout(["--path", path.join(tmp, "no-repo-here")], { configPath: cfgPath })
    );
    await assert.rejects(fs.stat(cfgPath), { code: "ENOENT" }, "config still removed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runLogout refuses without mutation while another sync operation holds sync.lock", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-lock-"));
  try {
    const repo = path.join(tmp, "aios");
    await fs.mkdir(repo);
    const cfgPath = path.join(tmp, "sync.json");
    const lockPath = path.join(tmp, "sync.lock");
    await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "u/u-aios" }));

    const git = createGit({ cwd: repo });
    await git.init();
    await git.addRemote("https://github.com/u/u-aios.git");

    await withOperationLock(lockPath, async () => {
      await assert.rejects(
        silenced(() => runLogout(["--path", repo], { configPath: cfgPath })),
        /another sync operation is already running/i
      );
      assert.equal((await git.raw(["remote"])).stdout.trim(), "origin");
      assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
        access_token: "ghp_SECRET",
        repo_full_name: "u/u-aios"
      });
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runLogout keeps sync config when an existing origin cannot be removed", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-failure-"));
  try {
    const repo = path.join(tmp, "aios");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    const cfgPath = path.join(tmp, "sync.json");
    await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "u/u-aios" }));
    const calls = [];

    await assert.rejects(
      silenced(() => runLogout(["--path", repo], {
        configPath: cfgPath,
        createGitImpl: () => ({
          isRepositoryRoot: async () => true,
          raw: async (args) => {
            if (args.join(" ") === "rev-parse --absolute-git-dir") {
              return { code: 0, stdout: `${path.join(repo, ".git")}\n`, stderr: "" };
            }
            if (args.join(" ") === "rev-parse --git-common-dir") {
              return { code: 0, stdout: `${path.join(repo, ".git")}\n`, stderr: "" };
            }
            if (args.join(" ") === "config --local --bool --get extensions.worktreeConfig") {
              return { code: 1, stdout: "", stderr: "" };
            }
            calls.push(args.join(" "));
            if (args.includes("get-url")) {
              return { code: 0, stdout: "https://github.com/u/u-aios.git\n", stderr: "" };
            }
            return { code: 1, stdout: "", stderr: "permission denied" };
          }
        })
      })),
      /sync config was kept/i
    );
    assert.deepEqual(calls, ["remote get-url origin", "remote remove origin"]);
    assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
      access_token: "ghp_SECRET",
      repo_full_name: "u/u-aios"
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runLogout refuses a gitfile that redirects into an external repository", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-external-gitfile-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const external = path.join(tmp, "external");
  const aiosPath = path.join(tmp, "aios");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(external);
  await fs.mkdir(aiosPath);
  const externalGit = createGit({ cwd: external });
  await externalGit.init();
  await externalGit.addRemote("https://github.com/example/external.git");
  await fs.writeFile(path.join(aiosPath, ".git"), `gitdir: ${path.join(external, ".git")}\n`);
  await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "example/external" }));

  await assert.rejects(
    silenced(() => runLogout(["--path", aiosPath], { configPath: cfgPath })),
    /does not belong|worktree metadata|worktree back-pointer/i
  );

  assert.equal((await externalGit.raw(["remote"])).stdout.trim(), "origin");
  assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
    access_token: "ghp_SECRET",
    repo_full_name: "example/external"
  });
});

test("runLogout refuses to remove the shared origin of a registered linked worktree", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-worktree-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const primary = path.join(tmp, "primary");
  const linked = path.join(tmp, "aios");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(primary);
  const primaryGit = createGit({ cwd: primary });
  await primaryGit.init();
  await primaryGit.raw(["config", "user.email", "test@example.com"]);
  await primaryGit.raw(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(primary, "README.md"), "base\n");
  await primaryGit.raw(["add", "README.md"]);
  await primaryGit.raw(["commit", "-m", "base"]);
  const linkedResult = await primaryGit.raw(["worktree", "add", "-q", "-b", "linked", linked]);
  assert.equal(linkedResult.code, 0, linkedResult.stderr);
  await primaryGit.addRemote("https://github.com/example/private-aios.git");
  await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "example/private-aios" }));

  await assert.rejects(
    silenced(() => runLogout(["--path", linked], { configPath: cfgPath })),
    /shared linked-worktree origin.*sync config was kept/i
  );

  assert.equal((await primaryGit.raw(["remote"])).stdout.trim(), "origin");
  assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
    access_token: "ghp_SECRET",
    repo_full_name: "example/private-aios"
  });
});

test("runLogout refuses a symlinked config before mutating an external repository", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-config-link-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const external = path.join(tmp, "external");
  const aiosPath = path.join(tmp, "aios");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(external);
  await fs.mkdir(aiosPath);
  const externalGit = createGit({ cwd: external });
  const aiosGit = createGit({ cwd: aiosPath });
  await externalGit.init();
  await aiosGit.init();
  await externalGit.addRemote("https://github.com/example/external.git");
  await fs.rm(path.join(aiosPath, ".git", "config"));
  await fs.symlink(
    path.join(external, ".git", "config"),
    path.join(aiosPath, ".git", "config")
  );
  await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "example/external" }));

  await assert.rejects(
    silenced(() => runLogout(["--path", aiosPath], { configPath: cfgPath })),
    /common config.*not a private regular file/i
  );

  assert.equal((await externalGit.raw(["remote"])).stdout.trim(), "origin");
  assert.equal((await fs.lstat(path.join(aiosPath, ".git", "config"))).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
    access_token: "ghp_SECRET",
    repo_full_name: "example/external"
  });
});

test("linked-worktree logout refuses a symlinked common config before external mutation", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-worktree-config-link-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const primary = path.join(tmp, "primary");
  const linked = path.join(tmp, "aios");
  const external = path.join(tmp, "external");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(primary);
  await fs.mkdir(external);
  const primaryGit = createGit({ cwd: primary });
  const externalGit = createGit({ cwd: external });
  await primaryGit.init();
  await externalGit.init();
  await primaryGit.raw(["config", "user.email", "test@example.com"]);
  await primaryGit.raw(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(primary, "README.md"), "base\n");
  await primaryGit.raw(["add", "README.md"]);
  await primaryGit.raw(["commit", "-m", "base"]);
  const linkedResult = await primaryGit.raw(["worktree", "add", "-q", "-b", "linked", linked]);
  assert.equal(linkedResult.code, 0, linkedResult.stderr);
  await externalGit.addRemote("https://github.com/example/external.git");
  await fs.rm(path.join(primary, ".git", "config"));
  await fs.symlink(
    path.join(external, ".git", "config"),
    path.join(primary, ".git", "config")
  );
  await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "example/external" }));

  await assert.rejects(
    silenced(() => runLogout(["--path", linked], { configPath: cfgPath })),
    /common config.*not a private regular file/i
  );

  assert.equal((await externalGit.raw(["remote"])).stdout.trim(), "origin");
  assert.equal((await fs.lstat(path.join(primary, ".git", "config"))).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
    access_token: "ghp_SECRET",
    repo_full_name: "example/external"
  });
});

test("linked-worktree logout refuses a routed symlinked config.worktree", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-worktree-local-config-link-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const primary = path.join(tmp, "primary");
  const linked = path.join(tmp, "aios");
  const external = path.join(tmp, "external");
  const cfgPath = path.join(tmp, "sync.json");
  await fs.mkdir(primary);
  await fs.mkdir(external);
  const primaryGit = createGit({ cwd: primary });
  const externalGit = createGit({ cwd: external });
  await primaryGit.init();
  await externalGit.init();
  await primaryGit.raw(["config", "user.email", "test@example.com"]);
  await primaryGit.raw(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(primary, "README.md"), "base\n");
  await primaryGit.raw(["add", "README.md"]);
  await primaryGit.raw(["commit", "-m", "base"]);
  const linkedResult = await primaryGit.raw(["worktree", "add", "-q", "-b", "linked", linked]);
  assert.equal(linkedResult.code, 0, linkedResult.stderr);
  await primaryGit.raw(["config", "extensions.worktreeConfig", "true"]);
  await externalGit.addRemote("https://github.com/example/external.git");
  const linkedGitDir = (await fs.readFile(path.join(linked, ".git"), "utf8"))
    .trim()
    .slice("gitdir: ".length);
  await fs.symlink(
    path.join(external, ".git", "config"),
    path.join(linkedGitDir, "config.worktree")
  );
  await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET", repo_full_name: "example/external" }));

  await assert.rejects(
    silenced(() => runLogout(["--path", linked], { configPath: cfgPath })),
    /worktree config.*not a private regular file/i
  );

  assert.equal((await externalGit.raw(["remote"])).stdout.trim(), "origin");
  assert.equal((await fs.lstat(path.join(linkedGitDir, "config.worktree"))).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(cfgPath, "utf8")), {
    access_token: "ghp_SECRET",
    repo_full_name: "example/external"
  });
});
