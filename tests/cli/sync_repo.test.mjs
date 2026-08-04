import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateRepoUrl,
  plainRemoteUrl,
  pollForRepoExists,
  initialMirrorPush
} from "../../packages/cli/src/sync/repo.mjs";
import { createGit } from "../../packages/cli/src/sync/git.mjs";

const run = promisify(execFile);
const RECEIPT = "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1";

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

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

test("pollForRepoExists classifies an empty private repo", async () => {
  let repoCalls = 0;
  const ok = await pollForRepoExists({
    accessToken: "T",
    fullName: "u/u-aios",
    fetchImpl: async (url) => {
      // empty repo -> GitHub returns 409 for the commits list
      if (url.endsWith("/commits")) return { ok: false, status: 409, json: async () => ({}) };
      repoCalls += 1;
      return { ok: repoCalls >= 2, status: repoCalls >= 2 ? 200 : 404, json: async () => ({ private: true }) };
    },
    sleep: () => Promise.resolve(),
    timeoutMs: 60_000,
    now: () => 0
  });
  assert.deepEqual(ok, { state: "empty" });
});

test("pollForRepoExists classifies an existing populated private repo for safe adoption", async () => {
  assert.deepEqual(
    await pollForRepoExists({
      accessToken: "T",
      fullName: "u/u-aios",
      fetchImpl: async (url) => {
        if (url.endsWith("/commits")) {
          return { ok: true, status: 200, json: async () => [{ sha: "abc" }] };
        }
        // Private, so this test still exercises the not-empty rejection rather
        // than tripping the privacy guard first.
        return { ok: true, status: 200, json: async () => ({ private: true }) };
      },
      sleep: () => Promise.resolve(),
      timeoutMs: 60_000,
      now: () => 0
    }),
    { state: "populated" }
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
      git: fakeGit,
      recordIntendedSha: async (intended) => calls.push(`receipt:${intended}`)
    });
    assert.deepEqual(calls, [
      "init",
      "remote:https://github.com/u/u-aios.git",
      "commit:Initial DotAIOS mirror",
      "receipt:deadbeef",
      "push:main"
    ]);
    assert.equal(sha, "deadbeef", "returns the initial commit sha for last_push_sha");
    const writtenGitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    assert.equal(writtenGitignore, ".env\n");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("initialMirrorPush leaves a matching existing origin untouched", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-mirror-origin-"));
  try {
    await fs.writeFile(path.join(tmp, "hello.md"), "hi");
    const calls = [];
    await initialMirrorPush({
      aiosPath: tmp,
      fullName: "u/u-aios",
      gitignoreContent: ".env\n",
      preserveExistingOrigin: true,
      git: {
        init: async () => calls.push("init"),
        addRemote: async () => calls.push("remote-mutated"),
        commitAll: async () => RECEIPT,
        push: async () => calls.push("push")
      }
    });
    assert.deepEqual(calls, ["init", "push"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("initialMirrorPush preserves custom ignore rules while adding sync exclusions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-mirror-ignore-"));
  try {
    await fs.writeFile(path.join(tmp, ".gitignore"), "custom-secret.txt\n");
    const fakeGit = {
      init: async () => {},
      addRemote: async () => {},
      commitAll: async () => "deadbeef",
      push: async () => {}
    };

    await initialMirrorPush({
      aiosPath: tmp,
      accessToken: "T",
      fullName: "u/u-aios",
      gitignoreContent: ".env\n",
      git: fakeGit
    });

    assert.equal(
      await fs.readFile(path.join(tmp, ".gitignore"), "utf8"),
      "custom-secret.txt\n.env\n"
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("initialMirrorPush refuses a nested repo before changing ignore content or Git metadata", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-mirror-preflight-"));
  try {
    await git(tmp, "init", "-q", "-b", "main");
    await git(tmp, "config", "user.email", "t@example.com");
    await git(tmp, "config", "user.name", "Test");
    await git(tmp, "config", "dotaios.sentinel", "keep-me");
    await git(tmp, "remote", "add", "origin", "https://github.com/existing/mirror.git");
    await fs.writeFile(path.join(tmp, ".gitignore"), "custom-secret.txt\n");
    await fs.writeFile(path.join(tmp, "README.md"), "base\n");
    await git(tmp, "add", ".gitignore", "README.md");
    await git(tmp, "commit", "-q", "-m", "base");

    const nested = path.join(tmp, "projects", "myapp");
    await fs.mkdir(nested, { recursive: true });
    await git(nested, "init", "-q");
    await git(nested, "config", "user.email", "t@example.com");
    await git(nested, "config", "user.name", "Test");
    await fs.writeFile(path.join(nested, "index.js"), "console.log('work')\n");
    await git(nested, "add", "index.js");
    await git(nested, "commit", "-q", "-m", "app");

    const snapshots = {
      ignore: await fs.readFile(path.join(tmp, ".gitignore")),
      config: await fs.readFile(path.join(tmp, ".git", "config")),
      index: await fs.readFile(path.join(tmp, ".git", "index")),
      head: (await git(tmp, "rev-parse", "HEAD")).stdout,
      status: (await git(tmp, "status", "--porcelain", "-z")).stdout
    };

    const client = createGit({ cwd: tmp, accessToken: "T" });
    await assert.rejects(
      () => initialMirrorPush({
        aiosPath: tmp,
        accessToken: "T",
        fullName: "u/u-aios",
        gitignoreContent: ".env\n",
        git: client
      }),
      /projects\/myapp/
    );

    assert.deepEqual(await fs.readFile(path.join(tmp, ".gitignore")), snapshots.ignore);
    assert.deepEqual(await fs.readFile(path.join(tmp, ".git", "config")), snapshots.config);
    assert.deepEqual(await fs.readFile(path.join(tmp, ".git", "index")), snapshots.index);
    assert.equal((await git(tmp, "rev-parse", "HEAD")).stdout, snapshots.head);
    assert.equal((await git(tmp, "status", "--porcelain", "-z")).stdout, snapshots.status);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
