import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import {
  applyProjectRegistration,
  doctorProjects,
  listProjects,
  planProjectRegistration,
  registerProject,
  resolveProject
} from "../../packages/core/src/projects.mjs";
import { projectCommand } from "../../packages/cli/src/commands/project.mjs";

const execFileAsync = promisify(execFile);
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const statePath = path.join(root, "local-state", "projects.json");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.mkdir(homePath, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, aiosPath, homePath, statePath };
}

async function makeRepo(root, name) {
  const projectPath = path.join(root, "repos", name);
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, "source.txt"), `source for ${name}\n`);
  return projectPath;
}

async function readReadme(readmePath) {
  const content = await fs.readFile(readmePath, "utf8");
  const match = FRONTMATTER_RE.exec(content);
  assert.ok(match, `README should have YAML frontmatter:\n${content}`);
  const document = parseDocument(match[1]);
  assert.equal(document.errors.length, 0);
  return { content, metadata: document.toJS(), body: match[2] };
}

async function writeProjectReadme(aiosPath, slug, frontmatter, body = `# ${slug}\n`) {
  const readmePath = path.join(aiosPath, "projects", slug, "README.md");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.writeFile(readmePath, `---\n${frontmatter}\n---\n${body}`);
  return readmePath;
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

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("registerProject previews the durable README by default without writing project truth", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "preview-project");

  const preview = await registerProject({
    aiosPath,
    statePath,
    projectPath,
    createId: () => "preview-id",
    readRepoUrl: async () => null
  });

  assert.equal(preview.applied, false);
  assert.match(preview.preview, /--- \/dev\/null/);
  assert.match(preview.preview, /\+\+\+ projects\/preview-project\/README\.md/);
  assert.deepEqual({
    version: preview.receipt.version,
    type: preview.receipt.type,
    operation: preview.receipt.operation,
    project_id: preview.receipt.project_id,
    project: preview.receipt.project,
    applied: preview.receipt.applied
  }, {
    version: 1,
    type: "project-registration",
    operation: "add",
    project_id: "preview-id",
    project: "preview-project",
    applied: false
  });
  assert.deepEqual({
    path: preview.receipt.durable.path,
    before_hash: preview.receipt.durable.before_hash
  }, {
    path: path.join("projects", "preview-project", "README.md"),
    before_hash: null
  });
  assert.deepEqual(preview.receipt.machine_local, {
    state_path: statePath,
    project_path: projectPath
  });
  assert.match(preview.receipt.durable.after_hash, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(preview.readmePath), { code: "ENOENT" });
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("registerProject writes project truth only with explicit apply or yes", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "approved-project");

  const applied = await registerProject({
    aiosPath,
    statePath,
    projectPath,
    yes: true,
    createId: () => "approved-id",
    readRepoUrl: async () => null
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.receipt.applied, true);
  assert.equal((await readReadme(applied.readmePath)).metadata.id, "approved-id");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    "approved-id": projectPath
  });
});

test("default project Git discovery ignores inherited repository-control environment", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "real-repository");
  const attackerPath = await makeRepo(root, "attacker-repository");
  for (const [repoPath, remote] of [
    [projectPath, "https://github.com/acme/real-repository.git"],
    [attackerPath, "https://github.com/attacker/wrong.git"]
  ]) {
    await execFileAsync("git", ["init", "-q", repoPath]);
    await execFileAsync("git", ["-C", repoPath, "remote", "add", "origin", remote]);
  }

  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(attackerPath, ".git");
  try {
    const plan = await planProjectRegistration({
      aiosPath,
      statePath,
      projectPath,
      createId: () => "real-id"
    });
    assert.equal(plan.repoUrl, "https://github.com/acme/real-repository.git");
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
});

test("project add CLI preview is zero-write and keeps absolute paths out of portable JSON", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "json-preview");

  const result = runCli([
    "project", "add", projectPath,
    "--path", aiosPath,
    "--state-path", statePath,
    "--json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.applied, false);
  assert.equal(payload.plan.operation, "add");
  assert.equal(payload.plan.project.slug, "json-preview");
  assert.equal(payload.plan.durable.path, path.join("projects", "json-preview", "README.md"));
  assert.match(payload.plan.preview, /--- \/dev\/null/);
  assert.deepEqual(payload.machine_local, {
    state_path: statePath,
    project_path: projectPath
  });
  assert.equal(payload.receipt.applied, false);
  assert.equal(payload.receipt.machine_local, undefined);
  assert.equal(
    JSON.stringify({ plan: payload.plan, receipt: payload.receipt }).includes(root),
    false,
    "portable JSON sections must not contain machine-local absolute paths"
  );
  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects")), []);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(projectPath, "source.txt"), "utf8"), "source for json-preview\n");
});

test("project add CLI applies explicitly and re-adds or updates one stable project", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "repeat-cli");
  const baseArgs = [
    "project", "add", projectPath,
    "--path", aiosPath,
    "--state-path", statePath,
    "--json"
  ];

  const first = JSON.parse(runCli([...baseArgs, "--apply"]).stdout);
  assert.equal(first.applied, true);
  assert.equal(first.receipt.applied, true);
  assert.equal(first.receipt.operation, "add");
  const readmePath = path.join(aiosPath, first.receipt.durable.path);
  const firstReadme = await fs.readFile(readmePath, "utf8");

  const repeated = JSON.parse(runCli([...baseArgs, "--yes"]).stdout);
  assert.equal(repeated.applied, true);
  assert.equal(repeated.receipt.operation, "replace");
  assert.equal(repeated.receipt.project_id, first.receipt.project_id);
  assert.equal(repeated.receipt.durable.before_hash, repeated.receipt.durable.after_hash);
  assert.equal(await fs.readFile(readmePath, "utf8"), firstReadme);

  const updated = JSON.parse(runCli([...baseArgs, "--status", "paused", "--apply"]).stdout);
  assert.equal(updated.receipt.project_id, first.receipt.project_id);
  assert.equal(updated.plan.project.status, "paused");
  assert.equal((await readReadme(readmePath)).metadata.status, "paused");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    [first.receipt.project_id]: projectPath
  });
  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects")), ["repeat-cli"]);
});

test("applyProjectRegistration rejects stale README and local-state plans", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const readmeRacePath = await makeRepo(root, "readme-race");
  const readmePlan = await planProjectRegistration({
    aiosPath,
    statePath,
    projectPath: readmeRacePath,
    createId: () => "readme-race-id",
    readRepoUrl: async () => null
  });
  await fs.mkdir(path.dirname(readmePlan.readmePath), { recursive: true });
  await fs.writeFile(readmePlan.readmePath, "# Concurrent project truth\n");

  await assert.rejects(
    applyProjectRegistration(readmePlan),
    /project README changed after the preview/
  );
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });

  await fs.rm(readmePlan.readmePath);
  const stateRacePath = await makeRepo(root, "state-race");
  const statePlan = await planProjectRegistration({
    aiosPath,
    statePath,
    projectPath: stateRacePath,
    createId: () => "state-race-id",
    readRepoUrl: async () => null
  });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({ version: 1, paths: { concurrent: readmeRacePath } }, null, 2)}\n`);

  await assert.rejects(
    applyProjectRegistration(statePlan),
    /machine-local project path state changed after the preview/
  );
  await assert.rejects(fs.access(statePlan.readmePath), { code: "ENOENT" });
});

test("project help explains preview, explicit apply, JSON, and local path separation", () => {
  const result = runCli(["project", "--help"]);

  assert.match(result.stdout, /read-only preview unless you explicitly pass --apply or --yes/);
  assert.match(result.stdout, /--apply\s+Apply the exact plan/);
  assert.match(result.stdout, /--yes\s+Explicit script-friendly alias/);
  assert.match(result.stdout, /--json\s+Print the portable plan and receipt/);
  assert.match(result.stdout, /local path mapping only on this machine/);
});

test("registerProject rejects a project README path that escapes through a symlink", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "outside-repo");
  const outside = path.join(root, "outside-project-truth");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(aiosPath, "projects", "escaped"), "dir");

  await assert.rejects(
    registerProject({
      aiosPath,
      statePath,
      projectPath,
      slug: "escaped",
      apply: true,
      createId: () => "escaped-id",
      readRepoUrl: async () => null
    }),
    /project README path.*outside the AIOS project shelf/i
  );

  await assert.rejects(fs.access(path.join(outside, "README.md")), { code: "ENOENT" });
});

test("registerProject discovers a Git remote and separates synced metadata from machine-local paths", async (t) => {
  const { root, aiosPath, homePath } = await fixture(t);
  const projectPath = await makeRepo(root, "Client Portal");
  await execFileAsync("git", ["init", "--quiet", projectPath]);
  await execFileAsync("git", ["-C", projectPath, "remote", "add", "upstream", "https://github.com/acme/client-portal.git"]);

  const project = await registerProject({
    aiosPath,
    homePath,
    projectPath,
    apply: true,
    createId: () => "project-001"
  });

  assert.deepEqual(
    { id: project.id, slug: project.slug, repoUrl: project.repoUrl },
    {
      id: "project-001",
      slug: "client-portal",
      repoUrl: "https://github.com/acme/client-portal.git"
    }
  );
  const readme = await readReadme(project.readmePath);
  assert.deepEqual(readme.metadata, {
    id: "project-001",
    project: "client-portal",
    name: "Client Portal",
    status: "active",
    domain: ["build"],
    repo_url: "https://github.com/acme/client-portal.git"
  });
  assert.equal(readme.content.includes(projectPath), false, "synced metadata must not contain a machine path");

  const statePath = path.join(homePath, ".dotaios", "projects.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(state.paths, { "project-001": projectPath });
  assert.equal(await fs.readFile(path.join(projectPath, "source.txt"), "utf8"), "source for Client Portal\n");
  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects", "client-portal")), ["README.md"]);
});

test("registerProject rejects project repositories inside AIOS without modifying them", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const nestedRepo = path.join(aiosPath, "actual-repositories", "nested");
  await fs.mkdir(nestedRepo, { recursive: true });
  const sentinel = path.join(nestedRepo, "keep.txt");
  await fs.writeFile(sentinel, "untouched\n");

  await assert.rejects(
    registerProject({
      aiosPath,
      statePath,
      projectPath: nestedRepo,
      createId: () => "should-not-be-used"
    }),
    /inside the AIOS folder.*own Git history/
  );

  assert.equal(await fs.readFile(sentinel, "utf8"), "untouched\n");
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("registerProject preserves stable ids, unknown frontmatter, and the README body", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "legacy-repo");
  const originalBody = "# Existing project\n\nKeep this paragraph, checklist, and link.\n\n- [ ] Ship it\n";
  const readmePath = await writeProjectReadme(
    aiosPath,
    "legacy",
    [
      "project_id: stable-legacy-id",
      "project: legacy",
      "status: planning",
      "domain: [make]",
      "owner: Filippo",
      "custom:",
      "  keep: true"
    ].join("\n"),
    originalBody
  );

  const project = await registerProject({
    aiosPath,
    statePath,
    projectPath,
    apply: true,
    slug: "legacy",
    name: "Legacy Renamed",
    status: "active",
    domain: ["build", "sell"],
    repoUrl: "https://github.com/acme/legacy.git",
    createId: () => {
      throw new Error("existing id should be reused");
    },
    readRepoUrl: async () => "git@github.com:acme/legacy.git"
  });

  assert.equal(project.id, "stable-legacy-id");
  assert.equal(project.receipt.operation, "replace");
  const readme = await readReadme(readmePath);
  assert.equal(readme.metadata.id, "stable-legacy-id");
  assert.equal(readme.metadata.project_id, "stable-legacy-id");
  assert.equal(readme.metadata.owner, "Filippo");
  assert.deepEqual(readme.metadata.custom, { keep: true });
  assert.equal(readme.metadata.name, "Legacy Renamed");
  assert.equal(readme.metadata.status, "active");
  assert.deepEqual(readme.metadata.domain, ["build", "sell"]);
  assert.equal(readme.metadata.repo_url, "https://github.com/acme/legacy.git");
  assert.equal(readme.body, originalBody);
  assert.equal(readme.content.includes(projectPath), false);
});

test("re-registering the same path reuses its id and updates metadata in place", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "repeat-project");

  const first = await registerProject({
    aiosPath,
    statePath,
    projectPath,
    apply: true,
    createId: () => "repeat-id",
    readRepoUrl: async () => null
  });
  const second = await registerProject({
    aiosPath,
    statePath,
    projectPath,
    apply: true,
    status: "paused",
    createId: () => {
      throw new Error("id must remain stable");
    },
    readRepoUrl: async () => null
  });

  assert.equal(second.id, first.id);
  assert.equal(second.readmePath, first.readmePath);
  const readme = await readReadme(first.readmePath);
  assert.equal(readme.metadata.status, "paused");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(state.paths, { "repeat-id": projectPath });
});

test("listProjects returns sorted portable metadata with local availability", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const zetaPath = await makeRepo(root, "zeta");
  await registerProject({
    aiosPath,
    statePath,
    projectPath: zetaPath,
    apply: true,
    slug: "zeta",
    domain: "make",
    createId: () => "zeta-id",
    readRepoUrl: async () => null
  });
  await writeProjectReadme(
    aiosPath,
    "alpha",
    "id: alpha-id\nproject: alpha\nname: Alpha\nstatus: planning\ndomain: [sell]\nrepo_url: null"
  );

  const projects = await listProjects({ aiosPath, statePath });

  assert.deepEqual(projects.map((project) => project.slug), ["alpha", "zeta"]);
  assert.deepEqual(
    projects.map((project) => ({ id: project.id, path: project.projectPath, available: project.pathAvailable })),
    [
      { id: "alpha-id", path: null, available: false },
      { id: "zeta-id", path: zetaPath, available: true }
    ]
  );
  assert.match(projects[1].readme, /# zeta/);
  assert.equal(projects[1].project, "zeta");
});

test("resolveProject accepts slug or id and explains unavailable paths", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "resolvable");
  await registerProject({
    aiosPath,
    statePath,
    projectPath,
    apply: true,
    createId: () => "resolve-id",
    readRepoUrl: async () => null
  });

  assert.equal(await resolveProject("resolvable", { aiosPath, statePath }), projectPath);
  assert.equal(await resolveProject({ aiosPath, statePath, project: "resolve-id" }), projectPath);

  await fs.rm(projectPath, { recursive: true });
  await assert.rejects(
    resolveProject({ aiosPath, statePath, project: "resolvable" }),
    /registered at .* but that path is missing.*project add/
  );

  await writeProjectReadme(
    aiosPath,
    "unmapped",
    "id: unmapped-id\nproject: unmapped\nname: Unmapped\nstatus: active\ndomain: [build]\nrepo_url: null"
  );
  await assert.rejects(
    resolveProject({ aiosPath, statePath, project: "unmapped" }),
    /has no path on this machine.*project add/
  );
  await assert.rejects(
    resolveProject({ aiosPath, statePath, project: "unknown" }),
    /is not registered.*project list/
  );
});

test("doctorProjects reports missing paths and remote mismatches without writing", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const goodPath = await makeRepo(root, "good");
  const mismatchPath = await makeRepo(root, "mismatch");
  const missingPath = await makeRepo(root, "missing");
  const registrations = [
    [goodPath, "good-id", "https://github.com/acme/good.git"],
    [mismatchPath, "mismatch-id", "https://github.com/acme/expected.git"],
    [missingPath, "missing-id", "https://github.com/acme/missing.git"]
  ];
  for (const [projectPath, id, repoUrl] of registrations) {
    await registerProject({
      aiosPath,
      statePath,
      projectPath,
      apply: true,
      repoUrl,
      createId: () => id,
      readRepoUrl: async () => repoUrl
    });
  }
  await fs.rm(missingPath, { recursive: true });
  await writeProjectReadme(
    aiosPath,
    "unmapped",
    "id: unmapped-id\nproject: unmapped\nname: Unmapped\nstatus: active\ndomain: [build]\nrepo_url: null"
  );

  const trackedFiles = [
    statePath,
    ...registrations.map(([projectPath]) => path.join(aiosPath, "projects", path.basename(projectPath), "README.md")),
    path.join(aiosPath, "projects", "unmapped", "README.md")
  ];
  const before = await Promise.all(trackedFiles.map((file) => fs.readFile(file, "utf8")));
  const report = await doctorProjects({
    aiosPath,
    statePath,
    readRepoUrl: async (projectPath) => {
      if (projectPath === goodPath) return "git@github.com:acme/good.git";
      if (projectPath === mismatchPath) return "https://github.com/acme/actual.git";
      return null;
    }
  });
  const after = await Promise.all(trackedFiles.map((file) => fs.readFile(file, "utf8")));

  assert.equal(report.ok, false);
  assert.equal(report.checked, 4);
  assert.deepEqual(
    report.issues.map((issue) => [issue.type, issue.project.slug]).sort(),
    [
      ["missing_path", "missing"],
      ["missing_path", "unmapped"],
      ["remote_mismatch", "mismatch"]
    ]
  );
  assert.deepEqual(after, before, "doctor must be read-only");
});

test("doctorProjects reports local state whose durable project README is missing", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({ version: 1, paths: { "orphan-id": "/tmp/missing-project" } }));

  const report = await doctorProjects({ aiosPath, statePath });

  assert.equal(report.ok, false);
  assert.equal(report.checked, 1);
  assert.equal(report.issues[0].type, "orphan_state");
  assert.match(report.issues[0].message, /no durable project README/);
});

test("local state overrides are rejected when they point or resolve inside synced AIOS content", async (t) => {
  const { root, aiosPath } = await fixture(t);
  const projectPath = await makeRepo(root, "outside");
  const unsafeStatePath = path.join(aiosPath, ".state", "projects.json");

  await assert.rejects(
    registerProject({
      aiosPath,
      statePath: unsafeStatePath,
      projectPath,
      createId: () => "unsafe-id"
    }),
    /state must live outside the synced AIOS folder/
  );
  await assert.rejects(fs.access(unsafeStatePath), { code: "ENOENT" });

  const linkedStateTarget = path.join(aiosPath, "linked-state");
  const linkedStateParent = path.join(root, "state-link");
  await fs.mkdir(linkedStateTarget);
  await fs.symlink(linkedStateTarget, linkedStateParent, "dir");
  await assert.rejects(
    listProjects({ aiosPath, statePath: path.join(linkedStateParent, "projects.json") }),
    /state must live outside the synced AIOS folder/
  );
});

test("projectCommand exposes add preview data plus list, resolve, and doctor output", async (t) => {
  const { root, aiosPath, homePath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "cli-project");
  const capture = outputCapture();
  const dependencies = {
    output: capture.output,
    createId: () => "cli-id",
    readRepoUrl: async () => "https://github.com/acme/cli.git"
  };

  const preview = await projectCommand([
    "add",
    projectPath,
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath,
    "--name", "CLI Project",
    "--domain", "build",
    "--domain", "make"
  ], dependencies);
  assert.equal(preview.applied, false);
  assert.match(preview.preview, /\+\+\+ projects\/cli-project\/README\.md/);
  assert.match(capture.lines.join("\n"), /Project registration preview \(no files changed\)/);
  assert.match(capture.lines.join("\n"), /Preview only.*--apply/s);
  await assert.rejects(fs.access(preview.readmePath), { code: "ENOENT" });

  capture.lines.length = 0;
  const applied = await projectCommand([
    "add",
    projectPath,
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath,
    "--name", "CLI Project",
    "--domain", "build",
    "--domain", "make",
    "--yes"
  ], dependencies);
  assert.equal(applied.applied, true);
  assert.match(capture.lines.join("\n"), /Project registration applied: CLI Project \(cli-project\)/);

  capture.lines.length = 0;
  const listed = await projectCommand(["list", "--path", aiosPath, "--state-path", statePath], {
    output: capture.output
  });
  assert.equal(listed.length, 1);
  assert.match(capture.lines.join("\n"), /\[external\] cli-project.*domain: build, make/s);

  capture.lines.length = 0;
  const resolved = await projectCommand([
    "resolve", "cli-id", "--path", aiosPath, "--state-path", statePath
  ], { output: capture.output });
  assert.equal(resolved, projectPath);
  assert.deepEqual(capture.lines, [projectPath]);

  capture.lines.length = 0;
  let exitCode = null;
  const report = await projectCommand(["doctor", "--path", aiosPath, "--state-path", statePath], {
    output: capture.output,
    readRepoUrl: async () => "https://github.com/acme/different.git",
    setExitCode(code) {
      exitCode = code;
    }
  });
  assert.equal(report.ok, false);
  assert.equal(exitCode, 1);
  assert.match(capture.lines.join("\n"), /\[mismatch\].*1 issue\(s\) found/s);
});

test("project list names managed, external, restorable, and local-only states", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const managedPath = path.join(aiosPath, "workspaces", "managed");
  const externalPath = path.join(root, "external");
  await fs.mkdir(managedPath, { recursive: true });
  await fs.mkdir(externalPath, { recursive: true });
  await writeProjectReadme(aiosPath, "managed", "id: managed-id\nproject: managed\nrepo_url: https://github.com/acme/managed.git");
  await writeProjectReadme(aiosPath, "external", "id: external-id\nproject: external\nrepo_url: https://github.com/acme/external.git");
  await writeProjectReadme(aiosPath, "restorable", "id: restorable-id\nproject: restorable\nrepo_url: https://github.com/acme/restorable.git");
  await writeProjectReadme(aiosPath, "local-only", "id: local-id\nproject: local-only\nrepo_url: https://token@github.com/acme/private.git");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({
    version: 1,
    paths: {
      "managed-id": managedPath,
      "external-id": externalPath
    }
  })}\n`);

  const capture = outputCapture();
  await projectCommand(["list", "--path", aiosPath, "--state-path", statePath], {
    output: capture.output
  });
  const rendered = capture.lines.join("\n");
  assert.match(rendered, /\[managed\] managed:/);
  assert.match(rendered, /\[external\] external:/);
  assert.match(rendered, /\[restorable\] restorable:/);
  assert.match(rendered, /\[local-only\] local-only:/);
});

test("projectCommand rejects invalid metadata options before writing", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "invalid-options");

  await assert.rejects(
    projectCommand([
      "add", projectPath,
      "--path", aiosPath,
      "--state-path", statePath,
      "--domain", "finance"
    ], { createId: () => "invalid-id", readRepoUrl: async () => null }),
    /Unknown project domain.*build, make, or sell/
  );
  await assert.rejects(
    projectCommand([
      "add", projectPath,
      "--path", aiosPath,
      "--state-path", statePath,
      "--slug", "Invalid Slug"
    ], { createId: () => "invalid-id", readRepoUrl: async () => null }),
    /slug must use lowercase/
  );
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

async function writeTimeline(aiosPath, entries) {
  await fs.mkdir(path.join(aiosPath, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
}

test("project context emits the scoped continuity payload for a registered project", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", ["project_id: ctx-alpha-id", "project: alpha", "status: active"].join("\n"));
  await writeProjectReadme(aiosPath, "beta", ["project_id: ctx-beta-id", "project: beta", "status: active"].join("\n"));
  const now = new Date().toISOString();
  await writeTimeline(aiosPath, [
    { ts: now, type: "update", source: "dotaios update", project: "alpha", summary: "Alpha decided to use Postgres" },
    { ts: now, type: "update", source: "dotaios update", project: "beta", summary: "Beta decided to use SQLite" }
  ]);

  const { lines, output } = outputCapture();
  const result = await projectCommand([
    "context", "alpha",
    "--path", aiosPath, "--home", homePath, "--state-path", statePath
  ], { output });

  const text = lines.join("\n");
  assert.match(text, /Project continuity: alpha/);
  assert.match(text, /continuity: today\+yesterday/);
  assert.match(text, /Alpha decided to use Postgres/);
  assert.doesNotMatch(text, /Beta decided to use SQLite/);
  assert.equal(result.project, "alpha");
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("project context fails closed on an unregistered reference", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", ["project_id: ctx-alpha-2", "project: alpha", "status: active"].join("\n"));
  const { output } = outputCapture();
  await assert.rejects(
    projectCommand(["context", "ghost", "--path", aiosPath, "--home", homePath, "--state-path", statePath], { output }),
    /not registered/
  );
});

test("project context --json wraps the payload for tool bridges", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", ["project_id: ctx-alpha-3", "project: alpha", "status: active"].join("\n"));
  await writeTimeline(aiosPath, [
    { ts: new Date().toISOString(), type: "update", source: "dotaios update", project: "alpha", summary: "Alpha decided to use Postgres" }
  ]);

  const { lines, output } = outputCapture();
  await projectCommand([
    "context", "alpha", "--json",
    "--path", aiosPath, "--home", homePath, "--state-path", statePath
  ], { output });

  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.project, "alpha");
  assert.ok(!("tool" in parsed));
  assert.match(parsed.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(parsed.context, /Alpha decided to use Postgres/);
  assert.ok(parsed.context_budget && typeof parsed.context_budget === "object");
});
