import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { readOptionValue } from "../lib/args.mjs";
import { classifyInput } from "../ingest/route.mjs";
import { ingestUrl, IngestError } from "../ingest/web.mjs";
import { ingestDocument } from "../ingest/pdf.mjs";
import { ingestText } from "../ingest/text.mjs";
import { ingestBinary } from "../ingest/binary.mjs";
import { SHELVES, isShelf, isDurableShelf, shelfNeedsName } from "../ingest/placement.mjs";
import { resolveProjectContext } from "../../../core/src/projects.mjs";

const HELP_TEXT = `Usage:
  dotaios ingest <input> [options]

  <input> can be:
    - A URL (http:// or https://) — fetched, extracted, saved as markdown.
    - A local file path — copied into the vault as markdown or kept as an asset.

Shelf routing:
  --to <shelf>      Where the item belongs, by purpose:
                      raw      rough source        -> vault/raw
                      wiki     lasting reference   -> vault/wiki
                      company  org record          -> vault/org/companies
                      person   org record          -> vault/org/people
                      signal   working note        -> memory/signals
  --name <name>     Record name. Required for company/person, optional for wiki.
  --apply           Approve a durable write (wiki/company/person) when not
                    running in an interactive Terminal.

  With no --to in a Terminal, DotAIOS asks one plain question. With no --to and
  no Terminal (an agent or script), it keeps today's behavior: saves to vault/raw.

Options:
  --path <dir>      Use an AIOS folder other than ~/aios
  --overwrite       Replace an existing destination (default skips)
  --dry-run         Classify the input and print the plan without writing
  --timeout <secs>  URL fetch timeout (default 10)
  --project <slug-or-id>  Attribute the ingest to a registered project

Examples:
  dotaios ingest report.pdf --to raw
  dotaios ingest https://example.com/post --to wiki --name ai-sales-research
  dotaios ingest company-brief.pdf --to company --name acme
  dotaios ingest call-note.md --to signal

Privacy:
  URL ingestion fetches the page from your machine to your machine.
  PDFs and documents are parsed locally with marker (if installed) or unpdf.
  No content is uploaded to any cloud service.

Note:
  Dynamic or paywalled pages may ingest partial content. If a saved article
  ends abruptly or misses table-of-contents sections, save the logged-in page
  as PDF from your browser and re-ingest that PDF.
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

  if (options.to && !isShelf(options.to)) {
    throw new Error(`Unknown shelf: ${options.to}. Use one of: ${SHELVES.join(", ")}`);
  }

  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });
  const config = await readConfig(aiosPath);
  const vaultRoot = resolveVaultPath(config || {}, aiosPath);
  const rawDir = path.join(vaultRoot, "raw");
  const assetsDir = path.join(vaultRoot, "assets");
  const signalsDir = path.join(aiosPath, "memory", "signals");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");

  const interactive = Boolean(process.stdin.isTTY);

  // Resolve the shelf: explicit --to wins; otherwise ask in a Terminal, or
  // fall back to today's vault/raw behavior for agents and scripts.
  let shelf = options.to;
  let name = options.name;
  let routedByDefault = false;

  if (!shelf) {
    if (interactive && !options.dryRun) {
      const picked = await promptShelf();
      shelf = picked.shelf;
      name = picked.name;
    } else {
      shelf = "raw";
      routedByDefault = !interactive;
    }
  }

  if (shelfNeedsName(shelf) && !name) {
    if (interactive && !options.dryRun) {
      name = await promptName(shelf);
    } else {
      throw new Error(`--to ${shelf} needs --name <name> (the ${shelf} this record is about).`);
    }
  }

  const classification = classifyInput(input);

  if (classification.kind === "binary" && shelf !== "raw") {
    console.log("[note] Binary files are always preserved as-is in vault/assets; --to does not apply.");
  }

  const shelfOptions = {
    shelf,
    name,
    vaultRoot,
    signalsDir,
    apply: options.apply,
    interactive,
    ...(project?.slug ? { project: project.slug } : {}),
    ...(project?.id ? { project_id: project.id } : {})
  };

  const flags = {
    overwrite: options.overwrite,
    dryRun: options.dryRun
  };

  try {
    if (classification.kind === "web") {
      const result = await ingestUrl(input, {
        rawDir,
        assetsDir,
        eventsPath,
        ...flags,
        ...shelfOptions,
        ...(options.timeoutMs != null ? { timeoutMs: options.timeoutMs } : {})
      });
      reportResult(result, { routedByDefault });
      return;
    }

    if (classification.kind === "document") {
      const result = await ingestDocument(classification.target, {
        rawDir,
        assetsDir,
        eventsPath,
        ...flags,
        ...shelfOptions
      });
      reportResult(result, { routedByDefault });
      return;
    }

    if (classification.kind === "text") {
      const result = await ingestText(classification.target, {
        rawDir,
        eventsPath,
        ...flags,
        ...shelfOptions
      });
      reportResult(result, { routedByDefault });
      return;
    }

    if (classification.kind === "binary") {
      const result = await ingestBinary(classification.target, {
        assetsDir,
        eventsPath,
        ...flags,
        ...shelfOptions
      });
      reportResult(result, { routedByDefault });
      return;
    }
  } catch (error) {
    if (error instanceof IngestError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

async function promptShelf() {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Where should this go?");
    console.log("  1) rough source       vault/raw            [default]");
    console.log("  2) lasting reference  vault/wiki");
    console.log("  3) company            vault/org/companies");
    console.log("  4) person             vault/org/people");
    console.log("  5) working note       memory/signals");
    const answer = (await rl.question("> ")).trim();
    const choices = { "": "raw", "1": "raw", "2": "wiki", "3": "company", "4": "person", "5": "signal" };
    const shelf = choices[answer];
    if (!shelf) {
      throw new Error(`Unrecognized choice: "${answer}". Run the command again and pick 1-5.`);
    }

    let name = null;
    if (shelf === "company" || shelf === "person") {
      name = (await rl.question(`Name of the ${shelf}: `)).trim();
      if (!name) throw new Error(`A ${shelf} record needs a name.`);
    } else if (shelf === "wiki") {
      name = (await rl.question("Reference name (Enter to use the title): ")).trim() || null;
    }
    return { shelf, name };
  } finally {
    rl.close();
  }
}

async function promptName(shelf) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = (await rl.question(`Name of the ${shelf}: `)).trim();
    if (!name) throw new Error(`A ${shelf} record needs a name.`);
    return name;
  } finally {
    rl.close();
  }
}

function reportResult(result, { routedByDefault } = {}) {
  if (result.action === "dry-run") {
    printPlan(result);
    return;
  }

  if (result.action === "preview") {
    console.log(
      `[preview] Would ${result.willAppend ? "append to" : "write"} ${result.destination}`
    );
    console.log("This is a durable knowledge shelf, so it needs your approval.");
    console.log("Re-run with --apply to write it.");
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

  if (result.warning) console.log(result.warning);

  if (result.kind === "binary") {
    console.log(`Preserved ${result.canonical} -> ${result.asset}`);
    console.log("[note] No markdown was generated. Unknown binary types are stored as assets only.");
    return;
  }

  if (result.shelf === "signal") {
    if (result.destination) {
      console.log(`Logged a working note in memory/signals and preserved the source at ${result.destination}`);
    } else {
      console.log("Logged a working note in memory/signals");
    }
    if (result.asset) console.log(`Original preserved at ${result.asset}`);
    return;
  }

  const verb = result.action === "appended" ? "Appended" : "Ingested";
  console.log(`${verb} ${result.canonical} -> ${result.destination}`);
  if (result.asset) {
    console.log(`Original preserved at ${result.asset}`);
  }
  if (isDurableShelf(result.shelf)) {
    console.log(`Saved to the ${result.shelf} shelf.`);
  }
  if (routedByDefault) {
    console.log("[note] Saved to vault/raw. Use --to wiki|company|person|signal to route by purpose.");
  }
}

function printPlan(result) {
  const plan = result.plan || {};
  console.log(`[dry-run] kind=${result.kind} parser=${result.parser || "n/a"}`);
  if (plan.shelf) console.log(`  shelf:  ${plan.shelf}`);
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
    to: null,
    name: null,
    apply: false,
    project: null,
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
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--to") {
      options.to = readOptionValue(args, index, "--to");
      index += 1;
    } else if (arg === "--name") {
      options.name = readOptionValue(args, index, "--name");
      index += 1;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
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

async function readConfig(target) {
  try {
    return JSON.parse(await fs.readFile(path.join(target, "aios.json"), "utf8"));
  } catch {
    return null;
  }
}
