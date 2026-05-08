#!/usr/bin/env node

const VERSION = "1.2.2";

const commands = {
  activate: "./commands/activate.mjs",
  attach: "./commands/activate.mjs",
  cleanup: "./commands/cleanup.mjs",
  connect: "./commands/connect.mjs",
  context: "./commands/context.mjs",
  google: "./commands/google.mjs",
  import: "./commands/import.mjs",
  init: "./commands/init.mjs",
  ingest: "./commands/ingest.mjs",
  install: "./commands/install.mjs",
  mcp: "./commands/mcp.mjs",
  schedule: "./commands/schedule.mjs",
  search: "./commands/search.mjs",
  status: "./commands/status.mjs"
};

function printHelp() {
  console.log(`DotAIOS ${VERSION}

Usage:
  dotaios <command> [options]

Commands:
  activate          Connect ~/.aios to global agent memory files
  attach <dir>      Connect a project folder to DotAIOS
  cleanup           Trim stale signals and compact the event log
  connect google    Connect optional local integrations such as Google Workspace
  context [name]    View, edit, or refresh local context files
  google <cmd>      Run read-first Google Workspace workflows
  import <file>     Preview or apply structured context from old chats
  init              Scaffold ~/.aios with local context templates
  ingest <file>     Copy material into vault/raw and log an event
  install <path>    Validate and install a local plugin directory
  mcp <cmd>         Print local MCP server status and client config
  schedule <cmd>    List, inspect, or run local manual schedules
  search <query>    Search across memory, vault, context, and projects
  status            Check the health of a local AIOS folder

Options:
  -h, --help        Show help
  -v, --version     Show version

Common command options:
  --path <dir>      Use a non-default AIOS folder
  --vault-path <dir>  Store long-term knowledge in an external vault during init
  --force           Add missing init files while preserving existing files
  --overwrite       Replace generated init files
`);
}

async function main(argv) {
  const [, , commandName, ...args] = argv;

  if (!commandName || commandName === "--help" || commandName === "-h") {
    printHelp();
    return;
  }

  if (commandName === "--version" || commandName === "-v") {
    console.log(VERSION);
    return;
  }

  const commandPath = commands[commandName];
  if (!commandPath) {
    console.error(`Unknown command: ${commandName}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const module = await import(commandPath);
  const command = module[`${commandName}Command`];
  await command(args);
}

main(process.argv).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
