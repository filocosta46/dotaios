import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { orchestrateSetup, runSetup } from "../../packages/cli/src/sync/setup-flow.mjs";

const successfulFirstTick = async () => ({ outcome: "success" });

test("orchestrateSetup runs all steps in order on the happy path", async () => {
  const calls = [];
  await orchestrateSetup({
    aiosPath: "/tmp/aios-test",
    gitignoreContent: ".env\n",
    readToken: async () => { calls.push("readToken"); return "ghp_TOKEN"; },
    validateToken: async () => { calls.push("validateToken"); return "alice"; },
    writeConfig: async (patch) => { calls.push("writeConfig"); return patch; },
    openInBrowser: async () => { calls.push("openInBrowser"); },
    pollForRepoExists: async () => { calls.push("pollForRepoExists"); return true; },
    initialMirrorPush: async () => { calls.push("initialMirrorPush"); },
    runFirstTick: async () => { calls.push("runFirstTick"); return { outcome: "success" }; },
    log: () => {}
  });
  assert.deepEqual(calls, [
    "openInBrowser",     // token-create URL
    "readToken",
    "validateToken",
    "writeConfig",       // token + username
    "openInBrowser",     // create-repo URL
    "pollForRepoExists",
    "writeConfig",       // repo url + full_name
    "initialMirrorPush",
    "runFirstTick"
  ]);
});

test("orchestrateSetup trims whitespace from the pasted token", async () => {
  let seen;
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "  ghp_PADDED\n",
    validateToken: async ({ accessToken }) => { seen = accessToken; return "alice"; },
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => {},
    runFirstTick: successfulFirstTick,
    log: () => {}
  });
  assert.equal(seen, "ghp_PADDED");
});

test("orchestrateSetup surfaces failure if the token is rejected", async () => {
  await assert.rejects(orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_BAD",
    validateToken: async () => { throw new Error("token was rejected"); },
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => {},
    runFirstTick: successfulFirstTick,
    log: () => {}
  }), /token was rejected/);
});

test("orchestrateSetup surfaces failure if the mirror push fails", async () => {
  await assert.rejects(orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "u",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => { throw new Error("push failed"); },
    runFirstTick: successfulFirstTick,
    log: () => {}
  }), /push failed/);
});

test("orchestrateSetup opens the browser to the token page and the create-repo page", async () => {
  const opened = [];
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async (url) => { opened.push(url); },
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => {},
    runFirstTick: successfulFirstTick,
    log: () => {}
  });
  assert.ok(opened.some((u) => u.includes("settings/tokens/new")));
  assert.ok(opened.some((u) => u.includes("github.com/new")));
});

test("orchestrateSetup describes sync as optional and manual", async () => {
  const logs = [];
  await orchestrateSetup({
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    readToken: async () => "ghp_T",
    validateToken: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => {},
    runFirstTick: successfulFirstTick,
    log: (message) => logs.push(message)
  });

  const copy = logs.join("\n");
  assert.match(copy, /Sync is optional and manual by default\./);
  assert.match(copy, /legacy automatic hook.*explicit opt-in/i);
  assert.match(copy, /dotaios sync now/);
  assert.doesNotMatch(copy, /syncs automatically|every dotaios command|agent session/i);
  assert.doesNotMatch(copy, /[—–]/, "user-facing sync copy must use plain punctuation");
});

for (const [label, result, message] of [
  ["an error", { error: "network down" }, /network down/],
  ["a public repository", { error: "the repo alice/alice-aios is public" }, /public/],
  ["an unverifiable repository", { error: "could not verify that alice/alice-aios is private" }, /could not verify/],
  ["a conflict", { conflict: true, error: "local and remote changes overlap" }, /overlap/],
  ["a stalled tick", { stalled: true, error: "nothing it could record" }, /nothing it could record/],
  ["a skipped tick", { skipped: "locked" }, /did not complete safely/]
]) {
  test(`orchestrateSetup withholds verified/private success copy after ${label}`, async () => {
    const logs = [];
    await assert.rejects(orchestrateSetup({
      aiosPath: "/tmp/x",
      gitignoreContent: ".env",
      readToken: async () => "ghp_T",
      validateToken: async () => "alice",
      writeConfig: async () => {},
      openInBrowser: async () => {},
      pollForRepoExists: async () => true,
      initialMirrorPush: async () => {},
      runFirstTick: async () => result,
      log: (line) => logs.push(line)
    }), message);

    const copy = logs.join("\n");
    assert.doesNotMatch(copy, /Setup verified\.|Your private memory repo is ready\./);
  });
}

test("runSetup throws on failure and does not leak process.exitCode", async () => {
  // Regression: a failing optional sync step inside `dotaios setup` must not
  // set process.exitCode — that leaked and made the whole wizard exit 1.
  const before = process.exitCode;
  try {
    await assert.rejects(
      runSetup([], { orchestrate: async () => { throw new Error("token rejected"); } }),
      /token rejected/
    );
    assert.equal(process.exitCode, before, "runSetup must not set process.exitCode");
  } finally {
    process.exitCode = before;
  }
});

test("runSetup honors --path for the AIOS folder", async () => {
  let seen;
  await runSetup(["--path", "/tmp/aios-synctest"], {
    orchestrate: async ({ aiosPath }) => { seen = aiosPath; }
  });
  assert.equal(seen, path.resolve("/tmp/aios-synctest"));
});
