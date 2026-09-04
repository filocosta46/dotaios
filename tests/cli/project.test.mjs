import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  projectStateProcessIsAlive,
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
  await fs.writeFile(path.join(aiosPath, "aios.json"), '{"schema_version":"1.2.0"}\n');
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

function runCli(args, { cwd = repoRoot } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function registerApprovedProject(options) {
  const preview = await registerProject({
    ...options,
    apply: false,
    yes: false
  });
  return registerProject({
    ...options,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true,
    yes: false
  });
}

function approvedCliArgs(preview, applyFlag = "--apply") {
  return [
    "--operation-id", preview.plan.operation_id,
    "--plan-fingerprint", preview.plan.plan_fingerprint,
    applyFlag
  ];
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
    project_path: projectPath,
    root_identity: (await verifiedPathMapping(projectPath)).root_identity
  });
  assert.match(preview.receipt.durable.after_hash, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(preview.readmePath), { code: "ENOENT" });
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("registerProject writes project truth only with explicit apply or yes", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "approved-project");

  const applied = await registerApprovedProject({
    aiosPath,
    statePath,
    projectPath,
    purpose: "Coordinate the approved launch work",
    yes: true,
    createId: () => "approved-id",
    readRepoUrl: async () => null
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.receipt.applied, true);
  const readme = await readReadme(applied.readmePath);
  assert.equal(readme.metadata.id, "approved-id");
  assert.equal(readme.metadata.description, "Coordinate the approved launch work");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    "approved-id": await verifiedPathMapping(projectPath)
  });
});

test("an explicitly supplied unsafe project remote fails redacted before any write", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "unsafe-explicit-remote");
  const secret = "super-secret-token";
  const unsafeRemote = `https://user:${secret}@github.com/acme/private.git`;
  let discoveryCalled = false;

  await assert.rejects(
    registerProject({
      aiosPath,
      statePath,
      projectPath,
      repoUrl: unsafeRemote,
      yes: true,
      createId: () => "unsafe-remote-id",
      readRepoUrl: async () => {
        discoveryCalled = true;
        return "https://github.com/acme/safe-fallback.git";
      }
    }),
    (error) => {
      assert.equal(error.code, "ERR_DOTAIOS_UNSAFE_PROJECT_REMOTE");
      assert.match(error.message, /explicit project remote is unsafe/i);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(unsafeRemote), false);
      return true;
    }
  );

  assert.equal(discoveryCalled, false, "an explicit rejection must not fall back to Git discovery");
  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects")), []);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("an unsafe discovered project remote remains local-only", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "unsafe-discovered-remote");

  const plan = await planProjectRegistration({
    aiosPath,
    statePath,
    projectPath,
    createId: () => "local-only-id",
    readRepoUrl: async () => "https://user:hidden@github.com/acme/private.git"
  });

  assert.equal(plan.repoUrl, null);
  assert.doesNotMatch(plan.readme, /hidden/);
  assert.doesNotMatch(plan.readme, /https?:\/\//);
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
    "--purpose", "Keep the launch work understandable and reachable",
    "--json"
  ]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.applied, false);
  assert.equal(payload.plan.operation, "add");
  assert.equal(payload.plan.project.slug, "json-preview");
  assert.equal(payload.plan.project.description, "Keep the launch work understandable and reachable");
  assert.equal(payload.plan.durable.path, path.join("projects", "json-preview", "README.md"));
  assert.match(payload.plan.preview, /--- \/dev\/null/);
  assert.deepEqual(payload.machine_local, {
    state_path: statePath,
    project_path: projectPath,
    root_identity: (await verifiedPathMapping(projectPath)).root_identity
  });
  assert.equal(payload.receipt.applied, false);
  assert.equal(payload.receipt.machine_local, undefined);
  assert.equal(
    JSON.stringify({ plan: payload.plan, receipt: payload.receipt }).includes(root),
    false,
    "portable JSON sections must not contain machine-local absolute paths"
  );
  assert.equal(
    JSON.stringify({ plan: payload.plan, receipt: payload.receipt }).includes("root_identity"),
    false,
    "portable JSON sections must not contain machine-local root identity"
  );
  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects")), []);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(projectPath, "source.txt"), "utf8"), "source for json-preview\n");
});

test("project identify --json reports Memory: Off when the AIOS folder is missing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-identify-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missingAiosPath = path.join(root, "moved-aios");

  const result = runCli([
    "project", "identify", "--json",
    "--path", missingAiosPath,
    "--home", root
  ]);

  assert.deepEqual(JSON.parse(result.stdout), {
    receipt: "Memory: Off",
    registered_project: null,
    aios_folder: false
  });
  assert.equal(result.stderr, "");
});

// The AIOS folder is never a registered project, so before this it identified as
// `Memory: Off` — the most closed mode, in the folder that exists to hold memory.
test("project identify --json reports Memory: Shared inside the AIOS folder", async (t) => {
  const { root, aiosPath } = await fixture(t);

  const result = runCli(
    ["project", "identify", "--json", "--path", aiosPath, "--home", root],
    { cwd: aiosPath }
  );

  assert.deepEqual(JSON.parse(result.stdout), {
    receipt: "Memory: Shared",
    registered_project: null,
    aios_folder: true
  });
});

test("project identify --json reports Memory: Shared from a nested AIOS directory", async (t) => {
  const { root, aiosPath } = await fixture(t);
  const nested = path.join(aiosPath, "vault", "notes");
  await fs.mkdir(nested, { recursive: true });

  const result = runCli(
    ["project", "identify", "--json", "--path", aiosPath, "--home", root],
    { cwd: nested }
  );

  assert.equal(JSON.parse(result.stdout).receipt, "Memory: Shared");
});

// A sibling that merely starts with the same characters is not inside the folder.
// Opening memory on a string prefix would leak Shared scope to unrelated work.
test("project identify --json does not treat a path prefix as the AIOS folder", async (t) => {
  const { root, aiosPath } = await fixture(t);
  const lookalike = `${aiosPath}-backup`;
  await fs.mkdir(lookalike, { recursive: true });

  const result = runCli(
    ["project", "identify", "--json", "--path", aiosPath, "--home", root],
    { cwd: lookalike }
  );

  assert.deepEqual(JSON.parse(result.stdout), {
    receipt: "Memory: Off",
    registered_project: null,
    aios_folder: false
  });
});

// Opening the AIOS folder to Shared must not loosen project scoping: a
// registered checkout still identifies as its own project.
test("project identify --json still scopes a registered project", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "still-scoped");
  const baseArgs = [
    "project", "add", projectPath,
    "--path", aiosPath,
    "--state-path", statePath,
    "--purpose", "Prove project scoping survives the AIOS folder default",
    "--json"
  ];

  const preview = JSON.parse(runCli(baseArgs).stdout);
  const applied = JSON.parse(runCli([
    ...baseArgs,
    "--operation-id", preview.plan.operation_id,
    "--plan-fingerprint", preview.plan.plan_fingerprint,
    "--apply"
  ]).stdout);
  assert.equal(applied.applied, true);

  const result = JSON.parse(runCli(
    [
      "project", "identify", "--json",
      "--path", aiosPath,
      "--state-path", statePath,
      "--home", root
    ],
    { cwd: projectPath }
  ).stdout);

  assert.equal(result.receipt, "Memory: This project");
  assert.equal(result.aios_folder, false);
  assert.equal(result.registered_project.slug, applied.registered_project.slug);
});

test("project add CLI applies only the exact proof from its zero-write preview", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "proved-cli");
  const baseArgs = [
    "project", "add", projectPath,
    "--path", aiosPath,
    "--state-path", statePath,
    "--purpose", "Carry one approved plan across the preview boundary",
    "--json"
  ];

  const preview = JSON.parse(runCli(baseArgs).stdout);
  const otherAiosPath = path.join(root, "other-aios");
  await fs.mkdir(path.join(otherAiosPath, "projects"), { recursive: true });
  assert.equal(preview.applied, false);
  assert.equal(preview.registered_project, null);
  assert.match(preview.plan.operation_id, /^[a-f0-9-]{1,64}$/);
  assert.match(preview.plan.plan_fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(path.join(aiosPath, "projects", "proved-cli", "README.md")), { code: "ENOENT" });
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });

  for (const refusedArgs of [
    [...baseArgs, "--apply"],
    [...baseArgs, "--operation-id", "caller-chosen-id"],
    [
      ...baseArgs,
      "--operation-id", "caller-chosen-id",
      "--plan-fingerprint", preview.plan.plan_fingerprint,
      "--apply"
    ],
    [
      ...baseArgs,
      "--operation-id", preview.plan.operation_id,
      "--plan-fingerprint", "0".repeat(64),
      "--apply"
    ]
  ]) {
    const refused = spawnSync(process.execPath, [cliPath, ...refusedArgs], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" }
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /proof options can only be used|operation id and plan fingerprint|plan is stale/i);
    await assert.rejects(fs.access(path.join(aiosPath, "projects", "proved-cli", "README.md")), { code: "ENOENT" });
    await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  }

  const redirected = spawnSync(process.execPath, [
    cliPath,
    ...baseArgs.map((arg) => arg === aiosPath ? otherAiosPath : arg),
    "--operation-id", preview.plan.operation_id,
    "--plan-fingerprint", preview.plan.plan_fingerprint,
    "--apply"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" }
  });
  assert.notEqual(redirected.status, 0);
  assert.match(redirected.stderr, /plan is stale/i);
  await assert.rejects(
    fs.access(path.join(otherAiosPath, "projects", "proved-cli", "README.md")),
    { code: "ENOENT" }
  );
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });

  const applied = JSON.parse(runCli([
    ...baseArgs,
    "--operation-id", preview.plan.operation_id,
    "--plan-fingerprint", preview.plan.plan_fingerprint,
    "--apply"
  ]).stdout);
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.registered_project, {
    id: preview.plan.project.id,
    slug: preview.plan.project.slug
  });
  assert.equal(applied.plan.project.id, preview.plan.project.id);
  assert.equal(applied.plan.durable.after_hash, preview.plan.durable.after_hash);
  assert.equal(applied.plan.preview, preview.plan.preview);
  assert.equal(applied.plan.operation_id, preview.plan.operation_id);
  assert.equal(applied.plan.plan_fingerprint, preview.plan.plan_fingerprint);
  const readme = await fs.readFile(path.join(aiosPath, "projects", "proved-cli", "README.md"), "utf8");
  assert.equal(createHash("sha256").update(readme).digest("hex"), preview.plan.durable.after_hash);
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

  const firstPreview = JSON.parse(runCli(baseArgs).stdout);
  const first = JSON.parse(runCli([...baseArgs, ...approvedCliArgs(firstPreview)]).stdout);
  assert.equal(first.applied, true);
  assert.equal(first.receipt.applied, true);
  assert.equal(first.receipt.operation, "add");
  const readmePath = path.join(aiosPath, first.receipt.durable.path);
  const firstReadme = await fs.readFile(readmePath, "utf8");

  const repeatedPreview = JSON.parse(runCli(baseArgs).stdout);
  const repeated = JSON.parse(runCli([...baseArgs, ...approvedCliArgs(repeatedPreview, "--yes")]).stdout);
  assert.equal(repeated.applied, true);
  assert.equal(repeated.receipt.operation, "replace");
  assert.equal(repeated.receipt.project_id, first.receipt.project_id);
  assert.equal(repeated.receipt.durable.before_hash, repeated.receipt.durable.after_hash);
  assert.equal(await fs.readFile(readmePath, "utf8"), firstReadme);

  const updatedArgs = [...baseArgs, "--status", "paused"];
  const updatedPreview = JSON.parse(runCli(updatedArgs).stdout);
  const updated = JSON.parse(runCli([...updatedArgs, ...approvedCliArgs(updatedPreview)]).stdout);
  assert.equal(updated.receipt.project_id, first.receipt.project_id);
  assert.equal(updated.plan.project.status, "paused");
  assert.equal((await readReadme(readmePath)).metadata.status, "paused");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).paths, {
    [first.receipt.project_id]: await verifiedPathMapping(projectPath)
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

test("applyProjectRegistration rejects a plan mutated after preview", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "mutated-plan");
  const plan = await planProjectRegistration({
    aiosPath,
    statePath,
    projectPath,
    purpose: "Keep the applied bytes identical to the approved preview",
    createId: () => "mutated-plan-id",
    readRepoUrl: async () => null
  });
  plan.readme = `${plan.readme}\nUnapproved mutation.\n`;

  await assert.rejects(
    applyProjectRegistration(plan),
    /invalid project registration plan/i
  );
  await assert.rejects(fs.access(plan.readmePath), { code: "ENOENT" });
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("applyProjectRegistration refuses a replaced project folder without partial state", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "replaced-after-preview");
  const plan = await planProjectRegistration({
    aiosPath,
    statePath,
    projectPath,
    purpose: "Keep one exact primary folder",
    createId: () => "replaced-id",
    readRepoUrl: async () => null
  });
  const originalPath = `${projectPath}-original`;
  await fs.rename(projectPath, originalPath);
  await fs.mkdir(projectPath);

  await assert.rejects(
    applyProjectRegistration(plan),
    /project folder changed after the preview/i
  );

  await assert.rejects(fs.access(plan.readmePath), { code: "ENOENT" });
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(originalPath, "source.txt"), "utf8"), "source for replaced-after-preview\n");
});

test("project help explains preview, explicit apply, JSON, and local path separation", () => {
  const result = runCli(["project", "--help"]);

  assert.match(result.stdout, /read-only preview\. Applying requires --apply or --yes plus the\s+operation id and fingerprint/);
  assert.match(result.stdout, /--apply\s+Apply only the exact displayed/);
  assert.match(result.stdout, /--yes\s+Script-friendly alias for the same proof-bound apply/);
  assert.match(result.stdout, /--purpose <text>\s+Optional routing hint; the folder connects without one/);
  assert.match(result.stdout, /--json\s+Print the portable plan and receipt/);
  assert.match(result.stdout, /local path mapping and verified directory\s+identity only on this machine/);
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

  const project = await registerApprovedProject({
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
  assert.deepEqual(state.paths, { "project-001": await verifiedPathMapping(projectPath) });
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

test("registerProject rejects a symlinked primary-folder record without writing", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const actualPath = await makeRepo(root, "actual-primary-folder");
  const linkedPath = path.join(root, "linked-primary-folder");
  await fs.symlink(actualPath, linkedPath, "dir");

  await assert.rejects(
    registerProject({
      aiosPath,
      statePath,
      projectPath: linkedPath,
      purpose: "Do not trust an aliased project root",
      apply: true,
      createId: () => "linked-primary-id",
      readRepoUrl: async () => null
    }),
    /must not be a symbolic link/i
  );

  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects")), []);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(actualPath, "source.txt"), "utf8"), "source for actual-primary-folder\n");
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
      "owner: Avery",
      "custom:",
      "  keep: true"
    ].join("\n"),
    originalBody
  );

  const project = await registerApprovedProject({
    aiosPath,
    statePath,
    projectPath,
    purpose: "Maintain the launch project",
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
  assert.equal(readme.metadata.owner, "Avery");
  assert.deepEqual(readme.metadata.custom, { keep: true });
  assert.equal(readme.metadata.name, "Legacy Renamed");
  assert.equal(readme.metadata.description, "Maintain the launch project");
  assert.equal(readme.metadata.status, "active");
  assert.deepEqual(readme.metadata.domain, ["build", "sell"]);
  assert.equal(readme.metadata.repo_url, "https://github.com/acme/legacy.git");
  assert.equal(readme.body, originalBody);
  assert.equal(readme.content.includes(projectPath), false);
});

test("re-registering the same path reuses its id and updates metadata in place", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "repeat-project");

  const first = await registerApprovedProject({
    aiosPath,
    statePath,
    projectPath,
    purpose: "Maintain the launch project",
    apply: true,
    createId: () => "repeat-id",
    readRepoUrl: async () => null
  });
  const second = await registerApprovedProject({
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
  assert.equal(readme.metadata.description, "Maintain the launch project");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(state.paths, {
    "repeat-id": await verifiedPathMapping(projectPath)
  });
});

test("registerProject rejects blank, unsafe, and over-budget purposes without writing", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const projectPath = await makeRepo(root, "invalid-purpose");
  for (const purpose of ["   ", "line one\nline two", "x".repeat(501)]) {
    await assert.rejects(
      registerProject({
        aiosPath,
        statePath,
        projectPath,
        purpose,
        apply: true,
        createId: () => "invalid-purpose-id",
        readRepoUrl: async () => null
      }),
      /purpose must contain 1-500 safe Unicode code points/
    );
  }
  assert.deepEqual(await fs.readdir(path.join(aiosPath, "projects")), []);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("listProjects returns sorted portable metadata with local availability", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const zetaPath = await makeRepo(root, "zeta");
  await registerApprovedProject({
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
  await registerApprovedProject({
    aiosPath,
    statePath,
    projectPath,
    apply: true,
    createId: () => "resolve-id",
    readRepoUrl: async () => "https://github.com/acme/resolvable.git"
  });

  assert.equal(await resolveProject("resolvable", { aiosPath, statePath }), projectPath);
  assert.equal(await resolveProject({ aiosPath, statePath, project: "resolve-id" }), projectPath);

  await fs.rm(projectPath, { recursive: true });
  await assert.rejects(
    resolveProject({ aiosPath, statePath, project: "resolvable" }),
    (error) => {
      assert.match(error.message, /cannot be verified.*project restore resolve-id --dry-run/);
      assert.equal(error.message.includes(projectPath), false);
      return true;
    }
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

test("legacy string mappings stay listable but never disclose an induction location", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const legacyPath = await makeRepo(root, "legacy-string-location");
  await writeProjectReadme(
    aiosPath,
    "legacy-location",
    "id: legacy-location-id\nproject: legacy-location\nname: Legacy Location\nstatus: active\ndomain: [build]\nrepo_url: null"
  );
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({
    version: 1,
    paths: { "legacy-location-id": legacyPath }
  })}\n`);

  const projects = await listProjects({ aiosPath, statePath });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].slug, "legacy-location");
  assert.equal(projects[0].projectPath, null);
  assert.equal(projects[0].pathAvailable, false);

  await assert.rejects(
    resolveProject({ aiosPath, statePath, project: "legacy-location" }),
    (error) => {
      assert.match(error.message, /re-register/i);
      assert.equal(error.message.includes(legacyPath), false);
      return true;
    }
  );

  const capture = outputCapture();
  await projectCommand(["list", "--path", aiosPath, "--state-path", statePath], {
    output: capture.output
  });
  assert.match(capture.lines.join("\n"), /legacy-location/);
  assert.match(capture.lines.join("\n"), /re-registration required on this machine/);
  assert.equal(capture.lines.join("\n").includes(legacyPath), false);

  await registerApprovedProject({
    aiosPath,
    statePath,
    projectPath: legacyPath,
    slug: "legacy-location",
    purpose: "Revalidate this primary folder",
    apply: true,
    createId: () => {
      throw new Error("the durable legacy id must be reused");
    },
    readRepoUrl: async () => null
  });
  assert.equal(
    await resolveProject({ aiosPath, statePath, project: "legacy-location" }),
    legacyPath
  );
});

test("project-state liveness fails closed on every error except ESRCH", () => {
  const throws = (code) => () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  assert.equal(projectStateProcessIsAlive(42, throws("ESRCH")), false);
  assert.equal(projectStateProcessIsAlive(42, throws("EPERM")), true);
  assert.equal(projectStateProcessIsAlive(42, throws("EACCES")), true);
  assert.equal(projectStateProcessIsAlive(42, () => {}), true);
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
    await registerApprovedProject({
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
    inspectRepoUrl: async (projectPath) => {
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
    "--operation-id", preview.operationId,
    "--plan-fingerprint", preview.planFingerprint,
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
      "managed-id": await verifiedPathMapping(managedPath),
      "external-id": await verifiedPathMapping(externalPath)
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
