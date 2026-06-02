import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent, appendSignal, isoDate } from "../../../core/src/memory.mjs";
import { pathExists } from "../../../core/src/files.mjs";
import { resolveMarkdownDestination } from "./destinations.mjs";
import { slugify } from "./frontmatter.mjs";

// The shelves a user (or agent) can route an ingested item to.
//   raw     -> vault/raw/<slug>.md            (default, today's behavior)
//   wiki    -> vault/wiki/<slug>/_index.md    (lasting knowledge)
//   company -> vault/org/companies/<slug>.md  (durable org record)
//   person  -> vault/org/people/<slug>.md     (durable org record)
//   signal  -> memory/signals/<date>.jsonl    (transient working note)
export const SHELVES = ["raw", "wiki", "company", "person", "signal"];

// wiki / company / person are "durable" knowledge shelves. CLAUDE.md requires
// user approval before writing them, so a non-interactive caller (an agent)
// only gets a preview unless it passes --apply.
const DURABLE_SHELVES = new Set(["wiki", "company", "person"]);

// company / person are records about a named entity — they need an explicit
// --name (or an interactive answer) to know the destination file.
const NAME_REQUIRED_SHELVES = new Set(["company", "person"]);

// Signal notes shorter than this are stored inline in the JSONL entry. Longer
// parsed documents are preserved as markdown in vault/raw and linked.
const SIGNAL_INLINE_LIMIT = 1500;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function isShelf(value) {
  return SHELVES.includes(value);
}

export function isDurableShelf(shelf) {
  return DURABLE_SHELVES.has(shelf);
}

export function shelfNeedsName(shelf) {
  return NAME_REQUIRED_SHELVES.has(shelf);
}

/**
 * Absolute path of the markdown file a non-raw markdown shelf writes to.
 */
export function shelfMarkdownPath({ shelf, vaultRoot, slug }) {
  if (shelf === "wiki") return path.join(vaultRoot, "wiki", slug, "_index.md");
  if (shelf === "company") return path.join(vaultRoot, "org", "companies", `${slug}.md`);
  if (shelf === "person") return path.join(vaultRoot, "org", "people", `${slug}.md`);
  throw new Error(`shelfMarkdownPath: not a markdown shelf: ${shelf}`);
}

function shelfSlug({ shelf, name, baseSlug }) {
  if (shelf === "wiki") return name ? slugify(name) : baseSlug;
  return slugify(name); // company / person — name is guaranteed by the caller
}

/**
 * Human-readable destination for --dry-run, without touching disk.
 */
export function describeShelfTarget({ shelf, vaultRoot, rawDir, signalsDir, name, baseSlug }) {
  if (shelf === "raw") return path.join(rawDir, `${baseSlug}.md`);
  if (shelf === "signal") return signalsDir ? path.join(signalsDir, `${todayStamp()}.jsonl`) : "memory/signals";
  return shelfMarkdownPath({ shelf, vaultRoot, slug: shelfSlug({ shelf, name, baseSlug }) });
}

export function todayStamp(now = () => new Date()) {
  return isoDate(now());
}

function ensureTrailingNewline(body) {
  return body.endsWith("\n") ? body : `${body}\n`;
}

function stripFrontmatter(body) {
  return body.replace(FRONTMATTER_RE, "");
}


/**
 * Write an ingested markdown payload to its shelf.
 *
 * The ingest modules (web/pdf/text) build the markdown body and hand it here;
 * this function owns destination resolution, the durable-shelf approval gate,
 * the write, and the audit-trail event.
 *
 * @param {object} opts
 * @param {string}  opts.shelf        raw | wiki | company | person | signal
 * @param {string|null} opts.name     entity/reference name (durable shelves)
 * @param {string}  opts.vaultRoot    absolute path to the vault
 * @param {string}  opts.rawDir       absolute path to vault/raw
 * @param {string}  opts.signalsDir   absolute path to memory/signals
 * @param {string}  opts.eventsPath   absolute path to memory/events.jsonl
 * @param {string}  opts.baseSlug     slug derived from the content title
 * @param {string}  opts.source       canonical source (URL or file path)
 * @param {string}  opts.title        human-readable title
 * @param {string}  opts.body         full markdown body (frontmatter included)
 * @param {string}  opts.kind         web | pdf | document | text
 * @param {string}  opts.parser       parser id for the audit trail
 * @param {boolean} [opts.overwrite]  replace an existing raw destination
 * @param {boolean} [opts.apply]      approve a durable write (non-interactive)
 * @param {boolean} [opts.interactive] a human is driving this invocation
 * @param {string}  [opts.asset]      preserved-original path, if any
 * @param {string}  [opts.warning]    parser warning to surface
 * @param {Function} [opts.now]       clock override (testing)
 */
export async function placeMarkdown(opts) {
  const {
    shelf = "raw",
    name = null,
    vaultRoot,
    rawDir,
    signalsDir,
    eventsPath,
    baseSlug,
    source,
    title,
    body,
    kind,
    parser,
    overwrite = false,
    apply = false,
    interactive = false,
    asset = null,
    warning = null,
    now = () => new Date()
  } = opts;

  if (shelf === "raw") {
    return placeRaw({ rawDir, eventsPath, baseSlug, source, title, body, kind, parser, overwrite, asset, warning });
  }

  if (shelf === "signal") {
    return placeSignal({ rawDir, signalsDir, eventsPath, baseSlug, source, title, body, kind, parser, overwrite, asset, now });
  }

  // wiki | company | person — durable knowledge shelves.
  const slug = shelfSlug({ shelf, name, baseSlug });
  const destination = shelfMarkdownPath({ shelf, vaultRoot, slug });
  const exists = await pathExists(destination);

  // Approval gate: an agent/script (no TTY) must pass --apply to write a
  // durable shelf. A human in the terminal has already approved by choosing it.
  if (!interactive && !apply) {
    return {
      action: "preview",
      shelf,
      destination,
      slug,
      kind,
      parser,
      canonical: source,
      willAppend: exists
    };
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });

  if (exists) {
    const existing = await fs.readFile(destination, "utf8");
    const addition = stripFrontmatter(body).trim();
    const merged = `${existing.replace(/\s*$/, "")}\n\n## Ingested ${todayStamp(now)}\n\n${addition}\n`;
    await fs.writeFile(destination, merged);
  } else {
    await fs.writeFile(destination, ensureTrailingNewline(body));
  }

  await appendEvent(eventsPath, {
    type: "ingest",
    source,
    destination,
    kind,
    parser,
    summary: title,
    shelf,
    ...(asset ? { asset } : {})
  });

  return {
    action: exists ? "appended" : "written",
    shelf,
    destination,
    slug,
    kind,
    parser,
    canonical: source,
    ...(asset ? { asset } : {}),
    ...(warning ? { warning } : {})
  };
}

async function placeRaw({ rawDir, eventsPath, baseSlug, source, title, body, kind, parser, overwrite, asset, warning }) {
  const target = await resolveMarkdownDestination({ rawDir, baseSlug, source, overwrite });

  if (target.action === "skip") {
    return {
      action: "skipped",
      destination: target.destination,
      slug: target.slug,
      parser,
      kind,
      canonical: source,
      ...(asset ? { asset } : {})
    };
  }

  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(target.destination, ensureTrailingNewline(body));

  await appendEvent(eventsPath, {
    type: "ingest",
    source,
    destination: target.destination,
    kind,
    parser,
    summary: title,
    ...(asset ? { asset } : {})
  });

  return {
    action: "written",
    destination: target.destination,
    slug: target.slug,
    parser,
    kind,
    canonical: source,
    ...(asset ? { asset } : {}),
    ...(warning ? { warning } : {})
  };
}

async function placeSignal({ rawDir, signalsDir, eventsPath, baseSlug, source, title, body, kind, parser, overwrite, asset, now }) {
  const inline = stripFrontmatter(body).trim();
  let destination = null;

  if (inline.length > SIGNAL_INLINE_LIMIT) {
    // Long parsed document: preserve the markdown in vault/raw, link the signal.
    const target = await resolveMarkdownDestination({ rawDir, baseSlug, source, overwrite });
    if (target.action !== "skip") {
      await fs.mkdir(rawDir, { recursive: true });
      await fs.writeFile(target.destination, ensureTrailingNewline(body));
    }
    destination = target.destination;
  }

  await appendSignal(signalsDir, {
    type: "ingest-note",
    summary: title,
    source,
    ...(destination ? { destination } : { note: inline })
  });

  await appendEvent(eventsPath, {
    type: "ingest",
    source,
    destination,
    kind,
    parser,
    summary: title,
    shelf: "signal",
    ...(asset ? { asset } : {})
  });

  return {
    action: "written",
    shelf: "signal",
    destination,
    kind,
    parser,
    canonical: source,
    ...(asset ? { asset } : {})
  };
}
