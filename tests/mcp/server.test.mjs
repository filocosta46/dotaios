import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_EVIDENCE_READ_LIMITS } from "../../packages/core/src/evidence-reader.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const server = path.join(repoRoot, "packages", "mcp", "src", "server.mjs");
const releaseVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const SEARCH_RESULT_BUDGET_FLOOR = 3530;

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
      params: { name: "search_aios", arguments: { query: "gateway", scope: "projects", project: "demo-id", budget: SEARCH_RESULT_BUDGET_FLOOR } },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "resolve_skill", arguments: { intent: "plan my day" } },
    },
  ]);

  assert.equal(responses[0].result.serverInfo.name, "dotaios-mcp");
  assert.equal(responses[0].result.serverInfo.version, releaseVersion);
  assert.deepEqual(
    responses[1].result.tools.map((tool) => tool.name),
    ["read_working_context", "search_aios", "resolve_skill"],
  );
  const projectSchema = responses[1].result.tools
    .find((tool) => tool.name === "read_working_context")
    .inputSchema.properties.project;
  assert.equal(projectSchema.minLength, 1);
  assert.equal(new RegExp(projectSchema.pattern, "u").test("demo-id"), true);
  assert.equal(new RegExp(projectSchema.pattern, "u").test("   "), false);
  assert.equal(new RegExp(projectSchema.pattern, "u").test("demo\n"), false);

  const workingContext = JSON.parse(toolText(responses[2]));
  assert.equal(workingContext.scope.project, "demo");
  assert.match(workingContext.markdown, /Gateway session/);
  assert.ok(workingContext.markdown.length <= 1000);

  const search = JSON.parse(toolText(responses[3]));
  assert.equal(search.scope, "projects");
  assert.match(JSON.stringify(search.results), /Gateway acceptance/);
  assert.doesNotMatch(JSON.stringify(search), /private\/machine/);
  assert.equal(search.budget.used, toolText(responses[3]).length);
  assert.ok(toolText(responses[3]).length <= search.budget.limit);

  const resolved = JSON.parse(toolText(responses[4]));
  assert.equal(resolved.matches[0].name, "plan-today");
  assert.equal(resolved.matches[0].resource, "skills/plan-today/SKILL.md");
  assert.doesNotMatch(JSON.stringify(resolved), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(fs.readFileSync(sessionsPath, "utf8"), sessionsBefore);
  assert.equal(fs.readFileSync(eventsPath, "utf8"), eventsBefore);
});

test("read_working_context preserves visible identity and priorities but omits frontmatter without mutation", () => {
  const { aiosPath } = setupAios();
  const identityPath = path.join(aiosPath, "context", "identity.md");
  const prioritiesPath = path.join(aiosPath, "context", "priorities.md");
  fs.writeFileSync(identityPath, "---\nsource: private-import\nkind: context\n---\n# Identity\n\nI lead the launch.\n");
  fs.writeFileSync(prioritiesPath, "---\nupdated_at: 2026-08-13\n---\n# Priorities\n\nShip the trust release.\n");
  const before = [fs.readFileSync(identityPath), fs.readFileSync(prioritiesPath)];

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 1000 } }
  }]);
  const markdown = JSON.parse(toolText(response)).markdown;

  assert.match(markdown, /I lead the launch/);
  assert.match(markdown, /Ship the trust release/);
  assert.doesNotMatch(markdown, /private-import|updated_at|kind: context|^---$/m);
  assert.deepEqual([fs.readFileSync(identityPath), fs.readFileSync(prioritiesPath)], before);
});

test("search_aios matches CLI project selection by slug and stable id without widening the tool allowlist", () => {
  const { aiosPath } = setupAios();
  for (const [slug, id, canary] of [
    ["acme-campaign", "project-acme-001", "ACME_MCP_SEARCH_CANARY"],
    ["other-client", "project-other-002", "OTHER_MCP_SEARCH_CANARY"]
  ]) {
    const projectPath = path.join(aiosPath, "projects", slug);
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "README.md"),
      `---\nid: ${id}\nproject: ${slug}\n---\n# ${slug}\n\n${canary} campaign assets\n`
    );
  }
  const responses = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search_aios", arguments: { query: "campaign assets", scope: "projects", project: "acme-campaign", budget: SEARCH_RESULT_BUDGET_FLOOR } }
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_aios", arguments: { query: "campaign assets", scope: "projects", project: "project-acme-001", budget: SEARCH_RESULT_BUDGET_FLOOR } }
    }
  ]);

  assert.deepEqual(
    responses[0].result.tools.map((tool) => tool.name),
    ["read_working_context", "search_aios", "resolve_skill"]
  );
  const bySlug = JSON.parse(toolText(responses[1]));
  const byId = JSON.parse(toolText(responses[2]));
  assert.deepEqual(bySlug.results, byId.results);
  assert.equal(bySlug.scope_selection.project, "acme-campaign");
  assert.match(JSON.stringify(bySlug), /ACME_MCP_SEARCH_CANARY/);
  assert.doesNotMatch(JSON.stringify(bySlug), /OTHER_MCP_SEARCH_CANARY|other-client/);
});

test("search_aios preserves the exact raw project selector like CLI and core search", () => {
  const { aiosPath } = setupAios();
  const projectPath = path.join(aiosPath, "projects", "acme-campaign");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "README.md"),
    "---\nid: project-acme-001\nproject: acme-campaign\n---\n# Acme\n\nRAW_SELECTOR_MCP_CANARY\n",
  );

  const responses = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_aios",
        arguments: {
          query: "RAW_SELECTOR_MCP_CANARY",
          scope: "projects",
          project: " acme-campaign ",
          budget: SEARCH_RESULT_BUDGET_FLOOR,
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_aios",
        arguments: {
          query: "RAW_SELECTOR_MCP_CANARY",
          scope: "projects",
          project: "acme-campaign",
          budget: SEARCH_RESULT_BUDGET_FLOOR,
        },
      },
    },
  ]);

  assert.equal(responses[1].error?.code, -32602);
  assert.match(responses[1].error.message, /safe project slug or stable id/);
  assert.doesNotMatch(JSON.stringify(responses[1]), /RAW_SELECTOR_MCP_CANARY/);
  assert.doesNotMatch(JSON.stringify(responses[1]), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const exact = JSON.parse(toolText(responses[2]));
  assert.equal(exact.scope_selection.project, "acme-campaign");
  assert.match(JSON.stringify(exact), /RAW_SELECTOR_MCP_CANARY/);

  const projectSchema = responses[0].result.tools
    .find((tool) => tool.name === "search_aios")
    .inputSchema.properties.project;
  const selectorPattern = new RegExp(projectSchema.pattern, "u");
  assert.equal(selectorPattern.test("acme-campaign"), true);
  assert.equal(selectorPattern.test(" acme-campaign "), false);
});

test("search_aios refuses a selected catalog identity outside the selector contract", () => {
  const { aiosPath } = setupAios();
  const projectPath = path.join(aiosPath, "projects", "acme-campaign");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "README.md"),
    "---\nid: \" project-acme-001 \"\nproject: acme-campaign\n---\n# Selected\n\nINVALID_ID_PRIVATE_CANARY\n",
  );

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: {
        query: "INVALID_ID_PRIVATE_CANARY",
        scope: "projects",
        project: "acme-campaign",
        budget: SEARCH_RESULT_BUDGET_FLOOR,
      },
    },
  }]);

  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /failed safely/i);
  assert.doesNotMatch(JSON.stringify(response), /INVALID_ID_PRIVATE_CANARY/);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("mcp search budgets bound the exact serialized response at minimum, default, and maximum", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(
    path.join(aiosPath, "context", "work.md"),
    `# Work\n\n${"bounded memory ".repeat(200)}\n`,
  );
  const query = `bounded ${"context ".repeat(55)}`.slice(0, 500);
  for (const requestedBudget of [SEARCH_RESULT_BUDGET_FLOOR, undefined, 32000]) {
    const argumentsValue = { query };
    if (requestedBudget !== undefined) argumentsValue.budget = requestedBudget;
    const [response] = runMcp(aiosPath, [{
      jsonrpc: "2.0",
      id: requestedBudget ?? "default",
      method: "tools/call",
      params: { name: "search_aios", arguments: argumentsValue },
    }]);

    const text = toolText(response);
    const payload = JSON.parse(text);
    const expectedBudget = requestedBudget ?? 6000;
    assert.ok(text.length <= expectedBudget);
    assert.equal(payload.budget.used, text.length);
    assert.equal(payload.budget.limit, expectedBudget);
    if (requestedBudget === SEARCH_RESULT_BUDGET_FLOOR) assert.equal(payload.budget.truncated, true);
  }
});

test("search_aios stabilizes budget metadata across the pretty-to-compact boundary", () => {
  const { aiosPath } = setupAios();
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(
      path.join(aiosPath, "context", `boundary-${index}.md`),
      `# Boundary ${index}\n\nserialization-boundary ${"x".repeat(193)}\n`,
    );
  }

  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "serialization-boundary", scope: "context", limit: 20, budget: 32000 },
    },
  };
  const [fullResponse] = runMcp(aiosPath, [request]);
  const fullPayload = JSON.parse(toolText(fullResponse));
  const boundarySeed = {
    ...fullPayload,
    budget: { ...fullPayload.budget, limit: 10000, used: 0 },
  };
  const boundaryBudget = JSON.stringify(boundarySeed, null, 2).length + 3;

  assert.ok(boundaryBudget >= 10000 && boundaryBudget <= 32000);
  assert.ok(JSON.stringify(boundarySeed).length < 10000);

  request.id = 2;
  request.params.arguments.budget = boundaryBudget;
  const [boundaryResponse] = runMcp(aiosPath, [request]);

  assert.equal(boundaryResponse.error, undefined);
  const text = toolText(boundaryResponse);
  const payload = JSON.parse(text);
  assert.equal(payload.results.length, 20);
  assert.equal(payload.budget.limit, boundaryBudget);
  assert.equal(payload.budget.used, text.length);
  assert.equal(payload.budget.truncated, false);
  assert.equal(text, JSON.stringify(payload));
  assert.notEqual(text, JSON.stringify(payload, null, 2));
});

test("mcp skill budgets bound every returned field at minimum, default, and maximum", () => {
  const { aiosPath } = setupAios();
  const skillDir = path.join(aiosPath, "skills", "verbose");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: verbose\ndescription: ${"bounded routing metadata ".repeat(200)}\ntriggers: bounded routing intent\n---\n# Verbose\n`
  );

  for (const requestedBudget of [256, undefined, 32000]) {
    const argumentsValue = { intent: "bounded routing intent", limit: 1 };
    if (requestedBudget !== undefined) argumentsValue.budget = requestedBudget;
    const [response] = runMcp(aiosPath, [{
      jsonrpc: "2.0",
      id: requestedBudget ?? "default",
      method: "tools/call",
      params: { name: "resolve_skill", arguments: argumentsValue },
    }]);
    const text = toolText(response);
    const payload = JSON.parse(text);
    const expectedBudget = requestedBudget ?? 6000;

    assert.ok(text.length <= expectedBudget);
    assert.equal(payload.budget.limit, expectedBudget);
    assert.equal(payload.budget.used, text.length);
    if (requestedBudget === 256) assert.equal(payload.budget.truncated, true);
  }
});

test("mcp response budgets remain exact for astral Unicode inputs", () => {
  const { aiosPath } = setupAios();
  const astral = "😀".repeat(434);
  const responses = runMcp(aiosPath, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_aios", arguments: { query: astral, scope: "context", budget: SEARCH_RESULT_BUDGET_FLOOR } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "resolve_skill", arguments: { intent: astral, budget: 256 } },
    },
  ]);

  for (const [response, expectedBudget] of responses.map((response, index) => [
    response,
    index === 0 ? SEARCH_RESULT_BUDGET_FLOOR : 256,
  ])) {
    assert.equal(response.error, undefined);
    const text = toolText(response);
    const payload = JSON.parse(text);
    assert.ok(text.length <= expectedBudget);
    assert.equal(payload.budget.limit, expectedBudget);
    assert.equal(payload.budget.used, text.length);
    assert.equal(payload.budget.truncated, expectedBudget === 256);
  }
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

test("MCP returns the same actionable migration state beside the unchanged bounded markdown", () => {
  const { aiosPath } = setupAios();
  const currentSnapshot = snapshotTree(aiosPath);
  const before = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 512 } },
  }]);
  const current = JSON.parse(toolText(before[0]));
  assert.equal(current.operational.migration.status, "current");
  assert.deepEqual(snapshotTree(aiosPath), currentSnapshot);

  const configPath = path.join(aiosPath, "aios.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.schema_version = "1.1.0";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const snapshot = snapshotTree(aiosPath);

  const after = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 512 } },
  }]);
  const stale = JSON.parse(toolText(after[0]));

  assert.equal(stale.markdown, current.markdown);
  assert.deepEqual(stale.budget, current.budget);
  assert.deepEqual(stale.operational.migration, {
    status: "schema_outdated",
    folder_schema_version: "1.1.0",
    supported_schema_version: "1.2.0",
    severity: "notice",
    action: { command: "dotaios migrate", path_scope: "configured_aios" }
  });
  assert.deepEqual(snapshotTree(aiosPath), snapshot);
  assert.doesNotMatch(JSON.stringify(stale.operational), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(workingContextMetadataText(stale).length <= 1024, "non-memory metadata must have a fixed bound");

  const migrationsRoot = path.join(aiosPath, ".dotaios", "migrations");
  fs.mkdirSync(path.join(migrationsRoot, "transactions", "migrate-1_1_0-to-1_2_0-0123456789abcdef"), { recursive: true });
  fs.writeFileSync(path.join(migrationsRoot, "owner.json"), `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`);
  const transactionSnapshot = snapshotTree(aiosPath);
  const [transactionResponse] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 512 } },
  }]);
  const transaction = JSON.parse(toolText(transactionResponse));
  assert.equal(transaction.operational.migration.status, "transaction_present");
  assert.doesNotMatch(JSON.stringify(transaction.operational), /migrate-1_1_0|recover/);
  assert.deepEqual(snapshotTree(aiosPath), transactionSnapshot);

  fs.writeFileSync(configPath, '{"schema_version":"invalid"}\n');
  const failedSnapshot = snapshotTree(aiosPath);
  const [failedResponse] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 512 } },
  }]);
  const failed = JSON.parse(toolText(failedResponse));
  assert.deepEqual(failed.operational.migration, {
    status: "inspection_failed",
    code: "INVALID_SCHEMA",
    severity: "warning",
    action: { command: "dotaios doctor", path_scope: "configured_aios" }
  });
  assert.equal(failed.markdown, current.markdown);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(snapshotTree(aiosPath), failedSnapshot);
});

test("read_working_context is byte-read-only on corrupt signals and emits no machine path", () => {
  const { aiosPath } = setupAios();
  const today = localDate();
  const signalPath = path.join(aiosPath, "memory", "signals", `${today}.jsonl`);
  fs.mkdirSync(path.dirname(signalPath), { recursive: true });
  fs.writeFileSync(
    signalPath,
    `{not-json}\n${JSON.stringify({ ts: `${today}T12:00:00.000Z`, summary: "CORRUPT_FIXTURE_SELECTED" })}\n`
  );
  const before = snapshotTree(aiosPath);

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 6000 } },
  }]);

  assert.equal(result.status, 0);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.match(JSON.parse(toolText(response)).markdown, /CORRUPT_FIXTURE_SELECTED/);
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.equal(fs.existsSync(`${signalPath}.bad.jsonl`), false);
  assert.doesNotMatch(result.stderr, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("search_aios is byte-read-only on corrupt JSONL and emits no machine path", () => {
  const { aiosPath } = setupAios();
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    `{not-json}\n${JSON.stringify({
      ts: "2026-08-10T10:00:00.000Z",
      type: "note",
      summary: "CORRUPT_SEARCH_FIXTURE_SELECTED"
    })}\n`
  );
  const before = snapshotTree(aiosPath);

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "CORRUPT_SEARCH_FIXTURE_SELECTED", scope: "memory" }
    },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(result.status, 0);
  assert.match(toolText(response), /CORRUPT_SEARCH_FIXTURE_SELECTED/);
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.equal(fs.existsSync(`${eventsPath}.bad.jsonl`), false);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("search_aios does not quarantine a corrupt session index", () => {
  const { aiosPath } = setupAios();
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  fs.writeFileSync(
    indexPath,
    `{not-json}\n${JSON.stringify({
      session_id: "safe-session",
      captured_at: "2026-08-10T10:00:00.000Z",
      title: "CORRUPT_SESSION_INDEX_SELECTED",
      agent: "codex",
      turns: 1,
      path: "memory/sessions/2026-08-10/safe-session.md"
    })}\n`
  );
  const before = snapshotTree(aiosPath);

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "CORRUPT_SESSION_INDEX_SELECTED", scope: "sessions" }
    },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(result.status, 0);
  assert.match(toolText(response), /CORRUPT_SESSION_INDEX_SELECTED/);
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.equal(fs.existsSync(`${indexPath}.bad.jsonl`), false);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("search_aios fails closed on linked evidence without exposing a path", () => {
  for (const targetKind of ["inside", "outside"]) {
    const { aiosPath, tempRoot } = setupAios();
    const targetPath = targetKind === "inside"
      ? path.join(aiosPath, "context", "work.md")
      : path.join(tempRoot, "outside.md");
    if (targetKind === "outside") {
      fs.writeFileSync(targetPath, "# Outside\n\nLINKED_SEARCH_CANARY\n");
    } else {
      fs.appendFileSync(targetPath, "\nLINKED_SEARCH_CANARY\n");
    }
    fs.symlinkSync(targetPath, path.join(aiosPath, "context", "linked.md"));

    const result = runMcpResult(aiosPath, [{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_aios",
        arguments: { query: "LINKED_SEARCH_CANARY", scope: "context" }
      },
    }]);
    const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

    assert.equal(response.error.code, -32603, `${targetKind} link must fail closed`);
    assert.equal(response.error.message, "DotAIOS request failed safely.");
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  }
});

test("search_aios returns an incomplete successful envelope for a per-file ceiling", () => {
  const { aiosPath } = setupAios();
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  // Sized from the shipped limit, not a copy of it. Hardcoding 1 MiB meant this
  // stopped testing anything the moment the per-file bound moved.
  fs.writeFileSync(eventsPath, Buffer.alloc(DEFAULT_EVIDENCE_READ_LIMITS.maxFileBytes + 1, 0x61));
  const before = snapshotTree(aiosPath);

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "missing", scope: "memory" }
    },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, false);
  const payload = JSON.parse(toolText(response));
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.results, []);
  assert.equal(payload.omissions[0].scope, "memory");
  assert.equal(payload.omissions[0].reason, "file_too_large");
  assert.equal(payload.budget.truncated, false);
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("search_aios succeeds at its advertised budget floor with one complete omission", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(
    path.join(aiosPath, "memory", "events.jsonl"),
    Buffer.alloc(DEFAULT_EVIDENCE_READ_LIMITS.maxFileBytes + 1, 0x61),
  );

  const [listed] = runMcp(aiosPath, [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  ]);
  const budgetSchema = listed.result.tools
    .find((tool) => tool.name === "search_aios")
    .inputSchema.properties.budget;
  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "missing", scope: "memory", budget: budgetSchema.minimum },
    },
  }]);

  assert.equal(budgetSchema.minimum, SEARCH_RESULT_BUDGET_FLOOR);
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, false);
  const text = toolText(response);
  const payload = JSON.parse(text);
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.results, []);
  assert.deepEqual(Object.keys(payload.omissions[0]), [
    "scope",
    "reason",
    "observed",
    "inspection",
    "recovery",
  ]);
  assert.equal(payload.omissions[0].reason, "file_too_large");
  assert.equal(payload.omissions[0].recovery.code, "split_or_move_file");
  assert.match(payload.omissions[0].recovery.message, /split|move/i);
  assert.equal(payload.budget.limit, budgetSchema.minimum);
  assert.equal(payload.budget.used, text.length);
  assert.ok(text.length <= budgetSchema.minimum);
});

test("search_aios fits its maximum selectable omission set at the exact budget floor", () => {
  const { aiosPath } = setupAios();
  const projectSlug = "ceiling-project";
  const projectPath = path.join(aiosPath, "projects", projectSlug);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "README.md"),
    `---\nid: ceiling-project-id\nproject: ${projectSlug}\n---\n# Ceiling project\n`,
  );
  for (const filePath of [
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    path.join(aiosPath, "context", "oversized.md"),
    path.join(aiosPath, "memory", "events.jsonl"),
    path.join(aiosPath, "vault", "oversized.md"),
    path.join(projectPath, "oversized.md"),
    path.join(aiosPath, "decisions", "oversized.md"),
    path.join(aiosPath, "skills", "oversized", "SKILL.md"),
    path.join(aiosPath, "references", "oversized.md"),
    path.join(aiosPath, "plugins", "oversized", "manifest.json"),
  ]) {
    writeOversizedEvidenceFile(filePath);
  }

  const responses = runMcp(aiosPath, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_aios",
        arguments: {
          query: "missing",
          scope: "all",
          project: projectSlug,
          budget: SEARCH_RESULT_BUDGET_FLOOR - 1,
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_aios",
        arguments: {
          query: "missing",
          scope: "all",
          project: projectSlug,
          budget: SEARCH_RESULT_BUDGET_FLOOR,
        },
      },
    },
  ]);

  assert.equal(responses[0].error.code, -32602);
  assert.match(responses[0].error.message, new RegExp(`${SEARCH_RESULT_BUDGET_FLOOR} to 32000`));
  assert.equal(responses[1].error, undefined);
  assert.equal(responses[1].result.isError, false);
  const text = toolText(responses[1]);
  const payload = JSON.parse(text);
  assert.equal(payload.complete, false);
  assert.deepEqual(payload.results, []);
  assert.deepEqual(
    payload.omissions.map((omission) => omission.scope),
    ["sessions", "context", "memory", "vault", "projects", "decisions", "skills", "references", "plugins"],
  );
  assert.equal(payload.omissions.length, 9);
  for (const omission of payload.omissions) {
    assert.equal(omission.reason, "file_too_large");
    assert.deepEqual(Object.keys(omission.observed), ["files", "bytes", "entries"]);
    assert.equal(omission.inspection, "not_searched");
    assert.equal(omission.recovery.code, "split_or_move_file");
    assert.match(omission.recovery.message, /split|move/i);
  }
  assert.equal(payload.budget.limit, SEARCH_RESULT_BUDGET_FLOOR);
  assert.equal(payload.budget.used, text.length);
  assert.ok(text.length <= SEARCH_RESULT_BUDGET_FLOOR);
  assert.doesNotMatch(JSON.stringify(payload.omissions), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("search_aios keeps completion metadata when result transport truncates", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(
    path.join(aiosPath, "memory", "events.jsonl"),
    Buffer.alloc(DEFAULT_EVIDENCE_READ_LIMITS.maxFileBytes + 1, 0x61)
  );
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(
      path.join(aiosPath, "context", `partial-${index}.md`),
      `# Work ${index}\n\n${"MCP_PARTIAL_TRANSPORT_CANARY ".repeat(100)}\n`,
    );
  }

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "MCP_PARTIAL_TRANSPORT_CANARY", scope: "all", budget: SEARCH_RESULT_BUDGET_FLOOR }
    }
  }]);
  const payload = JSON.parse(toolText(response));

  assert.equal(response.result.isError, false);
  assert.equal(payload.complete, false);
  assert.equal(payload.budget.truncated, true);
  assert.equal(payload.omissions[0].scope, "memory");
  assert.equal(payload.omissions[0].reason, "file_too_large");
});

test("search_aios rejects a session index path that escapes the AIOS root", () => {
  const { aiosPath, tempRoot } = setupAios();
  const outsidePath = path.join(tempRoot, "outside-session.md");
  fs.writeFileSync(outsidePath, "# Outside\n\nSESSION_TRAVERSAL_CANARY\n");
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${JSON.stringify({
      session_id: "unsafe-session",
      captured_at: "2026-08-10T10:00:00.000Z",
      title: "Unrelated title",
      agent: "codex",
      turns: 1,
      path: "../outside-session.md"
    })}\n`
  );

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "SESSION_TRAVERSAL_CANARY", scope: "sessions" }
    },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "DotAIOS request failed safely.");
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("search_aios rejects an absolute session path even when index metadata matches", () => {
  const { aiosPath, tempRoot } = setupAios();
  const outsidePath = path.join(tempRoot, "absolute-session.md");
  fs.writeFileSync(outsidePath, "# Outside\n");
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${JSON.stringify({
      session_id: "absolute-session",
      captured_at: "2026-08-10T10:00:00.000Z",
      title: "ABSOLUTE_SESSION_PATH_CANARY",
      agent: "codex",
      turns: 1,
      path: outsidePath
    })}\n`
  );

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "ABSOLUTE_SESSION_PATH_CANARY", scope: "sessions" }
    },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "DotAIOS request failed safely.");
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("search_aios rejects a session path that leaves the sessions corpus", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "context", "identity.md"), "# Identity\n\nCROSS_SCOPE_SESSION_CANARY\n");
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${JSON.stringify({
      session_id: "cross-scope-session",
      captured_at: "2026-08-10T10:00:00.000Z",
      title: "Unrelated title",
      agent: "codex",
      turns: 1,
      path: "context/identity.md"
    })}\n`
  );

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "CROSS_SCOPE_SESSION_CANARY", scope: "sessions" }
    },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "DotAIOS request failed safely.");
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("search_aios contains and bounds its authority config", () => {
  for (const variant of ["linked", "invalid-utf8", "oversized"]) {
    const { aiosPath, tempRoot } = setupAios();
    const configPath = path.join(aiosPath, "aios.json");
    if (variant === "linked") {
      const outsideConfig = path.join(tempRoot, "outside-aios.json");
      fs.writeFileSync(outsideConfig, '{"schema_version":"1.2.0"}\n');
      fs.unlinkSync(configPath);
      fs.symlinkSync(outsideConfig, configPath);
    } else if (variant === "invalid-utf8") {
      fs.writeFileSync(configPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
    } else {
      fs.writeFileSync(configPath, `${JSON.stringify({ schema_version: "1.2.0", padding: "x".repeat(1024 * 1024) })}\n`);
    }
    const before = fs.readFileSync(configPath);

    const result = runMcpResult(aiosPath, [{
      jsonrpc: "2.0",
      id: variant,
      method: "tools/call",
      params: { name: "search_aios", arguments: { query: "missing", scope: "memory" } },
    }]);
    const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

    assert.equal(response.error.code, -32603, variant);
    assert.equal(response.error.message, "DotAIOS request failed safely.", variant);
    assert.deepEqual(fs.readFileSync(configPath), before, variant);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      variant
    );
  }
});

test("search_aios authorizes a contained configured external vault", () => {
  const { aiosPath, tempRoot } = setupAios();
  const vaultPath = path.join(tempRoot, "external-vault");
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "note.md"), "# External\n\nMCP_EXTERNAL_VAULT_CANARY\n");
  const configPath = path.join(aiosPath, "aios.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, vault_path: vaultPath }, null, 2)}\n`);

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_aios",
      arguments: { query: "MCP_EXTERNAL_VAULT_CANARY", scope: "vault" }
    },
  }]);
  const payload = JSON.parse(toolText(response));

  assert.equal(payload.results[0].scope, "vault");
  assert.equal(payload.results[0].file, "note.md");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("resolve_skill skips linked top-level skills and keeps real siblings routable", () => {
  const { aiosPath, tempRoot } = setupAios();
  const outsideSkill = path.join(tempRoot, "linked-skill");
  fs.mkdirSync(outsideSkill);
  fs.writeFileSync(
    path.join(outsideSkill, "SKILL.md"),
    "---\nname: linked-skill\ndescription: ZZZXQ_9471\ntriggers: ZZZXQ_9471\n---\n"
  );
  fs.symlinkSync(outsideSkill, path.join(aiosPath, "skills", "linked-skill"), "dir");

  const responses = runMcp(aiosPath, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolve_skill",
        arguments: { intent: "ZZZXQ_9471" }
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "resolve_skill",
        arguments: { intent: "plan my day" }
      },
    },
  ]);
  const linked = JSON.parse(toolText(responses[0]));
  const real = JSON.parse(toolText(responses[1]));

  assert.deepEqual(linked.matches, []);
  assert.equal(real.matches[0].name, "plan-today");
  assert.doesNotMatch(JSON.stringify(linked.matches), /ZZZXQ_9471|linked-skill/);
  assert.doesNotMatch(JSON.stringify(responses), /linked-skill/);
  assert.doesNotMatch(JSON.stringify(responses), new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("resolve_skill bounds the complete serialized response", () => {
  const { aiosPath } = setupAios();
  const intent = `plan my day ${"context ".repeat(60)}`.slice(0, 500);
  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "resolve_skill",
      arguments: { intent, limit: 10, budget: 256 }
    },
  }]);

  const text = toolText(response);
  const payload = JSON.parse(text);
  assert.ok(text.length <= 256);
  assert.equal(payload.budget.limit, 256);
  assert.equal(payload.budget.used, text.length);
  assert.equal(payload.budget.truncated, true);
});

test("resolve_skill preserves complete trigger metadata when the response budget allows it", () => {
  const { aiosPath } = setupAios();
  const skillDir = path.join(aiosPath, "skills", "many-triggers");
  const triggers = Array.from({ length: 7 }, (_, index) => `routing phrase ${index + 1}`);
  fs.mkdirSync(skillDir);
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: many-triggers",
      "description: Route MANY_TRIGGER_CANARY.",
      "triggers:",
      ...triggers.map((trigger) => `  - ${trigger}`),
      "---",
      "# Many triggers",
      ""
    ].join("\n")
  );

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "resolve_skill",
      arguments: { intent: "MANY_TRIGGER_CANARY", budget: 32000 }
    },
  }]);
  const payload = JSON.parse(toolText(response));

  assert.deepEqual(payload.matches[0].triggers, triggers);
  assert.equal(payload.budget.truncated, false);
});

test("resolve_skill reads bounded frontmatter without loading a large skill body", () => {
  const { aiosPath } = setupAios();
  const skillDir = path.join(aiosPath, "skills", "metadata-only");
  fs.mkdirSync(skillDir);
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: metadata-only\ndescription: Route METADATA_ONLY_CANARY.\ntriggers: METADATA_ONLY_CANARY\n---\n\n${"body ".repeat(400_000)}`
  );

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "resolve_skill",
      arguments: { intent: "METADATA_ONLY_CANARY" }
    },
  }]);
  const payload = JSON.parse(toolText(response));

  assert.equal(payload.matches[0].name, "metadata-only");
  assert.equal(payload.matches[0].resource, "skills/metadata-only/SKILL.md");
});

test("read_working_context rejects oversized project filters before they inflate output", () => {
  const { aiosPath } = setupAios();
  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { project: "x".repeat(201), budget: 256 } },
  }]);

  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /project.*at most 200/i);
  assert.ok(JSON.stringify(response).length < 512);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("read_working_context rejects present non-string project filters", () => {
  const { aiosPath } = setupAios();
  const invalidValues = [42, true, null, {}, []];
  const responses = runMcp(aiosPath, invalidValues.map((project, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { project, budget: 256 } },
  })));

  for (const response of responses) {
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /project must be a non-empty string/i);
    assert.equal(response.result, undefined);
  }
});

test("read_working_context rejects non-object and unknown arguments instead of widening scope", () => {
  const { aiosPath } = setupAios();
  const invalidArguments = [
    42,
    true,
    "demo",
    [],
    null,
    { projet: "demo" },
    { project: "demo", extra: true },
    { ["x".repeat(100_000)]: true }
  ];
  const responses = runMcp(aiosPath, invalidArguments.map((argumentsValue, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: argumentsValue },
  })));

  for (const response of responses) {
    assert.equal(response.error.code, -32602);
    assert.equal(response.result, undefined);
    assert.ok(JSON.stringify(response).length < 512);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("MCP integer arguments reject schema-invalid coercions", () => {
  const { aiosPath } = setupAios();
  const invalidArguments = [
    { limit: "3", budget: 256 },
    { limit: true, budget: 256 },
    { limit: 3, budget: "256" },
    { limit: [], budget: 256 }
  ];
  const responses = runMcp(aiosPath, invalidArguments.map((argumentsValue, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: argumentsValue },
  })));

  for (const response of responses) {
    assert.equal(response.error.code, -32602);
    assert.equal(response.result, undefined);
  }
});

test("read_working_context reports an ambiguous project selector as a safe input error", () => {
  const { aiosPath } = setupAios();
  for (const [slug, id] of [["alpha", "id-alpha"], ["beta", "id-beta"]]) {
    const projectDir = path.join(aiosPath, "projects", slug);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "README.md"),
      `---\nid: ${id}\nproject: shared\n---\n# ${slug}\n`,
    );
  }

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { project: "shared", budget: 256 } },
  }]);

  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /ambiguous.*stable id/i);
  assert.doesNotMatch(response.error.message, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("read_working_context preserves opaque stable project identifiers", () => {
  const { aiosPath } = setupAios();
  const projectDir = path.join(aiosPath, "projects", "client-work");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "README.md"),
    "---\nid: café:client/01\nproject: client-work\n---\n# Client Work\n",
  );

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "read_working_context",
      arguments: { project: "café:client/01", budget: 512 }
    },
  }]);
  const payload = JSON.parse(toolText(response));

  assert.equal(payload.scope.project, "client-work");
  assert.match(payload.markdown, /Client Work/);
});

test("maximum project input and operational metadata stay inside the fixed metadata bound", () => {
  const { aiosPath } = setupAios();
  for (const project of ["x".repeat(200), "🚀".repeat(200)]) {
    const [response] = runMcp(aiosPath, [{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_working_context", arguments: { project, budget: 256 } },
    }]);
    const text = toolText(response);
    const payload = JSON.parse(text);

    assert.equal(Array.from(payload.scope.project).length, 200);
    assert.ok(payload.markdown.length <= 256);
    assert.ok(workingContextMetadataText(payload).length <= 1024);
  }
});

test("project input rejects 201 Unicode code points", () => {
  const { aiosPath } = setupAios();
  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "read_working_context",
      arguments: { project: "🚀".repeat(201), budget: 256 }
    },
  }]);

  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /project.*at most 200/i);
});

test("working-context budgets survive JSON escaping at minimum, default, and maximum sizes", () => {
  const { aiosPath } = setupAios();
  const date = localDate();
  const noisy = '"\\';
  fs.writeFileSync(
    path.join(aiosPath, "context", "identity.md"),
    `# Identity\n\n${'"\\\n'.repeat(12000)}`
  );
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${Array.from({ length: 3 }, (_, index) => JSON.stringify({
      captured_at: `${date}T12:0${index}:00.000Z`,
      agent: "test",
      session_id: `session-${index}`,
      title: noisy.repeat(3500),
      turns: 1
    })).join("\n")}\n`
  );
  fs.writeFileSync(
    path.join(aiosPath, "memory", "signals", `${date}.jsonl`),
    `${Array.from({ length: 8 }, (_, index) => JSON.stringify({
      ts: `${date}T13:0${index}:00.000Z`,
      summary: noisy.repeat(350)
    })).join("\n")}\n`
  );
  fs.writeFileSync(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${Array.from({ length: 8 }, (_, index) => JSON.stringify({
      ts: `${date}T14:0${index}:00.000Z`,
      summary: noisy.repeat(350)
    })).join("\n")}\n`
  );

  let representationExceededOperationalBound = false;
  for (const budget of [256, 6000, 32000]) {
    const [response] = runMcp(aiosPath, [{
      jsonrpc: "2.0",
      id: budget,
      method: "tools/call",
      params: { name: "read_working_context", arguments: { budget } },
    }]);
    const text = toolText(response);
    const payload = JSON.parse(text);
    assert.ok(payload.markdown.length <= budget);
    if (budget >= 6000) {
      assert.ok(
        payload.markdown.length >= budget * 0.8,
        `expected an escaping-heavy near-budget projection at ${budget}, received ${payload.markdown.length}`
      );
    }
    assert.ok(workingContextMetadataText(payload).length <= 1024);
    if (text.length > payload.markdown.length + 1024) {
      representationExceededOperationalBound = true;
    }
  }
  assert.equal(
    representationExceededOperationalBound,
    true,
    "JSON escaping is representation cost and must not be mistaken for operational metadata"
  );
});

test("control characters are rejected as project input errors, not internal envelope failures", () => {
  const { aiosPath } = setupAios();
  const responses = runMcp(aiosPath, ["x\u0000y", "alpha\n", "alpha\u007f", "alpha\u0085"].map(
    (project, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name: "read_working_context", arguments: { project, budget: 256 } },
    })
  ));

  for (const response of responses) {
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /project slug or stable id|control/i);
  }
});

test("internal projection failures return one path-free MCP error", () => {
  const { aiosPath } = setupAios();
  const projectDir = path.join(aiosPath, "projects", "broken");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "---\nid: [unterminated\n---\n# Broken\n");

  const result = runMcpResult(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: {} },
  }]);
  const [response] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "DotAIOS could not read working context safely.");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("oversized projection sources return one path-free read error without mutation", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(
    path.join(aiosPath, "context", "identity.md"),
    Buffer.alloc(1024 * 1024 + 1, 0x61)
  );
  const before = snapshotTree(aiosPath);

  const [response] = runMcp(aiosPath, [{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "read_working_context", arguments: { budget: 256 } },
  }]);

  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, "DotAIOS could not read working context safely.");
  assert.doesNotMatch(JSON.stringify(response), new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(snapshotTree(aiosPath), before);
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

function writeOversizedEvidenceFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "w");
  try {
    fs.ftruncateSync(descriptor, DEFAULT_EVIDENCE_READ_LIMITS.maxFileBytes + 1);
  } finally {
    fs.closeSync(descriptor);
  }
}

function runMcp(aiosPath, messages) {
  const result = runMcpResult(aiosPath, messages);
  if (result.status !== 0) throw new Error(`mcp failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runMcpResult(aiosPath, messages) {
  return spawnSync(process.execPath, [server, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  });
}

function toolText(response) {
  return response.result.content[0].text;
}

function workingContextMetadataText(payload) {
  const { markdown: _markdown, ...metadata } = payload;
  return JSON.stringify(metadata, null, 2);
}

function localDate(value = new Date()) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}

function snapshotTree(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push([entry.name, "directory"]);
      for (const [nested, kind, bytes] of snapshotTree(absolute)) {
        result.push([path.posix.join(entry.name, nested), kind, bytes]);
      }
    } else {
      result.push([entry.name, "file", fs.readFileSync(absolute).toString("base64")]);
    }
  }
  return result;
}
