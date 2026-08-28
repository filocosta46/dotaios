import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listProjects,
  readProjectCatalog,
  registerProject,
  restoreProjects,
  updateProjectPathMapping
} from "../../packages/core/src/projects.mjs";

const VERIFIED_HEAD = "0123456789abcdef0123456789abcdef01234567";
const VERIFIED_REMOTE = "https://github.com/acme/widget.git";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const statePath = path.join(root, "state", "projects.json");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.2.0" })}\n`);
  await fs.writeFile(path.join(aiosPath, ".gitignore"), "/workspaces/\n");
  return { root, aiosPath, statePath };
}

async function writeProject(aiosPath, slug, frontmatter) {
  const readmePath = path.join(aiosPath, "projects", slug, "README.md");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.writeFile(readmePath, `---\n${frontmatter}\n---\n# ${slug}\n`);
}

async function makeVerifiedManagedCheckout(aiosPath, slug = "widget") {
  const destination = path.join(aiosPath, "workspaces", slug);
  await fs.mkdir(path.join(destination, ".git"), { recursive: true });
  return destination;
}

async function verifiedPathMapping(projectPath) {
  const canonicalPath = await fs.realpath(projectPath);
  const stats = await fs.lstat(canonicalPath, { bigint: true });
  return {
    path: projectPath,
    root_identity: {
      type: "directory",
      dev: stats.dev.toString(),
      ino: stats.ino.toString()
    }
  };
}

function verifiedMappingOptions() {
  return {
    expectedRemote: VERIFIED_REMOTE,
    expectedHead: VERIFIED_HEAD,
    readRepoUrl: async () => VERIFIED_REMOTE,
    readRepoHead: async () => VERIFIED_HEAD
  };
}

test("registration permits only the exact managed workspace and canonicalizes a safe remote", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const projectPath = path.join(aiosPath, "workspaces", "widget");
  await fs.mkdir(projectPath, { recursive: true });

  const registered = await registerProject({
    aiosPath,
    statePath,
    projectPath,
    slug: "widget",
    yes: true,
    createId: () => "widget-id",
    readRepoUrl: async () => "https://GitHub.com/acme/widget"
  });
  assert.equal(registered.repoUrl, "https://github.com/acme/widget.git");

  const [listed] = await listProjects({ aiosPath, statePath });
  assert.equal(listed.placement, "managed");
  assert.equal(listed.restoreEligible, false);
  assert.equal(listed.restoreStatus, "available-managed");
  assert.equal(listed.remoteSafe, true);

  const nearMiss = path.join(aiosPath, "workspaces", "other", "widget");
  await fs.mkdir(nearMiss, { recursive: true });
  await assert.rejects(registerProject({
    aiosPath,
    statePath,
    projectPath: nearMiss,
    slug: "nested-widget",
    createId: () => "nested-id"
  }), /inside the AIOS folder.*own Git history/);
});

test("legacy unsafe remotes are local-only and are not exposed as clone inputs", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const externalPath = path.join(root, "legacy-checkout");
  await fs.mkdir(externalPath);
  await writeProject(
    aiosPath,
    "legacy",
    "id: legacy-id\nproject: legacy\nrepo_url: https://token@github.com/acme/legacy.git"
  );
  await writeProject(
    aiosPath,
    "restorable",
    "id: restorable-id\nproject: restorable\nrepo_url: git@github.com:acme/restorable.git"
  );
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({ version: 1, paths: { "legacy-id": externalPath } })}\n`);

  const projects = await listProjects({ aiosPath, statePath });
  const legacy = projects.find((project) => project.slug === "legacy");
  const restorable = projects.find((project) => project.slug === "restorable");
  assert.equal(legacy.repoUrl, null);
  assert.equal(legacy.projectPath, null);
  assert.equal(legacy.placement, "missing");
  assert.equal(legacy.mappingStatus, "legacy");
  assert.equal(legacy.remoteSafe, false);
  assert.equal(legacy.restoreEligible, false);
  assert.equal(legacy.restoreStatus, "local-only");
  assert.equal(restorable.placement, "missing");
  assert.equal(restorable.restoreEligible, true);
  assert.equal(restorable.restoreStatus, "restorable");
});

test("every catalog read refuses duplicate stable ids before selecting or restoring a project", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await writeProject(aiosPath, "alpha", "id: duplicate-id\nproject: alpha\nrepo_url: https://github.com/acme/alpha.git");
  await writeProject(aiosPath, "beta", "id: duplicate-id\nproject: beta\nrepo_url: https://github.com/acme/beta.git");

  for (const operation of [
    () => listProjects({ aiosPath, statePath }),
    () => readProjectCatalog({ aiosPath }),
    () => restoreProjects({ aiosPath, statePath, dryRun: true })
  ]) {
    await assert.rejects(operation, /duplicate-id.*both "alpha" and "beta"/i);
  }
  await assert.rejects(fs.access(path.join(aiosPath, "workspaces")), { code: "ENOENT" });
});

test("catalog reads refuse project directories whose names are not safe slugs", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await writeProject(aiosPath, "Unsafe Name", "id: unsafe-id\nproject: unsafe-name");

  await assert.rejects(
    listProjects({ aiosPath, statePath }),
    /invalid project directory slug "Unsafe Name"/i
  );
});

test("catalog reads refuse symlinked portable project metadata", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const outside = path.join(root, "outside-project.md");
  const readmePath = path.join(aiosPath, "projects", "linked", "README.md");
  await fs.writeFile(outside, "---\nid: linked-id\nproject: linked\nrepo_url: https://github.com/acme/linked.git\n---\n# linked\n");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.symlink(outside, readmePath);

  await assert.rejects(
    listProjects({ aiosPath, statePath }),
    /Project README must be a regular file.*symlink/i
  );
});

test("projects restore facade writes a private atomic managed mapping after verification", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await writeProject(
    aiosPath,
    "widget",
    "id: widget-id\nproject: widget\nrepo_url: https://github.com/acme/widget.git"
  );
  const head = "0123456789abcdef0123456789abcdef01234567";

  const receipt = await restoreProjects({
    aiosPath,
    statePath,
    project: "widget",
    cloneRepository: async ({ destination }) => {
      await fs.mkdir(path.join(destination, ".git"));
      await fs.writeFile(path.join(destination, ".remote"), "git@github.com:acme/widget.git");
    },
    readRepoUrl: async (repoPath) => fs.readFile(path.join(repoPath, ".remote"), "utf8"),
    readRepoHead: async () => head
  });

  const destination = path.join(aiosPath, "workspaces", "widget");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "cloned");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    "widget-id": await verifiedPathMapping(destination)
  });
  assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await listProjects({ aiosPath, statePath }))[0].placement, "managed");
});

test("restore gates old folder schemas before creating or cloning a managed workspace", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await writeProject(
    aiosPath,
    "widget",
    "id: widget-id\nproject: widget\nrepo_url: https://github.com/acme/widget.git"
  );
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.1.0" })}\n`);
  let cloneCalls = 0;

  await assert.rejects(restoreProjects({
    aiosPath,
    statePath,
    cloneRepository: async () => { cloneCalls += 1; },
    readRepoUrl: async () => VERIFIED_REMOTE,
    readRepoHead: async () => VERIFIED_HEAD
  }), /requires folder schema 1\.2\.0.*dotaios migrate --path/is);
  assert.equal(cloneCalls, 0);
  await assert.rejects(fs.access(path.join(aiosPath, "workspaces")), { code: "ENOENT" });
});

test("mapping updates refuse stale conflicting state without overwriting it", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const destination = await makeVerifiedManagedCheckout(aiosPath);
  const concurrentPath = path.join(root, "concurrent-widget");
  await fs.mkdir(destination, { recursive: true });
  await fs.mkdir(concurrentPath);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({ version: 1, paths: { "widget-id": concurrentPath } })}\n`);

  await assert.rejects(updateProjectPathMapping({
    aiosPath,
    statePath,
    id: "widget-id",
    slug: "widget",
    projectPath: destination,
    expectedPath: path.join(root, "stale-widget"),
    ...verifiedMappingOptions()
  }), /mapping changed|conflict/i);
  assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).paths["widget-id"], concurrentPath);
});

test("mapping updates refuse unverified or replaced managed destinations", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const emptyDestination = path.join(aiosPath, "workspaces", "empty");
  await fs.mkdir(emptyDestination, { recursive: true });
  await assert.rejects(updateProjectPathMapping({
    aiosPath,
    statePath,
    id: "empty-id",
    slug: "empty",
    projectPath: emptyDestination,
    ...verifiedMappingOptions()
  }), /changed after verification \(empty-directory\)/i);

  const destination = await makeVerifiedManagedCheckout(aiosPath, "raced");
  const displaced = `${destination}-old`;
  let replaced = false;
  await assert.rejects(updateProjectPathMapping({
    aiosPath,
    statePath,
    id: "raced-id",
    slug: "raced",
    projectPath: destination,
    expectedRemote: VERIFIED_REMOTE,
    expectedHead: VERIFIED_HEAD,
    readRepoUrl: async () => VERIFIED_REMOTE,
    readRepoHead: async () => {
      if (!replaced) {
        replaced = true;
        await fs.rename(destination, displaced);
        await fs.mkdir(path.join(destination, ".git"), { recursive: true });
      }
      return VERIFIED_HEAD;
    }
  }), /changed during verification/i);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("mapping lock recovers a dead owner but refuses a live owner", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const destination = await makeVerifiedManagedCheckout(aiosPath);
  const lockPath = `${statePath}.lock`;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const lockRecord = (pid, owner) => `${JSON.stringify({
    format: "dotaios-project-state-lock/v1",
    pid,
    owner,
    created_at: Date.now()
  })}\n`;

  await fs.writeFile(lockPath, lockRecord(2147483647, "dead-owner"));
  const recovered = await updateProjectPathMapping({
    aiosPath,
    statePath,
    id: "widget-id",
    slug: "widget",
    projectPath: destination,
    ...verifiedMappingOptions()
  });
  assert.equal(recovered.changed, true);
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });

  await fs.writeFile(lockPath, lockRecord(process.pid, "live-owner"));
  await assert.rejects(updateProjectPathMapping({
    aiosPath,
    statePath,
    id: "widget-id",
    slug: "widget",
    projectPath: destination,
    ...verifiedMappingOptions()
  }), /already being updated/);
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).owner, "live-owner");
});

test("mapping lock never removes a replacement owner's lock", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const destination = await makeVerifiedManagedCheckout(aiosPath);
  const lockPath = `${statePath}.lock`;
  let replaced = false;
  const replacingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "rename") return target[property];
      return async (source, destinationPath) => {
        await fs.rename(source, destinationPath);
        if (destinationPath === statePath && !replaced) {
          replaced = true;
          await fs.writeFile(lockPath, `${JSON.stringify({
            format: "dotaios-project-state-lock/v1",
            pid: process.pid,
            owner: "replacement-owner",
            created_at: Date.now()
          })}\n`);
        }
      };
    }
  });

  await assert.rejects(updateProjectPathMapping({
    aiosPath,
    statePath,
    fs: replacingFs,
    id: "widget-id",
    slug: "widget",
    projectPath: destination,
    ...verifiedMappingOptions()
  }), /lock ownership changed/);
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).owner, "replacement-owner");
});
