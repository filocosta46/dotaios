import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hasLicense } from "../../../core/src/licenses.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { installCommand } from "./install.mjs";

const DEFAULT_REGISTRY_URL = "https://dotaios.com/registry.json";

const HELP_TEXT = `Usage:
  dotaios market <subcommand> [options]

Subcommands:
  list                  Show every skill available in the public registry.
  info <id>             Show details for one entry.
  install <id>          Install one entry (verifies license first if paid).

Options:
  --registry <url>      Override the registry URL.
                        Default: ${DEFAULT_REGISTRY_URL}
                        (also honors DOTAIOS_REGISTRY_URL env var)
  --path <dir>          Install into an AIOS folder other than ~/aios
  --home <dir>          Write native agent bridges and skills under this home directory
  --dry-run             Validate only; do not copy files

The registry is a single static JSON file. Anyone can host one and pass it
with --registry. The default points at the official DotAIOS registry.
`;

export async function marketCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const { subcommand, positionals, options } = parseOptions(args);

  if (!subcommand) {
    console.log(HELP_TEXT);
    return;
  }

  const registryUrl = options.registry || process.env.DOTAIOS_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  let registry;
  try {
    registry = await fetchRegistry(registryUrl);
  } catch (err) {
    const isNetwork = err.message.includes("Could not reach") || err.message.includes("fetch");
    if (isNetwork) {
      console.error("Could not reach the skill registry. Check your internet connection and try again.");
      console.error(`(Registry URL: ${registryUrl})`);
    } else {
      console.error(`Registry error: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (subcommand === "list") {
    printList(registry, registryUrl);
    return;
  }

  if (subcommand === "info") {
    const [id] = positionals;
    if (!id) throw new Error("Usage: dotaios market info <id>");
    const entry = findEntry(registry, id);
    printEntry(entry);
    return;
  }

  if (subcommand === "install") {
    const [id] = positionals;
    if (!id) throw new Error("Usage: dotaios market install <id>");
    const entry = findEntry(registry, id);
    await marketInstall(entry, options);
    return;
  }

  throw new Error(`Unknown market subcommand: ${subcommand}. Try \`dotaios market --help\`.`);
}

function parseOptions(args = []) {
  const options = { registry: null, path: null, home: null, dryRun: false };
  const positionals = [];
  let subcommand = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--registry") {
      options.registry = readOptionValue(args, index, "--registry");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (!arg.startsWith("--") && !subcommand) {
      subcommand = arg;
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { subcommand, positionals, options };
}

async function fetchRegistry(url) {
  let payload;
  if (url.startsWith("file://")) {
    payload = await readFileRegistry(url);
  } else {
    payload = await fetchHttpRegistry(url);
  }

  if (!payload || !Array.isArray(payload.skills)) {
    throw new Error(`Registry at ${url} is missing a "skills" array.`);
  }
  return payload;
}

async function readFileRegistry(url) {
  const filePath = fileURLToPath(url);
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read registry at ${url}: ${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Registry at ${url} did not return valid JSON.`);
  }
}

async function fetchHttpRegistry(url) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch is not available in this Node runtime; upgrade to Node 20+");
  }

  let response;
  try {
    response = await globalThis.fetch(url);
  } catch (error) {
    throw new Error(`Could not reach registry at ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Registry returned status ${response.status} from ${url}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`Registry at ${url} did not return valid JSON.`);
  }
}

function findEntry(registry, id) {
  const entry = registry.skills.find((item) => item.id === id);
  if (!entry) {
    throw new Error(`No skill named "${id}" in the registry.`);
  }
  return entry;
}

function printList(registry, url) {
  console.log(`DotAIOS market (${url})`);
  console.log("");
  if (registry.skills.length === 0) {
    console.log("  (empty)");
    return;
  }
  for (const entry of registry.skills) {
    const price = entry.paid ? `paid ($${entry.price ?? "?"})` : "free";
    const vendor = entry.vendor ? `${entry.vendor}/` : "";
    console.log(`  ${entry.id}  [${price}]  ${vendor}${entry.name || entry.id}`);
    if (entry.description) {
      console.log(`      ${entry.description}`);
    }
  }
  console.log("");
  console.log("Install one: `dotaios market install <id>`.");
}

function printEntry(entry) {
  console.log(`${entry.id}`);
  if (entry.name) console.log(`  name:        ${entry.name}`);
  if (entry.vendor) console.log(`  vendor:      ${entry.vendor}`);
  console.log(`  paid:        ${entry.paid ? "yes" : "no"}`);
  if (entry.price) console.log(`  price:       $${entry.price}`);
  if (entry.product_id) console.log(`  product_id:  ${entry.product_id}`);
  if (entry.git_url) console.log(`  git_url:     ${entry.git_url}`);
  if (entry.subdir) console.log(`  subdir:      ${entry.subdir}`);
  if (entry.install_url) console.log(`  install_url: ${entry.install_url}`);
  if (entry.checkout_url) console.log(`  checkout:    ${entry.checkout_url}`);
  if (entry.description) {
    console.log(`  description: ${entry.description}`);
  }
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    console.log(`  tags:        ${entry.tags.join(", ")}`);
  }
}

async function marketInstall(entry, options) {
  const source = entry.git_url || entry.install_url;
  if (!source) {
    throw new Error(`Entry "${entry.id}" has no git_url or install_url.`);
  }

  if (entry.paid) {
    if (!entry.product_id) {
      throw new Error(`Entry "${entry.id}" is marked paid but has no product_id.`);
    }
    const licensed = await hasLicense(entry.product_id);
    if (!licensed) {
      const buyHint = entry.checkout_url ? `\nBuy a key: ${entry.checkout_url}` : "";
      throw new Error([
        `"${entry.id}" requires a license for product_id="${entry.product_id}".`,
        `Add the license, then retry:`,
        `  dotaios license add ${entry.product_id} <license-key>${buyHint}`
      ].join("\n"));
    }
  }

  const installArgs = [source];
  if (entry.subdir) installArgs.push("--subdir", entry.subdir);
  if (options.path) installArgs.push("--path", options.path);
  if (options.home) installArgs.push("--home", options.home);
  if (options.dryRun) installArgs.push("--dry-run");

  console.log(`Installing ${entry.id} from ${source}${entry.subdir ? ` (subdir: ${entry.subdir})` : ""}...`);
  await installCommand(installArgs);
}
