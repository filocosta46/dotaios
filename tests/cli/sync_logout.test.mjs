import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runLogout } from "../../packages/cli/src/sync/logout-cmd.mjs";
import { createGit } from "../../packages/cli/src/sync/git.mjs";

async function silenced(fn) {
  const origLog = console.log;
  console.log = () => {};
  try { await fn(); } finally { console.log = origLog; }
}

test("runLogout removes the token-bearing origin remote and the config file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-"));
  try {
    const repo = path.join(tmp, "aios");
    await fs.mkdir(repo);
    const cfgPath = path.join(tmp, "sync.json");
    await fs.writeFile(cfgPath, JSON.stringify({ access_token: "ghp_SECRET" }));

    const git = createGit({ cwd: repo });
    await git.init();
    await git.addRemote("https://x-access-token:ghp_SECRET@github.com/u/u-aios.git");
    assert.equal((await git.raw(["remote"])).stdout.trim(), "origin");

    await silenced(() => runLogout(["--path", repo], { configPath: cfgPath }));

    assert.equal((await git.raw(["remote"])).stdout.trim(), "", "origin remote removed");
    await assert.rejects(fs.stat(cfgPath), { code: "ENOENT" }, "sync config removed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("runLogout is best-effort when the AIOS folder is not a git repo", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-logout-"));
  try {
    const cfgPath = path.join(tmp, "sync.json");
    await fs.writeFile(cfgPath, "{}");
    await silenced(() =>
      runLogout(["--path", path.join(tmp, "no-repo-here")], { configPath: cfgPath })
    );
    await assert.rejects(fs.stat(cfgPath), { code: "ENOENT" }, "config still removed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
