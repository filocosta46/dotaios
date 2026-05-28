import path from "node:path";
import { appendMetric } from "../../../core/src/metrics.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { pilotMetricsFile } from "../lib/pilot-metrics.mjs";

export async function pilotScoreCommand(args) {
  if (hasHelpFlag(args)) {
    printHelp();
    return;
  }

  const options = parseOptions(args);
  validateRequired(options);

  const firstRecallMin = parseFiniteNumber(options.firstRecallMin, "--first-recall-min");
  const pAt5 = parseFiniteNumber(options.pAt5, "--p-at-5");
  if (firstRecallMin < 0) {
    throw new Error("Invalid --first-recall-min. Use a non-negative number.");
  }
  if (pAt5 < 0 || pAt5 > 1) {
    throw new Error("Invalid --p-at-5. Use a number between 0 and 1.");
  }

  const scoredAt = new Date().toISOString();
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  await appendMetric(pilotMetricsFile(aiosPath), {
    type: "pilot_score",
    first_recall_min: firstRecallMin,
    p_at_5: pAt5,
    scorer_id: options.scorerId,
    scorer_method_version: options.methodVersion,
    scored_at: scoredAt
  });
  console.log("Recorded pilot_score sample.");
}

function parseOptions(args = []) {
  const options = {
    firstRecallMin: null,
    pAt5: null,
    scorerId: null,
    methodVersion: null,
    path: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--first-recall-min") {
      options.firstRecallMin = readOptionValue(args, index, "--first-recall-min");
      index += 1;
    } else if (arg === "--p-at-5") {
      options.pAt5 = readOptionValue(args, index, "--p-at-5");
      index += 1;
    } else if (arg === "--scorer-id") {
      options.scorerId = readOptionValue(args, index, "--scorer-id");
      index += 1;
    } else if (arg === "--method-version") {
      options.methodVersion = readOptionValue(args, index, "--method-version");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function validateRequired(options) {
  if (options.firstRecallMin === null) throw new Error("Missing required option: --first-recall-min");
  if (options.pAt5 === null) throw new Error("Missing required option: --p-at-5");
  if (options.scorerId === null) throw new Error("Missing required option: --scorer-id");
  if (options.methodVersion === null) throw new Error("Missing required option: --method-version");
}

function parseFiniteNumber(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${flagName}. Use a number.`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  dotaios pilot-score [options]

Writes one scored pilot sample to memory/metrics/pilot.jsonl.

Required options:
  --first-recall-min <number>
  --p-at-5 <number>
  --scorer-id <id>
  --method-version <version>

Optional:
  --path <dir>  Use an AIOS folder other than ~/aios
`);
}
