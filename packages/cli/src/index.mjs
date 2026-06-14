#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fireSyncHook } from "./lib/sync-hook.mjs";

const pkg = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
);
const VERSION = pkg.version;

const commands = {
  activate: "./commands/activate.mjs",
  attach: "./commands/activate.mjs",
  brief: "./commands/brief.mjs",
  capture: "./commands/capture.mjs",
  cleanup: "./commands/cleanup.mjs",
  connect: "./commands/connect.mjs",
  context: "./commands/context.mjs",
  doctor: "./commands/doctor.mjs",
  "export-okf": "./commands/export-okf.mjs",
  google: "./commands/google.mjs",
  import: "./commands/import.mjs",
  index: "./commands/index.mjs",
  init: "./commands/init.mjs",
  ingest: "./commands/ingest.mjs",
  install: "./commands/install.mjs",
  interview: "./commands/interview.mjs",
  license: "./commands/license.mjs",
  market: "./commands/market.mjs",
  mcp: "./commands/mcp.mjs",
  "pilot-report": "./commands/pilot-report.mjs",
  "pilot-score": "./commands/pilot-score.mjs",
  reveal: "./commands/reveal.mjs",
  schedule: "./commands/schedule.mjs",
  search: "./commands/search.mjs",
  setup: "./commands/setup.mjs",
  skill: "./commands/skill.mjs",
  skills: "./commands/skills.mjs",
  status: "./commands/status.mjs",
  sync: "./commands/sync.mjs",
  update: "./commands/update.mjs"
};

function printHelp() {
  console.log(`DotAIOS ${VERSION}

Usage:
  dotaios <command> [options]

Commands:
  setup             One-shot: init + activate + reveal (recommended for new users)
  capture <cmd>     Save, browse, and search your AI conversations
  doctor            One-stop health check
  export-okf        Export your knowledge as an Open Knowledge Format (OKF) bundle
  activate          Connect ~/aios to global agent memory files
  attach <dir>      Connect a project folder to DotAIOS
  brief             Write today's brief into memory/daily/YYYY-MM-DD.md
  cleanup           Trim stale signals and compact the event log
  connect google    Connect optional local integrations such as Google Workspace
  context [name]    View, edit, or refresh local context files
  google <cmd>      Run read-first Google Workspace workflows
  import <file>     Preview or apply structured context from old chats
  index             Generate ~/aios/_index.md — table of contents across context and vault
  init              Scaffold ~/aios with local context templates
  ingest <input>    Copy material into vault/raw and log an event
  install <path>    Validate and install a local plugin directory
  interview         Update your context by answering a few short questions
  license <cmd>     Add, list, or remove license keys for paid skills
  market <cmd>      Browse and install skills from the public registry
  mcp <cmd>         Print local MCP server status and client config
  reveal            Open the AIOS folder in Finder, Explorer, or xdg-open
  schedule <cmd>    List, inspect, or run local manual schedules
  search <query>    Search across memory, vault, context, projects, skills, references, and plugins
  skill <cmd>       Add, list, or remove skills (friendly alias for install)
  skills [name]     List installed skills or show full instructions for one skill
  status            Check the health of a local AIOS folder
  sync <cmd>        Cross-device sync to a private GitHub repo
  update [text]     Log a quick update — decision, meeting, note — to memory

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
  const command = resolveCommand(module, commandName);
  if (typeof command !== "function") {
    throw new Error(`Command module missing handler for: ${commandName}`);
  }
  await command(args);

  // Fire-and-forget: sync any files the command changed. Best-effort, never throws.
  await fireSyncHook({ command: commandName });
}

function resolveCommand(module, commandName) {
  const camelName = commandName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return module[`${commandName}Command`] || module[`${camelName}Command`];
}

main(process.argv).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
