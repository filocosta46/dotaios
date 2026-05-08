import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const supportedAgents = new Set(["claude", "codex", "cursor", "gemini"]);

export async function mcpCommand(args) {
  if (hasHelpFlag(args)) {
    printMcpHelp();
    return;
  }

  const { command, options } = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await assertAiosFolder(target);

  if (command === "status") {
    await printStatus(target);
    return;
  }

  if (command === "install" || command === "config") {
    printInstall(target, options);
    return;
  }

  throw new Error(`Unknown mcp command: ${command}. Try \`dotaios mcp --help\`.`);
}

function printMcpHelp() {
  console.log(`Usage:
  dotaios mcp status [options]
  dotaios mcp install --dry-run --agent <agent> [options]
  dotaios mcp config --agent <agent> [options]

Options:
  --path <dir>      Use a non-default AIOS folder
  --agent <agent>   claude, codex, cursor, or gemini
  --dry-run         Preview install guidance without changing files
  --home <dir>      Use a non-default home path for target hints

DotAIOS does not mutate MCP client config automatically yet. This command prints the exact local stdio config to copy into a client.
`);
}

function parseOptions(args = []) {
  const options = { agent: "claude", dryRun: false, home: null, path: null };
  let command = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!command && !arg.startsWith("--")) {
      command = arg;
    } else if (arg === "--agent") {
      options.agent = readOptionValue(args, index, "--agent").toLowerCase();
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  command ||= "status";
  if (!supportedAgents.has(options.agent)) {
    throw new Error(`Invalid --agent: ${options.agent}. Use claude, codex, cursor, or gemini.`);
  }

  return { command, options };
}

async function assertAiosFolder(target) {
  try {
    await fs.access(path.join(target, "aios.json"));
  } catch {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
}

async function printStatus(target) {
  console.log("DotAIOS MCP status");
  console.log(`AIOS path: ${target}`);
  console.log(`[ok] MCP server: ${serverPath()}`);
  console.log("[info] Transport: stdio");
  console.log("[info] Tools: read_context, search_memory, search_vault, list_projects, log_event");
  console.log("[next] Run `dotaios mcp install --dry-run --agent claude` to print client config.");
}

function printInstall(target, options) {
  const homePath = path.resolve(expandHome(options.home || "~"));
  const config = mcpServerConfig(target);

  console.log(`DotAIOS MCP ${options.dryRun ? "dry run" : "config"}`);
  console.log(`Agent: ${options.agent}`);
  console.log(`AIOS path: ${target}`);
  console.log(`Suggested target: ${targetHint(options.agent, homePath)}`);
  console.log("");
  console.log("MCP server config:");
  console.log(JSON.stringify(config, null, 2));
  console.log("");
  console.log("DotAIOS does not edit MCP client config automatically yet.");
  console.log("Copy the config above into your MCP-capable client, then restart that client.");
}

function mcpServerConfig(target) {
  return {
    mcpServers: {
      dotaios: {
        command: process.execPath,
        args: [serverPath(), "--path", target]
      }
    }
  };
}

function serverPath() {
  return path.join(repoRoot, "packages", "mcp", "src", "server.mjs");
}

function targetHint(agent, homePath) {
  if (agent === "claude") return path.join(homePath, ".claude", "mcp.json");
  if (agent === "cursor") return path.join(homePath, ".cursor", "mcp.json");
  if (agent === "gemini") return path.join(homePath, ".gemini", "mcp.json");
  return path.join(homePath, ".codex", "mcp.json");
}
