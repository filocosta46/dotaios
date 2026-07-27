import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  mcpClientConfig,
  supportedMcpAgents
} from "../../packages/cli/src/commands/mcp.mjs";

const homePath = path.resolve("/tmp/dotaios-mcp-home");
const aiosPath = path.resolve("/tmp/dotaios-mcp-home/aios");
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("MCP configuration uses each client's documented user config path", () => {
  const expected = new Map([
    ["claude", path.join(homePath, ".claude.json")],
    ["codex", path.join(homePath, ".codex", "config.toml")],
    ["cursor", path.join(homePath, ".cursor", "mcp.json")],
    ["gemini", path.join(homePath, ".gemini", "settings.json")],
    ["antigravity", path.join(homePath, ".gemini", "config", "mcp_config.json")],
    ["kimi", path.join(homePath, ".kimi-code", "mcp.json")]
  ]);

  assert.deepEqual([...supportedMcpAgents], [...expected.keys()]);
  for (const [agent, target] of expected) {
    assert.equal(mcpClientConfig(agent, aiosPath, homePath).target, target);
  }
});

test("Codex receives a TOML mcp_servers fragment", () => {
  const config = mcpClientConfig("codex", aiosPath, homePath);

  assert.equal(config.format, "TOML");
  assert.match(config.text, /^\[mcp_servers\.dotaios\]/m);
  assert.match(config.text, /^command = /m);
  assert.match(config.text, /^args = \[/m);
  assert.doesNotMatch(config.text, /"mcpServers"/);
});

test("JSON clients receive an mcpServers object", () => {
  for (const agent of ["claude", "cursor", "gemini", "antigravity", "kimi"]) {
    const config = mcpClientConfig(agent, aiosPath, homePath);
    const parsed = JSON.parse(config.text);

    assert.equal(config.format, "JSON");
    assert.equal(parsed.mcpServers.dotaios.command, process.execPath);
    assert.deepEqual(
      parsed.mcpServers.dotaios.args.slice(-2),
      ["--path", aiosPath]
    );
  }
});

test("unknown MCP clients fail closed", () => {
  assert.throws(
    () => mcpClientConfig("zai", aiosPath, homePath),
    /Unsupported MCP agent/
  );
});

test("MCP CLI prints a merge-safe Codex TOML fragment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-mcp-cli-"));
  const localAiosPath = path.join(root, "aios");
  const localHomePath = path.join(root, "home");
  fs.mkdirSync(localAiosPath, { recursive: true });
  fs.writeFileSync(path.join(localAiosPath, "aios.json"), "{}\n");

  try {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "mcp",
        "config",
        "--agent",
        "codex",
        "--path",
        localAiosPath,
        "--home",
        localHomePath
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Suggested target: .*\.codex\/config\.toml/);
    assert.match(result.stdout, /Format: TOML/);
    assert.match(result.stdout, /\[mcp_servers\.dotaios\]/);
    assert.match(result.stdout, /Merge the fragment/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
