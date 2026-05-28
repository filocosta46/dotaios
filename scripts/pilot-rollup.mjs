import path from "node:path";
import { defaultAiosPath, expandHome } from "../packages/core/src/paths.mjs";
import { runRollup } from "../packages/cli/src/lib/pilot-rollup.mjs";

function readOption(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return idx + 1 < args.length ? args[idx + 1] : null;
}

function parsePositiveInteger(rawValue, flagName) {
  if (!/^\d+$/.test(rawValue) || Number(rawValue) < 1) {
    throw new Error(`Invalid ${flagName}. Use a positive whole number.`);
  }
  return Number(rawValue);
}

async function main() {
  const args = process.argv.slice(2);
  const pathArg = readOption(args, "--path");
  const minScoreSampleArg = readOption(args, "--min-score-sample");
  const options = {};
  if (minScoreSampleArg !== null) {
    options.minScoreSample = parsePositiveInteger(minScoreSampleArg, "--min-score-sample");
  }
  const aiosPath = path.resolve(expandHome(pathArg || defaultAiosPath()));
  const summary = await runRollup(aiosPath, options);
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
