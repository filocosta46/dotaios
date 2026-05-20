import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateSetup, isPlaceholderClientId } from "../../packages/cli/src/sync/setup-flow.mjs";

const PLACEHOLDER = "Iv23liUNREGISTERED_PLACEHOLDER";

test("isPlaceholderClientId detects the unregistered placeholder", () => {
  assert.equal(isPlaceholderClientId(PLACEHOLDER), true);
  assert.equal(isPlaceholderClientId("Iv23liREALCLIENTID12"), false);
  assert.equal(isPlaceholderClientId(""), true);
  assert.equal(isPlaceholderClientId(undefined), true);
});

test("orchestrateSetup runs all steps in order on happy path", async () => {
  const calls = [];
  await orchestrateSetup({
    clientId: "REALID",
    aiosPath: "/tmp/aios-test",
    gitignoreContent: ".env\n",
    requestDeviceCode: async () => {
      calls.push("requestDeviceCode");
      return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", deviceCode: "DC", intervalSec: 0, expiresInSec: 900 };
    },
    pollForToken: async () => { calls.push("pollForToken"); return { accessToken: "T" }; },
    fetchUsername: async () => { calls.push("fetchUsername"); return "alice"; },
    writeConfig: async (patch) => { calls.push("writeConfig"); return patch; },
    openInBrowser: async () => { calls.push("openInBrowser"); },
    pollForRepoExists: async () => { calls.push("pollForRepoExists"); return true; },
    initialMirrorPush: async () => { calls.push("initialMirrorPush"); },
    installHeartbeat: async () => { calls.push("installHeartbeat"); },
    runFirstTick: async () => { calls.push("runFirstTick"); },
    log: () => {}
  });
  assert.deepEqual(calls, [
    "requestDeviceCode",
    "openInBrowser",     // device verification URL
    "pollForToken",
    "fetchUsername",
    "writeConfig",       // token + username
    "openInBrowser",     // create-repo URL
    "pollForRepoExists",
    "writeConfig",       // repo url + full_name
    "initialMirrorPush",
    "installHeartbeat",
    "runFirstTick"
  ]);
});

test("orchestrateSetup surfaces failure if mirror push fails", async () => {
  await assert.rejects(orchestrateSetup({
    clientId: "REALID",
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    requestDeviceCode: async () => ({ userCode: "X", verificationUri: "u", deviceCode: "DC", intervalSec: 0 }),
    pollForToken: async () => ({ accessToken: "T" }),
    fetchUsername: async () => "u",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => { throw new Error("push failed"); },
    installHeartbeat: async () => {},
    runFirstTick: async () => {},
    log: () => {}
  }), /push failed/);
});

test("orchestrateSetup opens the browser to the device verification URL and the create-repo URL", async () => {
  const opened = [];
  await orchestrateSetup({
    clientId: "REALID",
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    requestDeviceCode: async () => ({ userCode: "X", verificationUri: "https://github.com/login/device", deviceCode: "DC", intervalSec: 0 }),
    pollForToken: async () => ({ accessToken: "T" }),
    fetchUsername: async () => "alice",
    writeConfig: async () => {},
    openInBrowser: async (url) => { opened.push(url); },
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => {},
    installHeartbeat: async () => {},
    runFirstTick: async () => {},
    log: () => {}
  });
  assert.ok(opened.some((u) => u.includes("login/device")));
  assert.ok(opened.some((u) => u.includes("github.com/new")));
});
