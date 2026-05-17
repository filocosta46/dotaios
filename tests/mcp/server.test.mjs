import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const server = path.join(repoRoot, "packages", "mcp", "src", "server.mjs");

test("mcp server exposes DotAIOS tools over newline JSON-RPC", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);
  fs.writeFileSync(path.join(aiosPath, "context", "work.md"), "# Work\n\nBuilding Google and MCP integration.\n");
  fs.mkdirSync(path.join(aiosPath, "vault", "wiki"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "vault", "wiki", "google.md"), "# Google\n\nGmail setup notes.\n");
  fs.mkdirSync(path.join(aiosPath, "projects", "demo"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "connections", "apis"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "connections", "apis", "google-workspace.md"), "# Google Workspace\n\nStatus: Active\n");

  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" }
      }
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_context", arguments: { file: "work.md" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_vault", arguments: { query: "gmail" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_projects", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "log_event", arguments: { type: "mcp-test", summary: "MCP test event" } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_memory", arguments: { query: "mcp-test" } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_aios", arguments: { query: "gmail", scope: "vault" } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "google_status", arguments: { gwsBin } } },
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "google_gmail_search", arguments: { query: "from:alice", gwsBin } } },
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "google_calendar_agenda", arguments: { today: true, gwsBin } } },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "google_drive_search", arguments: { query: "budget", gwsBin } } }
  ];

  const responses = runMcp(aiosPath, messages);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[0].result.serverInfo.name, "dotaios-mcp");

  const tools = responses[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, [
    "read_context",
    "read_session_digest",
    "search_memory",
    "search_vault",
    "search_aios",
    "google_status",
    "google_gmail_search",
    "google_calendar_agenda",
    "google_drive_search",
    "list_projects",
    "log_event"
  ]);

  assert.match(toolText(responses[2]), /Building Google and MCP integration/);
  assert.match(toolText(responses[3]), /Gmail setup notes/);
  assert.match(toolText(responses[4]), /"name": "demo"/);
  assert.match(toolText(responses[5]), /"type": "mcp-test"/);
  assert.match(toolText(responses[6]), /"summary": "MCP test event"/);
  assert.match(toolText(responses[7]), /Gmail setup notes/);
  assert.match(toolText(responses[8]), /"connected": true/);
  assert.match(toolText(responses[9]), /Gmail search: from:alice/);
  assert.match(toolText(responses[10]), /Calendar agenda: today/);
  assert.match(toolText(responses[11]), /Drive search: name contains 'budget'/);
});

test("mcp server validates tool inputs", () => {
  const { aiosPath, tempRoot } = setupAios();
  const gwsBin = createFakeGws(tempRoot);
  const responses = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_context", arguments: { file: "../secrets.md" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unknown", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "google_gmail_search", arguments: { query: "from:alice", gwsBin } } }
  ]);

  assert.equal(responses[0].error.code, -32602);
  assert.match(responses[0].error.message, /inside context/);
  assert.equal(responses[1].error.code, -32602);
  assert.match(responses[1].error.message, /Unknown tool/);
  assert.equal(responses[2].error.code, -32602);
  assert.match(responses[2].error.message, /not connected/);
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-mcp-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  const result = spawnSync(process.execPath, [cli, "init", "--path", aiosPath, "--yes"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`init failed\n${result.stdout}\n${result.stderr}`);
  }
  return { aiosPath, tempRoot };
}

function runMcp(aiosPath, messages) {
  const result = spawnSync(
    process.execPath,
    [server, "--path", aiosPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
    }
  );

  if (result.status !== 0) {
    throw new Error(`mcp failed\n${result.stdout}\n${result.stderr}`);
  }

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toolText(response) {
  return response.result.content[0].text;
}

function createFakeGws(tempRoot) {
  const gwsBin = path.join(tempRoot, "gws");
  fs.writeFileSync(
    gwsBin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("gws 0.22.5");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("Authenticated as beta@example.com");
  process.exit(0);
}
if (args[0] === "gmail" && args[1] === "messages" && args[2] === "list") {
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  console.log("Gmail search: " + params.q);
  process.exit(0);
}
if (args[0] === "calendar" && args[1] === "+agenda") {
  console.log("Calendar agenda: " + (args.includes("--today") ? "today" : "upcoming"));
  process.exit(0);
}
if (args[0] === "drive" && args[1] === "files" && args[2] === "list") {
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  console.log("Drive search: " + params.q);
  process.exit(0);
}
console.error("Unexpected gws command: " + args.join(" "));
process.exit(2);
`
  );
  fs.chmodSync(gwsBin, 0o755);
  return gwsBin;
}
