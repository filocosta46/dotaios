import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { projectCommand } from "../../packages/cli/src/commands/project.mjs";
import { doctorProjects } from "../../packages/core/src/projects.mjs";

const run = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-doctor-"));
  const aiosPath = path.join(root, "aios");
  const statePath = path.join(root, "state", "projects.json");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    `${JSON.stringify({ schema_version: "1.2.0" }, null, 2)}\n`
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, aiosPath, statePath };
}

async function writeProject(aiosPath, slug, repoUrl) {
  const directory = path.join(aiosPath, "projects", slug);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "README.md"),
    [
      "---",
      `id: id-${slug}`,
      `project: ${slug}`,
      `repo_url: ${repoUrl}`,
      "status: active",
      "domain: [build]",
      "---",
      `# ${slug}`,
      ""
    ].join("\n")
  );
}

async function writeState(statePath, paths) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({ version: 1, paths }, null, 2)}\n`);
}

function captureOutput() {
  const lines = [];
  return {
    lines,
    output: { log: (...values) => lines.push(values.join(" ")) }
  };
}

test("project doctor reports unsafe catalog data, unsafe placement, partial managed checkout, and remote mismatch without writing", async (t) => {
  const { root, aiosPath, statePath } = await fixture(t);
  const unsafePlacement = path.join(aiosPath, "vault", "unsafe-checkout");
  const partial = path.join(aiosPath, "workspaces", "partial");
  const mismatch = path.join(root, "external", "mismatch");
  await Promise.all([
    fs.mkdir(unsafePlacement, { recursive: true }),
    fs.mkdir(path.join(partial, ".git"), { recursive: true }),
    fs.mkdir(mismatch, { recursive: true })
  ]);
  await writeProject(aiosPath, "unsafe-catalog", "file:///tmp/unsafe");
  await writeProject(aiosPath, "unsafe-placement", "https://github.com/acme/unsafe-placement.git");
  await writeProject(aiosPath, "partial", "https://github.com/acme/partial.git");
  await writeProject(aiosPath, "mismatch", "https://github.com/acme/expected.git");
  await writeState(statePath, {
    "id-unsafe-catalog": mismatch,
    "id-unsafe-placement": unsafePlacement,
    "id-mismatch": mismatch
  });

  const before = await Promise.all([
    fs.readFile(statePath, "utf8"),
    fs.readFile(path.join(aiosPath, "projects", "partial", "README.md"), "utf8")
  ]);
  const report = await doctorProjects({
    aiosPath,
    statePath,
    readRepoUrl: async (repositoryPath) => {
      if (repositoryPath === partial) return "git@github.com:acme/partial.git";
      if (repositoryPath === mismatch) return "https://github.com/other/repository.git";
      return null;
    },
    readRepoHead: async () => null
  });
  const after = await Promise.all([
    fs.readFile(statePath, "utf8"),
    fs.readFile(path.join(aiosPath, "projects", "partial", "README.md"), "utf8")
  ]);

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.map((issue) => [issue.type, issue.project?.slug]).sort(),
    [
      ["incomplete_checkout", "partial"],
      ["missing_path", "partial"],
      ["remote_mismatch", "mismatch"],
      ["unsafe_placement", "unsafe-placement"],
      ["unsafe_remote", "unsafe-catalog"]
    ]
  );
  assert.deepEqual(after, before, "doctor must remain read-only");
});

test("project doctor reports an ineffective outer workspace ignore", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await run("git", ["init", "-q", "-b", "main"], { cwd: aiosPath });
  await fs.writeFile(path.join(aiosPath, ".gitignore"), "node_modules/\n");
  const capture = captureOutput();
  const exitCodes = [];

  const report = await projectCommand(
    ["doctor", "--path", aiosPath, "--state-path", statePath],
    {
      output: capture.output,
      setExitCode: (code) => exitCodes.push(code)
    }
  );

  assert.equal(report.ok, false);
  assert.equal(report.workspace.outer_git, true);
  assert.match(report.issues.find((issue) => issue.type === "workspace_boundary").message, /root ignore is not effective/i);
  assert.match(capture.lines.join("\n"), /workspace boundary/i);
  assert.deepEqual(exitCodes, [1]);
});

test("project doctor reports outer-index entries under the ignored workspace shelf", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await run("git", ["init", "-q", "-b", "main"], { cwd: aiosPath });
  await fs.writeFile(path.join(aiosPath, ".gitignore"), "/workspaces/\n");
  const tracked = path.join(aiosPath, "workspaces", "tracked", "private.txt");
  await fs.mkdir(path.dirname(tracked), { recursive: true });
  await fs.writeFile(tracked, "must remain local\n");
  await run("git", ["add", "-f", "--", "workspaces/tracked/private.txt"], { cwd: aiosPath });
  const capture = captureOutput();

  const report = await projectCommand(
    ["doctor", "--path", aiosPath, "--state-path", statePath],
    { output: capture.output, setExitCode: () => {} }
  );

  assert.equal(report.ok, false);
  assert.match(report.issues.find((issue) => issue.type === "workspace_boundary").message, /outer Git index.*workspaces\/tracked\/private\.txt/is);
  assert.match(capture.lines.join("\n"), /outer Git index/i);
});

test("project doctor reports unregistered workspace debris without requiring an outer Git repository", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  await fs.mkdir(path.join(aiosPath, "workspaces"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "workspaces", "interrupted"), "clone residue\n");
  const capture = captureOutput();
  const exitCodes = [];

  const report = await projectCommand(
    ["doctor", "--path", aiosPath, "--state-path", statePath],
    {
      output: capture.output,
      setExitCode: (code) => exitCodes.push(code)
    }
  );

  assert.equal(report.ok, false);
  assert.equal(report.workspace.outer_git, false);
  assert.match(report.issues.find((issue) => issue.type === "workspace_boundary").message, /unregistered/i);
  assert.match(capture.lines.join("\n"), /unregistered/i);
  assert.deepEqual(exitCodes, [1]);
});
