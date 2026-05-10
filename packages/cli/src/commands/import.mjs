import fs from "node:fs/promises";
import path from "node:path";
import { formatJsonlEntry } from "../../../core/src/memory.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { pathExists, readJson, writeFileSafe } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const sensitivePattern = /(api[_-]?key|secret|password|token|private[_-]?key|client[_-]?secret)/i;
const contextTargets = {
  identity: "context/identity.md",
  work: "context/work.md",
  priorities: "context/priorities.md",
  north_star: "context/north-star.md",
  northStar: "context/north-star.md"
};

export async function importCommand(args) {
  if (hasHelpFlag(args)) {
    printImportHelp();
    return;
  }

  const options = parseOptions(args);
  const [sourceFile] = options.positionals;
  if (!sourceFile) {
    throw new Error("Usage: dotaios import <file> [--apply]");
  }

  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const sourcePath = path.resolve(expandHome(sourceFile));
  const imported = await readImportFile(sourcePath);
  const config = await readJson(path.join(target, "aios.json"), {});
  const plan = buildImportPlan(target, resolveVaultPath(config, target), imported, sourcePath);
  const sensitive = plan.filter((item) => sensitivePattern.test(item.content));

  printImportPlan(plan, options.apply ? "apply" : "dry-run");

  if (!options.apply) {
    if (sensitive.length > 0) {
      console.log("\nSensitive-looking terms found. Review before applying; secrets belong in ~/aios/.env, not memory files.");
    }
    console.log("\nDry run only. Re-run with --apply to write these changes.");
    return;
  }

  if (sensitive.length > 0 && !options.allowSensitive) {
    throw new Error("Sensitive-looking terms found. Move secrets to ~/aios/.env or re-run with --allow-sensitive if you reviewed the file.");
  }

  const results = [];
  for (const item of plan) {
    results.push(await applyImportItem(item));
  }

  console.log("\nImport applied");
  for (const result of results) {
    console.log(`[${result.action}] ${result.path}`);
  }
}

function parseOptions(args = []) {
  const options = { allowSensitive: false, apply: false, path: null, positionals: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--allow-sensitive") {
      options.allowSensitive = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printImportHelp() {
  console.log(`Usage:
  dotaios import <file> [options]

Options:
  --path <dir>        Use an AIOS folder other than ~/aios
  --apply             Write the planned changes
  --dry-run           Preview only (default)
  --allow-sensitive   Allow import content with secret-like terms after review

Input:
  JSON using the DotAIOS import format. See docs/context-import.md.
`);
}

async function readImportFile(sourcePath) {
  try {
    const content = await fs.readFile(sourcePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Import file must be valid JSON: ${sourcePath}`);
    }
    throw error;
  }
}

function buildImportPlan(target, vaultPath, imported, sourcePath) {
  const plan = [];
  const importedAt = new Date().toISOString();

  for (const [key, relativePath] of Object.entries(contextTargets)) {
    if (imported.context?.[key]) {
      plan.push(markdownAppend(path.join(target, relativePath), `Imported Context - ${importedAt}`, imported.context[key], "context"));
    }
  }

  for (const project of asArray(imported.projects)) {
    const slug = safeSlug(project.slug || project.name, "project");
    const content = project.content || project.readme || `# ${project.name || slug}\n\n${project.summary || ""}\n`;
    plan.push(markdownAppend(path.join(target, "projects", slug, "README.md"), `Imported Project Context - ${importedAt}`, content, "project"));
  }

  for (const item of asArray(imported.wiki)) {
    const slug = safeSlug(item.slug || item.topic || item.title, "wiki");
    plan.push(markdownAppend(path.join(vaultPath, "wiki", slug, "_index.md"), `Imported Knowledge - ${importedAt}`, item.content || item.summary || "", "vault/wiki"));
  }

  for (const company of asArray(imported.companies)) {
    const slug = safeSlug(company.slug || company.name, "company");
    plan.push(markdownAppend(path.join(vaultPath, "org", "companies", `${slug}.md`), `Imported Company Context - ${importedAt}`, company.content || company.summary || "", "vault/org"));
  }

  for (const person of asArray(imported.people)) {
    const slug = safeSlug(person.slug || person.name, "person");
    plan.push(markdownAppend(path.join(vaultPath, "org", "people", `${slug}.md`), `Imported Person Context - ${importedAt}`, person.content || person.summary || "", "vault/org"));
  }

  for (const signal of asArray(imported.signals)) {
    const ts = signal.ts || importedAt;
    const date = ts.slice(0, 10);
    plan.push(jsonlAppend(path.join(target, "memory", "signals", `${date}.jsonl`), {
      ts,
      type: signal.type || "imported-signal",
      project: signal.project || null,
      domain: signal.domain || null,
      summary: signal.summary || signal.content || "",
      source: signal.source || sourcePath
    }, "memory/signals"));
  }

  for (const event of asArray(imported.events)) {
    plan.push(jsonlAppend(path.join(target, "memory", "events.jsonl"), {
      ts: event.ts || importedAt,
      type: event.type || "import",
      project: event.project || null,
      domain: event.domain || null,
      summary: event.summary || event.content || "",
      source: event.source || sourcePath
    }, "memory/events"));
  }

  if (plan.length === 0) {
    throw new Error("Import file did not contain any supported context, project, wiki, org, signal, or event entries.");
  }

  return plan;
}

function markdownAppend(destination, heading, content, bucket) {
  return {
    kind: "markdown",
    action: "append",
    bucket,
    path: destination,
    content: `\n\n## ${heading}\n\n${String(content).trim()}\n`
  };
}

function jsonlAppend(destination, entry, bucket) {
  return {
    kind: "jsonl",
    action: "append",
    bucket,
    path: destination,
    content: formatJsonlEntry(entry)
  };
}

async function applyImportItem(item) {
  if (item.kind === "markdown" && !await pathExists(item.path)) {
    const title = path.basename(item.path, ".md") === "README" ? path.basename(path.dirname(item.path)) : path.basename(item.path, ".md");
    return writeFileSafe(item.path, `# ${title}\n${item.content}`, "preserve");
  }

  await fs.mkdir(path.dirname(item.path), { recursive: true });
  await fs.appendFile(item.path, item.content);
  return { action: "updated", path: item.path };
}

function printImportPlan(plan, mode) {
  console.log(`DotAIOS import plan (${mode})`);
  for (const item of plan) {
    console.log(`[${item.bucket}] append -> ${item.path}`);
  }
}

async function ensureAiosFolder(target) {
  if (!await pathExists(path.join(target, "aios.json"))) {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeSlug(value, label) {
  const slug = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error(`Missing ${label} slug/name in import file`);
  return slug;
}
