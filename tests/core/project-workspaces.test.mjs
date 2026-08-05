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
    identity: "github.com/Acme/Widget"
  });
  assert.deepEqual(parseProjectRemote("ssh://git@GitHub.com/Acme/Widget.git"), {
    transport: "ssh",
    canonicalUrl: "ssh://git@github.com/Acme/Widget.git",
    identity: "github.com/Acme/Widget"
  });
  assert.equal(
    projectRemotesMatch("https://github.com/Acme/Widget.git", "git@github.com:Acme/Widget.git"),
    true
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

  const alias = path.join(root, "alias");
  await fs.symlink(matching, alias);
  assert.equal((await classifyRestoreDestination({
    destination: alias,
    expectedRemote,
    readRepositoryRemote,
    readRepositoryHead
  })).state, "symlink");
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
  assert.deepEqual(calls[0], ["clone", "git@github.com:acme/widget.git", destination]);
  assert.equal(calls[1][0], "map");
  assert.equal(calls[1][1].projectPath, destination);
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
    cloneRepository: async () => { cloneCalls += 1; },
    readRepositoryRemote: async () => null,
    readRepositoryHead: async () => null,
    updateMapping: async () => {}
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.results.length, 2);
  assert.equal(receipt.results[0].reason, "destination-raced");
  assert.equal(receipt.results[1].reason, "unsafe-remote");
  assert.equal(cloneCalls, 0);
  assert.equal((await fs.readdir(racedDestination)).length, 0, "concurrent winner is left untouched");
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
