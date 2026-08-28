import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { mcpLauncher } from "../lib/mcp-launcher.mjs";

export const supportedMcpAgents = new Set([
  "claude",
  "codex",
  "cursor",
  "gemini",
  "antigravity",
  "kimi",
  "opencode"
]);

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
  --agent <agent>   claude, codex, cursor, gemini, antigravity, kimi, or opencode
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
  if (!supportedMcpAgents.has(options.agent)) {
    throw new Error(
      `Invalid --agent: ${options.agent}. Use ${[...supportedMcpAgents].join(", ")}.`
    );
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
  console.log("DotAIOS optional MCP adapter");
  console.log(`AIOS path: ${target}`);
  console.log("[ok] MCP server launcher: version-pinned npx package");
  console.log("[info] Transport: stdio");
  console.log("[info] Read-only tools: read_working_context, search_aios, resolve_skill");
  console.log("[next] Run `dotaios mcp install --dry-run --agent claude` to print client config.");
}

function printInstall(target, options) {
  const homePath = path.resolve(expandHome(options.home || "~"));
  const config = mcpClientConfig(options.agent, target, homePath);

  console.log(`DotAIOS MCP ${options.dryRun ? "dry run" : "config"}`);
  console.log(`Agent: ${options.agent}`);
  console.log(`AIOS path: ${target}`);
  console.log(`Suggested target: ${config.target}`);
  console.log(`Format: ${config.format}`);
  console.log("");
  console.log("MCP server config fragment:");
  console.log(config.text);
  console.log("");
  console.log("DotAIOS does not edit MCP client config automatically yet.");
  console.log("Merge the fragment into the existing client config, then restart that client.");
}

function mcpServerConfig(target, options) {
  const launcher = mcpLauncher(target, undefined, options);
  return {
    mcpServers: {
      dotaios: {
        command: launcher.command,
        args: launcher.args
      }
    }
  };
}

export function mcpClientConfig(agent, target, homePath, options = {}) {
  if (!supportedMcpAgents.has(agent)) {
    throw new Error(`Unsupported MCP agent: ${agent}`);
  }

  const targets = {
    claude: path.join(homePath, ".claude.json"),
    codex: path.join(homePath, ".codex", "config.toml"),
    cursor: path.join(homePath, ".cursor", "mcp.json"),
    gemini: path.join(homePath, ".gemini", "settings.json"),
    antigravity: path.join(homePath, ".gemini", "config", "mcp_config.json"),
    kimi: path.join(homePath, ".kimi-code", "mcp.json"),
    opencode: path.join(homePath, ".config", "opencode", "opencode.json")
  };

  if (agent === "codex") {
    const server = mcpServerConfig(target, options).mcpServers.dotaios;
    return {
      target: targets[agent],
      format: "TOML",
      text: [
        "[mcp_servers.dotaios]",
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`
      ].join("\n")
    };
  }

  if (agent === "opencode") {
    const server = mcpServerConfig(target, options).mcpServers.dotaios;
    return {
      target: targets[agent],
      format: "JSON",
      text: JSON.stringify({
        mcp: {
          dotaios: {
            type: "local",
            command: [server.command, ...server.args],
            enabled: true
          }
        }
      }, null, 2)
    };
  }

  return {
    target: targets[agent],
    format: "JSON",
    text: JSON.stringify(mcpServerConfig(target, options), null, 2)
  };
}
