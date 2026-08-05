import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  completeInitialMirror,
  orchestrateSetup,
  preflightSetupBranch,
  runSetup,
  verifyInitialMirror,
  withSetupLock
} from "../../packages/cli/src/sync/setup-flow.mjs";
import { runTick as runTickImpl } from "../../packages/cli/src/sync/tick.mjs";
import { readSyncConfig, writeSyncConfig } from "../../packages/core/src/sync-config.mjs";
import { createGit } from "../../packages/cli/src/sync/git.mjs";

const verifiedUpload = async () => true;
const RECEIPT = "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1";

test("orchestrateSetup runs all steps in order on the happy path", async () => {
  const calls = [];
  await orchestrateSetup({
    aiosPath: "/tmp/aios-test",
    gitignoreContent: ".env\n",
    readToken: async () => { calls.push("readToken"); return "ghp_TOKEN"; },
    validateToken: async () => { calls.push("validateToken"); return "alice"; },
    writeConfig: async (patch) => { calls.push("writeConfig"); return patch; },
    openInBrowser: async () => { calls.push("openInBrowser"); },
    pollForRepoExists: async () => { calls.push("pollForRepoExists"); return true; },
    initialMirrorPush: async () => { calls.push("initialMirrorPush"); return RECEIPT; },
    verifyInitialUpload: async ({ expectedSha }) => { calls.push(`verifyInitialUpload:${expectedSha}`); },
    log: () => {}
  });
  assert.deepEqual(calls, [
    "openInBrowser",     // token-create URL
    "readToken",
    "validateToken",
    "writeConfig",       // token + username
    "openInBrowser",     // create-repo URL
    "pollForRepoExists",
    "writeConfig",       // repo url + full_name
    "initialMirrorPush",
    `verifyInitialUpload:${RECEIPT}`,
    "writeConfig"        // verified push receipt
  ]);
});

test("orchestrateSetup trims whitespace from the pasted token", async () => {
  let seen;
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "  ghp_PADDED\n",
    validateToken: async ({ accessToken }) => { seen = accessToken; return "alice"; },
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: verifiedUpload,
    log: () => {}
  });
  assert.equal(seen, "ghp_PADDED");
});

test("orchestrateSetup surfaces failure if the token is rejected", async () => {
  await assert.rejects(orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_BAD",
    validateToken: async () => { throw new Error("token was rejected"); },
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: verifiedUpload,
    log: () => {}
  }), /token was rejected/);
});

test("orchestrateSetup surfaces failure if the mirror push fails", async () => {
  await assert.rejects(orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "u",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => { throw new Error("push failed"); },
    verifyInitialUpload: verifiedUpload,
    log: () => {}
  }), /push failed/);
});

test("orchestrateSetup opens the browser to the token page and the create-repo page", async () => {
  const opened = [];
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async (url) => { opened.push(url); },
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: verifiedUpload,
    log: () => {}
  });
  assert.ok(opened.some((u) => u.includes("settings/tokens/new")));
  assert.ok(opened.some((u) => u.includes("github.com/new")));
});

test("orchestrateSetup describes sync as optional and manual", async () => {
  const logs = [];
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: verifiedUpload,
    log: (message) => logs.push(message)
  });

  const copy = logs.join("\n");
  assert.match(copy, /Sync is optional and manual by default\./);
  assert.match(copy, /legacy automatic hook.*explicit opt-in/i);
  assert.match(copy, /dotaios sync now/);
  assert.doesNotMatch(copy, /syncs automatically|every dotaios command|agent session/i);
  assert.doesNotMatch(copy, /[—–]/, "user-facing sync copy must use plain punctuation");
});

for (const [label, error, message] of [
  ["a network error", new Error("network down"), /network down/],
  ["a mismatched remote SHA", new Error("remote main does not match the uploaded commit"), /does not match/]
]) {
  test(`orchestrateSetup withholds verified/private success copy after ${label}`, async () => {
    const logs = [];
    await assert.rejects(orchestrateSetup({
      aiosPath: "/tmp/x",
      gitignoreContent: ".env",
      readToken: async () => "ghp_T",
      validateToken: async () => "alice",
      writeConfig: async () => {},
      openInBrowser: async () => {},
      pollForRepoExists: async () => true,
      initialMirrorPush: async () => RECEIPT,
      verifyInitialUpload: async () => { throw error; },
      log: (line) => logs.push(line)
    }), message);

    const copy = logs.join("\n");
    assert.doesNotMatch(copy, /Setup verified\.|Your private memory repo is ready\./);
  });
}

test("orchestrateSetup never runs a normal sync tick after the initial push", async () => {
  const calls = [];
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => ({ state: "empty" }),
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: async () => { calls.push("direct-remote-verification"); },
    runFirstTick: async () => { calls.push("normal-tick"); },
    log: () => {}
  });
  assert.deepEqual(calls, ["direct-remote-verification"]);
});

test("orchestrateSetup refuses a non-main branch before requesting a token", async () => {
  let tokenRequested = false;
  await assert.rejects(orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    preflightLocalBranch: async () => { throw new Error("sync setup requires main and changed nothing"); },
    readToken: async () => { tokenRequested = true; return "ghp_T"; },
    validateToken: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => ({ state: "empty" }),
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: verifiedUpload,
    log: () => {}
  }), /requires main/);
  assert.equal(tokenRequested, false);
});

test("setup preflight refuses a symlinked root .git marker before creating a Git client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-git-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const externalGit = path.join(root, "external-git");
  await fs.mkdir(aiosPath);
  await fs.mkdir(externalGit);
  await fs.symlink(externalGit, path.join(aiosPath, ".git"));

  let gitCreated = false;
  await assert.rejects(
    preflightSetupBranch({
      aiosPath,
      createGitImpl: () => {
        gitCreated = true;
        return { currentBranch: async () => "main" };
      }
    }),
    /root \.git.*symbolic link.*changed nothing/i
  );
  assert.equal(gitCreated, false);
});

test("setup preflight refuses a regular gitfile that redirects into an external repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-git-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const external = path.join(root, "external");
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(external);
  await fs.mkdir(aiosPath);
  const externalGit = createGit({ cwd: external });
  await externalGit.init();
  await externalGit.addRemote("https://github.com/example/external.git");
  await fs.writeFile(path.join(aiosPath, ".git"), `gitdir: ${path.join(external, ".git")}\n`);

  await assert.rejects(
    preflightSetupBranch({ aiosPath }),
    /worktree back-pointer|does not belong|registered worktree/i
  );
  assert.equal(await externalGit.originUrl(), "https://github.com/example/external.git");
});

test("setup preflight accepts a real registered linked worktree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-real-worktree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  const linked = path.join(root, "aios");
  await fs.mkdir(primary);
  const git = createGit({ cwd: primary });
  await git.init();
  await git.raw(["config", "user.email", "test@example.com"]);
  await git.raw(["config", "user.name", "Test"]);
  await fs.writeFile(path.join(primary, "README.md"), "base\n");
  await git.raw(["add", "README.md"]);
  await git.raw(["commit", "-m", "base"]);
  await git.raw(["branch", "holding"]);
  await git.raw(["switch", "-q", "holding"]);
  const added = await git.raw(["worktree", "add", "-q", linked, "main"]);
  assert.equal(added.code, 0, added.stderr);

  await preflightSetupBranch({ aiosPath: linked });
});

for (const kind of ["symlink", "hardlink"]) {
  test(`setup preflight refuses a ${kind}ed common Git config`, async (t) => {
    if (kind === "symlink" && process.platform === "win32") {
      t.skip("symlink permissions are platform-specific");
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `dotaios-setup-config-${kind}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const aiosPath = path.join(root, "aios");
    const externalConfig = path.join(root, "external-config");
    await fs.mkdir(aiosPath);
    const git = createGit({ cwd: aiosPath });
    await git.init();
    const configPath = path.join(aiosPath, ".git", "config");
    const original = await fs.readFile(configPath, "utf8");
    await fs.writeFile(externalConfig, original);
    await fs.rm(configPath);
    if (kind === "symlink") await fs.symlink(externalConfig, configPath);
    else await fs.link(externalConfig, configPath);

    await assert.rejects(
      preflightSetupBranch({ aiosPath }),
      /common config.*not a private regular file/i
    );
    assert.equal(await fs.readFile(externalConfig, "utf8"), original);
  });
}

test("setup preflight refuses a special root .git marker before creating a Git client", async () => {
  let gitCreated = false;
  await assert.rejects(
    preflightSetupBranch({
      aiosPath: "/tmp/aios-special-git-marker",
      filesystem: {
        lstat: async () => ({
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => false
        })
      },
      createGitImpl: () => {
        gitCreated = true;
        return { currentBranch: async () => "main" };
      }
    }),
    /root \.git.*special file.*changed nothing/i
  );
  assert.equal(gitCreated, false);
});

test("orchestrateSetup checks origin immediately after username lookup and before persistence or repo creation", async () => {
  const calls = [];
  await assert.rejects(orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    preflightLocalBranch: async () => { calls.push("branch"); },
    readToken: async () => { calls.push("token"); return "ghp_T"; },
    validateToken: async () => { calls.push("username"); return "alice"; },
    preflightLocalOrigin: async () => {
      calls.push("origin");
      throw new Error("origin does not match");
    },
    writeConfig: async () => { calls.push("write"); },
    openInBrowser: async (url) => { calls.push(url.includes("settings/tokens") ? "token-page" : "repo-page"); },
    pollForRepoExists: async () => ({ state: "empty" }),
    initialMirrorPush: async () => RECEIPT,
    verifyInitialUpload: verifiedUpload,
    log: () => {}
  }), /origin does not match/);
  assert.deepEqual(calls, ["branch", "token-page", "token", "username", "origin"]);
});

test("completeInitialMirror adopts only the receipt-matching populated main", async () => {
  const calls = [];
  const inspectionGit = {
    currentBranch: async () => "main",
    originUrl: async () => "https://github.com/alice/alice-aios.git",
    isAncestor: async (ancestor, descendant) => {
      calls.push(`ancestor:${ancestor}:${descendant}`);
      return true;
    }
  };
  const credentialedGit = {
    remoteHead: async (branch) => {
      calls.push(`remote:${branch}`);
      return RECEIPT;
    }
  };

  const adopted = await completeInitialMirror({
    aiosPath: "/tmp/existing-aios",
    accessToken: "ghp_T",
    fullName: "alice/alice-aios",
    gitignoreContent: ".env\n",
    repoState: "populated",
    filesystem: {
      lstat: async () => ({}),
      realpath: async () => "/tmp/existing-aios"
    },
    assertBindingImpl: async () => ({ kind: "primary" }),
    createGitImpl: (options) => options.accessToken ? credentialedGit : inspectionGit,
    readConfig: async () => ({
      setup_intended_push: {
        format: "dotaios-sync-setup-receipt/v1",
        sha: RECEIPT,
        aios_path: "/tmp/existing-aios",
        repo_identity: "alice/alice-aios",
        branch: "main"
      }
    }),
    initialMirrorPushImpl: async () => { throw new Error("must not push again"); }
  });

  assert.equal(adopted, RECEIPT);
  assert.deepEqual(calls, [
    "remote:main",
    `ancestor:${RECEIPT}:HEAD`
  ]);
});

for (const [label, inspectionGit, message] of [
  [
    "a non-main local repository",
    { currentBranch: async () => "feature" },
    /requires main.*changed nothing/i
  ],
  [
    "a mismatched local origin",
    {
      currentBranch: async () => "main",
      originUrl: async () => "https://github.com/bob/other.git"
    },
    /origin does not match.*changed nothing/i
  ]
]) {
  test(`completeInitialMirror refuses ${label} before mutation`, async () => {
    let mutated = false;
    await assert.rejects(
      completeInitialMirror({
        aiosPath: "/tmp/existing-aios",
        accessToken: "ghp_T",
        fullName: "alice/alice-aios",
        gitignoreContent: ".env\n",
        repoState: "empty",
        filesystem: {
          lstat: async () => ({}),
          realpath: async () => "/tmp/existing-aios"
        },
        assertBindingImpl: async () => ({ kind: "primary" }),
        createGitImpl: () => inspectionGit,
        writeConfig: async () => { mutated = true; },
        initialMirrorPushImpl: async () => { mutated = true; }
      }),
      message
    );
    assert.equal(mutated, false);
  });
}

test("completeInitialMirror refuses a populated mirror without its intended-upload receipt", async () => {
  let mutated = false;
  await assert.rejects(
    completeInitialMirror({
      aiosPath: "/tmp/existing-aios",
      accessToken: "ghp_T",
      fullName: "alice/alice-aios",
      gitignoreContent: ".env\n",
      repoState: "populated",
      filesystem: {
        lstat: async () => ({}),
        realpath: async () => "/tmp/existing-aios"
      },
      assertBindingImpl: async () => ({ kind: "primary" }),
      createGitImpl: () => ({
        currentBranch: async () => "main",
        originUrl: async () => "https://github.com/alice/alice-aios.git"
      }),
      readConfig: async () => ({ setup_intended_push: null }),
      writeConfig: async () => { mutated = true; },
      initialMirrorPushImpl: async () => { mutated = true; }
    }),
    /without a matching unfinished-upload receipt/i
  );
  assert.equal(mutated, false);
});

test("completeInitialMirror scopes adoption receipts to path, repository, and main", async () => {
  const baseReceipt = {
    format: "dotaios-sync-setup-receipt/v1",
    sha: RECEIPT,
    aios_path: "/tmp/existing-aios",
    repo_identity: "alice/alice-aios",
    branch: "main"
  };
  for (const patch of [
    { aios_path: "/tmp/other-aios" },
    { repo_identity: "mallory/mallory-aios" },
    { branch: "feature" }
  ]) {
    await assert.rejects(completeInitialMirror({
      aiosPath: "/tmp/existing-aios",
      accessToken: "ghp_T",
      fullName: "alice/alice-aios",
      gitignoreContent: ".env\n",
      repoState: "populated",
      filesystem: {
        lstat: async () => ({}),
        realpath: async () => "/tmp/existing-aios"
      },
      assertBindingImpl: async () => ({ kind: "primary" }),
      createGitImpl: () => ({
        currentBranch: async () => "main",
        originUrl: async () => "https://github.com/alice/alice-aios.git"
      }),
      readConfig: async () => ({ setup_intended_push: { ...baseReceipt, ...patch } })
    }), /without a matching unfinished-upload receipt/i);
  }
});

test("completeInitialMirror preserves a matching existing origin during an empty upload", async () => {
  let preserved = false;
  await completeInitialMirror({
    aiosPath: "/tmp/existing-aios",
    accessToken: "ghp_T",
    fullName: "alice/alice-aios",
    gitignoreContent: ".env\n",
    repoState: "empty",
    filesystem: {
      lstat: async () => ({}),
      realpath: async () => "/tmp/existing-aios"
    },
    assertBindingImpl: async () => ({ kind: "primary" }),
    createGitImpl: () => ({
      currentBranch: async () => "main",
      originUrl: async () => "https://github.com/alice/alice-aios.git"
    }),
    initialMirrorPushImpl: async ({ preserveExistingOrigin }) => {
      preserved = preserveExistingOrigin;
      return RECEIPT;
    }
  });
  assert.equal(preserved, true);
});

test("verifyInitialMirror requires fresh privacy before comparing remote main", async () => {
  const calls = [];
  await verifyInitialMirror({
    aiosPath: "/tmp/x",
    expectedSha: RECEIPT,
    accessToken: "ghp_T",
    fullName: "alice/alice-aios",
    verifyPrivate: async () => { calls.push("privacy"); },
    createGitImpl: () => ({
      remoteHead: async () => { calls.push("sha"); return RECEIPT; }
    })
  });
  assert.deepEqual(calls, ["privacy", "sha"]);

  await assert.rejects(verifyInitialMirror({
    aiosPath: "/tmp/x",
    expectedSha: RECEIPT,
    accessToken: "ghp_T",
    fullName: "alice/alice-aios",
    verifyPrivate: async () => { throw new Error("repo is public"); },
    createGitImpl: () => ({ remoteHead: async () => RECEIPT })
  }), /repo is public/);
});

test("withSetupLock serializes setup attempts and removes its owner record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-lock-"));
  const lockPath = path.join(root, "sync-setup.lock");
  try {
    await withSetupLock(async () => {
      await assert.rejects(
        withSetupLock(async () => {}, { lockPath }),
        /another sync operation is already running/i
      );
    }, { lockPath });
    await assert.rejects(fs.lstat(lockPath), (error) => error.code === "ENOENT");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a tick cannot run Git or clobber sync config while setup owns the shared gate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-tick-gate-"));
  const lockPath = path.join(root, "sync.lock");
  const configPath = path.join(root, "sync.json");
  const gitCalls = [];
  try {
    await writeSyncConfig(configPath, {
      access_token: "T",
      repo_full_name: "alice/alice-aios",
      setup_intended_push: { sha: RECEIPT, owner: "setup" }
    });

    await withSetupLock(async () => {
      const result = await runTickImpl({
        lockPath,
        readConfig: () => readSyncConfig(configPath),
        writeConfig: (patch) => writeSyncConfig(configPath, patch),
        makeGit: () => {
          gitCalls.push("git-created");
          return { currentBranch: async () => "main" };
        },
        verifyRepoPrivate: async () => { gitCalls.push("privacy"); },
        appendEvent: async () => {},
        now: () => Date.parse("2026-08-05T12:00:00.000Z")
      });
      assert.deepEqual(result, { skipped: "locked" });
    }, { lockPath });

    assert.deepEqual(gitCalls, [], "tick must acquire the shared gate before any Git client is created");
    assert.deepEqual((await readSyncConfig(configPath)).setup_intended_push, {
      sha: RECEIPT,
      owner: "setup"
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runSetup throws on failure and does not leak process.exitCode", async () => {
  // Regression: a failing optional sync step inside `dotaios setup` must not
  // set process.exitCode — that leaked and made the whole wizard exit 1.
  const before = process.exitCode;
  try {
    await assert.rejects(
      runSetup([], {
        orchestrate: async () => { throw new Error("token rejected"); },
        lock: async (callback) => callback()
      }),
      /token rejected/
    );
    assert.equal(process.exitCode, before, "runSetup must not set process.exitCode");
  } finally {
    process.exitCode = before;
  }
});

test("runSetup honors --path for the AIOS folder", async () => {
  let seen;
  await runSetup(["--path", "/tmp/aios-synctest"], {
    orchestrate: async ({ aiosPath }) => { seen = aiosPath; },
    lock: async (callback) => callback()
  });
  assert.equal(seen, path.resolve("/tmp/aios-synctest"));
});
