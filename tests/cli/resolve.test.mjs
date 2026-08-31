import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../../packages/core/src/projects.mjs";

const run = promisify(execFile);

async function registerApprovedProject(options) {
  const preview = await registerProject({ ...options, apply: false, yes: false });
  return registerProject({
    ...options,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true,
    yes: false
  });
}

async function makeFixture(t, {
  purpose = "Ship one approved customer action.",
  remote = "https://github.com/customer/primary.git",
  withConvention = true
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-resolve-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "primary");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");
  if (withConvention) {
    await fs.writeFile(path.join(projectPath, "AGENTS.md"), "CLI_CONVENTION_BODY_CANARY\n");
  }
  await run("git", ["-C", projectPath, "init", "-q"]);
  if (remote) await run("git", ["-C", projectPath, "remote", "add", "origin", remote]);
  await registerApprovedProject({
    aiosPath,
    homePath,
    projectPath,
    slug: "primary",
    ...(purpose == null ? {} : { purpose }),
    createId: () => "project-primary-001",
    apply: true
  });
  await fs.mkdir(path.join(aiosPath, "skills", "plan-today"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "plan-today", "SKILL.md"),
    "---\nname: plan-today\ndescription: Plan the day.\ntriggers: [plan my day]\n---\n# Plan today\n"
  );
  await fs.mkdir(path.join(aiosPath, "connections", "apis"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "connections", "apis", "google-workspace.md"), "do not parse this prose\n");
  return { aiosPath, homePath, projectPath };
}

function captureOutput() {
  const lines = [];
  return { lines, output: { log: (value = "") => lines.push(String(value)) } };
}

test("dotaios resolve prints the complete callable envelope and structured optional tool route", async (t) => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const fixture = await makeFixture(t);
  const captured = captureOutput();
  const result = await resolveCommand([
    "plan my day",
    "--project", "project-primary-001",
    "--tool", "google.drive.find",
    "--query", "launch brief",
    "--budget", "8000",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: captured.output,
    cwd: fixture.projectPath,
    clock: () => new Date("2026-08-29T08:00:00.000Z")
  });

  assert.equal(result.status, "matched");
  assert.deepEqual(result.tool.argv_suffix, [
    "google", "drive", "find", "--query", "launch brief", "--json"
  ]);
  assert.equal(Object.hasOwn(result, "project_route"), false);
  assert.deepEqual(result.omissions, ["supplemental_project_sources_not_requested"]);
  assert.deepEqual(result.next_action, {
    state: "approval_required",
    approval: "direct_user_required",
    summary: "Review this recommendation and ask the user to approve before acting."
  });
  assert.equal(captured.lines.length, 1);
  const printed = JSON.parse(captured.lines[0]);
  assert.deepEqual(printed, result);
  assert.equal(printed.location, fixture.projectPath);
});

test("dotaios resolve uses one unique cwd attachment without widening to Shared", async (t) => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const fixture = await makeFixture(t);
  const child = path.join(fixture.projectPath, "nested");
  await fs.mkdir(child);
  const captured = captureOutput();

  const result = await resolveCommand([
    "Ship one approved customer action.",
    "--supports-conventions", "agents-md",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: captured.output,
    cwd: child,
    clock: () => new Date("2026-08-29T08:00:00.000Z")
  });

  assert.equal(result.project, null);
  assert.equal(result.project_route.status, "candidate");
  assert.equal(result.project_route.project.slug, "primary");
  assert.equal(result.location, null);
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.doesNotMatch(captured.lines[0], /Memory: Shared/);
});

test("dotaios resolve forwards hidden host support and approval binding for one exact route", async (t) => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const { PROJECT_NATIVE_CONVENTION_KINDS } = await import(
    "../../packages/core/src/project-native-routing.mjs"
  );
  const fixture = await makeFixture(t);
  const discoveryOutput = captureOutput();

  assert.deepEqual(PROJECT_NATIVE_CONVENTION_KINDS, [
    "agents-md",
    "claude-md",
    "repository-skill"
  ]);

  const candidate = await resolveCommand([
    "Ship one approved customer action.",
    "--supports-conventions", PROJECT_NATIVE_CONVENTION_KINDS.join(","),
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: discoveryOutput.output,
    cwd: fixture.projectPath,
    clock: () => new Date("2026-08-29T08:00:00.000Z")
  });
  const exactOutput = captureOutput();
  const result = await resolveCommand([
    "Ship one approved customer action.",
    "--project", "primary",
    "--supports-conventions", PROJECT_NATIVE_CONVENTION_KINDS.join(","),
    "--approval-binding", candidate.project_route.approval_binding,
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: exactOutput.output,
    cwd: fixture.projectPath,
    clock: () => new Date("2026-08-29T08:00:00.000Z")
  });

  assert.equal(candidate.project_route.status, "candidate");
  assert.match(candidate.project_route.approval_binding, /^[a-f0-9]{64}$/);
  assert.equal(result.project_route.status, "ready");
  assert.equal(result.location, await fs.realpath(fixture.projectPath));
  assert.equal(Object.hasOwn(result, "tool"), false);
  assert.deepEqual(result.project_route.route.conventions.map(({ kind }) => kind), ["agents-md"]);
  assert.equal(result.next_action.state, "fresh_context_required");
  assert.doesNotMatch(discoveryOutput.lines[0], /CLI_CONVENTION_BODY_CANARY/);
  assert.doesNotMatch(exactOutput.lines[0], /CLI_CONVENTION_BODY_CANARY/);
});

test("dotaios resolve carries a generic task through a newly connected purpose-free local folder", async (t) => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const fixture = await makeFixture(t, {
    purpose: null,
    remote: null,
    withConvention: false
  });
  const action = "Summarize what is in this folder";
  const proposalOutput = captureOutput();

  const proposal = await resolveCommand([
    action,
    "--project", "project-primary-001",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: proposalOutput.output,
    cwd: fixture.projectPath
  });

  assert.equal(proposal.project_route.status, "candidate");
  assert.equal(proposal.project_route.reason, "explicit_registered_project_candidate");
  assert.deepEqual(proposal.project_route.routability.conventions, []);
  assert.equal(proposal.location, null);
  assert.doesNotMatch(proposalOutput.lines[0], new RegExp(fixture.projectPath));

  const exact = await resolveCommand([
    action,
    "--project", "project-primary-001",
    "--approval-binding", proposal.project_route.approval_binding,
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: captureOutput().output,
    cwd: fixture.projectPath
  });

  assert.equal(exact.project_route.status, "ready");
  assert.deepEqual(exact.project_route.route.conventions, []);
  assert.equal(exact.location, await fs.realpath(fixture.projectPath));
});

test("dotaios resolve rejects ambiguous free arguments and unattached tool parameters", async () => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  await assert.rejects(resolveCommand(["plan", "my", "day"]), /Usage: dotaios resolve/);
  await assert.rejects(resolveCommand(["plan my day", "--query", "launch"]), /require --tool/);
  await assert.rejects(resolveCommand(["plan my day", "--unknown", "value"]), /Unknown resolve option/);
  await assert.rejects(
    resolveCommand(["plan my day", "--supports-conventions", "all-agents"]),
    /supported convention kind/
  );
  await assert.rejects(resolveCommand(["plan my day", "--budget", "8.5"]), /must be an integer/);
  await assert.rejects(resolveCommand(["plan my day", "--tool", "google.drive.list", "--page-size", "many"]), /must be an integer/);
});

test("dotaios resolve Memory Off evaluates no project, context, skill, or path", async (t) => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-resolve-off-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absentAios = path.join(root, "must-stay-absent");
  const captured = captureOutput();

  const result = await resolveCommand([
    "plan my day",
    "--memory", "off",
    "--project", "not-a-real-project",
    "--path", absentAios
  ], { output: captured.output });

  assert.equal(result.status, "partial");
  assert.equal(result.project, null);
  assert.equal(result.memory.receipt, "Memory: Off");
  assert.match(result.memory.notice, /did not read, search, save, or capture this turn/i);
  assert.equal(result.memory.context, "");
  assert.equal(result.skill.status, "not_evaluated");
  assert.equal(result.skill.reason, "memory_off");
  assert.equal(result.location, null);
  assert.equal(await fs.stat(absentAios).then(() => true, () => false), false);
  assert.deepEqual(JSON.parse(captured.lines[0]), result);
});

test("dotaios resolve help is readable and promises recommendation without execution", async () => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const captured = captureOutput();
  const result = await resolveCommand(["--help"], { output: captured.output });
  assert.equal(result, null);
  assert.match(captured.lines[0], /dotaios resolve "<intent>"/);
  assert.match(captured.lines[0], /never runs the tool or approves an action/i);
  assert.match(captured.lines[0], /approved.*exact project route/i);
  assert.doesNotMatch(captured.lines[0], /otherwise cwd/i);
  assert.doesNotMatch(captured.lines[0], /approval-binding|supports-conventions/i);
});
