import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectCommand } from "../../packages/cli/src/commands/project.mjs";

const HEAD = "a".repeat(40);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-restore-cli-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const statePath = path.join(root, "state", "projects.json");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.2.0" })}\n`);
  await fs.writeFile(path.join(aiosPath, ".gitignore"), "/workspaces/\n");
  await fs.mkdir(homePath, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, aiosPath, homePath, statePath };
}

async function writeProject(aiosPath, slug, options = {}) {
  const id = options.id || `${slug}-id`;
  const remote = options.remote === undefined
    ? `https://github.com/acme/${slug}.git`
    : options.remote;
  const readmePath = path.join(aiosPath, "projects", slug, "README.md");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.writeFile(readmePath, [
    "---",
    `id: ${id}`,
    `project: ${slug}`,
    `name: ${slug}`,
    "status: active",
    "domain: [build]",
    `repo_url: ${remote === null ? "null" : remote}`,
    "---",
    `# ${slug}`,
    ""
  ].join("\n"));
  return { id, readmePath, remote };
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

function outputCapture() {
  const lines = [];
  return {
    lines,
    output: {
      log(...values) {
        lines.push(values.join(" "));
      },
      error(...values) {
        lines.push(values.join(" "));
      }
    }
  };
}

function refusingGit(overrides = {}) {
  return {
    cloneRepository: async () => { throw new Error("unexpected clone"); },
    readRepositoryRemote: async () => { throw new Error("unexpected remote read"); },
    readRepositoryHead: async () => { throw new Error("unexpected HEAD read"); },
    ...overrides
  };
}

test("project restore dry-run previews unavailable projects with zero writes", async (t) => {
  const { root, aiosPath, homePath, statePath } = await fixture(t);
  await writeProject(aiosPath, "missing");
  const available = await writeProject(aiosPath, "available");
  const externalPath = path.join(root, "external", "available");
  await fs.mkdir(externalPath, { recursive: true });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({
    version: 1,
    paths: { [available.id]: await verifiedPathMapping(externalPath) }
  }, null, 2)}\n`);
  const stateBefore = await fs.readFile(statePath, "utf8");
  const readmesBefore = await readProjectFiles(aiosPath);
  const capture = outputCapture();

  const receipt = await projectCommand([
    "restore",
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath,
    "--dry-run",
    "--json"
  ], {
    output: capture.output,
    projectGit: refusingGit()
  });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.selected, 1, "no-reference restore selects unavailable projects only");
  assert.equal(receipt.results[0].project, "missing");
  assert.equal(receipt.results[0].action, "would-clone");
  assert.equal(await fs.readFile(statePath, "utf8"), stateBefore);
  assert.deepEqual(await readProjectFiles(aiosPath), readmesBefore);
  await assert.rejects(fs.access(path.join(aiosPath, "workspaces")), { code: "ENOENT" });

  const json = JSON.parse(capture.lines.join("\n"));
  assert.equal(json.results[0].destination, undefined);
  assert.equal(JSON.stringify({ ...json, machine_local: undefined }).includes(root), false);
  assert.equal(json.machine_local.results[0].destination, path.join(aiosPath, "workspaces", "missing"));
});

test("project restore refuses an ignore rule canceled later in the same file", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProject(aiosPath, "missing");
  await fs.writeFile(path.join(aiosPath, ".gitignore"), "/workspaces/\n!/workspaces/\n");

  await assert.rejects(
    projectCommand([
      "restore", "missing",
      "--path", aiosPath,
      "--home", homePath,
      "--state-path", statePath,
      "--dry-run"
    ], { output: outputCapture().output, projectGit: refusingGit() }),
    /later ignore rule cancels.*privacy boundary/i
  );
  await assert.rejects(fs.access(path.join(aiosPath, "workspaces")), { code: "ENOENT" });
});

test("explicit restore accepts a valid external mapping without Git or writes", async (t) => {
  const { root, aiosPath, homePath, statePath } = await fixture(t);
  const project = await writeProject(aiosPath, "external");
  const externalPath = path.join(root, "repositories", "external");
  await fs.mkdir(path.join(externalPath, ".git"), { recursive: true });
  await fs.writeFile(path.join(externalPath, "README.md"), "# external checkout\n");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({
    version: 1,
    paths: { [project.id]: await verifiedPathMapping(externalPath) }
  }, null, 2)}\n`);
  const before = await fs.readFile(statePath, "utf8");

  const receipt = await projectCommand([
    "restore", project.id,
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath
  ], {
    output: outputCapture().output,
    projectGit: refusingGit({
      readRepositoryRemote: async () => project.remote,
      readRepositoryHead: async () => HEAD
    })
  });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.results[0].action, "already-available");
  assert.equal(receipt.results[0].destination, externalPath);
  assert.equal(await fs.readFile(statePath, "utf8"), before);
  await assert.rejects(fs.access(path.join(aiosPath, "workspaces")), { code: "ENOENT" });
});

test("project restore continues after clone failure and maps only verified success", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  const good = await writeProject(aiosPath, "good");
  const bad = await writeProject(aiosPath, "bad");
  const catalogBefore = await readProjectFiles(aiosPath);
  const exitCodes = [];
  const capture = outputCapture();
  const cloneCalls = [];
  const projectGit = refusingGit({
    cloneRepository: async ({ url, destination }) => {
      cloneCalls.push({ url, destination });
      if (url.endsWith("/bad.git")) throw new Error("network unavailable");
      await fs.mkdir(path.join(destination, ".git"));
      await fs.writeFile(path.join(destination, ".remote"), url);
      await fs.writeFile(path.join(destination, "README.md"), "# checkout\n");
    },
    readRepositoryRemote: async (destination) => fs.readFile(path.join(destination, ".remote"), "utf8"),
    readRepositoryHead: async () => HEAD
  });

  const receipt = await projectCommand([
    "restore",
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath,
    "--json"
  ], {
    output: capture.output,
    projectGit,
    setExitCode: (code) => exitCodes.push(code)
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.selected, 2);
  assert.equal(cloneCalls.length, 2, "a failure does not stop the remaining batch");
  const byProject = Object.fromEntries(receipt.results.map((result) => [result.project, result]));
  assert.equal(byProject.good.action, "cloned");
  assert.equal(byProject.bad.reason, "clone-failed");
  assert.deepEqual(exitCodes, [1]);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    [good.id]: await verifiedPathMapping(path.join(aiosPath, "workspaces", "good"))
  });
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(statePath, "utf8")).paths, bad.id), false);
  assert.deepEqual(await readProjectFiles(aiosPath), catalogBefore, "restore never edits tracked catalog records");

  const json = JSON.parse(capture.lines.join("\n"));
  assert.equal(json.ok, false);
  assert.equal(JSON.stringify(json.results).includes(aiosPath), false);
  assert.ok(json.machine_local.results.every((result) => result.destination.startsWith(aiosPath)));
});

test("project restore repairs a verified managed checkout without cloning", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  const project = await writeProject(aiosPath, "repair");
  const destination = path.join(aiosPath, "workspaces", "repair");
  await fs.mkdir(path.join(destination, ".git"), { recursive: true });
  await fs.writeFile(path.join(destination, "README.md"), "# existing checkout\n");
  const projectGit = refusingGit({
    readRepositoryRemote: async () => project.remote,
    readRepositoryHead: async () => HEAD
  });

  const receipt = await projectCommand([
    "restore", "repair",
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath
  ], {
    output: outputCapture().output,
    projectGit
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.results[0].action, "mapping-repaired");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    [project.id]: await verifiedPathMapping(destination)
  });
});

test("project restore accepts zero or one reference and scopes --dry-run", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await assert.rejects(
    projectCommand([
      "restore", "one", "two",
      "--path", aiosPath,
      "--home", homePath,
      "--state-path", statePath
    ], { output: outputCapture().output }),
    /Usage: dotaios project restore \[slug-or-id\]/
  );
  await assert.rejects(
    projectCommand(["list", "--path", aiosPath, "--dry-run"], {
      output: outputCapture().output
    }),
    /--dry-run can only be used with.*project restore/
  );
  await assert.rejects(
    projectCommand(["add", "/tmp/project", "--path", aiosPath, "--dry-run"], {
      output: outputCapture().output
    }),
    /--dry-run can only be used with.*project restore/
  );
});

async function readProjectFiles(aiosPath) {
  const projectsPath = path.join(aiosPath, "projects");
  const slugs = (await fs.readdir(projectsPath)).sort();
  return Object.fromEntries(await Promise.all(slugs.map(async (slug) => [
    slug,
    await fs.readFile(path.join(projectsPath, slug, "README.md"), "utf8")
  ])));
}
