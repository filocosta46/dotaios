import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../../packages/core/src/projects.mjs";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("EPR-005, EPR-013, and EPR-014: two black-box fixtures use one offline read-only route", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-native-blackbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const careerPath = path.join(root, "career-ops");
  const reachPath = path.join(root, "agent-reach");
  const preloadPath = path.join(root, "read-guard.cjs");
  const gitLogPath = path.join(root, "git.log");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");

  const career = await registerFixture({
    aiosPath,
    homePath,
    projectPath: careerPath,
    slug: "career-ops",
    id: "project-career-ops-001",
    purpose: "Evaluate and track job opportunities.",
    remote: "https://github.com/santifer/career-ops.git",
    conventions: ["AGENTS.md", ".agents/skills/career-ops/SKILL.md"]
  });
  const reach = await registerFixture({
    aiosPath,
    homePath,
    projectPath: reachPath,
    slug: "agent-reach",
    id: "project-agent-reach-001",
    purpose: "Collect and organize public research sources.",
    remote: "https://github.com/Panniantong/agent-reach.git",
    conventions: ["CLAUDE.md"]
  });
  await fs.writeFile(preloadPath, readGuardPreload());

  const guardedEnvironment = {
    ...process.env,
    DOTAIOS_GUARDED_ROOTS: JSON.stringify([careerPath, reachPath]),
    DOTAIOS_GUARDED_READ_LIMITS: JSON.stringify({
      [career.readmePath]: career.frontmatterBytes,
      [reach.readmePath]: reach.frontmatterBytes
    }),
    DOTAIOS_GIT_LOG: gitLogPath
  };
  const before = await snapshotTrees([aiosPath, homePath, careerPath, reachPath]);

  const implicit = await runCli([
    "Evaluate this job opportunity without applying.",
    "--path", aiosPath,
    "--home", homePath
  ], { preloadPath, environment: guardedEnvironment });
  const implicitGitLog = await fs.readFile(gitLogPath, "utf8").catch(() => "NO_GIT_LOG");
  assert.equal(implicit.exitCode, 0, implicit.stderr);
  assert.equal(
    implicit.result.project_route.status,
    "candidate",
    JSON.stringify({ result: implicit.result, stderr: implicit.stderr, implicitGitLog })
  );
  assert.equal(implicit.result.project_route.project.slug, "career-ops");
  assert.equal(implicit.result.location, null);
  assert.doesNotMatch(implicit.stdout, /PORTABLE_README_BODY_CANARY/);
  assert.doesNotMatch(implicitGitLog, /README_BODY_READ/);

  const careerExact = await runCli([
    "Evaluate this job opportunity without applying.",
    "--project", "career-ops",
    "--supports-conventions", "agents-md,repository-skill",
    "--path", aiosPath,
    "--home", homePath
  ], { preloadPath, environment: guardedEnvironment });
  assert.equal(careerExact.exitCode, 0, careerExact.stderr);
  assert.equal(careerExact.result.project_route.status, "ready");
  assert.equal(careerExact.result.location, careerPath);

  const codexReach = await runCli([
    "Collect and organize these public research sources.",
    "--project", "agent-reach",
    "--supports-conventions", "agents-md,repository-skill",
    "--path", aiosPath,
    "--home", homePath
  ], { preloadPath, environment: guardedEnvironment });
  assert.equal(codexReach.exitCode, 2, codexReach.stderr);
  assert.equal(codexReach.result.project_route.status, "unsupported_by_host");
  assert.equal(codexReach.result.location, null);
  assert.doesNotMatch(codexReach.stdout, new RegExp(escapeRegex(reachPath)));

  const compatibleReach = await runCli([
    "Collect and organize these public research sources.",
    "--project", "project-agent-reach-001",
    "--supports-conventions", "claude-md",
    "--path", aiosPath,
    "--home", homePath
  ], { preloadPath, environment: guardedEnvironment });
  assert.equal(compatibleReach.exitCode, 0, compatibleReach.stderr);
  assert.equal(compatibleReach.result.project_route.status, "ready");
  assert.equal(compatibleReach.result.location, reachPath);

  const after = await snapshotTrees([aiosPath, homePath, careerPath, reachPath]);
  assert.deepEqual(after, before, "resolution must not write registration or fixture trees");
  const combined = [implicit, careerExact, codexReach, compatibleReach]
    .map(({ stdout }) => stdout)
    .join("\n");
  assert.doesNotMatch(
    combined,
    /CONVENTION_BODY_CANARY|PROJECT_DATA_CANARY/
  );
  const gitLog = await fs.readFile(gitLogPath, "utf8");
  assert.match(gitLog, /config|remote/);
  assert.doesNotMatch(gitLog, /fetch|pull|clone|ls-remote|https?:\/\//);
});

test("EPR-013: shipped router and CLI source contain no fixture identity or capability selector", async () => {
  const sourceRoots = [
    path.join(repoRoot, "packages", "core", "src"),
    path.join(repoRoot, "packages", "cli", "src")
  ];
  const sourceFiles = (await Promise.all(sourceRoots.map((root) => listFiles(root)))).flat();
  const source = (await Promise.all(sourceFiles.map((filePath) => fs.readFile(filePath, "utf8")))).join("\n");
  assert.doesNotMatch(source, /career-ops|agent-reach|santifer|panniantong/i);
  assert.doesNotMatch(source, /--capability|curated-external-user-owned|external capability catalog/i);
});

async function registerFixture({
  aiosPath,
  homePath,
  projectPath,
  slug,
  id,
  purpose,
  remote,
  conventions
}) {
  await fs.mkdir(projectPath, { recursive: true });
  for (const resource of conventions) {
    const filePath = path.join(projectPath, ...resource.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `CONVENTION_BODY_CANARY ${resource}\n`);
  }
  await fs.writeFile(path.join(projectPath, "customer-data.txt"), "PROJECT_DATA_CANARY\n");
  await run("git", ["-C", projectPath, "init", "-q"]);
  await run("git", ["-C", projectPath, "remote", "add", "origin", remote]);
  const options = { aiosPath, homePath, projectPath, slug, purpose, createId: () => id };
  const preview = await registerProject({ ...options, apply: false, yes: false });
  await registerProject({
    ...options,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true,
    yes: false
  });
  const readmePath = path.join(aiosPath, "projects", slug, "README.md");
  const frontmatter = await fs.readFile(readmePath, "utf8");
  const boundary = frontmatter.indexOf("\n---\n", 4) + "\n---\n".length;
  await fs.appendFile(readmePath, "PORTABLE_README_BODY_CANARY\n");
  return { readmePath, frontmatterBytes: boundary };
}

async function runCli(args, { preloadPath, environment }) {
  try {
    const { stdout, stderr } = await run(process.execPath, [
      "--require", preloadPath,
      cliPath,
      "resolve",
      ...args
    ], {
      cwd: repoRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return { exitCode: 0, stdout, stderr, result: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout || "");
    return {
      exitCode: Number(error.code),
      stdout,
      stderr: String(error.stderr || ""),
      result: JSON.parse(stdout)
    };
  }
}

function readGuardPreload() {
  return String.raw`const fs = require("node:fs");
const childProcess = require("node:child_process");
const moduleBuiltin = require("node:module");
const path = require("node:path");
const util = require("node:util");
const guardedRoots = JSON.parse(process.env.DOTAIOS_GUARDED_ROOTS);
const readLimits = JSON.parse(process.env.DOTAIOS_GUARDED_READ_LIMITS);
const gitLog = process.env.DOTAIOS_GIT_LOG;
const originalOpen = fs.promises.open.bind(fs.promises);
const originalReadFile = fs.promises.readFile.bind(fs.promises);
const originalExecFile = childProcess.execFile.bind(childProcess);
const originalExecFileAsync = util.promisify(childProcess.execFile);
function guardedExternalFile(filePath) {
  const resolved = path.resolve(String(filePath));
  return guardedRoots.some((root) => resolved.startsWith(path.resolve(root) + path.sep))
    && (resolved.endsWith("AGENTS.md") || resolved.endsWith("CLAUDE.md") || resolved.endsWith("SKILL.md") || resolved.endsWith("customer-data.txt"));
}
fs.promises.readFile = async function(filePath, ...args) {
  if (guardedExternalFile(filePath)) throw new Error("forbidden external body read: " + filePath);
  return originalReadFile(filePath, ...args);
};
fs.promises.open = async function(filePath, ...args) {
  if (guardedExternalFile(filePath)) throw new Error("forbidden external body open: " + filePath);
  const handle = await originalOpen(filePath, ...args);
  const limit = readLimits[path.resolve(String(filePath))];
  if (limit === undefined) return handle;
  const originalRead = handle.read.bind(handle);
  let offset = 0;
  handle.read = async function(buffer, bufferOffset, length, position) {
    if (offset >= limit) fs.appendFileSync(gitLog, "README_BODY_READ\n");
    const result = await originalRead(buffer, bufferOffset, length, position);
    offset += result.bytesRead;
    return result;
  };
  return handle;
};
function guardGit(file, args) {
  if (file !== "git") throw new Error("unexpected subprocess: " + file);
  const root = args && args[0] === "-C" ? path.resolve(args[1]) : null;
  const operation = args && args[2];
  if (!guardedRoots.map((value) => path.resolve(value)).includes(root) || !["config", "remote"].includes(operation)) {
    throw new Error("non-local or mutating Git command: " + JSON.stringify(args));
  }
  fs.appendFileSync(gitLog, JSON.stringify(args) + "\n");
}
childProcess.execFile = function(file, args, options, callback) {
  guardGit(file, args);
  return originalExecFile(file, args, options, callback);
};
childProcess.execFile[util.promisify.custom] = async function(file, args, options) {
  guardGit(file, args);
  return originalExecFileAsync(file, args, options);
};
global.fetch = async function() { throw new Error("network access is forbidden during routing"); };
moduleBuiltin.syncBuiltinESMExports();
`;
}

async function snapshotTrees(roots) {
  const snapshots = {};
  for (const root of roots) snapshots[root] = await snapshotTree(root);
  return snapshots;
}

async function snapshotTree(root) {
  const records = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(current, entry.name);
      const stats = await fs.lstat(filePath, { bigint: true });
      records.push({
        path: path.relative(root, filePath),
        mode: stats.mode.toString(),
        size: stats.size.toString(),
        mtime: stats.mtimeNs.toString(),
        ctime: stats.ctimeNs.toString()
      });
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(filePath);
    }
  }
  await walk(root);
  return records;
}

async function listFiles(root) {
  const files = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
