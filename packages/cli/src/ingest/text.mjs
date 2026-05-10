import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { buildFrontmatter, slugify, disambiguateSlug } from "./frontmatter.mjs";
import { IngestError } from "./web.mjs";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FENCED_LANGS = { ".json": "json", ".csv": "csv" };
const SUPPORTED_EXTS = new Set([".md", ".txt", ".json", ".csv"]);

/**
 * Path C: copy a local text file into vault/raw/ as markdown.
 *
 * - .md  : copy as-is; prepend frontmatter only when missing
 * - .txt : frontmatter + raw body
 * - .json/.csv : frontmatter + fenced code block of the raw content
 *
 * @returns {Promise<{action:"written"|"skipped"|"dry-run", destination?:string, slug?:string, parser:"copy", kind:"text", canonical:string, plan?:object}>}
 */
export async function ingestText(rawInput, options) {
  if (!options || !options.rawDir || !options.eventsPath) {
    throw new Error("ingestText requires options.rawDir and options.eventsPath");
  }
  const {
    rawDir,
    eventsPath,
    overwrite = false,
    dryRun = false,
    now = () => new Date()
  } = options;

  const sourcePath = path.resolve(rawInput);
  const ext = path.extname(sourcePath).toLowerCase();

  if (!SUPPORTED_EXTS.has(ext)) {
    throw new IngestError(`ingestText received unsupported extension: ${ext}`, "UNSUPPORTED_EXT");
  }

  await assertExists(sourcePath);

  const baseName = path.basename(sourcePath, ext);
  const baseSlug = slugify(baseName);
  let slug = baseSlug;
  let destination = path.join(rawDir, `${slug}.md`);

  if (dryRun) {
    return {
      action: "dry-run",
      kind: "text",
      parser: "copy",
      canonical: sourcePath,
      plan: { kind: "text", parser: "copy", source: sourcePath, destination }
    };
  }

  if (await fileExists(destination) && !overwrite) {
    return { action: "skipped", destination, slug, parser: "copy", kind: "text", canonical: sourcePath };
  }

  const sourceContent = await fs.readFile(sourcePath, "utf8");
  const title = baseName;
  const ingestedAt = now().toISOString();

  let body;
  if (ext === ".md" && FRONTMATTER_RE.test(sourceContent)) {
    body = sourceContent;
  } else {
    const frontmatter = buildFrontmatter({
      source: sourcePath,
      kind: "text",
      parser: "copy",
      title,
      ingestedAt
    });
    const wrapped = wrapBody(ext, sourceContent);
    body = `${frontmatter}\n${wrapped}`;
  }

  // Disambiguate collision against an unrelated source if the file did not exist
  // before this run but a different earlier ingest occupies the slug.
  if (!(await fileExists(destination))) {
    let probe = destination;
    if (await fileExists(probe)) {
      slug = disambiguateSlug(baseSlug, sourcePath);
      probe = path.join(rawDir, `${slug}.md`);
    }
    destination = probe;
  }

  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(destination, body.endsWith("\n") ? body : `${body}\n`);

  await appendEvent(eventsPath, {
    type: "ingest",
    source: sourcePath,
    destination,
    kind: "text",
    parser: "copy",
    summary: title
  });

  return { action: "written", destination, slug, parser: "copy", kind: "text", canonical: sourcePath };
}

function wrapBody(ext, content) {
  const lang = FENCED_LANGS[ext];
  if (lang) {
    const fence = "```";
    const trimmed = content.replace(/\s+$/, "");
    return `${fence}${lang}\n${trimmed}\n${fence}\n`;
  }
  // .txt and .md without frontmatter: leave the body intact, ensure trailing newline.
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new IngestError(`File not found: ${filePath}`, "FILE_NOT_FOUND");
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
