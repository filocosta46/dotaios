import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  dotaiosBinDir,
  lightpandaBinPath,
  syncConfigPath,
  inboxDir,
  heartbeatPlistPath,
  heartbeatUnitDir
} from "../../packages/core/src/paths.mjs";

test("dotaiosBinDir returns ~/.dotaios/bin", () => {
  assert.equal(dotaiosBinDir(), path.join(os.homedir(), ".dotaios", "bin"));
});

test("lightpandaBinPath returns ~/.dotaios/bin/lightpanda on unix", { skip: process.platform === "win32" }, () => {
  assert.equal(lightpandaBinPath(), path.join(os.homedir(), ".dotaios", "bin", "lightpanda"));
});

test("lightpandaBinPath returns ~/.dotaios/bin/lightpanda.exe on windows", { skip: process.platform !== "win32" }, () => {
  assert.equal(lightpandaBinPath(), path.join(os.homedir(), ".dotaios", "bin", "lightpanda.exe"));
});

test("syncConfigPath returns ~/.dotaios/sync.json", () => {
  assert.equal(syncConfigPath(), path.join(os.homedir(), ".dotaios", "sync.json"));
});

test("inboxDir returns <aios>/memory/inbox", () => {
  assert.equal(
    inboxDir("/tmp/aios-test"),
    path.join("/tmp/aios-test", "memory", "inbox")
  );
});

test("heartbeatPlistPath returns ~/Library/LaunchAgents/io.dotaios.sync.plist", () => {
  assert.equal(
    heartbeatPlistPath(),
    path.join(os.homedir(), "Library", "LaunchAgents", "io.dotaios.sync.plist")
  );
});

test("heartbeatUnitDir returns ~/.config/systemd/user", () => {
  assert.equal(
    heartbeatUnitDir(),
    path.join(os.homedir(), ".config", "systemd", "user")
  );
});
