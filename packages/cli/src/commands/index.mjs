import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { pathExists, readJson } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const SUMMARY_MAX_LENGTH = 120;
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".obsidian", ".trash"]);

export async function indexCommand(args) {
  if (hasHelpFlag(args)) {
    printIndexHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const config = await readJson(path.join(target, "aios.json"), {});
  const vaultPath = resolveVaultPath(config, target);
  const indexPath = path.join(target, "_index.md");

  const sections = [];
  sections.push(await buildSection("context", path.join(target, "context"), target));

  if (await pathExists(vaultPath)) {
    sections.push(await buildSection("vault", vaultPath, target));
  }

  const projectsPath = path.join(target, "projects");
  if (await pathExists(projectsPath)) {
    sections.push(await buildSection("projects", projectsPath, target));
  }

  const totalFiles = sections.reduce((sum, s) => sum + s.entries.length, 0);
  const generatedAt = new Date().toISOString().slice(0, 10);
  const output = renderIndex(sections, generatedAt);

  if (options.dryRun) {
    console.log(`(dry run — would write ${indexPath})\n`);
    console.log(output);
    return;
  }

  await fs.writeFile(indexPath, output, "utf8");
  console.log(`Indexed ${totalFiles} markdown file(s) across ${sections.length} section(s).`);
  console.log(`Wrote ${indexPath}`);
}

async function buildSection(name, dir, aiosPath) {
  const files = await listMarkdownFiles(dir);
  const entries = [];
  for (const file of files) {
    const relativeToDir = path.relative(dir, file);
    if (relativeToDir === "_index.md") continue;
    const summary = await readSummary(file);
    const link = makeLink(file, aiosPath);
    entries.push({ relativeToDir, link, summary });
  }
  entries.sort((a, b) => a.relativeToDir.localeCompare(b.relativeToDir));
  return { name, entries };
}

function renderIndex(sections, generatedAt) {
  const lines = [];
  lines.push("# AIOS Index");
  lines.push("");
  lines.push(`Generated ${generatedAt}. Run \`dotaios index\` to refresh.`);
  lines.push("");

  for (const section of sections) {
    lines.push(`## ${section.name}/`);
    if (section.entries.length === 0) {
      lines.push("");
      lines.push("_(empty)_");
      lines.push("");
      continue;
    }
    lines.push("");
    for (const entry of section.entries) {
      const summary = entry.summary ? ` — ${entry.summary}` : "";
      lines.push(`- [${entry.relativeToDir}](${entry.link})${summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function makeLink(file, aiosPath) {
  const rel = path.relative(aiosPath, file);
  return rel.startsWith("..") ? file : rel;
}

async function readSummary(file) {
  let content;
  try {
    content = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }

  const fromFrontmatter = readFrontmatterDescription(content);
  if (fromFrontmatter) return truncate(fromFrontmatter, SUMMARY_MAX_LENGTH);

  const fromHeading = readFirstHeading(content);
  if (fromHeading) return truncate(fromHeading, SUMMARY_MAX_LENGTH);

  return null;
}

function readFrontmatterDescription(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = content.slice(4, end);
  for (const line of block.split("\n")) {
    const match = line.match(/^description\s*:\s*(.+)$/);
    if (match) return stripQuotes(match[1].trim());
  }
  return null;
}

function readFirstHeading(content) {
  const stripped = stripFrontmatter(content);
  for (const line of stripped.split("\n")) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function stripFrontmatter(content) {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  return content.slice(end + 4);
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function truncate(value, maxLength) {
  if (!value) return value;
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

async function listMarkdownFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

function parseOptions(args = []) {
  const options = { path: null, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function ensureAiosFolder(target) {
  if (!await pathExists(path.join(target, "aios.json"))) {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
}

function printIndexHelp() {
  console.log(`Usage:
  dotaios index [options]

Generates ~/aios/_index.md — a table of contents across context, vault, and
projects. Reads the YAML frontmatter "description" field for each file's
summary, falling back to the first H1, falling back to no summary.

Examples:
  dotaios index
  dotaios index --dry-run
  dotaios index --path ./test-aios

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --dry-run     Print the index that would be written, without writing it
`);
}
