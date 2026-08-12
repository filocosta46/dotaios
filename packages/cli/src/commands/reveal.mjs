import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

export async function revealCommand(args) {
  if (hasHelpFlag(args)) {
    printHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));

  try {
    await fs.access(target);
  } catch {
    throw new Error(`No AIOS folder found at ${target}. Run 'dotaios init' first.`);
  }

  const opener = pickOpener();

  if (options.dryRun) {
    console.log(`Would open ${target} with ${opener}`);
    return;
  }

  spawn(opener, [target], { stdio: "ignore", detached: true }).unref();
  console.log(`Opening ${target}`);
}

function pickOpener() {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "explorer";
  return "xdg-open";
}

function parseOptions(args = []) {
  const options = { path: null, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  dotaios reveal [--path <dir>] [--dry-run]

Open the AIOS folder in your system file manager so you can browse and edit
context, memory, and vault files.

Defaults to ${defaultAiosPath()}.

Options:
  --path <dir>  Open a non-default AIOS folder
  --dry-run     Print the command that would be run, do not open
`);
}
