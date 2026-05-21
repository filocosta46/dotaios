import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateSetup } from "../../packages/cli/src/sync/setup-flow.mjs";

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
    runFirstTick: async () => { calls.push("runFirstTick"); },
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
    runFirstTick: async () => {},
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
    runFirstTick: async () => {},
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
    runFirstTick: async () => {},
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
    runFirstTick: async () => {},
    log: () => {}
  });
  assert.ok(opened.some((u) => u.includes("settings/tokens/new")));
  assert.ok(opened.some((u) => u.includes("github.com/new")));
});
