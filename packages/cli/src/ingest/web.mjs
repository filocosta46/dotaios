import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { canonicalizeUrl } from "./canonical-url.mjs";
import { buildFrontmatter, slugify } from "./frontmatter.mjs";
import { describeShelfTarget, placeMarkdown } from "./placement.mjs";
import { resolveLightpanda, lightpandaPlatformBinary } from "../../../core/src/lightpanda.mjs";

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
 * @param {object} [options.documentOptions] Path B overrides (testing)
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
    documentOptions = {},
    shelf = "raw",
    name = null,
    vaultRoot = null,
    signalsDir = null,
    apply = false,
    interactive = false,
    now = () => new Date(),
    resolveLightpandaImpl = resolveLightpanda,
    spawnImpl = nodeSpawnSync,
    hintFlagPath = path.join(os.homedir(), ".dotaios", ".lightpanda_hint_shown"),
    lightpandaPlatformSupported = lightpandaPlatformBinary() !== null
  } = options;

  const canonical = canonicalizeUrl(rawInput);

  if (dryRun) {
    const lp = await resolveLightpandaImpl();
    const parser = lp ? "lightpanda+readability+turndown" : "readability+turndown";
    return {
      action: "dry-run",
      kind: "web",
      parser,
      canonical,
      plan: {
        kind: "web",
        parser,
        canonical,
        shelf,
        rawDir
      }
    };
  }

  const fetched = await fetchHtml(canonical, {
    timeoutMs,
    fetchImpl,
    resolveLightpandaImpl,
    spawnImpl,
    hintFlagPath,
    lightpandaPlatformSupported
  });

  // PDF branch still goes through plain fetch (fetched.response is set when lightpanda was skipped)
  if (fetched.via === "plain") {
    const response = fetched.response;
    if (!response.ok) {
      throw new IngestError(
        `Fetch failed: ${canonical} returned ${response.status} ${response.statusText || ""}`.trim(),
        "FETCH_FAILED"
      );
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/pdf")) {
      return await ingestPdfResponse({
        response,
        canonical,
        rawDir,
        assetsDir: options.assetsDir,
        eventsPath,
        overwrite,
        documentOptions,
        shelf,
        name,
        vaultRoot,
        signalsDir,
        apply,
        interactive,
        now
      });
    }
  }

  const html = fetched.html;
  const parser = fetched.parser;
  const { title, markdown } = await extractArticle(html, canonical);

  const baseSlug = slugify(title);
  const frontmatter = buildFrontmatter({
    source: canonical,
    kind: "web",
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
    source: canonical,
    title,
    body: `${frontmatter}\n${markdown.trimEnd()}`,
    kind: "web",
    parser,
    overwrite,
    apply,
    interactive,
    now
  });
}

async function fetchHtml(url, {
  timeoutMs,
  fetchImpl,
  resolveLightpandaImpl,
  spawnImpl,
  hintFlagPath,
  lightpandaPlatformSupported
}) {
  const lp = await resolveLightpandaImpl();

  if (lp) {
    try {
      const result = spawnImpl(lp, ["fetch", "--dump", url], {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      });
      if (result && result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
        return { via: "lightpanda", html: result.stdout, parser: "lightpanda+readability+turndown" };
      }
      console.warn(`[lightpanda] fetch failed for ${url} (exit ${result?.status ?? "?"}), falling back to plain fetch`);
    } catch (err) {
      console.warn(`[lightpanda] spawn error for ${url}: ${err.message}, falling back to plain fetch`);
    }
  } else if (lightpandaPlatformSupported) {
    await maybeShowLightpandaHint(hintFlagPath);
  }

  const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
  if (!response.ok) {
    return { via: "plain", response, html: "", parser: "readability+turndown" };
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    return { via: "plain", response, html: "", parser: "readability+turndown" };
  }
  const html = await response.text();
  return { via: "plain", response, html, parser: "readability+turndown" };
}

async function maybeShowLightpandaHint(hintFlagPath) {
  try {
    await fs.access(hintFlagPath);
    return; // already shown
  } catch {
    // fall through
  }
  try {
    await fs.mkdir(path.dirname(hintFlagPath), { recursive: true });
    await fs.writeFile(hintFlagPath, new Date().toISOString());
    console.log("Tip: run `dotaios setup` to install Lightpanda for better web scraping.");
  } catch {
    // non-fatal — never block ingest because of the hint
  }
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

async function ingestPdfResponse({
  response,
  canonical,
  rawDir,
  assetsDir,
  eventsPath,
  overwrite,
  documentOptions,
  shelf,
  name,
  vaultRoot,
  signalsDir,
  apply,
  interactive,
  now
}) {
  if (!assetsDir) {
    throw new IngestError("URL returned a PDF but ingestUrl was not given options.assetsDir", "ASSETS_DIR_REQUIRED");
  }

  const { ingestDocument } = await import("./pdf.mjs");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-url-pdf-"));
  const assetName = assetNameFromUrl(canonical);
  const tempPath = path.join(tmpRoot, assetName);

  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(tempPath, buffer);
    return await ingestDocument(tempPath, {
      rawDir,
      assetsDir,
      eventsPath,
      overwrite,
      sourceOverride: canonical,
      titleOverride: path.basename(assetName, path.extname(assetName)),
      assetName,
      shelf,
      name,
      vaultRoot,
      signalsDir,
      apply,
      interactive,
      now,
      ...documentOptions
    });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function assetNameFromUrl(canonical) {
  const url = new URL(canonical);
  const baseName = path.basename(url.pathname);
  if (baseName && baseName.toLowerCase().endsWith(".pdf")) return baseName;
  const stem = slugify(baseName || url.hostname || "download");
  return `${stem}.pdf`;
}
