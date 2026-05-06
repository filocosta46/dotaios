import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";

export async function ingestCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  dotaios ingest <file> [options]

Options:
  --path <dir>  Use an AIOS folder other than ~/.aios
`);
    return;
  }

  const options = parseOptions(args);
  const [file] = options.positionals;

  if (!file) {
    throw new Error("Usage: dotaios ingest <file>");
  }

  const source = path.resolve(file);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const config = await readConfig(target);
  const rawDir = path.join(resolveVaultPath(config || {}, target), "raw");
  const destination = path.join(rawDir, path.basename(source));

  await fs.mkdir(rawDir, { recursive: true });
  await fs.copyFile(source, destination);
  await fs.mkdir(path.join(target, "memory"), { recursive: true });
  await fs.appendFile(path.join(target, "memory", "events.jsonl"), JSON.stringify({
    ts: new Date().toISOString(),
    type: "ingest",
    source,
    destination
  }) + "\n");

  console.log(`Ingested ${source} -> ${destination}`);
}

function parseOptions(args = []) {
  const options = { path: null, positionals: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
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
