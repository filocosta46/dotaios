import crypto from "node:crypto";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Build the YAML frontmatter block used by every ingest output.
 *
 * @param {object} fields
 * @param {string} fields.source        URL or absolute file path the content came from
 * @param {string} fields.kind          web | pdf | document | text | binary
 * @param {string} fields.parser        readability+turndown | marker-local | unpdf | copy
 * @param {string} fields.title         human-readable title
 * @param {string} [fields.ingestedAt]  ISO timestamp; defaults to now
 * @param {string[]} [fields.tags]      defaults to []
 * @returns {string} YAML frontmatter block, terminated with a trailing newline
 */
export function buildFrontmatter({ source, kind, parser, title, ingestedAt, tags = [] }) {
  if (!source) throw new Error("Frontmatter requires a source");
  if (!kind) throw new Error("Frontmatter requires a kind");
  if (!parser) throw new Error("Frontmatter requires a parser");
  if (!title) throw new Error("Frontmatter requires a title");

  const ts = ingestedAt || new Date().toISOString();
  const safeTitle = escapeYamlBlockScalar(title);
  const safeSource = escapeYamlBlockScalar(source);
  const tagsBlock = formatTags(tags);

  return [
    "---",
    `source: ${safeSource}`,
    `ingested_at: ${ts}`,
    `kind: ${kind}`,
    `parser: ${parser}`,
    `title: ${safeTitle}`,
    `tags: ${tagsBlock}`,
    "---",
    ""
  ].join("\n");
}

/**
 * Prepend frontmatter to body if not already present. Used for text passthrough.
 */
export function ensureFrontmatter(body, fields) {
  if (FRONTMATTER_RE.test(body)) return body;
  return `${buildFrontmatter(fields)}\n${body}`;
}

/**
 * Slugify a title to a safe filename stem (kebab-case, ASCII).
 * Empty result falls back to "untitled".
 */
export function slugify(title) {
  const ascii = String(title)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return ascii || "untitled";
}

/**
 * Append an 8-char SHA256 suffix derived from `key` to disambiguate slug collisions.
 */
export function disambiguateSlug(slug, key) {
  const suffix = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${slug}-${suffix}`;
}

function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return "[]";
  const items = tags.map((tag) => escapeYamlFlowScalar(String(tag))).join(", ");
  return `[${items}]`;
}

const RESERVED_YAML_LEADERS = new Set([
  "&", "*", "!", "|", ">", "'", '"', "%", "@", "`", "#", "?", "-"
]);

function escapeYamlBlockScalar(value) {
  const str = String(value);
  if (str.length === 0) return '""';
  if (
    /[\n\r"\\]/.test(str) ||
    /:\s/.test(str) ||
    /\s#/.test(str) ||
    /^\s|\s$/.test(str) ||
    RESERVED_YAML_LEADERS.has(str[0])
  ) {
    return quote(str);
  }
  return str;
}

function escapeYamlFlowScalar(value) {
  const str = String(value);
  if (str.length === 0) return '""';
  if (
    /[\n\r"\\,\[\]\{\}\s]/.test(str) ||
    /:\s/.test(str) ||
    RESERVED_YAML_LEADERS.has(str[0])
  ) {
    return quote(str);
  }
  return str;
}

function quote(str) {
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
