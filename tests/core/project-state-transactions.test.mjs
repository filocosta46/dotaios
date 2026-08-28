import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyProjectRegistration,
  planProjectRegistration
} from "../../packages/core/src/projects.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-state-"));
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "repos", "widget");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, "source.txt"), "source\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, aiosPath, projectPath };
}

async function makePlan({ aiosPath, homePath, projectPath, statePath }) {
  return planProjectRegistration({
    aiosPath,
    homePath,
    projectPath,
    statePath,
    createId: () => "widget-id",
    readRepoUrl: async () => null
  });
}

test("concurrent identical registration cannot let the loser delete the winner README", async (t) => {
  const { root, aiosPath, projectPath } = await fixture(t);
  const statePath = path.join(root, "state", "projects.json");
  const plan = await makePlan({ aiosPath, projectPath, statePath });
  let readmeWrites = 0;
  let releaseSecondWrite;
  const secondWrite = new Promise((resolve) => { releaseSecondWrite = resolve; });
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "writeFile") return target[property];
      return async (destination, ...args) => {
        const result = await fs.writeFile(destination, ...args);
        if (destination !== plan.readmePath) return result;
        readmeWrites += 1;
        if (readmeWrites === 2) releaseSecondWrite();
        if (readmeWrites === 1) {
          await Promise.race([
            secondWrite,
            new Promise((resolve) => setTimeout(resolve, 40))
          ]);
        }
        return result;
      };
    }
  });

  const results = await Promise.allSettled([
    applyProjectRegistration(plan, { fs: racingFs }),
    applyProjectRegistration(plan, { fs: racingFs })
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await fs.readFile(plan.readmePath, "utf8"), plan.readme);
  assert.deepEqual(
    JSON.parse(await fs.readFile(statePath, "utf8")).paths,
    plan.stateAfter.paths
  );
});

test("registration rollback preserves README content replaced after its own write", async (t) => {
  const { root, aiosPath, projectPath } = await fixture(t);
  const statePath = path.join(root, "state", "projects.json");
  const plan = await makePlan({ aiosPath, projectPath, statePath });
  const replacement = "# Newer project truth\n";
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "rename") return target[property];
      return async (source, destination) => {
        if (destination !== statePath) return fs.rename(source, destination);
        await fs.writeFile(plan.readmePath, replacement);
        const error = new Error("simulated state rename failure");
        error.code = "EIO";
        throw error;
      };
    }
  });

  await assert.rejects(
    applyProjectRegistration(plan, { fs: failingFs }),
    /rollback could not be completed/i
  );

  assert.equal(await fs.readFile(plan.readmePath, "utf8"), replacement);
  await assert.rejects(fs.access(statePath), { code: "ENOENT" });
});

test("registration preserves an existing custom state-directory mode", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode assertion");
  const { root, aiosPath, projectPath } = await fixture(t);
  const stateDirectory = path.join(root, "shared-custom-state");
  const statePath = path.join(stateDirectory, "projects.json");
  await fs.mkdir(stateDirectory, { mode: 0o755 });
  await fs.chmod(stateDirectory, 0o755);
  const beforeMode = (await fs.stat(stateDirectory)).mode & 0o777;
  const plan = await makePlan({ aiosPath, projectPath, statePath });

  await applyProjectRegistration(plan);

  const afterMode = (await fs.stat(stateDirectory)).mode & 0o777;
  assert.equal(beforeMode, 0o755);
  assert.equal(afterMode, beforeMode);
});

test("registration secures a newly-created default DotAIOS state directory", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode assertion");
  const { root, aiosPath, projectPath } = await fixture(t);
  const homePath = path.join(root, "home");
  await fs.mkdir(homePath);
  const plan = await makePlan({ aiosPath, homePath, projectPath });

  await applyProjectRegistration(plan);

  assert.equal(path.dirname(plan.statePath), path.join(homePath, ".dotaios"));
  assert.equal((await fs.stat(path.dirname(plan.statePath))).mode & 0o777, 0o700);
});

test("registration never steals an old project-state lock from a live owner", async (t) => {
  const { root, aiosPath, projectPath } = await fixture(t);
  const statePath = path.join(root, "state", "projects.json");
  const plan = await makePlan({ aiosPath, projectPath, statePath });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(`${statePath}.lock`, `${JSON.stringify({
    format: "dotaios-project-state-lock/v1",
    pid: process.pid,
    owner: "reused-pid",
    created_at: Date.now() - 31 * 60 * 1000
  })}\n`);

  await assert.rejects(
    () => applyProjectRegistration(plan),
    /already being updated/i
  );
  await assert.doesNotReject(fs.access(`${statePath}.lock`));
});

test("registration recovers a project-state lock after its PID is reused", async (t) => {
  const { root, aiosPath, projectPath } = await fixture(t);
  const statePath = path.join(root, "state", "projects.json");
  const plan = await makePlan({ aiosPath, projectPath, statePath });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(`${statePath}.lock`, `${JSON.stringify({
    format: "dotaios-project-state-lock/v1",
    pid: process.pid,
    owner: "reused-pid",
    created_at: Date.now() - 31 * 60 * 1000,
    process_started_at: "definitely-not-the-current-process"
  })}\n`);

  await assert.doesNotReject(() => applyProjectRegistration(plan));
  await assert.rejects(fs.access(`${statePath}.lock`), { code: "ENOENT" });
});

test("registration reclaims malformed project-state lock residue after it is stale", async (t) => {
  const { root, aiosPath, projectPath } = await fixture(t);
  const statePath = path.join(root, "state", "projects.json");
  const plan = await makePlan({ aiosPath, projectPath, statePath });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  await fs.writeFile(lockPath, "{truncated");
  const old = new Date(Date.now() - 6 * 60 * 1000);
  await fs.utimes(lockPath, old, old);

  await assert.doesNotReject(() => applyProjectRegistration(plan));
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
});
