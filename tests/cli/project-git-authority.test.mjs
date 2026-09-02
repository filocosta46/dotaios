import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { projectCommand } from "../../packages/cli/src/commands/project.mjs";
import { resolveProjectRoute } from "../../packages/core/src/project-native-routing.mjs";
import { registerProject } from "../../packages/core/src/projects.mjs";

const run = promisify(execFile);

test("project add keeps a plain non-Git folder local-only and approval-routable", async (t) => {
  const fixture = await makeFixture(t, "plain-folder");

  const project = await addProject(fixture);
  const { candidate, exact } = await resolveApprovedRoute(fixture, project);

  assert.equal(project.repoUrl, null);
  assert.equal(candidate.status, "candidate");
  assert.equal(JSON.stringify(candidate).includes(fixture.projectPath), false, "candidates must remain path-free");
  assert.equal(exact.status, "ready");
});

test("project add ignores an origin available only through local include.path", async (t) => {
  const fixture = await makeFixture(t, "included-origin");
  const remote = "https://github.com/acme/included-origin.git";
  await initRepository(fixture.projectPath);
  await configureIncludedOrigin(fixture, remote);

  const project = await addProject(fixture);
  const { exact } = await resolveApprovedRoute(fixture, project);
  const { report, exitCodes } = await runProjectDoctor(fixture);

  assert.equal(project.repoUrl, null, "included Git config must not become portable project metadata");
  assert.equal(exact.status, "ready");
  assert.equal(report.ok, true, "doctor must agree with the local-only registration");
  assert.deepEqual(report.issues, []);
  assert.deepEqual(exitCodes, []);
});

test("project add refuses multiple local fetch remotes when origin is absent", async (t) => {
  const fixture = await makeFixture(t, "ambiguous-remotes");
  await initRepository(fixture.projectPath);
  await git(fixture.projectPath, "remote", "add", "upstream", "https://github.com/acme/upstream.git");
  await git(fixture.projectPath, "remote", "add", "fork", "https://github.com/acme/fork.git");

  await assert.rejects(
    registerProject(registrationOptions(fixture)),
    /unique authoritative local Git remote/i
  );
});

test("project add and exact routing accept one normal local HTTPS origin", async (t) => {
  const fixture = await makeFixture(t, "normal-origin");
  const remote = "https://github.com/acme/normal-origin.git";
  await initRepository(fixture.projectPath);
  await git(fixture.projectPath, "remote", "add", "origin", remote);

  const project = await addProject(fixture);
  const { exact } = await resolveApprovedRoute(fixture, project);

  assert.equal(project.repoUrl, remote);
  assert.equal(exact.status, "ready");
});

test("project add refuses an explicit repo URL that the local authority does not verify", async (t) => {
  const fixture = await makeFixture(t, "explicit-mismatch");
  await initRepository(fixture.projectPath);
  await git(
    fixture.projectPath,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/actual-repository.git"
  );

  await assert.rejects(
    registerProject({
      ...registrationOptions(fixture),
      repoUrl: "https://github.com/acme/different-repository.git"
    }),
    /explicit project remote.*authoritative local Git remote/i
  );
});

test("reconnecting an existing project to a plain folder records it local-only and routes ready", async (t) => {
  const fixture = await makeFixture(t, "reconnected-project");
  await initRepository(fixture.projectPath);
  await git(
    fixture.projectPath,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/reconnected-project.git"
  );
  await addProject(fixture);

  const localPath = path.join(fixture.root, "replacement-plain-folder");
  await fs.mkdir(localPath);
  const reconnected = await addProject({ ...fixture, projectPath: localPath });
  const routeFixture = { ...fixture, projectPath: localPath };
  const { exact } = await resolveApprovedRoute(routeFixture, reconnected);

  assert.equal(reconnected.repoUrl, null);
  assert.equal(exact.status, "ready");
});

test("CLI project doctor reports the same included-origin drift that routing refuses", async (t) => {
  const fixture = await makeFixture(t, "doctor-included-origin");
  const remote = "https://github.com/acme/doctor-included-origin.git";
  await initRepository(fixture.projectPath);
  await git(fixture.projectPath, "remote", "add", "origin", remote);
  const project = await addProject(fixture);

  await git(fixture.projectPath, "remote", "remove", "origin");
  await configureIncludedOrigin(fixture, remote);

  const route = await resolveProjectRoute({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    intent: "Fix the release blocker",
    projectSelector: project.id,
    supportedConventionKinds: []
  });
  const { report, exitCodes } = await runProjectDoctor(fixture);

  assert.equal(route.status, "refused");
  assert.equal(route.reason, "project_remote_mismatch");
  assert.equal(route.route, null);
  assert.equal(JSON.stringify(route).includes(fixture.projectPath), false, "refusals must remain path-free");
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => (
    issue.type === "remote_mismatch" && issue.project?.slug === fixture.slug
  )));
  assert.deepEqual(exitCodes, [1]);
});

async function makeFixture(t, slug) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-git-authority-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(homePath, "aios");
  const projectPath = path.join(root, slug);
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), '{"schema_version":"1.2.0"}\n');
  return {
    root,
    slug,
    id: `project-${slug}-001`,
    homePath,
    aiosPath,
    projectPath
  };
}

function registrationOptions(fixture) {
  return {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectPath: fixture.projectPath,
    slug: fixture.slug,
    createId: () => fixture.id
  };
}

async function addProject(fixture) {
  const options = registrationOptions(fixture);
  const preview = await registerProject(options);
  return registerProject({
    ...options,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true
  });
}

async function resolveApprovedRoute(fixture, project) {
  const request = {
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    intent: "Fix the release blocker",
    projectSelector: project.id,
    supportedConventionKinds: []
  };
  const candidate = await resolveProjectRoute(request);
  const exact = await resolveProjectRoute({
    ...request,
    approvalBinding: candidate.approval_binding
  });
  return { candidate, exact };
}

async function runProjectDoctor(fixture) {
  const lines = [];
  const exitCodes = [];
  const report = await projectCommand(
    ["doctor", "--path", fixture.aiosPath, "--home", fixture.homePath],
    {
      output: {
        log: (...values) => lines.push(values.join(" ")),
        error: (...values) => lines.push(values.join(" "))
      },
      setExitCode: (code) => exitCodes.push(code)
    }
  );
  return { report, exitCodes, lines };
}

async function initRepository(projectPath) {
  await git(projectPath, "init", "--quiet");
}

async function configureIncludedOrigin(fixture, remote) {
  const includePath = path.join(fixture.root, `${fixture.slug}-included.gitconfig`);
  await fs.writeFile(includePath, [
    '[remote "origin"]',
    `\turl = ${remote}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    ""
  ].join("\n"));
  await git(fixture.projectPath, "config", "--local", "include.path", includePath);
}

async function git(projectPath, ...args) {
  return run("git", ["-C", projectPath, ...args], { encoding: "utf8" });
}
