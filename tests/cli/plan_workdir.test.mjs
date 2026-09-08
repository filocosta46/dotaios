import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const cli = fileURLToPath(new URL("../../packages/cli/src/index.mjs", import.meta.url));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-plan-workdir-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workdir = path.join(directory, "project");
  const home = path.join(directory, "home");
  await fs.mkdir(workdir);
  await fs.mkdir(home);
  const run = (args) => spawnSync(process.execPath, [cli, "plan", ...args], {
    cwd: workdir, env: { ...process.env, HOME: home, DOTAIOS_PATH: path.join(directory, "missing-aios") }, encoding: "utf8"
  });
  return { workdir, home, run };
}

test("an ordinary project session resumes research with plan inspect and no checkpoint name or AIOS", async (t) => {
  const { workdir, home, run } = await fixture(t);
  await fs.writeFile(path.join(workdir, "request.json"), JSON.stringify({
    goal: "Compare primary evidence", limits: ["Use public sources"], nextAction: "Read both sources"
  }));
  const started = run(["start", "--workdir", ".", "--input", "request.json", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const revision = JSON.parse(started.stdout).revision;
  await fs.mkdir(path.join(workdir, "research/sources"), { recursive: true });
  await fs.mkdir(path.join(workdir, "research/results"));
  await fs.writeFile(path.join(workdir, "research/sources/primary.md"), "Source evidence");
  await fs.writeFile(path.join(workdir, "research/results/comparison.md"), "A sourced comparison");
  await fs.writeFile(path.join(workdir, "checkpoint.json"), JSON.stringify({
    completed: ["Compared first source"],
    sources: [{ path: "research/sources/primary.md", origin: "https://example.org/primary" }],
    outputs: [{ path: "research/results/comparison.md", sources: ["research/sources/primary.md"] }],
    unresolved: ["Second source is not yet checked"], nextAction: "Read the second source"
  }));
  const saved = run(["checkpoint", "--workdir", ".", "--input", "checkpoint.json", "--expected", revision, "--json"]);
  assert.equal(saved.status, 0, saved.stderr);
  const resumed = run(["inspect", "--workdir", ".", "--json"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.equal(result.plan.nextAction, "Read the second source");
  assert.deepEqual(result.plan.completed, ["Compared first source"]);
  assert.equal(result.plan.outputs[0].path, "research/results/comparison.md");
  assert.ok(resumed.stdout.length < 10000);
  assert.deepEqual(await fs.readdir(home), []);
  assert.equal((await fs.readdir(workdir)).includes("memory"), false);
});

test("work-folder plan refusals are machine-readable and preserve the prior entry", async (t) => {
  const { workdir, run } = await fixture(t);
  await fs.writeFile(path.join(workdir, "request.json"), JSON.stringify({ goal: "Keep the goal", limits: [], nextAction: "Read" }));
  const start = run(["start", "--workdir", ".", "--input", "request.json", "--json"]);
  assert.equal(start.status, 0, start.stderr);
  const before = await fs.readFile(path.join(workdir, "plan.md"));
  for (const args of [
    ["start", "--workdir", ".", "--input", "../outside.json", "--json"],
    ["checkpoint", "--workdir", ".", "--input", "request.json", "--expected", "stale", "--json"],
    ["inspect", "--workdir", ".", "--path", "some-aios", "--json"],
    ["inspect", "--workdir", ".", "--workdir", ".", "--json"],
    ["inspect", "--workdir=.", "--json"],
    ["inspect", "--json"],
    ["start", "--input", "request.json", "--json"]
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, "refused");
    assert.ok(result.stdout.length < 1000);
  }
  assert.deepEqual(await fs.readFile(path.join(workdir, "plan.md")), before);
});
