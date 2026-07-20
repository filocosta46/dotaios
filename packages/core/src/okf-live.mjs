import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "./jsonl.mjs";
import { readFrontmatterField } from "./search.mjs";

// OKF-native maintenance for the LIVE folder. The export bundle
// (export-okf.mjs) and the live tree share ONE index renderer so the two can
// never drift; the live variants are deterministic and write-if-changed, so a
// no-op regeneration produces zero diff (and zero mtime churn).

const RESERVED_DOCS = new Set(["index.md", "log.md", "logs.md"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash", "build"]);
const PROJECT_LOG_LIMIT = 50;
const LIFECYCLE_TYPES = new Set(["memory-promotion", "promoted-evidence"]);

/**
 * The one directory-index renderer, shared by export-okf and the live folder.
 * Callers precompute link hrefs (bundle-absolute for exports, relative for the
 * live tree); rendering, ordering, and format live only here.
 */
export function renderDirectoryIndex({ heading, childLinks = [], docLinks = [] }) {
  const lines = [`# ${heading}`, ""];
  for (const child of childLinks) {
    lines.push(`* [${child.label}](${child.href})`);
  }
  for (const doc of docLinks) {
    const type = doc.type ? ` (${doc.type})` : "";
    const description = doc.description ? ` - ${doc.description}` : "";
    lines.push(`* [${doc.label}](${doc.href})${type}${description}`);
  }
  return lines.join("\n") + "\n";
}

async function readTextOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeIfChanged(filePath, next) {
  const current = await readTextOrNull(filePath);
  if (current === next) return { changed: false, path: filePath };
  await fs.writeFile(filePath, next);
  return { changed: true, path: filePath };
}

/**
 * Maintain a live per-shelf/per-project index.md: every doc listed with its
 * OKF frontmatter type and the same description field search parses.
 */
export async function updateDirectoryIndex(dirPath, { label } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return { changed: false, skipped: "missing" };
  }

  const childLinks = [];
  const docLinks = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      childLinks.push({ label: entry.name, href: `${entry.name}/` });
      continue;
    }
    if (!entry.name.endsWith(".md") || RESERVED_DOCS.has(entry.name)) continue;
    const content = await readTextOrNull(path.join(dirPath, entry.name));
    if (content === null) continue;
    docLinks.push({
      label: path.basename(entry.name, ".md"),
      href: entry.name,
      type: readFrontmatterField(content, "type") || "",
      description: readFrontmatterField(content, "description") || ""
    });
  }

  if (childLinks.length === 0 && docLinks.length === 0) {
    return { changed: false, skipped: "empty" };
  }

  const heading = label || path.basename(dirPath);
  return writeIfChanged(path.join(dirPath, "index.md"), renderDirectoryIndex({ heading, childLinks, docLinks }));
}

/**
 * Project a per-project OKF changelog (the reserved log.md) from
 * memory/events.jsonl: promotion/decision lifecycle entries for that project,
 * newest first. This is the surface an agent reads to answer "what changed in
 * project X" without re-scanning the event log.
 */
export async function writeProjectLog(aiosPath, project, { limit = PROJECT_LOG_LIMIT } = {}) {
  if (!project) return { changed: false, skipped: "no-project" };
  const projectDir = path.join(aiosPath, "projects", project);
  try {
    await fs.access(projectDir);
  } catch {
    return { changed: false, skipped: "no-project-dir" };
  }

  const events = await readJsonl(path.join(aiosPath, "memory", "events.jsonl"));
  const lifecycle = events.filter((entry) => entry.project === project && (
    entry.operation
    || LIFECYCLE_TYPES.has(entry.type)
    || String(entry.type || "").startsWith("decision")
  ));
  const ordered = [...lifecycle]
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")))
    .slice(0, limit);

  const logPath = path.join(projectDir, "log.md");
  if (ordered.length === 0 && await readTextOrNull(logPath) === null) {
    return { changed: false, skipped: "no-lifecycle-events" };
  }

  const lines = [
    `# Log — ${project}`,
    "",
    "What changed in this project, projected from memory/events.jsonl (newest first).",
    ""
  ];
  for (const entry of ordered) {
    const day = String(entry.ts || "").slice(0, 10) || "????-??-??";
    const kind = entry.operation || entry.type || "event";
    lines.push(`- ${day} · ${kind} · ${entry.summary || ""}`.trimEnd());
  }
  return writeIfChanged(logPath, lines.join("\n") + "\n");
}

/**
 * Catch-all refresh for the live tree: memory shelf index, projects index,
 * per-project indexes and logs. Cheap, deterministic, safe to run daily from
 * maintainMemory.
 */
export async function refreshLiveOkf(aiosPath) {
  const results = [];
  results.push(await updateDirectoryIndex(path.join(aiosPath, "memory"), { label: "memory" }));

  const projectsDir = path.join(aiosPath, "projects");
  let names = [];
  try {
    names = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { changed: results.some((result) => result.changed) };
  }
  results.push(await updateDirectoryIndex(projectsDir, { label: "projects" }));
  for (const name of names) {
    results.push(await updateDirectoryIndex(path.join(projectsDir, name), { label: `projects/${name}` }));
    results.push(await writeProjectLog(aiosPath, name));
  }
  return { changed: results.some((result) => result.changed) };
}
