import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizedGitEnvironment } from "../../packages/cli/src/sync/git.mjs";
import { createProjectGitAdapter } from "../../packages/cli/src/project-git.mjs";

const SAFE_URL = "https://github.com/acme/client-portal.git";
const DESTINATION = "/tmp/aios/workspaces/client-portal";
const run = promisify(execFile);

function spawnRecorder(responses = []) {
  const calls = [];
  return {
    calls,
    spawnImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return responses.shift() || { code: 0, stdout: "", stderr: "" };
    }
  };
}

test("clone uses the shared sanitized Git environment and an option terminator", async () => {
  const inherited = {
    HOME: "/safe/home",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    PATH: "/usr/bin:/bin",
    DOTAIOS_SYNC_TOKEN: "MUST_NOT_REACH_PROJECT_GIT",
    GIT_DIR: "/tmp/attacker-git-dir",
    GIT_WORK_TREE: "/tmp/attacker-worktree",
    GIT_CONFIG_GLOBAL: "/tmp/attacker-gitconfig",
    GIT_SSH_COMMAND: "touch /tmp/pwned"
  };
  const recorder = spawnRecorder([
    { code: 1, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" }
  ]);
  const adapter = createProjectGitAdapter({
    spawnImpl: recorder.spawnImpl,
    env: inherited,
    cwd: "/tmp"
  });

  await adapter.cloneRepository({ url: SAFE_URL, destination: DESTINATION });

  const clone = recorder.calls.at(-1);
  assert.equal(clone.command, "git");
  assert.deepEqual(clone.args, ["clone", "--", SAFE_URL, DESTINATION]);
  assert.deepEqual(clone.options.env, sanitizedGitEnvironment(inherited));
  assert.equal(clone.options.env.HOME, inherited.HOME);
  assert.equal(clone.options.env.SSH_AUTH_SOCK, inherited.SSH_AUTH_SOCK);
  assert.equal(clone.options.env.DOTAIOS_SYNC_TOKEN, undefined);
  assert.notEqual(clone.options.env.GIT_DIR, inherited.GIT_DIR);
  assert.notEqual(clone.options.env.GIT_SSH_COMMAND, inherited.GIT_SSH_COMMAND);
});

test("clone allows unrelated insteadOf rules", async () => {
  const recorder = spawnRecorder([
    {
      code: 0,
      stdout: "url.ssh://git@internal.example/.insteadof\ninternal:\u0000",
      stderr: ""
    },
    { code: 0, stdout: "", stderr: "" }
  ]);
  const adapter = createProjectGitAdapter({ spawnImpl: recorder.spawnImpl, cwd: "/tmp" });

  await adapter.cloneRepository({ url: SAFE_URL, destination: DESTINATION });

  assert.deepEqual(recorder.calls.at(-1).args, ["clone", "--", SAFE_URL, DESTINATION]);
});

test("clone refuses an effective insteadOf host or repository change before network", async () => {
  for (const [label, replacement] of [
    ["host", "https://attacker.example/"],
    ["repository", "https://github.com/mallory/"]
  ]) {
    const recorder = spawnRecorder([{
      code: 0,
      stdout: `url.${replacement}.insteadof\nhttps://github.com/acme/\u0000`,
      stderr: ""
    }]);
    const adapter = createProjectGitAdapter({ spawnImpl: recorder.spawnImpl, cwd: "/tmp" });

    await assert.rejects(
      adapter.cloneRepository({ url: SAFE_URL, destination: DESTINATION }),
      new RegExp(`rewrite.*${label}|${label}.*identity|destination`, "i")
    );
    assert.equal(
      recorder.calls.some((call) => call.args[0] === "clone"),
      false,
      "refusal must happen before clone can contact a remote"
    );
  }
});

test("clone sees and refuses an identity-changing rewrite from real local Git config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-git-rewrite-"));
  const localRepo = path.join(root, "local-config-repo");
  const home = path.join(root, "home");
  const destination = path.join(root, "claimed-destination");
  try {
    await fs.mkdir(home, { recursive: true });
    await run("git", ["init", "-q", localRepo]);
    await run("git", [
      "-C", localRepo,
      "config",
      "url.https://attacker.example/.insteadOf",
      "https://github.com/"
    ]);
    const adapter = createProjectGitAdapter({
      cwd: localRepo,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || ""
      }
    });

    await assert.rejects(
      adapter.cloneRepository({ url: SAFE_URL, destination }),
      /rewrite.*host|host.*identity|destination/i
    );
    await assert.rejects(fs.lstat(destination), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("clone accepts a transport rewrite only when shared parsing proves the same host/repo", async () => {
  const recorder = spawnRecorder([
    {
      code: 0,
      stdout: "url.git@github.com:.insteadof\nhttps://github.com/\u0000",
      stderr: ""
    },
    { code: 0, stdout: "", stderr: "" }
  ]);
  const adapter = createProjectGitAdapter({ spawnImpl: recorder.spawnImpl, cwd: "/tmp" });

  await adapter.cloneRepository({ url: SAFE_URL, destination: DESTINATION });
  assert.equal(recorder.calls.at(-1).args[0], "clone");
});

test("unsafe remote syntax is refused by shared core policy before any Git process", async () => {
  for (const unsafe of [
    "--upload-pack=touch /tmp/pwned",
    "file:///tmp/private-repo",
    "ext::sh -c touch% /tmp/pwned",
    "https://user:password@github.com/acme/repo.git"
  ]) {
    const recorder = spawnRecorder();
    const adapter = createProjectGitAdapter({ spawnImpl: recorder.spawnImpl, cwd: "/tmp" });
    await assert.rejects(
      adapter.cloneRepository({ url: unsafe, destination: DESTINATION }),
      /safe|remote|url|transport|credential|option/i
    );
    assert.deepEqual(recorder.calls, []);
  }
});

test("repository inspection uses sanitized local Git and returns a parsed safe origin", async () => {
  const inherited = {
    HOME: "/safe/home",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    DOTAIOS_SYNC_TOKEN: "SECRET",
    GIT_INDEX_FILE: "/tmp/attacker-index"
  };
  const recorder = spawnRecorder([
    { code: 0, stdout: "true\n", stderr: "" },
    { code: 0, stdout: `${SAFE_URL}\n`, stderr: "" }
  ]);
  const adapter = createProjectGitAdapter({ spawnImpl: recorder.spawnImpl, env: inherited });

  const result = await adapter.inspectRepository({ repositoryPath: DESTINATION });

  assert.equal(result.isRepository, true);
  assert.equal(result.originUrl, SAFE_URL);
  assert.ok(result.origin, "the safe origin is parsed by the shared core policy");
  assert.equal(result.origin.identity, "github.com/acme/client-portal");
  assert.deepEqual(recorder.calls.map((call) => call.args), [
    ["rev-parse", "--is-inside-work-tree"],
    ["remote", "get-url", "origin"]
  ]);
  for (const call of recorder.calls) {
    assert.equal(call.options.cwd, DESTINATION);
    assert.deepEqual(call.options.env, sanitizedGitEnvironment(inherited));
  }
});

test("repository inspection distinguishes non-repositories, missing origins, and unsafe origins", async () => {
  const nonRepo = spawnRecorder([{ code: 128, stdout: "", stderr: "not a repository" }]);
  assert.deepEqual(
    await createProjectGitAdapter({ spawnImpl: nonRepo.spawnImpl })
      .inspectRepository({ repositoryPath: DESTINATION }),
    { isRepository: false, originUrl: null, origin: null, originError: null }
  );

  const noOrigin = spawnRecorder([
    { code: 0, stdout: "true\n", stderr: "" },
    { code: 2, stdout: "", stderr: "No such remote 'origin'" }
  ]);
  assert.deepEqual(
    await createProjectGitAdapter({ spawnImpl: noOrigin.spawnImpl })
      .inspectRepository({ repositoryPath: DESTINATION }),
    { isRepository: true, originUrl: null, origin: null, originError: null }
  );

  const unsafeOrigin = spawnRecorder([
    { code: 0, stdout: "true\n", stderr: "" },
    { code: 0, stdout: "https://user:secret@github.com/acme/repo.git\n", stderr: "" }
  ]);
  const inspected = await createProjectGitAdapter({ spawnImpl: unsafeOrigin.spawnImpl })
    .inspectRepository({ repositoryPath: DESTINATION });
  assert.equal(inspected.isRepository, true);
  assert.equal(inspected.originUrl, null, "unsafe credential text must not leave the adapter");
  assert.equal(inspected.origin, null);
  assert.match(inspected.originError, /unsafe|credential|remote/i);
  assert.doesNotMatch(inspected.originError, /secret/);
});

test("restore readers return only a safe origin and a verified HEAD", async () => {
  const head = "a".repeat(40);
  const recorder = spawnRecorder([
    { code: 0, stdout: `${SAFE_URL}\n`, stderr: "" },
    { code: 0, stdout: `${head}\n`, stderr: "" }
  ]);
  const adapter = createProjectGitAdapter({ spawnImpl: recorder.spawnImpl });

  assert.equal(await adapter.readRepositoryRemote(DESTINATION), SAFE_URL);
  assert.equal(await adapter.readRepositoryHead(DESTINATION), head);
  assert.deepEqual(recorder.calls.map((call) => call.args), [
    ["remote", "get-url", "origin"],
    ["rev-parse", "--verify", "HEAD"]
  ]);
  assert.ok(recorder.calls.every((call) => call.options.cwd === DESTINATION));
});

test("restore readers refuse unsafe origins and invalid HEAD values", async () => {
  const unsafe = spawnRecorder([{
    code: 0,
    stdout: "https://user:secret@github.com/acme/repo.git\n",
    stderr: ""
  }]);
  const unsafeAdapter = createProjectGitAdapter({ spawnImpl: unsafe.spawnImpl });
  await assert.rejects(
    unsafeAdapter.readRepositoryRemote(DESTINATION),
    /unsafe|credential|remote/i
  );

  const invalidHead = spawnRecorder([{
    code: 0,
    stdout: "HEAD\n",
    stderr: ""
  }]);
  const headAdapter = createProjectGitAdapter({ spawnImpl: invalidHead.spawnImpl });
  await assert.rejects(
    headAdapter.readRepositoryHead(DESTINATION),
    /verifiable HEAD/i
  );
});
