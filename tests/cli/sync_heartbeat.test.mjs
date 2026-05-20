import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderLaunchAgentPlist, installMacHeartbeat } from "../../packages/cli/src/sync/heartbeat.mjs";
import { renderSystemdUnits, installLinuxHeartbeat } from "../../packages/cli/src/sync/heartbeat.mjs";
import { buildSchtasksArgs, installWindowsHeartbeat } from "../../packages/cli/src/sync/heartbeat.mjs";

test("renderLaunchAgentPlist embeds binary, 300s interval, log paths", () => {
  const plist = renderLaunchAgentPlist({
    label: "io.dotaios.sync",
    binary: "/usr/local/bin/dotaios",
    args: ["sync", "tick"],
    intervalSec: 300,
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log"
  });
  assert.ok(plist.includes("<key>Label</key>"));
  assert.ok(plist.includes("<string>io.dotaios.sync</string>"));
  assert.ok(plist.includes("<string>/usr/local/bin/dotaios</string>"));
  assert.ok(plist.includes("<string>sync</string>"));
  assert.ok(plist.includes("<string>tick</string>"));
  assert.ok(plist.includes("<key>StartInterval</key>"));
  assert.ok(plist.includes("<integer>300</integer>"));
  assert.ok(plist.includes("<string>/tmp/out.log</string>"));
});

test("installMacHeartbeat writes plist and invokes launchctl bootstrap", { skip: process.platform === "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hb-"));
  try {
    const plistPath = path.join(dir, "io.dotaios.sync.plist");
    const calls = [];
    await installMacHeartbeat({
      binary: "/usr/local/bin/dotaios",
      plistPath,
      logsDir: path.join(dir, "logs"),
      exec: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stderr: "" }; }
    });
    const written = await fs.readFile(plistPath, "utf8");
    assert.ok(written.includes("<string>/usr/local/bin/dotaios</string>"));
    assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap")));
    assert.ok(calls.some((c) => c.includes(plistPath)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("installMacHeartbeat treats 'already loaded' as benign", { skip: process.platform === "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hb-"));
  try {
    await installMacHeartbeat({
      binary: "/bin/dotaios",
      plistPath: path.join(dir, "a.plist"),
      logsDir: path.join(dir, "logs"),
      exec: async () => ({ code: 5, stderr: "Bootstrap failed: service already bootstrapped" })
    });
    // no throw → benign handled correctly
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("installMacHeartbeat throws on a hard launchctl failure", { skip: process.platform === "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hb-"));
  try {
    await assert.rejects(
      installMacHeartbeat({
        binary: "/bin/dotaios",
        plistPath: path.join(dir, "a.plist"),
        logsDir: path.join(dir, "logs"),
        exec: async () => ({ code: 1, stderr: "Could not find specified service" })
      }),
      /launchctl bootstrap failed/
    );
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("renderSystemdUnits returns service + timer matching binary + 300s interval", () => {
  const { service, timer } = renderSystemdUnits({
    binary: "/usr/bin/dotaios",
    intervalSec: 300
  });
  assert.ok(service.includes("[Service]"));
  assert.ok(service.includes("ExecStart=/usr/bin/dotaios sync tick"));
  assert.ok(timer.includes("[Timer]"));
  assert.ok(timer.includes("OnUnitActiveSec=300s"));
  assert.ok(timer.includes("OnBootSec=30s"));
  assert.ok(timer.includes("[Install]"));
  assert.ok(timer.includes("WantedBy=default.target"));
});

test("buildSchtasksArgs creates the right /Create command", () => {
  const args = buildSchtasksArgs({ taskName: "DotAIOS Sync", binary: "C:/dotaios.exe" });
  assert.ok(args.includes("/Create"));
  assert.ok(args.includes("/TN"));
  assert.ok(args.includes("DotAIOS Sync"));
  assert.ok(args.includes("/SC"));
  assert.ok(args.includes("MINUTE"));
  assert.ok(args.includes("/MO"));
  assert.ok(args.includes("5"));
  assert.ok(args.includes("/TR"));
  assert.ok(args.some((a) => a.includes("C:/dotaios.exe")));
  assert.ok(args.some((a) => a.includes("sync tick")));
});

test("installLinuxHeartbeat writes both unit files and reloads/enables", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hb-linux-"));
  try {
    const calls = [];
    await installLinuxHeartbeat({
      binary: "/usr/bin/dotaios",
      unitDir: dir,
      exec: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stderr: "" }; }
    });
    const service = await fs.readFile(path.join(dir, "dotaios-sync.service"), "utf8");
    const timer = await fs.readFile(path.join(dir, "dotaios-sync.timer"), "utf8");
    assert.ok(service.includes("ExecStart=/usr/bin/dotaios sync tick"));
    assert.ok(timer.includes("OnUnitActiveSec="));
    assert.ok(calls.some((c) => c.includes("daemon-reload")));
    assert.ok(calls.some((c) => c.includes("enable --now dotaios-sync.timer")));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("installLinuxHeartbeat throws on a hard systemctl failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hb-linux-"));
  try {
    await assert.rejects(
      installLinuxHeartbeat({
        binary: "/usr/bin/dotaios",
        unitDir: dir,
        exec: async () => ({ code: 1, stderr: "Failed to connect to bus" })
      }),
      /systemctl/
    );
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("installWindowsHeartbeat invokes schtasks /Create", async () => {
  const calls = [];
  await installWindowsHeartbeat({
    binary: "C:/dotaios.exe",
    taskName: "DotAIOS Sync",
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stderr: "" }; }
  });
  assert.ok(calls.some((c) => c.startsWith("schtasks /Create")));
  assert.ok(calls.some((c) => c.includes("sync tick")));
});

test("installWindowsHeartbeat throws on a hard schtasks failure", async () => {
  await assert.rejects(
    installWindowsHeartbeat({
      binary: "C:/dotaios.exe",
      taskName: "DotAIOS Sync",
      exec: async () => ({ code: 1, stderr: "Access is denied" })
    }),
    /schtasks install failed/
  );
});
