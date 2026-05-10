import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { canonicalizeUrl } from "./canonical-url.mjs";
import { buildFrontmatter, slugify, disambiguateSlug } from "./frontmatter.mjs";

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const STRIP_SELECTORS = ["script", "style", "noscript", "iframe", "nav", "footer", "aside", "header"];

export class IngestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

let _deps = null;

async function loadDeps() {
  if (_deps) return _deps;
  const [linkedom, cheerio, readability, turndown] = await Promise.all([
    import("linkedom"),
    import("cheerio"),
    import("@mozilla/readability"),
    import("turndown")
  ]);
  _deps = {
    parseHTML: linkedom.parseHTML,
    load: cheerio.load,
    Readability: readability.Readability,
    TurndownService: turndown.default || turndown.TurndownService
  };
  return _deps;
}

/**
 * Path A: fetch a URL, extract the article, write markdown to vault/raw/.
 *
 * @param {string} rawInput   URL as the user typed it
 * @param {object} options
 * @param {string} options.rawDir            absolute path to vault/raw
 * @param {string} options.eventsPath        absolute path to memory/events.jsonl
 * @param {boolean} [options.overwrite]      replace existing destination
 * @param {boolean} [options.dryRun]         print plan only, no I/O
 * @param {number}  [options.timeoutMs]      fetch timeout
 * @param {Function} [options.fetchImpl]     fetch override (testing)
 * @param {Function} [options.now]           clock override (testing)
 *
 * @returns {Promise<{action:"written"|"skipped"|"dry-run", destination?:string, slug?:string, plan?:object, parser:string, kind:"web", canonical:string}>}
 */
export async function ingestUrl(rawInput, options) {
  if (!options || !options.rawDir || !options.eventsPath) {
    throw new Error("ingestUrl requires options.rawDir and options.eventsPath");
  }
  const {
    rawDir,
    eventsPath,
    overwrite = false,
    dryRun = false,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    now = () => new Date()
  } = options;

  const canonical = canonicalizeUrl(rawInput);

  if (dryRun) {
    return {
      action: "dry-run",
      kind: "web",
      parser: "readability+turndown",
      canonical,
      plan: {
        kind: "web",
        parser: "readability+turndown",
        canonical,
        rawDir
      }
    };
  }

  const response = await fetchWithTimeout(canonical, { timeoutMs, fetchImpl });

  if (!response.ok) {
    throw new IngestError(
      `Fetch failed: ${canonical} returned ${response.status} ${response.statusText || ""}`.trim(),
      "FETCH_FAILED"
    );
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    throw new IngestError(
      `URL returned a PDF (Content-Type: ${contentType}). Save the file locally and re-ingest as a path.`,
      "PDF_CONTENT_TYPE"
    );
  }

  const html = await response.text();
  const { title, markdown } = await extractArticle(html, canonical);

  const baseSlug = slugify(title);
  let slug = baseSlug;
  let destination = path.join(rawDir, `${slug}.md`);
  const exists = await fileExists(destination);
  if (exists && !overwrite) {
    return { action: "skipped", destination, slug, parser: "readability+turndown", kind: "web", canonical };
  }
  if (exists && overwrite) {
    // overwrite same destination
  }

  // Slug collision against unrelated source: only checked when not overwriting an existing match.
  // We use canonical URL as disambiguation key.
  if (!exists) {
    let probe = destination;
    let probeSlug = slug;
    let collisions = 0;
    while (await fileExists(probe)) {
      probeSlug = disambiguateSlug(baseSlug, canonical);
      probe = path.join(rawDir, `${probeSlug}.md`);
      collisions += 1;
      if (collisions > 1) break;
    }
    slug = probeSlug;
    destination = probe;
  }

  const frontmatter = buildFrontmatter({
    source: canonical,
    kind: "web",
    parser: "readability+turndown",
    title,
    ingestedAt: now().toISOString()
  });

  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(destination, `${frontmatter}\n${markdown.trimEnd()}\n`);

  await appendEvent(eventsPath, {
    type: "ingest",
    source: canonical,
    destination,
    kind: "web",
    parser: "readability+turndown",
    summary: title
  });

  return { action: "written", destination, slug, parser: "readability+turndown", kind: "web", canonical };
}

async function fetchWithTimeout(url, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (error.name === "AbortError" || /aborted/i.test(error.message || "")) {
      throw new IngestError(`Fetch timed out after ${timeoutMs}ms: ${url}`, "TIMEOUT");
    }
    throw new IngestError(`Fetch failed: ${error.message}`, "FETCH_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

async function extractArticle(html, sourceUrl) {
  const { load, parseHTML, Readability, TurndownService } = await loadDeps();

  const $ = load(html);
  for (const sel of STRIP_SELECTORS) $(sel).remove();
  const cleaned = $.html();

  const { document } = parseHTML(cleaned);
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article || !article.content || !article.content.trim()) {
    throw new IngestError(
      "Page returned no readable article. Some sites require JavaScript. Save as PDF and re-ingest.",
      "READABILITY_NULL"
    );
  }

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const markdown = turndown.turndown(article.content);
  const title = (article.title || extractFallbackTitle($) || sourceUrl).trim();

  return { title, markdown };
}

function extractFallbackTitle($) {
  return $("title").first().text().trim() || $("h1").first().text().trim() || "";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
