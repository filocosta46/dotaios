import path from "node:path";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { runRollup } from "../lib/pilot-rollup.mjs";

export async function pilotReportCommand(args) {
  if (hasHelpFlag(args)) {
    printHelp();
    return;
  }

  const options = parseOptions(args);
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const summary = await runRollup(aiosPath);

  const shipPilot = Boolean(summary.go);
  const shipPublic = Boolean(summary.go_public);

  if (options.json) {
    console.log(JSON.stringify({
      ...summary,
      ship_pilot: shipPilot,
      ship_public: shipPublic
    }));
    return;
  }

  console.log(`Ship pilot: ${shipPilot ? "yes" : "no"}`);
  console.log(`Ship public: ${shipPublic ? "yes" : "no"}`);
  if (summary.block_reasons?.length > 0) {
    console.log("Block reasons:");
    for (const reason of summary.block_reasons) {
      console.log(`- ${reason}`);
    }
  } else {
    console.log("Block reasons: none");
  }
  if (shipPilot && !shipPublic && summary.public_block_reasons?.length > 0) {
    console.log("Public-only block reasons:");
    for (const reason of summary.public_block_reasons) {
      console.log(`- ${reason}`);
    }
  }
}

function parseOptions(args = []) {
  const options = { path: null, json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  dotaios pilot-report [options]

Runs pilot rollup and prints ship decisions.

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --json        Print machine-readable JSON
`);
}
