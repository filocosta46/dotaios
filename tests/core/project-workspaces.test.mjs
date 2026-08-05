import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyProjectRemote,
  classifyProjectPlacement,
  classifyRestoreDestination,
  managedWorkspacePath,
  managedWorkspaceRoot,
  parseProjectRemote,
  projectRemotesMatch,
  restoreManagedProjects
} from "../../packages/core/src/project-workspaces.mjs";

test("project remotes accept only credential-free HTTPS and SSH/scp transports", () => {
  assert.deepEqual(parseProjectRemote("https://GitHub.com/Acme/Widget.git"), {
    transport: "https",
    canonicalUrl: "https://github.com/Acme/Widget.git",
    identity: "github.com/Acme/Widget"
  });
  assert.deepEqual(parseProjectRemote("git@GitHub.com:Acme/Widget.git"), {
    transport: "scp",
    canonicalUrl: "git@github.com:Acme/Widget.git",
    identity: "git@github.com/Acme/Widget"
  });
  assert.deepEqual(parseProjectRemote("ssh://git@GitHub.com/Acme/Widget.git"), {
    transport: "ssh",
    canonicalUrl: "ssh://git@github.com/Acme/Widget.git",
    identity: "git@github.com/Acme/Widget"
  });
  assert.equal(
    projectRemotesMatch("https://github.com/Acme/Widget.git", "git@github.com:Acme/Widget.git"),
    true
  );
  assert.equal(
    projectRemotesMatch("alice@git.example:Acme/Widget.git", "mallory@git.example:Acme/Widget.git"),
    false,
    "distinct SSH principals must never collapse to one repository identity"
  );
  assert.equal(
    projectRemotesMatch("ssh://alice@git.example/Acme/Widget.git", "alice@git.example:Acme/Widget.git"),
    true,
    "SSH URL and scp syntax may describe the same principal and repository"
  );
  assert.equal(
    projectRemotesMatch("https://git.example/Acme/Widget.git", "git.example:Acme/Widget.git"),
    false,
    "HTTPS must not collapse into the machine's implicit SSH principal"
  );
  assert.equal(
    projectRemotesMatch("https://gitlab.com/Acme/Widget.git", "git@gitlab.com:Acme/Widget.git"),
    true,
    "a hosted forge's explicit fixed Git principal remains transport-portable"
  );
  assert.equal(
    projectRemotesMatch("https://git.example/Acme/Widget.git", "git@git.example:Acme/Widget.git"),
    false,
    "an arbitrary host has no proven cross-transport repository identity"
  );
});

test("project remotes reject credentials, local paths, unsafe schemes, helpers, and option-like values", () => {
  const unsafe = [
    "https://token@github.com/acme/widget.git",
    "https://user:secret@github.com/acme/widget.git",
    "file:///tmp/widget",
    "git://github.com/acme/widget.git",
    "ext::sh -c whoami",
    "fd::helper",
    "/tmp/widget",
    "./widget",
    "../widget",
    "~/widget",
    "C:\\widget",
    "C:widget",
    "--upload-pack=helper",
    "git@@github.com:acme/widget.git",
    "git@github!.com:acme/widget.git",
    "github.com:../widget",
    "github.com:/absolute/widget"
  ];

  for (const remote of unsafe) {
    assert.throws(() => parseProjectRemote(remote), /remote/i, remote);
    const classification = classifyProjectRemote(remote);
    assert.equal(classification.safe, false, remote);
    assert.equal(classification.canonicalUrl, null, remote);
  }
});

test("missing and unsafe legacy remotes classify as local-only without throwing", () => {
  assert.deepEqual(classifyProjectRemote(null), {
    safe: false,
    transport: null,
    canonicalUrl: null,
    identity: null,
    reason: "missing"
  });
  assert.equal(classifyProjectRemote("file:///tmp/widget").reason, "unsupported-transport");
  assert.equal(projectRemotesMatch("file:///tmp/widget", "file:///tmp/widget"), false);
});

test("managed workspace paths are exact, contained, and distinguish missing from external", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-workspaces-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const managedPath = path.join(aiosPath, "workspaces", "widget");
  const externalPath = path.join(root, "widget-external");
  await fs.mkdir(managedPath, { recursive: true });
  await fs.mkdir(externalPath);

  assert.equal(managedWorkspaceRoot(aiosPath), path.join(aiosPath, "workspaces"));
  assert.equal(managedWorkspacePath(aiosPath, "widget"), managedPath);
  assert.throws(() => managedWorkspacePath(aiosPath, "../widget"), /slug/i);

  assert.deepEqual(await classifyProjectPlacement({ aiosPath, projectPath: managedPath, slug: "widget" }), {
    placement: "managed",
    managed: true,
    pathAvailable: true,
    destination: managedPath
  });
  assert.equal((await classifyProjectPlacement({
    aiosPath,
    projectPath: externalPath,
    slug: "widget"
  })).placement, "external");

  await fs.rm(managedPath, { recursive: true });
  assert.deepEqual(await classifyProjectPlacement({ aiosPath, projectPath: managedPath, slug: "widget" }), {
    placement: "missing",
    managed: true,
    pathAvailable: false,
    destination: managedPath
  });
});

test("managed placement rejects in-AIOS near misses and symlink escapes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-workspace-escape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(aiosPath, "projects", "widget"), { recursive: true });
  await fs.mkdir(outside);

  const nearMiss = await classifyProjectPlacement({
    aiosPath,
    projectPath: path.join(aiosPath, "projects", "widget"),
    slug: "widget"
  });
  assert.equal(nearMiss.placement, "unsafe");

  await fs.mkdir(path.join(aiosPath, "workspaces"));
  await fs.symlink(outside, path.join(aiosPath, "workspaces", "widget"));
  const escaped = await classifyProjectPlacement({
    aiosPath,
    projectPath: path.join(aiosPath, "workspaces", "widget"),
    slug: "widget"
  });
  assert.equal(escaped.placement, "unsafe");
  assert.equal(escaped.managed, false);

  const externalAlias = path.join(root, "external-alias");
  await fs.symlink(outside, externalAlias);
  assert.deepEqual(await classifyProjectPlacement({
    aiosPath,
    projectPath: externalAlias,
    slug: "widget"
  }), {
    placement: "external",
    managed: false,
    pathAvailable: true,
    destination: path.join(aiosPath, "workspaces", "widget"),
    canonicalPath: await fs.realpath(outside)
  });
});

test("restore destination classification refuses occupied and unverifiable paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const expectedRemote = "https://github.com/acme/widget.git";
  const readRepositoryRemote = async (destination) => {
    try {
      return await fs.readFile(path.join(destination, ".remote"), "utf8");
    } catch {
      return null;
    }
  };
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const missing = path.join(root, "missing");
  assert.equal((await classifyRestoreDestination({
    destination: missing,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "missing");

  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  assert.equal((await classifyRestoreDestination({
    destination: empty,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "empty-directory");

  const nonRepo = path.join(root, "non-repo");
  await fs.mkdir(nonRepo);
  await fs.writeFile(path.join(nonRepo, "README.md"), "occupied\n");
  assert.equal((await classifyRestoreDestination({
    destination: nonRepo,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "non-repository");

  const noRemote = path.join(root, "no-remote");
  await fs.mkdir(path.join(noRemote, ".git"), { recursive: true });
  assert.equal((await classifyRestoreDestination({
    destination: noRemote,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "git-no-remote");

  const wrong = path.join(root, "wrong");
  await fs.mkdir(path.join(wrong, ".git"), { recursive: true });
  await fs.writeFile(path.join(wrong, ".remote"), "git@github.com:acme/other.git");
  assert.equal((await classifyRestoreDestination({
    destination: wrong,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "remote-mismatch");

  const matching = path.join(root, "matching");
  await fs.mkdir(path.join(matching, ".git"), { recursive: true });
  await fs.writeFile(path.join(matching, ".remote"), "git@github.com:acme/widget.git");
  assert.equal((await classifyRestoreDestination({
    destination: matching,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "existing-match");

  const worktree = path.join(root, "worktree");
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, ".git"), "gitdir: ../shared.git/worktrees/widget\n");
  await fs.writeFile(path.join(worktree, ".remote"), "git@github.com:acme/widget.git");
  assert.equal((await classifyRestoreDestination({
    destination: worktree,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "existing-match", "a regular non-symlink Git worktree marker remains supported");

  const linkedMarker = path.join(root, "linked-marker");
  let linkedMarkerRemoteReads = 0;
  await fs.mkdir(linkedMarker);
  await fs.symlink(path.join(matching, ".git"), path.join(linkedMarker, ".git"));
  assert.equal((await classifyRestoreDestination({
    destination: linkedMarker,
    expectedRemote,
    readRepositoryRemote: async () => {
      linkedMarkerRemoteReads += 1;
      return expectedRemote;
    },
    readRepositoryHead
  })).state, "unsafe-git-marker");
  assert.equal(linkedMarkerRemoteReads, 0, "a symlink marker is rejected before any Git inspection");

  const alias = path.join(root, "alias");
  await fs.symlink(matching, alias);
  assert.equal((await classifyRestoreDestination({
    destination: alias,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "symlink");
});

test("restore destination classification rejects special .git markers", async () => {
  const destination = path.resolve("/virtual/special-git-marker");
  let remoteReads = 0;
  const directoryStats = {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false
  };
  const specialStats = {
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => false
  };
  const classification = await classifyRestoreDestination({
    destination,
    expectedRemote: "https://github.com/acme/widget.git",
    fileSystem: {
      lstat: async (target) => target === destination ? directoryStats : specialStats
    },
    readRepositoryRemote: async () => {
      remoteReads += 1;
      return "https://github.com/acme/widget.git";
    }
  });

  assert.equal(classification.state, "unsafe-git-marker");
  assert.equal(remoteReads, 0, "a special marker is rejected before any Git inspection");
});

test("managed restore dry-run is read-only and a real restore claims, clones, verifies, and maps", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "git@github.com:acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  const destination = managedWorkspacePath(aiosPath, "widget");
  const calls = [];
  const cloneRepository = async ({ url, destination: claimed }) => {
    assert.equal((await fs.stat(claimed)).isDirectory(), true, "destination is claimed before clone");
    calls.push(["clone", url, claimed]);
    await fs.mkdir(path.join(claimed, ".git"));
    await fs.writeFile(path.join(claimed, ".remote"), "https://github.com/acme/widget.git");
  };
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";
  const updateMapping = async (mapping) => calls.push(["map", mapping]);

  const preview = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    dryRun: true,
    cloneRepository,
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.results[0].action, "would-clone");
  assert.equal(await pathExists(destination), false);
  assert.deepEqual(calls, []);

  const receipt = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository,
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "cloned");
  assert.equal(receipt.results[0].applied, true);
  assert.equal(calls[0][0], "clone");
  assert.equal(calls[0][1], "git@github.com:acme/widget.git");
  assert.equal(path.basename(calls[0][2]), "checkout");
  assert.match(
    path.basename(path.dirname(calls[0][2])),
    /^\.dotaios-restore-widget-[0-9a-f-]+$/,
    "clone is isolated in an owned sibling transaction before publication"
  );
  assert.equal(calls[1][0], "map");
  assert.equal(calls[1][1].projectPath, destination);
  assert.equal(await pathExists(destination), true);
  assert.deepEqual(
    (await fs.readdir(managedWorkspaceRoot(aiosPath))).sort(),
    ["widget"],
    "the staging transaction is removed after publication"
  );
});

test("restore repairs only mapping for an existing matching checkout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-map-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const destination = managedWorkspacePath(aiosPath, "widget");
  await fs.mkdir(path.join(destination, ".git"), { recursive: true });
  await fs.writeFile(path.join(destination, ".remote"), "git@github.com:acme/widget.git");
  await fs.writeFile(path.join(destination, "branch.txt"), "leave-me\n");
  let cloneCalls = 0;
  let mapped = null;

  const receipt = await restoreManagedProjects({
    aiosPath,
    reference: "widget",
    projects: [{
      id: "project-1",
      slug: "widget",
      repoUrl: "https://github.com/acme/widget.git",
      projectPath: null,
      pathAvailable: false
    }],
    cloneRepository: async () => { cloneCalls += 1; },
    readRepositoryRemote: async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8"),
    readRepositoryHead: async () => "0123456789abcdef0123456789abcdef01234567",
    updateMapping: async (mapping) => { mapped = mapping; }
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "mapping-repaired");
  assert.equal(cloneCalls, 0);
  assert.equal(mapped.projectPath, destination);
  assert.equal(await fs.readFile(path.join(destination, "branch.txt"), "utf8"), "leave-me\n");
});

test("a verified clone remains visible after mapping failure and rerun repairs mapping", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-recover-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  let cloneCalls = 0;
  const cloneRepository = async ({ destination }) => {
    cloneCalls += 1;
    await fs.mkdir(path.join(destination, ".git"));
    await fs.writeFile(path.join(destination, ".remote"), project.repoUrl);
  };
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const failed = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository,
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => { throw new Error("state busy"); }
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].reason, "mapping-failed");
  assert.equal(await pathExists(managedWorkspacePath(aiosPath, "widget")), true);

  let mapped = false;
  const repaired = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository,
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => { mapped = true; }
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.results[0].action, "mapping-repaired");
  assert.equal(cloneCalls, 1);
  assert.equal(mapped, true);
});

test("an interrupted clone removes only its owned staging transaction and an identical retry succeeds", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-interrupted-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  let cloneCalls = 0;
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const interrupted = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async ({ destination }) => {
      cloneCalls += 1;
      await fs.mkdir(path.join(destination, ".git"));
      await fs.writeFile(path.join(destination, ".git", "PARTIAL"), "network stopped\n");
      throw new Error("network interrupted");
    },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => assert.fail("an interrupted clone must not map")
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.results[0].reason, "clone-failed");
  assert.equal(await pathExists(managedWorkspacePath(aiosPath, "widget")), false);
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), [], "owned partial staging is removed");

  let mapped = null;
  const retried = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async ({ destination }) => {
      cloneCalls += 1;
      await fs.mkdir(path.join(destination, ".git"));
      await fs.writeFile(path.join(destination, ".remote"), project.repoUrl);
    },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async (mapping) => { mapped = mapping; }
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.results[0].action, "cloned");
  assert.equal(cloneCalls, 2);
  assert.equal(mapped.projectPath, managedWorkspacePath(aiosPath, "widget"));
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), ["widget"]);
});

test("a live matching restore transaction blocks a duplicate clone", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-live-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  let cloneCalls = 0;
  let announceClone;
  let releaseClone;
  const cloneStarted = new Promise((resolve) => { announceClone = resolve; });
  const cloneReleased = new Promise((resolve) => { releaseClone = resolve; });
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const firstRestore = restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async ({ destination }) => {
      cloneCalls += 1;
      announceClone();
      await cloneReleased;
      await fs.mkdir(path.join(destination, ".git"));
      await fs.writeFile(path.join(destination, ".remote"), project.repoUrl);
    },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => {}
  });
  await cloneStarted;

  const concurrent = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async () => { cloneCalls += 1; },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => {}
  });
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.results[0].reason, "restore-busy");
  assert.equal(cloneCalls, 1, "a live matching transaction prevents duplicate network work");

  releaseClone();
  const completed = await firstRestore;
  assert.equal(completed.ok, true);
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), ["widget"]);
});

test("a dead owner's verified staging transaction is recovered without cloning again", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-transaction-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const destination = managedWorkspacePath(aiosPath, "widget");
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  let transactionRoot = null;
  const interruptedFs = new Proxy(fs, {
    get(target, property) {
      if (property === "rename") {
        return async (source, targetPath) => {
          if (targetPath === destination && path.basename(source) === "checkout") {
            transactionRoot = path.dirname(source);
            const error = new Error("simulated process interruption before publication");
            error.code = "EIO";
            throw error;
          }
          return fs.rename(source, targetPath);
        };
      }
      if (property === "rm") {
        return async (targetPath, options) => {
          if (transactionRoot && targetPath === transactionRoot) {
            throw new Error("simulated process exit before cleanup");
          }
          return fs.rm(targetPath, options);
        };
      }
      return target[property];
    }
  });
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const interrupted = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    fileSystem: interruptedFs,
    cloneRepository: async ({ destination: staged }) => {
      await fs.mkdir(path.join(staged, ".git"));
      await fs.writeFile(path.join(staged, ".remote"), project.repoUrl);
    },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => assert.fail("publication did not complete")
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.results[0].reason, "cleanup-required");
  assert.ok(transactionRoot);

  const markerPath = path.join(transactionRoot, "transaction.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  marker.pid = 2_147_483_647;
  marker.process_started_at = "dead process";
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  let mapped = null;
  const recovered = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async () => assert.fail("verified abandoned staging must be recovered, not recloned"),
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async (mapping) => { mapped = mapping; }
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.results[0].action, "cloned");
  assert.equal(mapped.projectPath, destination);
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), ["widget"]);
});

test("retry after publication crash cleans the dead transaction before repairing mapping", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-published-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const destination = managedWorkspacePath(aiosPath, "widget");
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  let publishedTransaction = null;
  const interruptedFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "rm") return target[property];
      return async (targetPath, options) => {
        if (path.basename(targetPath).startsWith(".dotaios-restore-widget-")) {
          publishedTransaction = targetPath;
          throw new Error("simulated exit after publication");
        }
        return fs.rm(targetPath, options);
      };
    }
  });
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const interrupted = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    fileSystem: interruptedFs,
    cloneRepository: async ({ destination: staged }) => {
      await fs.mkdir(path.join(staged, ".git"));
      await fs.writeFile(path.join(staged, ".remote"), project.repoUrl);
    },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => assert.fail("cleanup failure is surfaced before mapping")
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.results[0].reason, "cleanup-required");
  assert.equal(await pathExists(destination), true, "the verified checkout was already published");
  assert.ok(publishedTransaction);

  const markerPath = path.join(publishedTransaction, "transaction.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  marker.pid = 2_147_483_647;
  marker.process_started_at = "dead process";
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  let mapped = null;
  const recovered = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async () => assert.fail("published checkout must not be cloned again"),
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async (mapping) => { mapped = mapping; }
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.results[0].action, "mapping-repaired");
  assert.equal(mapped.projectPath, destination);
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), ["widget"]);
});

test("retry recovers a verified checkout after crashing between final-name claim and rename", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-claim-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const destination = managedWorkspacePath(aiosPath, "widget");
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  let transactionRoot = null;
  const interruptedFs = new Proxy(fs, {
    get(target, property) {
      if (property === "rename") {
        return async (source, targetPath) => {
          if (targetPath === destination && path.basename(source) === "checkout") {
            transactionRoot = path.dirname(source);
            const error = new Error("simulated exit after final-name claim");
            error.code = "EIO";
            throw error;
          }
          return fs.rename(source, targetPath);
        };
      }
      if (property === "rmdir") {
        return async (targetPath) => {
          if (targetPath === destination) throw new Error("process exited before claim rollback");
          return fs.rmdir(targetPath);
        };
      }
      return target[property];
    }
  });
  const readRepositoryRemote = async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8");
  const readRepositoryHead = async () => "0123456789abcdef0123456789abcdef01234567";

  const interrupted = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    fileSystem: interruptedFs,
    cloneRepository: async ({ destination: staged }) => {
      await fs.mkdir(path.join(staged, ".git"));
      await fs.writeFile(path.join(staged, ".remote"), project.repoUrl);
    },
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async () => assert.fail("publication did not complete")
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.results[0].reason, "cleanup-required");
  assert.ok(transactionRoot);
  assert.deepEqual(await fs.readdir(destination), [], "the exact empty final-name claim remains");
  assert.equal(await pathExists(path.join(transactionRoot, "destination-claim.json")), true);

  const markerPath = path.join(transactionRoot, "transaction.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  marker.pid = 2_147_483_647;
  marker.process_started_at = "dead process";
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  let mapped = null;
  const recovered = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async () => assert.fail("verified claimed staging must not be recloned"),
    readRepositoryRemote,
    readRepositoryHead,
    updateMapping: async (mapping) => { mapped = mapping; }
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.results[0].action, "cloned");
  assert.equal(mapped.projectPath, destination);
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), ["widget"]);
});

test("ambiguous restore markers are never deleted while a separate restore proceeds", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-ambiguous-marker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const workspaces = managedWorkspaceRoot(aiosPath);
  await fs.mkdir(workspaces, { recursive: true });
  const destination = managedWorkspacePath(aiosPath, "widget");
  const project = {
    id: "project-1",
    slug: "widget",
    repoUrl: "https://github.com/acme/widget.git",
    projectPath: null,
    pathAvailable: false
  };
  const canonicalOwner = "11111111-1111-4111-8111-111111111111";
  const unknownKeyRoot = path.join(workspaces, `.dotaios-restore-widget-${canonicalOwner}`);
  const arbitraryOwnerRoot = path.join(workspaces, ".dotaios-restore-widget-not-a-uuid");
  const baseMarker = {
    schema: "dotaios.project-restore-transaction.v1",
    project_id: project.id,
    slug: project.slug,
    remote_url: project.repoUrl,
    destination,
    checkout: "checkout",
    pid: 2_147_483_647,
    owner: canonicalOwner,
    created_at: new Date().toISOString()
  };
  await fs.mkdir(path.join(unknownKeyRoot, "checkout"), { recursive: true });
  await fs.writeFile(
    path.join(unknownKeyRoot, "transaction.json"),
    `${JSON.stringify({ ...baseMarker, unexpected: true }, null, 2)}\n`
  );
  await fs.mkdir(path.join(arbitraryOwnerRoot, "checkout"), { recursive: true });
  await fs.writeFile(
    path.join(arbitraryOwnerRoot, "transaction.json"),
    `${JSON.stringify({ ...baseMarker, owner: "not-a-uuid" }, null, 2)}\n`
  );

  const receipt = await restoreManagedProjects({
    aiosPath,
    projects: [project],
    cloneRepository: async ({ destination: staged }) => {
      await fs.mkdir(path.join(staged, ".git"));
      await fs.writeFile(path.join(staged, ".remote"), project.repoUrl);
    },
    readRepositoryRemote: async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8"),
    readRepositoryHead: async () => "0123456789abcdef0123456789abcdef01234567",
    updateMapping: async () => {}
  });
  assert.equal(receipt.ok, true);
  assert.equal(await pathExists(unknownKeyRoot), true, "unknown marker keys make ownership ambiguous");
  assert.equal(await pathExists(arbitraryOwnerRoot), true, "non-canonical owners are not cleanup authority");
  assert.equal(await pathExists(destination), true);
});

test("dead exact marker with a symlink checkout surfaces cleanup-required without deleting either path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-symlink-staging-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const workspaces = managedWorkspaceRoot(aiosPath);
  const outside = path.join(root, "outside");
  await fs.mkdir(workspaces, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep.txt"), "do not delete\n");
  const owner = "22222222-2222-4222-8222-222222222222";
  const transactionRoot = path.join(workspaces, `.dotaios-restore-widget-${owner}`);
  const destination = managedWorkspacePath(aiosPath, "widget");
  await fs.mkdir(transactionRoot);
  await fs.symlink(outside, path.join(transactionRoot, "checkout"));
  await fs.writeFile(path.join(transactionRoot, "transaction.json"), `${JSON.stringify({
    schema: "dotaios.project-restore-transaction.v1",
    project_id: "project-1",
    slug: "widget",
    remote_url: "https://github.com/acme/widget.git",
    destination,
    checkout: "checkout",
    pid: 2_147_483_647,
    owner,
    created_at: new Date().toISOString()
  }, null, 2)}\n`);

  const receipt = await restoreManagedProjects({
    aiosPath,
    projects: [{
      id: "project-1",
      slug: "widget",
      repoUrl: "https://github.com/acme/widget.git",
      projectPath: null,
      pathAvailable: false
    }],
    cloneRepository: async () => assert.fail("unsafe staging must block before clone"),
    readRepositoryRemote: async () => assert.fail("symlink staging must not invoke Git"),
    readRepositoryHead: async () => assert.fail("symlink staging must not invoke Git"),
    updateMapping: async () => {}
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.results[0].reason, "cleanup-required");
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "do not delete\n");
  assert.equal((await fs.lstat(path.join(transactionRoot, "checkout"))).isSymbolicLink(), true);
});

test("restore refuses a destination won concurrently and continues independent projects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const racedDestination = managedWorkspacePath(aiosPath, "raced");
  let cloneCalls = 0;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "mkdir") return target[property];
      return async (targetPath, options) => {
        if (targetPath === racedDestination && options?.recursive === false) {
          await fs.mkdir(targetPath);
          await fs.writeFile(path.join(targetPath, "winner.txt"), "concurrent owner\n");
          const error = new Error("already exists");
          error.code = "EEXIST";
          throw error;
        }
        return fs.mkdir(targetPath, options);
      };
    }
  });

  const receipt = await restoreManagedProjects({
    aiosPath,
    projects: [
      { id: "project-raced", slug: "raced", repoUrl: "https://github.com/acme/raced.git", pathAvailable: false },
      { id: "project-local", slug: "local", repoUrl: "file:///tmp/local", pathAvailable: false }
    ],
    fileSystem: racingFs,
    cloneRepository: async ({ destination }) => {
      cloneCalls += 1;
      await fs.mkdir(path.join(destination, ".git"));
      await fs.writeFile(path.join(destination, ".remote"), "https://github.com/acme/raced.git");
    },
    readRepositoryRemote: async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8"),
    readRepositoryHead: async () => "0123456789abcdef0123456789abcdef01234567",
    updateMapping: async () => {}
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.results.length, 2);
  assert.equal(receipt.results[0].reason, "destination-raced");
  assert.equal(receipt.results[1].reason, "unsafe-remote");
  assert.equal(cloneCalls, 1);
  assert.deepEqual(await fs.readdir(racedDestination), ["winner.txt"], "concurrent winner is left untouched");
  assert.equal(await fs.readFile(path.join(racedDestination, "winner.txt"), "utf8"), "concurrent owner\n");
  assert.deepEqual(
    await fs.readdir(managedWorkspaceRoot(aiosPath)),
    ["raced"],
    "the losing restore removes only its own staging transaction"
  );
});

test("restore never replaces an empty final destination created during publication", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-empty-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const destination = managedWorkspacePath(aiosPath, "widget");
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "mkdir") return target[property];
      return async (targetPath, options) => {
        if (targetPath === destination && options?.recursive === false) {
          await fs.mkdir(targetPath);
          const error = new Error("concurrent empty destination");
          error.code = "EEXIST";
          throw error;
        }
        return fs.mkdir(targetPath, options);
      };
    }
  });

  const receipt = await restoreManagedProjects({
    aiosPath,
    fileSystem: racingFs,
    projects: [{
      id: "project-1",
      slug: "widget",
      repoUrl: "https://github.com/acme/widget.git",
      pathAvailable: false
    }],
    cloneRepository: async ({ destination: staged }) => {
      await fs.mkdir(path.join(staged, ".git"));
      await fs.writeFile(path.join(staged, ".remote"), "https://github.com/acme/widget.git");
    },
    readRepositoryRemote: async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8"),
    readRepositoryHead: async () => "0123456789abcdef0123456789abcdef01234567",
    updateMapping: async () => {}
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.results[0].reason, "destination-raced");
  assert.deepEqual(await fs.readdir(destination), [], "the concurrent empty directory is not replaced");
  assert.deepEqual(await fs.readdir(managedWorkspaceRoot(aiosPath)), ["widget"]);
});

test("a matching origin without a resolvable HEAD is a partial checkout", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-head-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "widget");
  await fs.mkdir(path.join(destination, ".git"), { recursive: true });

  const classification = await classifyRestoreDestination({
    destination,
    expectedRemote: "https://github.com/acme/widget.git",
    readRepositoryRemote: async () => "git@github.com:acme/widget.git",
    readRepositoryHead: async () => null
  });
  assert.equal(classification.state, "partial-clone");
});

test("explicit restore leaves a valid external checkout alone", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-external-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const externalPath = path.join(root, "external-widget");
  await fs.mkdir(aiosPath);
  await fs.mkdir(path.join(externalPath, ".git"), { recursive: true });
  let mutations = 0;
  let inspections = 0;

  const receipt = await restoreManagedProjects({
    aiosPath,
    reference: "widget",
    projects: [{
      id: "project-1",
      slug: "widget",
      repoUrl: "https://github.com/acme/widget.git",
      projectPath: externalPath,
      pathAvailable: true
    }],
    cloneRepository: async () => { mutations += 1; },
    readRepositoryRemote: async () => {
      inspections += 1;
      return "git@github.com:acme/widget.git";
    },
    readRepositoryHead: async () => {
      inspections += 1;
      return "0123456789abcdef0123456789abcdef01234567";
    },
    updateMapping: async () => { mutations += 1; }
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "already-available");
  assert.equal(receipt.results[0].destination, externalPath);
  assert.equal(mutations, 0);
  assert.equal(inspections, 2);
  assert.equal(await pathExists(managedWorkspacePath(aiosPath, "widget")), false);

  const refused = await restoreManagedProjects({
    aiosPath,
    reference: "widget",
    projects: [{
      id: "project-1",
      slug: "widget",
      repoUrl: "https://github.com/acme/widget.git",
      projectPath: externalPath,
      pathAvailable: true
    }],
    cloneRepository: async () => { mutations += 1; },
    readRepositoryRemote: async () => "git@github.com:acme/wrong.git",
    readRepositoryHead: async () => "0123456789abcdef0123456789abcdef01234567",
    updateMapping: async () => { mutations += 1; }
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.results[0].reason, "remote-mismatch");
  assert.equal(mutations, 0);
});

test("explicit restore validates a symlink alias through its proven external target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-external-alias-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const externalPath = path.join(root, "external-widget");
  const externalAlias = path.join(root, "widget-alias");
  await fs.mkdir(aiosPath);
  await fs.mkdir(path.join(externalPath, ".git"), { recursive: true });
  await fs.symlink(externalPath, externalAlias);

  const inspectedPaths = [];
  const receipt = await restoreManagedProjects({
    aiosPath,
    reference: "widget",
    projects: [{
      id: "project-1",
      slug: "widget",
      repoUrl: "https://github.com/acme/widget.git",
      projectPath: externalAlias,
      pathAvailable: true
    }],
    cloneRepository: async () => assert.fail("a valid external alias must not clone"),
    readRepositoryRemote: async (repoPath) => {
      inspectedPaths.push(repoPath);
      return "git@github.com:acme/widget.git";
    },
    readRepositoryHead: async (repoPath) => {
      inspectedPaths.push(repoPath);
      return "0123456789abcdef0123456789abcdef01234567";
    },
    updateMapping: async () => assert.fail("an existing external alias must not rewrite mapping")
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "already-available");
  assert.equal(receipt.results[0].destination, externalAlias);
  const canonicalExternalPath = await fs.realpath(externalPath);
  assert.deepEqual(inspectedPaths, [canonicalExternalPath, canonicalExternalPath]);
});

test("unexpected project failures are receipts and do not stop the batch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-restore-continue-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  await fs.mkdir(aiosPath);
  const brokenDestination = managedWorkspacePath(aiosPath, "broken");
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "lstat") return target[property];
      return async (targetPath) => {
        if (targetPath === brokenDestination) throw new Error("unreadable destination");
        return fs.lstat(targetPath);
      };
    }
  });

  const receipt = await restoreManagedProjects({
    aiosPath,
    dryRun: true,
    fileSystem: failingFs,
    projects: [
      { id: "broken-id", slug: "broken", repoUrl: "https://github.com/acme/broken.git", pathAvailable: false },
      { id: "healthy-id", slug: "healthy", repoUrl: "https://github.com/acme/healthy.git", pathAvailable: false }
    ],
    readRepositoryRemote: async () => null,
    readRepositoryHead: async () => null
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.results[0].reason, "unexpected-error");
  assert.equal(receipt.results[1].action, "would-clone");
});

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
