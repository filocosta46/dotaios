#!/usr/bin/env node

const VERSION = "1.0.0";

const commands = {
  init: "./commands/init.mjs",
  status: "./commands/status.mjs",
  ingest: "./commands/ingest.mjs",
  install: "./commands/install.mjs"
};

function printHelp() {
  console.log(`DotAIOS ${VERSION}

Usage:
  dotaios <command> [options]

Commands:
  init              Scaffold ~/.aios with local context templates
  status            Check the health of a local AIOS folder
  ingest <file>     Copy material into vault/raw and log an event
  install <path>    Validate and install a local plugin directory

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
