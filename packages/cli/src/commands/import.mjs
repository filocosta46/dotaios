import fs from "node:fs/promises";
import path from "node:path";
import { appendEventRecord, formatJsonlEntry } from "../../../core/src/memory.mjs";
import { findManagedBlock } from "../../../core/src/bridges.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome, isPathWithin, isPathWithinLexically, resolveVaultPath } from "../../../core/src/paths.mjs";
import { readJson, replaceFileIfUnchanged, writeFileSafe } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { assertNoHeading, assertPlainText, JOURNAL_CONTROL_CHARACTERS, SECTION_BODY_CONTROL_CHARACTERS } from "../lib/answers.mjs";

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
  const plan = await buildImportPlan(target, resolveVaultPath(config, target), imported, sourcePath);
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

async function buildImportPlan(target, vaultPath, imported, sourcePath) {
  const plan = [];
  const importedAt = new Date().toISOString();
  // One destination file holds one managed block, so every section bound for
  // the same file has to be collected before the block is rendered. Two plan
  // items for one path would otherwise overwrite each other inside one run.
  const markdown = new Map();

  const addSection = (destination, heading, content, bucket, subject, { sectionBody = false } = {}) => {
    const entry = markdown.get(destination) || { bucket, sections: [] };
    const section = { heading, content: String(content).trim() };

    // An answer is something the person typed at their own assistant. This text
    // was written by whichever assistant read their old chat, so of the two
    // doors into the same files it is the untrusted one, and it was the one
    // with no rules: U+202E and a bare carriage return reached
    // context/identity.md on disk through this path, verbatim, while --answers
    // refused both by name.
    //
    // A control character is never legitimate in any markdown destination, so
    // that rule applies to all of them here — the signal and event journals are
    // not markdown and do not pass through this function; journalText covers
    // them. A heading is different: it is only
    // harmful where something later reads the file back by section, which is
    // the four context files. docs/context-import.md documents projects and
    // wiki entries as whole markdown documents whose content opens with `# `,
    // so refusing headings there would reject the format this command's own
    // documentation tells people to produce.
    assertPlainText(section.content, subject, SECTION_BODY_CONTROL_CHARACTERS);
    if (sectionBody) assertNoHeading(section.content, subject);

    if (!entry.sections.some((existing) => existing.heading === section.heading && existing.content === section.content)) {
      entry.sections.push(section);
    }
    markdown.set(destination, entry);
  };

  for (const [key, relativePath] of Object.entries(contextTargets)) {
    if (imported.context?.[key]) {
      addSection(path.join(target, relativePath), "Imported Context", imported.context[key], "context", `imported context "${key}"`, { sectionBody: true });
    }
  }

  for (const project of asArray(imported.projects)) {
    const slug = safeSlug(project.slug || project.name, "project");
    const content = project.content || project.readme || `# ${project.name || slug}\n\n${project.summary || ""}\n`;
    addSection(path.join(target, "projects", slug, "README.md"), "Imported Project Context", content, "project", `imported project "${slug}"`);
  }

  for (const item of asArray(imported.wiki)) {
    const slug = safeSlug(item.slug || item.topic || item.title, "wiki");
    addSection(path.join(vaultPath, "wiki", slug, "_index.md"), "Imported Knowledge", item.content || item.summary || "", "vault/wiki", `imported wiki topic "${slug}"`);
  }

  for (const company of asArray(imported.companies)) {
    const slug = safeSlug(company.slug || company.name, "company");
    addSection(path.join(vaultPath, "org", "companies", `${slug}.md`), "Imported Company Context", company.content || company.summary || "", "vault/org", `imported company "${slug}"`);
  }

  for (const person of asArray(imported.people)) {
    const slug = safeSlug(person.slug || person.name, "person");
    addSection(path.join(vaultPath, "org", "people", `${slug}.md`), "Imported Person Context", person.content || person.summary || "", "vault/org", `imported person "${slug}"`);
  }

  for (const [destination, entry] of markdown) {
    plan.push(markdownBlock(destination, entry.sections, entry.bucket, importedAt));
  }

  for (const signal of asArray(imported.signals)) {
    const date = signalDate(signal.ts, importedAt);
    const ts = signal.ts || importedAt;
    plan.push(jsonlAppend(path.join(target, "memory", "signals", `${date}.jsonl`), {
      ts,
      type: journalText(signal.type, "imported-signal", `imported signal "type"`),
      project: signal.project || null,
      domain: signal.domain || null,
      summary: journalText(signal.summary || signal.content, "", `imported signal "summary"`),
      source: signal.source || sourcePath
    }, "memory/signals"));
  }

  for (const event of asArray(imported.events)) {
    plan.push(eventAppend(path.join(target, "memory", "events.jsonl"), {
      ts: event.ts || importedAt,
      type: journalText(event.type, "import", `imported event "type"`),
      project: event.project || null,
      domain: event.domain || null,
      summary: journalText(event.summary || event.content, "", `imported event "summary"`),
      source: event.source || sourcePath
    }, "memory/events"));
  }

  if (plan.length === 0) {
    throw new Error("Import file did not contain any supported context, project, wiki, org, signal, or event entries.");
  }

  for (const item of plan) {
    await assertContained(item.path, [target, vaultPath]);
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

// A signal's date names a file. `ts` arrives from the import payload, and the
// payload is written by whichever assistant read the user's old chat, so it is
// third-party text rather than something this product produced. Slicing ten
// characters off it and joining that to a directory turned `../../../x` into a
// write one level above the AIOS folder: `plan` reported it, `--apply` created
// the parent directories and appended the record, and nothing in the run looked
// wrong. The shape is the check — a signal is filed under a calendar day, and
// anything that is not one is refused rather than coerced, so a malformed
// export fails loudly instead of filing itself somewhere quiet.
const SIGNAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The markdown rules run inside addSection, so they never covered the two
// destinations this command writes that are not markdown. A signal and an
// event carry free text too, and it does not stay in the file: `dotaios brief`
// renders both into the projection every agent is told to read at session
// start, one line each. A bidi override, a bare carriage return and a raw ANSI
// escape all reached that output — the carriage return being the character the
// answers rule singles out as the sharpest case, because it can make a line
// print as something it does not say.
//
// A JSONL record is one line by construction, so a newline is refused here
// rather than kept the way a section body keeps it.
function journalText(value, fallback, subject) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    throw new Error(`${subject} must be a string, received ${typeof value}.`);
  }
  assertPlainText(value, subject, JOURNAL_CONTROL_CHARACTERS);
  return value;
}

function signalDate(ts, importedAt) {
  if (ts === undefined || ts === null || ts === "") return importedAt.slice(0, 10);
  if (typeof ts !== "string") {
    throw new Error(`Import signal "ts" must be a string, received ${typeof ts}.`);
  }
  const date = ts.slice(0, 10);
  if (!SIGNAL_DATE.test(date)) {
    throw new Error(
      `Import signal "ts" must start with a YYYY-MM-DD date, received ${JSON.stringify(ts)}. ` +
        "That value names the signal file, so a date is the only thing it can be."
    );
  }
  return date;
}

// Every destination this command writes is derived from the import file, and
// derivation is where containment gets lost: one unvalidated field reached
// path.join and the result escaped the folder the user pointed at. The rule is
// checked once, over the finished plan, rather than at each of the six places a
// path is built — a seventh writer added later inherits it instead of having to
// remember it. isPathWithinLexically is core's own containment predicate, so
// this asks the same question the rest of the product asks rather than a second
// one that can drift from it. The vault is a separate root because vault_path
// may legitimately point outside the AIOS folder.
// Lexical containment answers "does this path spell its way out", which is the
// `../../../x` case. It does not answer "does this path lead out", and three of
// four planted-symlink routes walked straight through it: a `memory/signals`
// directory symlink, a `memory/events.jsonl` file symlink, and a
// `projects/<slug>` directory symlink all wrote outside the folder while the
// plan printed the in-folder path.
//
// That last part is why this is resolved with the async check rather than left
// as a known limit. The argument for treating the original traversal as a real
// defect was that the preview named the destination; a preview that names a
// path the bytes do not go to is worse than one that names an alarming path.
// init.mjs already runs exactly this lexical-then-symlink pair for
// --vault-path, so the untrusted door now asks the same question the trusted
// one does.
async function assertContained(destination, roots) {
  for (const root of roots) {
    if (isPathWithinLexically(root, destination) && await isPathWithin(root, destination)) return;
  }
  throw new Error(
    `Import refused: ${path.resolve(destination)} is outside the AIOS folder, ` +
      "or a symlink on the way there leads outside it. " +
      "An import may only write inside the folder it was pointed at and its vault."
  );
}
