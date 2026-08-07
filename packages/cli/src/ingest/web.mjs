import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { canonicalizeUrl } from "./canonical-url.mjs";
import { buildFrontmatter, slugify } from "./frontmatter.mjs";
import { describeShelfTarget, placeMarkdown } from "./placement.mjs";
import { resolveLightpanda, lightpandaPlatformBinary } from "../../../core/src/lightpanda.mjs";
import { lightpandaHintFlagPath } from "../../../core/src/paths.mjs";
import { pathExists } from "../../../core/src/files.mjs";

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const PARSER_LIGHTPANDA = "lightpanda+readability+turndown";
export const PARSER_PLAIN = "readability+turndown";
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
  const [linkedom, readability, turndown] = await Promise.all([
    import("linkedom"),
    import("@mozilla/readability"),
    import("turndown")
  ]);
  _deps = {
    parseHTML: linkedom.parseHTML,
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
    hintFlagPath = lightpandaHintFlagPath(),
    lightpandaPlatformSupported = lightpandaPlatformBinary() !== null
  } = options;

  const canonical = canonicalizeUrl(rawInput);

  if (dryRun) {
    const lp = await resolveLightpandaImpl();
    const parser = lp ? PARSER_LIGHTPANDA : PARSER_PLAIN;
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
  const looksLikePdfUrl = /\.pdf($|[?#])/i.test(url);
  const lp = looksLikePdfUrl ? null : await resolveLightpandaImpl();

  if (lp) {
    try {
      const result = spawnImpl(lp, ["fetch", "--dump", "html", url], {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      });
      if (result && result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
        return { via: "lightpanda", html: result.stdout, parser: PARSER_LIGHTPANDA };
      }
      console.warn(`[lightpanda] fetch failed for ${url} (exit ${result?.status ?? "?"}), falling back to plain fetch`);
    } catch (err) {
      console.warn(`[lightpanda] spawn error for ${url}: ${err.message}, falling back to plain fetch`);
    }
  } else if (!looksLikePdfUrl && lightpandaPlatformSupported) {
    await maybeShowLightpandaHint(hintFlagPath);
  }

  const response = await fetchWithTimeout(url, { timeoutMs, fetchImpl });
  if (!response.ok) {
    return { via: "plain", response, html: "", parser: PARSER_PLAIN };
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    return { via: "plain", response, html: "", parser: PARSER_PLAIN };
  }
  const html = await response.text();
  return { via: "plain", response, html, parser: PARSER_PLAIN };
}

async function maybeShowLightpandaHint(hintFlagPath) {
  if (await pathExists(hintFlagPath)) return;
  try {
    await fs.mkdir(path.dirname(hintFlagPath), { recursive: true });
    await fs.writeFile(hintFlagPath, new Date().toISOString());
    console.log("Tip: run `dotaios setup` to enable JavaScript-rendered web pages (better content from modern sites).");
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
  const { parseHTML, Readability, TurndownService } = await loadDeps();

  const { document } = parseHTML(html);
  for (const sel of STRIP_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) el.remove();
  }

  // Readability mutates the document, so capture the fallback title first.
  const fallbackTitle = extractFallbackTitle(document);
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
  const title = (article.title || fallbackTitle || sourceUrl).trim();

  const blocked = detectBlockedExtraction(markdown);
  if (blocked) {
    throw new IngestError(
      `Page returned ${blocked} instead of content. Nothing was saved. Open the page in a browser, save it as PDF, and re-ingest that file.`,
      "EXTRACTION_BLOCKED"
    );
  }

  return { title, markdown };
}

// Readability parses a consent wall or a video-player shell into a perfectly
// valid, non-empty article, so the null check above passes and the boilerplate
// lands in the vault wearing the real page's title and URL. Length cannot
// separate the two: a genuine short capture runs ~450 bytes while a YouTube
// consent wall runs ~1,700, so any byte floor that caught the walls would
// discard real captures.
const BLOCKED_EXTRACTION_SIGNATURES = [
  [/X and its partners use cookies/i, "a cookie-consent wall"],
  [/Did someone say\s*(?:…|\.\.\.)?\s*cookies\?/i, "a cookie-consent wall"],
  [/Before you continue to YouTube/i, "a cookie-consent wall"],
  [/If playback doesn.{0,3}t begin shortly/i, "a video-player shell"],
  [/Your browser can.{0,3}t play this video/i, "a video-player error"]
];

export function detectBlockedExtraction(markdown) {
  const text = String(markdown || "");
  for (const [pattern, reason] of BLOCKED_EXTRACTION_SIGNATURES) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function extractFallbackTitle(document) {
  return (
    document.querySelector("title")?.textContent.trim() ||
    document.querySelector("h1")?.textContent.trim() ||
    ""
  );
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
