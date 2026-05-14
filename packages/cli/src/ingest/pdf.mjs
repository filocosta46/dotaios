import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildFrontmatter, slugify } from "./frontmatter.mjs";
import { resolveAssetDestination, resolveMarkdownDestination } from "./destinations.mjs";
import { describeShelfTarget, placeMarkdown } from "./placement.mjs";
import { IngestError } from "./web.mjs";

export const DEFAULT_MARKER_TIMEOUT_MS = 300_000;
const MARKER_DOC_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".epub"]);
const MARKER_BIN = "marker_single";

/**
 * Detect whether `marker_single` is available on PATH.
 * Returns the absolute path if found, otherwise null.
 *
 * @param {Function} [whichImpl]  override for testing
 */
export async function detectMarker(whichImpl = defaultWhich) {
  try {
    return await whichImpl(MARKER_BIN);
  } catch {
    return null;
  }
}

/**
 * Path B: parse a local document into markdown.
 *
 * Strategy:
 *   marker_single in PATH -> spawn marker (handles .pdf/.docx/.pptx/.epub)
 *   marker absent + .pdf  -> unpdf basic text extraction (with warning)
 *   marker absent + other -> loud error (no silent binary copy)
 *
 * The original file is always copied to vault/assets/ so users never
 * lose fidelity, regardless of which parser ran.
 *
 * @param {string} rawInput  local file path (must already exist)
 * @param {object} options
 * @param {string}  options.rawDir
 * @param {string}  options.assetsDir
 * @param {string}  options.eventsPath
 * @param {boolean} [options.overwrite]
 * @param {boolean} [options.dryRun]
 * @param {number}  [options.markerTimeoutMs]
 * @param {Function} [options.whichImpl]
 * @param {Function} [options.spawnImpl]
 * @param {Function} [options.extractPdfImpl]
 * @param {Function} [options.now]
 * @param {string} [options.sourceOverride]
 * @param {string} [options.titleOverride]
 * @param {string} [options.assetName]
 *
 * @returns {Promise<{action:"written"|"skipped"|"dry-run", destination?:string, slug?:string, parser:string, kind:"pdf"|"document", canonical:string, asset?:string, warning?:string, plan?:object}>}
 */
export async function ingestDocument(rawInput, options) {
  if (!options || !options.rawDir || !options.assetsDir || !options.eventsPath) {
    throw new Error("ingestDocument requires options.rawDir, options.assetsDir, options.eventsPath");
  }
  const {
    rawDir,
    assetsDir,
    eventsPath,
    overwrite = false,
    dryRun = false,
    markerTimeoutMs = DEFAULT_MARKER_TIMEOUT_MS,
    whichImpl = defaultWhich,
    spawnImpl = defaultSpawn,
    extractPdfImpl = defaultExtractPdf,
    now = () => new Date(),
    sourceOverride = null,
    titleOverride = null,
    assetName = null,
    shelf = "raw",
    name = null,
    vaultRoot = null,
    signalsDir = null,
    apply = false,
    interactive = false
  } = options;

  const sourcePath = path.resolve(rawInput);
  const ext = path.extname(sourcePath).toLowerCase();

  if (!MARKER_DOC_EXTENSIONS.has(ext)) {
    throw new IngestError(`ingestDocument received unsupported extension: ${ext}`, "UNSUPPORTED_EXT");
  }

  const baseName = path.basename(sourcePath, ext);
  const title = titleOverride || baseName;
  const source = sourceOverride || sourcePath;
  const baseSlug = slugify(title);
  const assetFileName = assetName || path.basename(sourcePath);
  const assetDest = path.join(assetsDir, assetFileName);
  const kind = ext === ".pdf" ? "pdf" : "document";

  if (dryRun) {
    const parser = ext === ".pdf" ? "marker-local|unpdf" : "marker-local";
    return {
      action: "dry-run",
      kind,
      parser,
      canonical: source,
      plan: {
        kind,
        parser,
        source,
        shelf,
        destination: describeShelfTarget({ shelf, vaultRoot, rawDir, signalsDir, name, baseSlug }),
        asset: assetDest
      }
    };
  }

  await assertExists(sourcePath);

  const marker = await detectMarker(whichImpl);
  const parser = marker ? "marker-local" : ext === ".pdf" ? "unpdf" : null;

  // Raw shelf keeps the early-skip optimization: if the destination already
  // exists for this source, don't spend time parsing the document.
  if (shelf === "raw") {
    const earlyTarget = await resolveMarkdownDestination({ rawDir, baseSlug, source, overwrite });
    if (earlyTarget.action === "skip") {
      return {
        action: "skipped",
        destination: earlyTarget.destination,
        slug: earlyTarget.slug,
        parser,
        kind,
        canonical: source
      };
    }
  }

  const assetTarget = await resolveAssetDestination({
    assetsDir,
    fileName: assetFileName,
    source,
    eventsPath,
    overwrite
  });
  await fs.mkdir(assetsDir, { recursive: true });
  if (assetTarget.action === "write") {
    await fs.copyFile(sourcePath, assetTarget.asset);
  }

  if (!marker && !parser) {
    throw new IngestError(
      `marker_single not installed; cannot parse ${ext} files. Install marker via skills/ingest, or convert this file to PDF and re-ingest.`,
      "MARKER_REQUIRED"
    );
  }

  let markdown;
  let warning;
  if (marker) {
    markdown = await runMarker({ sourcePath, marker, spawnImpl, timeoutMs: markerTimeoutMs });
  } else {
    markdown = await extractPdfImpl(sourcePath);
    warning = "[basic text extraction — install marker for tables/math/docx/pptx/epub: see skills/ingest]";
  }

  if (!markdown || !markdown.trim()) {
    throw new IngestError(
      `Parser produced no text for ${path.basename(sourcePath)}. The file may be image-only or corrupt.`,
      "EMPTY_PARSE"
    );
  }

  const frontmatter = buildFrontmatter({
    source,
    kind,
    parser,
    title,
    ingestedAt: now().toISOString()
  });

  return await placeMarkdown({
    shelf,
    name,
    vaultRoot,
    rawDir,
    signalsDir,
    eventsPath,
    baseSlug,
    source,
    title,
    body: `${frontmatter}\n${markdown.trimEnd()}`,
    kind,
    parser,
    overwrite,
    apply,
    interactive,
    asset: assetTarget.asset,
    warning,
    now
  });
}

async function runMarker({ sourcePath, marker, spawnImpl, timeoutMs }) {
  const tmpRoot = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "dotaios-marker-"));
  try {
    await spawnImpl(marker, [sourcePath, "--output_dir", tmpRoot, "--output_format", "markdown"], {
      timeoutMs
    });

    const md = await findMarkdownOutput(tmpRoot);
    if (!md) {
      throw new IngestError(`marker did not produce a markdown file in ${tmpRoot}`, "MARKER_EMPTY");
    }
    return await fs.readFile(md, "utf8");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function findMarkdownOutput(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findMarkdownOutput(full);
      if (nested) return nested;
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      return full;
    }
  }
  return null;
}

async function defaultWhich(binary) {
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "where" : "which";
  return await new Promise((resolve, reject) => {
    const proc = spawn(cmd, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).find((l) => l.trim());
        resolve(first ? first.trim() : binary);
      } else {
        resolve(null);
      }
    });
  });
}

async function defaultSpawn(cmd, args, { timeoutMs } = {}) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = timeoutMs
      ? setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new IngestError(`marker_single timed out after ${timeoutMs}ms`, "MARKER_TIMEOUT"));
        }, timeoutMs)
      : null;
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new IngestError(`marker_single failed to start: ${err.message}`, "MARKER_SPAWN_ERROR"));
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new IngestError(`marker_single exited with code ${code}: ${stderr.trim()}`, "MARKER_NONZERO"));
        return;
      }
      resolve();
    });
  });
}

async function defaultExtractPdf(sourcePath) {
  const buffer = await fs.readFile(sourcePath);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : String(text || "");
}

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new IngestError(`File not found: ${filePath}`, "FILE_NOT_FOUND");
  }
}
