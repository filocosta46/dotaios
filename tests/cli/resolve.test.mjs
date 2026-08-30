import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../../packages/core/src/projects.mjs";

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

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-resolve-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "primary");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");
  await registerApprovedProject({
    aiosPath,
    homePath,
    projectPath,
    slug: "primary",
    purpose: "Ship one approved customer action.",
    createId: () => "project-primary-001",
    readRepoUrl: async () => null,
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
    "plan my day",
    "--path", fixture.aiosPath,
    "--home", fixture.homePath
  ], {
    output: captured.output,
    cwd: child,
    clock: () => new Date("2026-08-29T08:00:00.000Z")
  });

  assert.equal(result.project.slug, "primary");
  assert.equal(result.location, fixture.projectPath);
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.doesNotMatch(captured.lines[0], /Memory: Shared/);
});

test("dotaios resolve rejects ambiguous free arguments and unattached tool parameters", async () => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  await assert.rejects(resolveCommand(["plan", "my", "day"]), /Usage: dotaios resolve/);
  await assert.rejects(resolveCommand(["plan my day", "--query", "launch"]), /require --tool/);
  await assert.rejects(resolveCommand(["plan my day", "--unknown", "value"]), /Unknown resolve option/);
  await assert.rejects(resolveCommand(["plan my day", "--budget", "8.5"]), /must be an integer/);
  await assert.rejects(resolveCommand(["plan my day", "--tool", "google.drive.list", "--page-size", "many"]), /must be an integer/);
});

test("dotaios resolve help is readable and promises recommendation without execution", async () => {
  const { resolveCommand } = await import("../../packages/cli/src/commands/resolve.mjs");
  const captured = captureOutput();
  const result = await resolveCommand(["--help"], { output: captured.output });
  assert.equal(result, null);
  assert.match(captured.lines[0], /dotaios resolve "<intent>"/);
  assert.match(captured.lines[0], /never runs the tool or approves an action/i);
});
