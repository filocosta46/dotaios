import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGit } from "../../packages/cli/src/sync/git.mjs";
import { plainRemoteUrl, initialMirrorPush } from "../../packages/cli/src/sync/repo.mjs";

const TOKEN = "ghp_SECRET_TOKEN_VALUE";
const run = promisify(execFile);

function recordingSpawn(responses = {}) {
  const calls = [];
  const spawnImpl = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = args.slice(0, 3).join(" ");
    for (const [prefix, response] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return { stdout: "", stderr: "", code: 0, ...response };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, spawnImpl };
}

function flatArgs(calls) {
  return calls.flatMap((call) => call.args);
}

function invokeCredentialHelper(helperConfig, operation, input, env) {
  const command = helperConfig.slice("credential.helper=!".length);
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command, "dotaios-credential-helper", operation], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function localOnlyGitSpawn(calls) {
  return async (cmd, args, opts) => {
    calls.push(args);
    if (["push", "fetch", "ls-remote"].some((operation) => args.includes(operation))) {
      return { stdout: "", stderr: "test blocked a network operation", code: 99 };
    }
    try {
      const { stdout, stderr } = await run(cmd, args, { cwd: opts.cwd, env: opts.env });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        code: Number.isInteger(error.code) ? error.code : 1
      };
    }
  };
}

test("plainRemoteUrl never embeds a credential", () => {
  assert.equal(plainRemoteUrl("user/repo"), "https://github.com/user/repo.git");
});

test("addRemote strips an embedded token before it can reach .git/config", async () => {
  const { calls, spawnImpl } = recordingSpawn();
  const git = createGit({ cwd: "/tmp/x", spawnImpl });
  await git.addRemote(`https://x-access-token:${TOKEN}@github.com/user/repo.git`);

  const addCall = calls.find((call) => call.args[0] === "remote" && call.args[1] === "add");
  assert.ok(addCall, "expected a remote add invocation");
  assert.ok(addCall.args.includes("https://github.com/user/repo.git"), "remote must be stored as the plain URL");
  assert.ok(!flatArgs(calls).some((arg) => arg.includes(TOKEN)), "token must never appear in git argv");
});

test("push authenticates via env-fed credential helper, never via argv or the stored remote", async () => {
  const { calls, spawnImpl } = recordingSpawn({
    "remote get-url": { stdout: "https://github.com/user/repo.git\n" }
  });
  const git = createGit({
    cwd: "/tmp/x",
    spawnImpl,
    accessToken: TOKEN,
    expectedRepoFullName: "user/repo"
  });
  await git.push("main");

  const pushCall = calls.find((call) => call.args.includes("push"));
  assert.ok(pushCall, "expected a push invocation");
  assert.ok(pushCall.args.includes("-c"), "push must configure a per-invocation credential helper");
  assert.ok(
    pushCall.args.some((arg) => arg.startsWith("credential.helper=!")),
    "credential helper must be inline and per-invocation, not persisted config"
  );
  assert.ok(
    pushCall.args.includes("credential.useHttpPath=true"),
    "Git must include the repository path in credential requests"
  );
  const hooksConfig = pushCall.args.find((arg) => arg.startsWith("core.hooksPath="));
  assert.ok(hooksConfig, "token-bearing Git must disable checkout-local hooks");
  await assert.rejects(
    fs.access(hooksConfig.slice("core.hooksPath=".length)),
    /ENOENT/,
    "the private empty hooks directory is removed after the network operation"
  );
  assert.ok(!flatArgs(calls).some((arg) => arg.includes(TOKEN)), "token must never appear in argv");
  assert.equal(pushCall.opts.env.DOTAIOS_SYNC_TOKEN, TOKEN, "token must flow through the environment only");
  assert.equal(pushCall.opts.env.DOTAIOS_SYNC_REPO_PATH, "user/repo.git");
  assert.ok(pushCall.args.includes("https://github.com/user/repo.git"), "credentialed push is pinned to the verified repo URL");
  const originRead = calls.find((call) => call.args[0] === "remote" && call.args[1] === "get-url");
  assert.ok(!("DOTAIOS_SYNC_TOKEN" in originRead.opts.env), "origin is read without the sync token in the Git environment");
});

test("credential helper returns the token only for the exact HTTPS GitHub repository", async () => {
  const { calls, spawnImpl } = recordingSpawn({
    "remote get-url": { stdout: "https://github.com/user/repo.git\n" }
  });
  const git = createGit({
    cwd: "/tmp/x",
    spawnImpl,
    accessToken: TOKEN,
    expectedRepoFullName: "user/repo"
  });
  await git.push("main");

  const pushCall = calls.find((call) => call.args.includes("push"));
  const helperConfig = pushCall.args.find((arg) => arg.startsWith("credential.helper=!"));
  const exact = await invokeCredentialHelper(
    helperConfig,
    "get",
    "protocol=https\nhost=github.com\npath=user/repo.git\n\n",
    pushCall.opts.env
  );
  assert.equal(exact.code, 0);
  assert.match(exact.stdout, /username=x-access-token/);
  assert.match(exact.stdout, new RegExp(`password=${TOKEN}`));

  for (const [label, input] of [
    ["wrong host", "protocol=https\nhost=attacker.example\npath=user/repo.git\n\n"],
    ["wrong path", "protocol=https\nhost=github.com\npath=user/other.git\n\n"],
    ["wrong protocol", "protocol=http\nhost=github.com\npath=user/repo.git\n\n"]
  ]) {
    const refused = await invokeCredentialHelper(helperConfig, "get", input, pushCall.opts.env);
    assert.equal(refused.code, 0, `${label} is a quiet credential miss`);
    assert.equal(refused.stdout, "", `${label} receives no username or token`);
  }
});

for (const rewriteKey of [
  "url.https://attacker.example/.insteadof",
  "url.https://attacker.example/.pushinsteadof"
]) {
  test(`credentialed Git refuses effective ${rewriteKey.split(".").at(-1)} rules before mutation or network`, async () => {
    const { calls, spawnImpl } = recordingSpawn({
      "config --null --get-regexp": {
        stdout: `${rewriteKey}\nhttps://github.com/\0`
      },
      "remote get-url": { stdout: "https://github.com/user/repo.git\n" }
    });
    const git = createGit({
      cwd: "/tmp/x",
      spawnImpl,
      accessToken: TOKEN,
      expectedRepoFullName: "user/repo"
    });

    await assert.rejects(() => git.push("main"), /URL rewrite/i);
    assert.ok(!calls.some((call) => call.args.includes("push")), "no network push is launched");
    assert.ok(
      !calls.some((call) => call.args[0] === "remote" && call.args[1] === "set-url"),
      "the stored remote is not mutated"
    );
    assert.ok(
      calls.every((call) => !("DOTAIOS_SYNC_TOKEN" in call.opts.env)),
      "the token never enters any Git process"
    );
  });
}

test("credentialed Git allows an unrelated URL rewrite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-unrelated-rewrite-"));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await run("git", ["init", "-q"], { cwd: repo });
  await run("git", ["config", "url.https://mirror.example/.insteadOf", "https://example.com/"], { cwd: repo });

  const calls = [];
  const git = createGit({
    cwd: repo,
    spawnImpl: localOnlyGitSpawn(calls),
    accessToken: TOKEN,
    expectedRepoFullName: "user/repo"
  });

  await assert.rejects(() => git.push("main"), /test blocked a network operation/);
  assert.ok(calls.some((args) => args.includes("push")), "unrelated rewrites must reach the network operation");
});

for (const source of ["local", "global"]) {
  test(`credentialed Git sees and refuses a real ${source} URL rewrite configuration`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-url-rewrite-"));
    const repo = path.join(root, "repo");
    const globalConfig = path.join(root, ".gitconfig");
    await fs.mkdir(repo);
    await run("git", ["init", "-q"], { cwd: repo });
    const configArgs = source === "local"
      ? ["config", "url.https://attacker.example/.insteadOf", "https://github.com/"]
      : ["config", "--file", globalConfig, "url.https://attacker.example/.insteadOf", "https://github.com/"];
    await run("git", configArgs, { cwd: repo });

    const calls = [];
    const git = createGit({
      cwd: repo,
      spawnImpl: localOnlyGitSpawn(calls),
      env: { ...process.env, HOME: root },
      accessToken: TOKEN,
      expectedRepoFullName: "user/repo"
    });

    await assert.rejects(() => git.push("main"), /URL rewrite/i);
    assert.ok(!calls.some((args) => args.includes("push")), "the blocked rewrite launches no push");
    assert.ok(
      !calls.some((args) => args[0] === "remote" && args[1] === "set-url"),
      "the blocked rewrite performs no remote mutation"
    );
  });
}

test("a legacy token-embedded remote is self-healed to the plain URL before network ops", async () => {
  const { calls, spawnImpl } = recordingSpawn({
    "remote get-url": { stdout: `https://x-access-token:${TOKEN}@github.com/user/repo.git\n` }
  });
  const git = createGit({
    cwd: "/tmp/x",
    spawnImpl,
    accessToken: TOKEN,
    expectedRepoFullName: "user/repo"
  });
  await git.fetch();

  const setUrl = calls.find((call) => call.args[0] === "remote" && call.args[1] === "set-url");
  assert.ok(setUrl, "expected the legacy embedded-token remote to be rewritten");
  assert.ok(setUrl.args.includes("https://github.com/user/repo.git"), "rewritten remote must be credential-free");
  const fetchIndex = calls.findIndex((call) => call.args.includes("fetch"));
  const setUrlIndex = calls.indexOf(setUrl);
  assert.ok(setUrlIndex < fetchIndex, "self-heal must happen before the network op");
});

test("without an access token git behaves exactly as before (no helper, no env var)", async () => {
  const { calls, spawnImpl } = recordingSpawn();
  const git = createGit({ cwd: "/tmp/x", spawnImpl });
  await git.push("main");

  const pushCall = calls.find((call) => call.args.includes("push"));
  assert.ok(!pushCall.args.some((arg) => String(arg).startsWith("credential.helper=")), "no helper without a token");
  assert.ok(!("DOTAIOS_SYNC_TOKEN" in pushCall.opts.env), "no token env var without a token");
});

test("a credentialed Git client refuses network access without a bound repository identity", async () => {
  const { calls, spawnImpl } = recordingSpawn({
    "remote get-url": { stdout: "https://attacker.example/collect.git\n" }
  });
  const git = createGit({ cwd: "/tmp/x", spawnImpl, accessToken: TOKEN });

  await assert.rejects(() => git.push("main"), /repository identity is unavailable/i);
  assert.ok(!calls.some((call) => call.args.includes("push")), "no credentialed push is launched");
  assert.ok(calls.every((call) => !("DOTAIOS_SYNC_TOKEN" in call.opts.env)), "the token never enters a local inspection command");
});

test("initialMirrorPush stores the plain remote and still pushes", async () => {
  const { calls, spawnImpl } = recordingSpawn();
  const git = createGit({
    cwd: "/tmp/x",
    spawnImpl,
    accessToken: TOKEN,
    expectedRepoFullName: "user/repo"
  });
  const fakeFsWrites = [];
  const fakeFs = {
    readdir: async () => [],
    readFile: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    writeFile: async (p) => { fakeFsWrites.push(p); }
  };

  await initialMirrorPush({
    aiosPath: "/tmp/x",
    accessToken: TOKEN,
    fullName: "user/repo",
    gitignoreContent: "build/\n",
    git,
    filesystem: fakeFs
  });

  const addCall = calls.find((call) => call.args[0] === "remote" && call.args[1] === "add");
  assert.ok(addCall.args.includes("https://github.com/user/repo.git"), "mirror setup must store the plain URL");
  assert.ok(!flatArgs(calls).some((arg) => arg.includes(TOKEN)), "token must never appear in argv during setup");
});
