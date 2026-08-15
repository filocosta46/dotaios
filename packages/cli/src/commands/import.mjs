import fs from "node:fs/promises";
import path from "node:path";
import { appendEventRecord, formatJsonlEntry } from "../../../core/src/memory.mjs";
import { findManagedBlock } from "../../../core/src/bridges.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { readJson, replaceFileIfUnchanged, writeFileSafe } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

// Import owns exactly one delimited block per destination file, on the same
// ownership rule the agent bridges use: one well-formed pair or nothing. A
// bare append made a retry — the most ordinary thing a user does — silently
// duplicate every imported section.
const IMPORT_START = "<!-- dotaios-import:start -->";
const IMPORT_END = "<!-- dotaios-import:end -->";
const IMPORT_STAMP = "<!-- dotaios-import:at ";

const sensitivePattern = /api[_-]?key|client[_-]?secret|private[_-]?key|secret|password|token|bearer\s+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9_-]+|xox[abpros]-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----/i;
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

  // Resolve every destination against what is already on disk, so the preview
  // states the same decision the apply will take.
  const resolved = [];
  for (const item of plan) {
    resolved.push(await resolveImportItem(item));
  }

  printImportPlan(resolved, options.apply ? "apply" : "dry-run");

  if (!options.apply) {
    if (sensitive.length > 0) {
      console.log("\nSensitive-looking terms found. Review before applying; secrets belong in ~/aios/.env, not memory files.");
    }
    const refused = resolved.filter((item) => item.decision === "refuse");
    if (resolved.some((item) => item.decision !== "unchanged" && item.decision !== "refuse")) {
      console.log("\nDry run only. Re-run with --apply to write these changes.");
    } else if (refused.length > 0) {
      // The preview has to state the decision the apply will take, exit code
      // included, or it is a gate that passes what the next command refuses.
      console.log("\nDry run only. Nothing can be written: resolve the notes above, then re-run.");
      process.exitCode = 1;
    } else {
      console.log("\nDry run only. Nothing to write: every imported block is already in place.");
    }
    return;
  }

  if (sensitive.length > 0 && !options.allowSensitive) {
    throw new Error("Sensitive-looking terms found. Move secrets to ~/aios/.env or re-run with --allow-sensitive if you reviewed the file.");
  }

  const results = [];
  for (const item of resolved) {
    results.push(await applyImportItem(item));
  }

  console.log("\nImport applied");
  for (const result of results) {
    console.log(`[${result.action}] ${result.path}`);
    if (result.note) console.log(`  ${result.note}`);
  }

  if (results.some((result) => result.action === "refused" || result.action === "conflict")) {
    console.log("\nSome files were left untouched. Resolve the notes above, then re-run.");
    process.exitCode = 1;
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

Re-importing:
  Imported markdown lives in one DotAIOS-managed block per file. Importing the
  same content again changes nothing; changed content replaces that block and
  keeps a timestamped backup of the file beside it. Text outside the block is
  never touched.
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
  // One destination file holds one managed block, so every section bound for
  // the same file has to be collected before the block is rendered. Two plan
  // items for one path would otherwise overwrite each other inside one run.
  const markdown = new Map();

  const addSection = (destination, heading, content, bucket) => {
    const entry = markdown.get(destination) || { bucket, sections: [] };
    const section = { heading, content: String(content).trim() };
    if (!entry.sections.some((existing) => existing.heading === section.heading && existing.content === section.content)) {
      entry.sections.push(section);
    }
    markdown.set(destination, entry);
  };

  for (const [key, relativePath] of Object.entries(contextTargets)) {
    if (imported.context?.[key]) {
      addSection(path.join(target, relativePath), "Imported Context", imported.context[key], "context");
    }
  }

  for (const project of asArray(imported.projects)) {
    const slug = safeSlug(project.slug || project.name, "project");
    const content = project.content || project.readme || `# ${project.name || slug}\n\n${project.summary || ""}\n`;
    addSection(path.join(target, "projects", slug, "README.md"), "Imported Project Context", content, "project");
  }

  for (const item of asArray(imported.wiki)) {
    const slug = safeSlug(item.slug || item.topic || item.title, "wiki");
    addSection(path.join(vaultPath, "wiki", slug, "_index.md"), "Imported Knowledge", item.content || item.summary || "", "vault/wiki");
  }

  for (const company of asArray(imported.companies)) {
    const slug = safeSlug(company.slug || company.name, "company");
    addSection(path.join(vaultPath, "org", "companies", `${slug}.md`), "Imported Company Context", company.content || company.summary || "", "vault/org");
  }

  for (const person of asArray(imported.people)) {
    const slug = safeSlug(person.slug || person.name, "person");
    addSection(path.join(vaultPath, "org", "people", `${slug}.md`), "Imported Person Context", person.content || person.summary || "", "vault/org");
  }

  for (const [destination, entry] of markdown) {
    plan.push(markdownBlock(destination, entry.sections, entry.bucket, importedAt));
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
    plan.push(eventAppend(path.join(target, "memory", "events.jsonl"), {
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

function markdownBlock(destination, sections, bucket, importedAt) {
  const body = sections.map(({ heading, content }) => `## ${heading}\n\n${content}\n`).join("\n");
  return {
    kind: "markdown",
    bucket,
    path: destination,
    content: body,
    block: [IMPORT_START, `${IMPORT_STAMP}${importedAt} -->`, "", body.trimEnd(), "", IMPORT_END].join("\n")
  };
}

// The stamp records when a block was written, not what it says. Two imports of
// the same export differ only by that line, so block identity ignores it —
// otherwise every rerun would look changed and rewrite a file for nothing.
function importBlockBody(block) {
  return block.split("\n").filter((line) => !line.startsWith(IMPORT_STAMP)).join("\n");
}

function jsonlAppend(destination, entry, bucket) {
  return {
    kind: "jsonl",
    bucket,
    path: destination,
    content: formatJsonlEntry(entry)
  };
}

function eventAppend(destination, entry) {
  return {
    kind: "event",
    bucket: "memory/events",
    path: destination,
    entry,
    content: formatJsonlEntry(entry)
  };
}

// Decide what this destination needs before anything is written. A journal
// line is always an append; a markdown file is answered by whether DotAIOS
// already owns a block in it, and whether that block still says the same thing.
async function resolveImportItem(item) {
  if (item.kind !== "markdown") return { ...item, decision: "append" };

  // Content carrying our own markers would be written inside the block and make
  // the file unownable on the next run — the same permanent refusal a
  // hand-mangled destination earns, except this command created it. An export
  // of an AIOS that already holds an import block is the ordinary way to get
  // here, so refuse the payload rather than the file it would have ruined.
  if (item.content.includes(IMPORT_START) || item.content.includes(IMPORT_END)) {
    return { ...item, decision: "refuse", note: "imported content carries DotAIOS import markers; nothing was written" };
  }

  const stats = await lstatIfPresent(item.path);
  if (!stats) return { ...item, decision: "create" };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { ...item, decision: "refuse", note: "destination is not a regular file; nothing was written" };
  }

  const current = await fs.readFile(item.path, "utf8");
  const existing = findManagedBlock(current, IMPORT_START, IMPORT_END);
  if (!existing) {
    // Markers that do not form one clean pair are not ownership proof. Appending
    // beside them would leave a second start marker and make the file
    // permanently unownable, so leave it exactly as the user has it.
    if (current.includes(IMPORT_START) || current.includes(IMPORT_END)) {
      return { ...item, decision: "refuse", note: "import markers are malformed; nothing was written" };
    }
    return { ...item, decision: "append", current, stats };
  }

  return {
    ...item,
    decision: importBlockBody(existing.text) === importBlockBody(item.block) ? "unchanged" : "replace",
    current,
    existing,
    stats
  };
}

async function applyImportItem(item) {
  if (item.kind === "markdown") return applyMarkdownItem(item);

  if (item.kind === "event") {
    await appendEventRecord(item.path, item.entry);
    return { action: "updated", path: item.path };
  }

  await fs.mkdir(path.dirname(item.path), { recursive: true });
  await fs.appendFile(item.path, item.content);
  return { action: "updated", path: item.path };
}

async function applyMarkdownItem(item) {
  if (item.decision === "refuse") {
    return { action: "refused", path: item.path, note: item.note };
  }

  if (item.decision === "unchanged") {
    return { action: "unchanged", path: item.path, note: "this import is already in place" };
  }

  if (item.decision === "create") {
    const title = path.basename(item.path, ".md") === "README" ? path.basename(path.dirname(item.path)) : path.basename(item.path, ".md");
    return writeFileSafe(item.path, `# ${title}\n\n${item.block}\n`, "preserve");
  }

  if (item.decision === "append") {
    await fs.mkdir(path.dirname(item.path), { recursive: true });
    await fs.appendFile(item.path, `\n\n${item.block}\n`);
    return { action: "updated", path: item.path };
  }

  // Replacing is the only destructive path, so it goes through the guarded
  // rewrite: the pre-edit file is preserved byte for byte beside itself, and a
  // file that changed since the preview is left alone rather than clobbered.
  const next = `${item.current.slice(0, item.existing.start)}${item.block}${item.current.slice(item.existing.end)}`;
  const replacement = await replaceFileIfUnchanged(item.path, item.current, next, {
    expectedStats: item.stats,
    mode: item.stats.mode & 0o777
  });
  const preserved = replacement.preservedPath
    ? ` Previous file preserved at ${path.basename(replacement.preservedPath)}.`
    : "";
  return replacement.replaced
    ? { action: "replaced", path: item.path, note: `replaced the previous import block.${preserved}` }
    : { action: "conflict", path: item.path, note: `the file changed during import; left it untouched.${preserved}` };
}

const planVerbs = {
  create: "create",
  append: "append",
  replace: "replace the previous import block",
  unchanged: "skip (already imported)",
  refuse: "refuse"
};

function printImportPlan(plan, mode) {
  console.log(`DotAIOS import plan (${mode})`);
  for (const item of plan) {
    const verb = planVerbs[item.decision] || "append";
    console.log(`[${item.bucket}] ${mode === "dry-run" ? `would ${verb}` : verb} -> ${item.path}`);
    if (item.note) console.log(`  ${item.note}`);
  }
}

async function lstatIfPresent(destination) {
  try {
    return await fs.lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
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
