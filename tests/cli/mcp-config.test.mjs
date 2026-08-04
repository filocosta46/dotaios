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
import { DOTAIOS_PACKAGE_VERSION } from "../../packages/cli/src/lib/mcp-launcher.mjs";

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
    ["kimi", path.join(homePath, ".kimi-code", "mcp.json")],
    ["opencode", path.join(homePath, ".config", "opencode", "opencode.json")]
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
    assert.equal(parsed.mcpServers.dotaios.command, "npx");
    assert.deepEqual(parsed.mcpServers.dotaios.args, [
      "--yes",
      "--package",
      `dotaios@${DOTAIOS_PACKAGE_VERSION}`,
      "dotaios-mcp",
      "--path",
      aiosPath
    ]);
    assert.doesNotMatch(config.text, /packages[\\/]mcp[\\/]src[\\/]server\.mjs|_npx/);
  }
});

test("OpenCode receives its documented mcp.dotaios object", () => {
  const config = mcpClientConfig("opencode", aiosPath, homePath);
  const parsed = JSON.parse(config.text);

  assert.equal(parsed.mcp.dotaios.type, "local");
  assert.deepEqual(parsed.mcp.dotaios.command, [
    "npx",
    "--yes",
    "--package",
    `dotaios@${DOTAIOS_PACKAGE_VERSION}`,
    "dotaios-mcp",
    "--path",
    aiosPath
  ]);
  assert.equal(parsed.mcp.dotaios.enabled, true);
  assert.doesNotMatch(config.text, /packages[\\/]mcp[\\/]src[\\/]server\.mjs|_npx/);
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

test("MCP CLI prints valid JSON fragments for every JSON client", () => {
  const expectedTargets = new Map([
    ["claude", path.join(".claude.json")],
    ["cursor", path.join(".cursor", "mcp.json")],
    ["gemini", path.join(".gemini", "settings.json")],
    ["antigravity", path.join(".gemini", "config", "mcp_config.json")],
    ["kimi", path.join(".kimi-code", "mcp.json")]
  ]);

  for (const [agent, targetSuffix] of expectedTargets) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-mcp-${agent}-`));
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
          agent,
          "--path",
          localAiosPath,
          "--home",
          localHomePath
        ],
        { cwd: repoRoot, encoding: "utf8" }
      );

      assert.equal(result.status, 0, `${agent}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Suggested target: .*${targetSuffix.replaceAll("\\", "\\\\").replaceAll("/", "\\/")}`));
      assert.match(result.stdout, /Format: JSON/);

      const fragment = result.stdout
        .split("MCP server config fragment:\n")[1]
        .split("\n\nDotAIOS does not edit MCP client config automatically yet.")[0];
      const parsed = JSON.parse(fragment);
      assert.equal(parsed.mcpServers.dotaios.command, "npx");
      assert.deepEqual(parsed.mcpServers.dotaios.args.slice(-2), ["--path", localAiosPath]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("MCP CLI prints a mergeable OpenCode fragment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-mcp-opencode-"));
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
        "opencode",
        "--path",
        localAiosPath,
        "--home",
        localHomePath
      ],
      { cwd: repoRoot, encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const fragment = result.stdout
      .split("MCP server config fragment:\n")[1]
      .split("\n\nDotAIOS does not edit MCP client config automatically yet.")[0];
    const parsed = JSON.parse(fragment);
    assert.equal(parsed.mcp.dotaios.command[0], "npx");
    assert.deepEqual(parsed.mcp.dotaios.command.slice(-2), ["--path", localAiosPath]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
