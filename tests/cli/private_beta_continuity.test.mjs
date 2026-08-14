import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const mcp = path.join(repoRoot, "packages", "mcp", "src", "server.mjs");

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function project(aiosPath, slug, id) {
  const directory = path.join(aiosPath, "projects", slug);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "README.md"), [
    "---",
    `id: ${id}`,
    `project: ${slug}`,
    "status: active",
    "---",
    `# ${slug}`,
    "",
    `${slug.toUpperCase()}_PROJECT_README_CANARY`,
    "",
  ].join("\n"));
}

function callMcp(aiosPath, name, args) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = spawnSync(process.execPath, [mcp, "--path", aiosPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: `${request}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return JSON.parse(response.result.content[0].text);
}

test("private-beta continuity works across save, strict project, Off, MCP, and secret boundaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-private-beta-"));
  const aiosPath = path.join(root, "aios");
  const missingPrivatePath = path.join(root, "private-must-not-open");
  try {
    run(["init", "--yes", "--path", aiosPath]);
    fs.writeFileSync(
      path.join(aiosPath, "context", "identity.md"),
      "# Identity\n\nSHARED_PERSONAL_IDENTITY_CANARY\n"
    );
    project(aiosPath, "alpha", "project-alpha-001");
    project(aiosPath, "beta", "project-beta-002");

    run(["update", "SHARED_SAVE_CANARY", "--path", aiosPath]);
    const shared = run(["search", "SHARED_SAVE_CANARY", "--scope", "memory", "--path", aiosPath]);
    assert.match(shared, /^Memory: Shared/m);
    assert.match(shared, /1 result\(s\) found/);
    assert.match(shared, /source: dotaios update/);

    run(["update", "ALPHA_EXPLICIT_MEMORY_CANARY", "--memory", "project", "--project", "alpha", "--path", aiosPath]);
    run(["update", "BETA_EXPLICIT_MEMORY_CANARY", "--memory", "project", "--project", "beta", "--path", aiosPath]);
    const alpha = run(["search", "MEMORY_CANARY", "--project", "alpha", "--path", aiosPath]);
    assert.match(alpha, /^Memory: This project/m);
    assert.match(alpha, /ALPHA_EXPLICIT_.*MEMORY_CANARY/);
    assert.doesNotMatch(alpha, /BETA_EXPLICIT_MEMORY_CANARY|SHARED_SAVE_CANARY|SHARED_PERSONAL_IDENTITY_CANARY/);
    const alphaBrief = run(["brief", "--compact", "--project", "alpha", "--path", aiosPath]);
    assert.match(alphaBrief, /^Memory: This project/m);
    assert.match(alphaBrief, /ALPHA_PROJECT_README_CANARY/);
    assert.doesNotMatch(alphaBrief, /BETA_PROJECT_README_CANARY|SHARED_PERSONAL_IDENTITY_CANARY/);

    const privateSearch = run(["search", "anything", "--memory", "off", "--path", missingPrivatePath]);
    assert.match(privateSearch, /^Memory: Off/m);
    assert.match(privateSearch, /AI app may still keep its own conversation history/i);
    assert.equal(fs.existsSync(missingPrivatePath), false);

    const secret = "SECRET_LEAK_CANARY_9D31";
    fs.writeFileSync(path.join(aiosPath, ".env"), `PRIVATE_API_KEY=${secret}\n`, { mode: 0o600 });
    const secretSearch = run(["search", "LEAK_CANARY", "--path", aiosPath]);
    assert.doesNotMatch(secretSearch, new RegExp(secret));
    assert.doesNotMatch(run(["brief", "--compact", "--path", aiosPath]), new RegExp(secret));
    const mcpSearch = callMcp(aiosPath, "search_aios", { query: "LEAK_CANARY" });
    assert.equal(mcpSearch.memory, "shared");
    assert.equal(mcpSearch.receipt, "Memory: Shared");
    assert.doesNotMatch(JSON.stringify(mcpSearch), new RegExp(secret));
    assert.doesNotMatch(
      fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8"),
      new RegExp(secret)
    );
    assert.match(fs.readFileSync(path.join(aiosPath, ".gitignore"), "utf8"), /^\.env$/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
