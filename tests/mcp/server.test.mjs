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
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "context", "work.md"), "# Work\n\nBuilding Google and MCP integration.\n");
  fs.mkdirSync(path.join(aiosPath, "vault", "wiki"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "vault", "wiki", "google.md"), "# Google\n\nGmail setup notes.\n");
  fs.mkdirSync(path.join(aiosPath, "projects", "demo"), { recursive: true });

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
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_memory", arguments: { query: "mcp-test" } } }
  ];

  const responses = runMcp(aiosPath, messages);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[0].result.serverInfo.name, "dotaios-mcp");

  const tools = responses[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(tools, ["read_context", "search_memory", "search_vault", "list_projects", "log_event"]);

  assert.match(toolText(responses[2]), /Building Google and MCP integration/);
  assert.match(toolText(responses[3]), /Gmail setup notes/);
  assert.match(toolText(responses[4]), /"name": "demo"/);
  assert.match(toolText(responses[5]), /"type": "mcp-test"/);
  assert.match(toolText(responses[6]), /"summary": "MCP test event"/);
});

test("mcp server validates tool inputs", () => {
  const { aiosPath } = setupAios();
  const responses = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_context", arguments: { file: "../secrets.md" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unknown", arguments: {} } }
  ]);

  assert.equal(responses[0].error.code, -32602);
  assert.match(responses[0].error.message, /inside context/);
  assert.equal(responses[1].error.code, -32602);
  assert.match(responses[1].error.message, /Unknown tool/);
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
