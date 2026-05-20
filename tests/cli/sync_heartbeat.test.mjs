import test from "node:test";
import assert from "node:assert/strict";
import { renderLaunchAgentPlist } from "../../packages/cli/src/sync/heartbeat.mjs";

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
