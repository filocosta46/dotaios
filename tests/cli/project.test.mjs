import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import {
  doctorProjects,
  listProjects,
  registerProject,
  resolveProject
} from "../../packages/core/src/projects.mjs";
import { projectCommand } from "../../packages/cli/src/commands/project.mjs";

const execFileAsync = promisify(execFile);
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

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

test("registerProject discovers a Git remote and separates synced metadata from machine-local paths", async (t) => {
  const { root, aiosPath, homePath } = await fixture(t);
  const projectPath = await makeRepo(root, "Client Portal");
  await execFileAsync("git", ["init", "--quiet", projectPath]);
  await execFileAsync("git", ["-C", projectPath, "remote", "add", "upstream", "https://github.com/acme/client-portal.git"]);

  const project = await registerProject({
    aiosPath,
    homePath,
    projectPath,
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
    createId: () => "repeat-id",
    readRepoUrl: async () => null
  });
  const second = await registerProject({
    aiosPath,
    statePath,
    projectPath,
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

test("projectCommand exposes beginner-facing add, list, resolve, and doctor output", async (t) => {
  const { root, aiosPath, homePath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "cli-project");
  const capture = outputCapture();
  const dependencies = {
    output: capture.output,
    createId: () => "cli-id",
    readRepoUrl: async () => "https://github.com/acme/cli.git"
  };

  await projectCommand([
    "add",
    projectPath,
    "--path", aiosPath,
    "--home", homePath,
    "--state-path", statePath,
    "--name", "CLI Project",
    "--domain", "build",
    "--domain", "make"
  ], dependencies);
  assert.match(capture.lines.join("\n"), /Registered CLI Project \(cli-project\)/);

  capture.lines.length = 0;
  const listed = await projectCommand(["list", "--path", aiosPath, "--state-path", statePath], {
    output: capture.output
  });
  assert.equal(listed.length, 1);
  assert.match(capture.lines.join("\n"), /\[ok\] cli-project.*domain: build, make/s);

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
