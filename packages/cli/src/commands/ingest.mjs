import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { appendEvent } from "../../../core/src/memory.mjs";
import { classifyInput } from "../ingest/route.mjs";
import { ingestUrl, IngestError } from "../ingest/web.mjs";
import { ingestDocument } from "../ingest/pdf.mjs";

export async function ingestCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  dotaios ingest <input> [options]

  <input> can be:
    - A URL (http:// or https://) — fetched, extracted, saved as markdown.
    - A local file path — copied into vault/raw or vault/assets.

Options:
  --path <dir>  Use an AIOS folder other than ~/.aios

Privacy:
  URL ingestion fetches the page from your machine to your machine.
  No content is uploaded to any cloud service.
`);
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

  if (classification.kind === "web") {
    try {
      const result = await ingestUrl(input, { rawDir, eventsPath });
      if (result.action === "skipped") {
        console.log(`Already ingested: ${result.destination}`);
        return;
      }
      console.log(`Ingested ${result.canonical} -> ${result.destination}`);
    } catch (error) {
      if (error instanceof IngestError) {
        throw new Error(error.message);
      }
      throw error;
    }
    return;
  }

  if (classification.kind === "document") {
    try {
      const result = await ingestDocument(classification.target, {
        rawDir,
        assetsDir,
        eventsPath
      });
      if (result.action === "skipped") {
        console.log(`Already ingested: ${result.destination}`);
        return;
      }
      if (result.warning) console.log(result.warning);
      console.log(`Ingested ${result.canonical} -> ${result.destination}`);
      console.log(`Original preserved at ${result.asset}`);
    } catch (error) {
      if (error instanceof IngestError) {
        throw new Error(error.message);
      }
      throw error;
    }
    return;
  }

  // Other paths (document/text/binary) land in commits 3-4. For now, retain the
  // previous behavior: copy the file into vault/raw/.
  const source = classification.target;
  const destination = path.join(rawDir, path.basename(source));
  await fs.mkdir(rawDir, { recursive: true });
  await fs.copyFile(source, destination);
  await appendEvent(eventsPath, {
    type: "ingest",
    source,
    destination,
    summary: `Ingested ${path.basename(source)}`
  });
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
