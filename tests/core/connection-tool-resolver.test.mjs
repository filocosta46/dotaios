import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectConfiguredConnections,
  resolveConnectionTool
} from "../../packages/core/src/connection-tool-resolver.mjs";

const configuredConnections = ["google-workspace"];

test("the closed read-only table returns argv suffixes for the admitted local CLI only", () => {
  const cases = [
    [
      { capability: "google.gmail.inbox" },
      ["google", "inbox", "--json"]
    ],
    [
      { capability: "google.gmail.search", query: "from:alice@example.com" },
      ["google", "gmail", "search", "--query", "from:alice@example.com", "--json"]
    ],
    [
      { capability: "google.gmail.read", messageId: "187abc_123-Z" },
      ["google", "gmail", "read", "--message-id", "187abc_123-Z", "--json"]
    ],
    [
      { capability: "google.calendar.agenda", dateWindow: "today" },
      ["google", "agenda", "--today", "--json"]
    ],
    [
      { capability: "google.calendar.prep", dateWindow: "week" },
      ["google", "calendar", "prep", "--week", "--json"]
    ],
    [
      { capability: "google.drive.list", pageSize: 25 },
      ["google", "drive", "--page-size", "25", "--json"]
    ],
    [
      { capability: "google.drive.find", query: "approved launch brief" },
      ["google", "drive", "find", "--query", "approved launch brief", "--json"]
    ]
  ];

  for (const [request, argvSuffix] of cases) {
    const result = resolveConnectionTool({ configuredConnections, request });
    assert.equal(result.status, "matched", request.capability);
    assert.deepEqual(result.argv_suffix, argvSuffix, request.capability);
    assert.equal(Array.isArray(result.argv_suffix), true);
    assert.equal(Object.hasOwn(result, "executable"), false);
    assert.equal(Object.hasOwn(result, "command"), false);
  }
});

test("unknown and unconfigured capabilities do not produce an executable recommendation", () => {
  const unknown = resolveConnectionTool({
    configuredConnections,
    request: { capability: "google.chat.read" }
  });
  assert.equal(unknown.status, "no_match");
  assert.equal(Object.hasOwn(unknown, "argv_suffix"), false);

  const unconfigured = resolveConnectionTool({
    configuredConnections: [],
    request: { capability: "google.gmail.inbox" }
  });
  assert.equal(unconfigured.status, "no_match");
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.authenticated, "unknown");
  assert.equal(Object.hasOwn(unconfigured, "argv_suffix"), false);
});

test("collisions, extra parameters, write-like requests, and invalid bounded values are refused", () => {
  const cases = [
    resolveConnectionTool({
      configuredConnections: ["google-workspace", "google-workspace"],
      request: { capability: "google.gmail.inbox" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.gmail.inbox", query: "extra" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.gmail.send", query: "hello" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.gmail.search", query: "" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.gmail.search", query: "--help" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.gmail.read", messageId: "--help" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.calendar.agenda", dateWindow: "month" }
    }),
    resolveConnectionTool({
      configuredConnections,
      request: { capability: "google.drive.list", pageSize: 101 }
    })
  ];

  for (const result of cases) {
    assert.equal(result.status, "refused", JSON.stringify(result));
    assert.equal(Object.hasOwn(result, "argv_suffix"), false);
  }
});

test("a connection marker reached through an outside ancestor symlink is not configured", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-connection-marker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const outside = path.join(root, "outside");
  await fs.mkdir(path.join(aiosPath, "connections"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "google-workspace.md"), "outside\n");
  await fs.symlink(outside, path.join(aiosPath, "connections", "apis"), "dir");

  const configured = await inspectConfiguredConnections({ aiosPath });
  assert.deepEqual(configured.labels, []);
  assert.deepEqual(configured.issues, ["google_connection_marker_unsafe"]);
});
