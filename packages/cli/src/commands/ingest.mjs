import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { classifyInput } from "../ingest/route.mjs";
import { ingestUrl, IngestError } from "../ingest/web.mjs";
import { ingestDocument } from "../ingest/pdf.mjs";
import { ingestText } from "../ingest/text.mjs";
import { ingestBinary } from "../ingest/binary.mjs";

const HELP_TEXT = `Usage:
  dotaios ingest <input> [options]

  <input> can be:
    - A URL (http:// or https://) — fetched, extracted, saved as markdown.
    - A local file path — copied into vault/raw or vault/assets.

Options:
  --path <dir>      Use an AIOS folder other than ~/.aios
  --overwrite       Replace an existing destination (default skips)
  --dry-run         Classify the input and print the plan without writing
  --timeout <secs>  URL fetch timeout (Path A only, default 10)

Privacy:
  URL ingestion fetches the page from your machine to your machine.
  No content is uploaded to any cloud service.
`;

export async function ingestCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parseOptions(args);
  const [input] = options.positionals;

  if (!input) {
    throw new Error("Usage: dotaios ingest <input>");
  }

  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const config = await readConfig(aiosPath);
  const vaultRoot = resolveVaultPath(config || {}, aiosPath);
  const rawDir = path.join(vaultRoot, "raw");
  const assetsDir = path.join(vaultRoot, "assets");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");

  const classification = classifyInput(input);
  const flags = {
    overwrite: options.overwrite,
    dryRun: options.dryRun
  };

  try {
    if (classification.kind === "web") {
      const result = await ingestUrl(input, {
        rawDir,
        eventsPath,
        ...flags,
        ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {})
      });
      reportResult(result);
      return;
    }

    if (classification.kind === "document") {
      const result = await ingestDocument(classification.target, {
        rawDir,
        assetsDir,
        eventsPath,
        ...flags
      });
      reportResult(result);
      return;
    }

    if (classification.kind === "text") {
      const result = await ingestText(classification.target, {
        rawDir,
        eventsPath,
        ...flags
      });
      reportResult(result);
      return;
    }

    if (classification.kind === "binary") {
      const result = await ingestBinary(classification.target, {
        assetsDir,
        eventsPath,
        ...flags
      });
      reportResult(result);
      return;
    }
  } catch (error) {
    if (error instanceof IngestError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

function reportResult(result) {
  if (result.action === "dry-run") {
    printPlan(result);
    return;
  }
  if (result.action === "skipped") {
    if (result.destination) {
      console.log(`Already ingested: ${result.destination}`);
    } else if (result.asset) {
      console.log(`Already preserved: ${result.asset}`);
    }
    return;
  }
  // action === "written"
  if (result.warning) console.log(result.warning);
  if (result.kind === "binary") {
    console.log(`Preserved ${result.canonical} -> ${result.asset}`);
    console.log("[note] No markdown was generated. Unknown binary types are stored as assets only.");
    return;
  }
  console.log(`Ingested ${result.canonical} -> ${result.destination}`);
  if (result.asset) {
    console.log(`Original preserved at ${result.asset}`);
  }
}

function printPlan(result) {
  const plan = result.plan || {};
  console.log(`[dry-run] kind=${result.kind} parser=${result.parser || "n/a"}`);
  if (plan.canonical || result.canonical) {
    console.log(`  source: ${plan.canonical || plan.source || result.canonical}`);
  } else if (plan.source) {
    console.log(`  source: ${plan.source}`);
  }
  if (plan.destination) console.log(`  target: ${plan.destination}`);
  if (plan.asset) console.log(`  asset:  ${plan.asset}`);
  if (plan.rawDir && !plan.destination) console.log(`  rawDir: ${plan.rawDir}`);
}

function parseOptions(args = []) {
  const options = {
    path: null,
    overwrite: false,
    dryRun: false,
    timeoutMs: null,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--timeout") {
      const raw = readOptionValue(args, index, "--timeout");
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`--timeout must be a positive number of seconds, got: ${raw}`);
      }
      options.timeoutMs = Math.round(seconds * 1000);
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

async function readConfig(target) {
  try {
    return JSON.parse(await fs.readFile(path.join(target, "aios.json"), "utf8"));
  } catch {
    return null;
  }
}
