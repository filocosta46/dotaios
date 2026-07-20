import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateRepoUrl,
  plainRemoteUrl,
  pollForRepoExists,
  initialMirrorPush
} from "../../packages/cli/src/sync/repo.mjs";

test("buildCreateRepoUrl returns a pre-filled github.com/new URL", () => {
  const url = buildCreateRepoUrl("filocosta46");
  assert.ok(url.startsWith("https://github.com/new?"));
  assert.ok(url.includes("name=filocosta46-aios"));
  assert.ok(url.includes("visibility=private"));
  assert.ok(url.includes("description="));
});

test("plainRemoteUrl carries no credential", () => {
  const url = plainRemoteUrl("filocosta46/filocosta46-aios");
  assert.equal(url, "https://github.com/filocosta46/filocosta46-aios.git");
  assert.ok(!url.includes("x-access-token"), "the stored remote must never embed a token");
});

test("pollForRepoExists resolves once the repo exists and is empty", async () => {
  let repoCalls = 0;
  const ok = await pollForRepoExists({
    accessToken: "T",
    fullName: "u/u-aios",
    fetchImpl: async (url) => {
      // empty repo -> GitHub returns 409 for the commits list
      if (url.endsWith("/commits")) return { ok: false, status: 409, json: async () => ({}) };
      repoCalls += 1;
      return { ok: repoCalls >= 2, status: repoCalls >= 2 ? 200 : 404, json: async () => ({}) };
    },
    sleep: () => Promise.resolve(),
    timeoutMs: 60_000,
    now: () => 0
  });
  assert.equal(ok, true);
});

test("pollForRepoExists rejects a repo that was created with files in it", async () => {
  await assert.rejects(
    pollForRepoExists({
      accessToken: "T",
      fullName: "u/u-aios",
      fetchImpl: async (url) => {
        if (url.endsWith("/commits")) {
          return { ok: true, status: 200, json: async () => [{ sha: "abc" }] };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
      sleep: () => Promise.resolve(),
      timeoutMs: 60_000,
      now: () => 0
    }),
    /created with files already in it/
  );
});

test("initialMirrorPush invokes git init, add, commit, push in order", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-mirror-"));
  try {
    await fs.writeFile(path.join(tmp, "hello.md"), "hi");
    const calls = [];
    const fakeGit = {
      init: async () => calls.push("init"),
      addRemote: async (url) => calls.push(`remote:${url}`),
      raw: async (args) => { calls.push(`raw:${args.join(" ")}`); return { stdout: "", stderr: "", code: 0 }; },
      dirty: async () => true,
      commitAll: async (m) => { calls.push(`commit:${m}`); return "deadbeef"; },
      push: async (b) => calls.push(`push:${b}`)
    };
    const sha = await initialMirrorPush({
      aiosPath: tmp,
      accessToken: "T",
      fullName: "u/u-aios",
      gitignoreContent: ".env\n",
      git: fakeGit
    });
    assert.deepEqual(calls, [
      "init",
      "remote:https://github.com/u/u-aios.git",
      "commit:Initial DotAIOS mirror",
      "push:main"
    ]);
    assert.equal(sha, "deadbeef", "returns the initial commit sha for last_push_sha");
    const writtenGitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    assert.equal(writtenGitignore, ".env\n");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
