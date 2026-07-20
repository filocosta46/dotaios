import test from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../../packages/cli/src/sync/git.mjs";
import { plainRemoteUrl, initialMirrorPush } from "../../packages/cli/src/sync/repo.mjs";

const TOKEN = "ghp_SECRET_TOKEN_VALUE";

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
  const git = createGit({ cwd: "/tmp/x", spawnImpl, accessToken: TOKEN });
  await git.push("main");

  const pushCall = calls.find((call) => call.args.includes("push"));
  assert.ok(pushCall, "expected a push invocation");
  assert.ok(pushCall.args.includes("-c"), "push must configure a per-invocation credential helper");
  assert.ok(
    pushCall.args.some((arg) => arg.startsWith("credential.helper=!")),
    "credential helper must be inline and per-invocation, not persisted config"
  );
  assert.ok(!flatArgs(calls).some((arg) => arg.includes(TOKEN)), "token must never appear in argv");
  assert.equal(pushCall.opts.env.DOTAIOS_SYNC_TOKEN, TOKEN, "token must flow through the environment only");
});

test("a legacy token-embedded remote is self-healed to the plain URL before network ops", async () => {
  const { calls, spawnImpl } = recordingSpawn({
    "remote get-url": { stdout: `https://x-access-token:${TOKEN}@github.com/user/repo.git\n` }
  });
  const git = createGit({ cwd: "/tmp/x", spawnImpl, accessToken: TOKEN });
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

test("initialMirrorPush stores the plain remote and still pushes", async () => {
  const { calls, spawnImpl } = recordingSpawn();
  const git = createGit({ cwd: "/tmp/x", spawnImpl, accessToken: TOKEN });
  const fakeFsWrites = [];
  const fakeFs = { writeFile: async (p, c) => { fakeFsWrites.push(p); } };

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
