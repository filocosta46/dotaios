import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const server = path.join(repoRoot, "packages", "mcp", "src", "server.mjs");

test("mcp exposes one bounded read-only DotAIOS gateway", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "context", "work.md"), "# Work\n\nBuilding the DotAIOS context gateway.\n");
  fs.mkdirSync(path.join(aiosPath, "projects", "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "demo", "README.md"),
    "---\nid: demo-id\nproject: demo\nstatus: active\ndomain: [build]\n---\n# Demo\n\nGateway acceptance.\n",
  );
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${JSON.stringify({
      session_id: "session-1",
      project: "demo",
      captured_at: "2026-07-15T09:00:00.000Z",
      title: "Gateway session",
      agent: "codex",
      turns: 3,
      source_path: "/private/machine/session.jsonl",
    })}\n`,
  );

  const sessionsPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  const sessionsBefore = fs.readFileSync(sessionsPath, "utf8");
  const eventsBefore = fs.readFileSync(eventsPath, "utf8");
  const responses = runMcp(aiosPath, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_working_context", arguments: { project: "demo-id", budget: 1000 } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_aios", arguments: { query: "gateway", scope: "projects", budget: 1000 } },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "resolve_skill", arguments: { intent: "plan my day" } },
    },
  ]);

  assert.equal(responses[0].result.serverInfo.name, "dotaios-mcp");
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    ["read_working_context", "search_aios", "resolve_skill"],
  );

  const workingContext = JSON.parse(toolText(responses[2]));
  assert.equal(workingContext.scope.project, "demo");
  assert.match(workingContext.markdown, /Gateway session/);
  assert.ok(workingContext.markdown.length <= 1000);

  const search = JSON.parse(toolText(responses[3]));
  assert.equal(search.scope, "projects");
  assert.match(JSON.stringify(search.results), /Gateway acceptance/);
  assert.doesNotMatch(JSON.stringify(search), /private\/machine/);
  assert.ok(search.budget.used <= search.budget.limit);

  const resolved = JSON.parse(toolText(responses[4]));
  assert.equal(resolved.matches[0].name, "plan-today");
  assert.equal(resolved.matches[0].resource, "skills/plan-today/SKILL.md");
  assert.doesNotMatch(JSON.stringify(resolved), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(fs.readFileSync(sessionsPath, "utf8"), sessionsBefore);
  assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
});

test("mcp enforces runtime bounds and rejects removed write tools", () => {
  const { aiosPath } = setupAios();
  const responses = runMcp(aiosPath, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_working_context", arguments: { budget: 20 } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_aios", arguments: { query: "x", limit: 100 } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "log_event", arguments: { type: "should-not-write" } },
    },
  ]);

  assert.equal(responses[0].error.code, -32602);
  assert.match(responses[0].error.message, /256 to 32000/);
  assert.equal(responses[1].error.code, -32602);
  assert.match(responses[1].error.message, /1 to 20/);
  assert.equal(responses[2].error.code, -32602);
  assert.match(responses[2].error.message, /Unknown tool/);
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-mcp-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  const result = spawnSync(process.execPath, [cli, "init", "--path", aiosPath, "--yes"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`init failed\n${result.stdout}\n${result.stderr}`);
  return { aiosPath, tempRoot };
}

function runMcp(aiosPath, messages) {
  const result = spawnSync(process.execPath, [server, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  });
  if (result.status !== 0) throw new Error(`mcp failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function toolText(response) {
  return response.result.content[0].text;
}
