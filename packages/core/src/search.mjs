import fs from "node:fs/promises";
import path from "node:path";

export const SEARCH_SCOPES = ["memory", "vault", "context", "skills", "references", "plugins", "all"];

const DEFAULT_LIMIT = 20;
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".obsidian", ".trash"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/,
  /^credentials(?:\.|$)/i,
  /^token(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i
];

export async function searchAios({
  aiosPath,
  vaultPath,
  query,
  scope = "all",
  limit = DEFAULT_LIMIT
}) {
  const scopes = scope === "all"
    ? ["context", "memory", "vault", "projects", "skills", "references", "plugins"]
    : [scope];

  const groups = [];
  for (const name of scopes) {
    const results = await searchScope(name, { aiosPath, vaultPath, query, limit });
    groups.push({ scope: name, results });
  }
  return groups;
}

export async function searchScope(scope, { aiosPath, vaultPath, query, limit = DEFAULT_LIMIT }) {
  if (scope === "memory") {
    return searchMemoryDir(path.join(aiosPath, "memory"), query, { limit });
  }
  if (scope === "context") {
    return searchMarkdownDir(path.join(aiosPath, "context"), query, {
      limit,
      sourcePrefix: "context"
    });
  }
  if (scope === "vault") {
    return searchMarkdownDir(vaultPath || path.join(aiosPath, "vault"), query, {
      limit,
      sourcePrefix: "vault"
    });
  }
  if (scope === "projects") {
    return searchMarkdownDir(path.join(aiosPath, "projects"), query, {
      limit,
      sourcePrefix: "projects"
    });
  }
  if (scope === "skills") {
    return searchMarkdownDir(path.join(aiosPath, "skills"), query, {
      limit,
      sourcePrefix: "skills",
      extensions: [".md"]
    });
  }
  if (scope === "references") {
    return searchMarkdownDir(path.join(aiosPath, "references"), query, {
      limit,
      sourcePrefix: "references",
      extensions: [".md"]
    });
  }
  if (scope === "plugins") {
    return searchMarkdownDir(path.join(aiosPath, "plugins"), query, {
      limit,
      sourcePrefix: "plugins",
      extensions: [".md", ".json"],
      includeFile: (filePath) => filePath.endsWith(".md") || path.basename(filePath) === "manifest.json"
    });
  }
  return [];
}

export function matchQuery(text, query) {
  const haystack = String(text || "").toLowerCase();
  const phrase = normalizeQuery(query);
  if (!phrase) return { matched: false, kind: null };

  if (haystack.includes(phrase)) {
    return { matched: true, kind: "phrase" };
  }

  const terms = queryTerms(query);
  if (terms.length > 1 && terms.every((term) => haystack.includes(term))) {
    return { matched: true, kind: "terms" };
  }

  return { matched: false, kind: null };
}

export async function searchMemoryDir(memoryDir, query, { limit = DEFAULT_LIMIT } = {}) {
  const events = await searchJsonlEntries(path.join(memoryDir, "events.jsonl"), query, {
    source: "memory/events.jsonl"
  });
  const archived = await searchJsonlEntries(path.join(memoryDir, "events-archive.jsonl"), query, {
    source: "memory/events-archive.jsonl"
  });
  const signals = await searchSignalEntries(path.join(memoryDir, "signals"), query);

  return [...events, ...archived, ...signals]
    .sort(compareMemoryResults)
    .slice(0, limit);
}

export async function searchJsonlEntries(filePath, query, { source }) {
  const entries = await readJsonl(filePath);
  const results = [];
  for (const entry of entries) {
    const match = matchJsonEntry(entry, query);
    if (!match) continue;
    results.push({
      source,
      match,
      matchedField: match.field === "summary" ? null : match.field,
      matchedSnippet: match.field === "summary" ? null : match.value,
      ...entry
    });
  }
  return results;
}

export async function searchMarkdownDir(dir, query, {
  limit = DEFAULT_LIMIT,
  sourcePrefix = path.basename(dir),
  extensions = [".md"],
  includeFile = null
} = {}) {
  const files = await listSearchFiles(dir, { extensions, includeFile });
  const results = [];

  for (const filePath of files) {
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      console.warn(`[dotaios] Warning: Could not read file ${filePath} (${err.message})`);
      continue;
    }

    const snippets = buildMarkdownSnippets(content, query);
    if (snippets.length === 0) continue;

    const relative = path.relative(dir, filePath);
    const title = readTitle(content) || relative;
    const pathMatch = matchQuery(relative, query);
    const titleMatch = matchQuery(title, query);
    const score = scoreMarkdownResult({ snippets, pathMatch, titleMatch });

    results.push({
      source: `${sourcePrefix}/${relative}`,
      file: relative,
      title,
      matches: snippets.slice(0, 5),
      score
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map(({ score, ...result }) => result);
}

export function buildMarkdownSnippets(content, query, { contextLines = 1 } = {}) {
  const lines = String(content || "").split("\n");
  const candidates = [];
  const frontmatterDescription = readFrontmatterDescription(content);

  if (frontmatterDescription) {
    const match = matchQuery(frontmatterDescription, query);
    if (match.matched) {
      candidates.push({
        line: 1,
        lineEnd: 1,
        content: `description: ${frontmatterDescription}`,
        match,
        area: "description"
      });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = matchQuery(line, query);
    if (!match.matched) continue;

    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const excerpt = lines
      .slice(start, end + 1)
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" / ");

    candidates.push({
      line: start + 1,
      lineEnd: end + 1,
      content: excerpt || line.trim(),
      match,
      area: line.trim().startsWith("#") ? "heading" : "body"
    });
  }

  const fileMatch = matchQuery(content, query);
  if (candidates.length === 0 && fileMatch.matched) {
    for (const index of termLineIndexes(lines, query).slice(0, 5)) {
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length - 1, index + contextLines);
      const excerpt = lines
        .slice(start, end + 1)
        .map((value) => value.trim())
        .filter(Boolean)
        .join(" / ");

      candidates.push({
        line: start + 1,
        lineEnd: end + 1,
        content: excerpt || lines[index].trim(),
        match: fileMatch,
        area: lines[index].trim().startsWith("#") ? "heading" : "body"
      });
    }
  }

  const seen = new Set();
  return candidates
    .sort(compareSnippetCandidates)
    .filter((candidate) => {
      const key = `${candidate.line}:${candidate.lineEnd}:${candidate.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ match, area, ...snippet }) => ({
      ...snippet,
      match: match.kind,
      area
    }));
}

export function markMatches(value, query) {
  let output = String(value || "");
  const phrase = normalizeQuery(query);
  if (!phrase) return output;

  const phrasePattern = new RegExp(escapeRegExp(phrase), "ig");
  if (phrasePattern.test(output)) {
    return output.replace(phrasePattern, (match) => `>>${match}<<`);
  }

  for (const term of queryTerms(query)) {
    const termPattern = new RegExp(escapeRegExp(term), "ig");
    output = output.replace(termPattern, (match) => `>>${match}<<`);
  }
  return output;
}

async function searchSignalEntries(signalsDir, query) {
  let files;
  try {
    files = (await fs.readdir(signalsDir)).filter((file) => file.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }

  const results = [];
  for (const file of files) {
    results.push(...await searchJsonlEntries(path.join(signalsDir, file), query, {
      source: `memory/signals/${file}`
    }));
  }
  return results;
}

function matchJsonEntry(entry, query) {
  const fields = flattenEntry(entry);
  const summary = fields.find((field) => field.name === "summary");
  const ordered = summary ? [summary, ...fields.filter((field) => field !== summary)] : fields;

  let best = null;
  for (const field of ordered) {
    const match = matchQuery(field.value, query);
    if (!match.matched) continue;
    const candidate = {
      field: field.name,
      value: truncate(field.value, 160),
      kind: match.kind,
      score: match.kind === "phrase" ? 2 : 1
    };
    if (!best || candidate.score > best.score || (best.field !== "summary" && candidate.field === "summary")) {
      best = candidate;
    }
  }

  if (best) return best;

  const serialized = JSON.stringify(entry);
  const whole = matchQuery(serialized, query);
  if (!whole.matched) return null;
  return {
    field: "entry",
    value: truncate(serialized, 160),
    kind: whole.kind,
    score: whole.kind === "phrase" ? 2 : 1
  };
}

function flattenEntry(value, prefix = "") {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenEntry(item, `${prefix}[${index}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => flattenEntry(child, prefix ? `${prefix}.${key}` : key));
  }
  return [{ name: prefix || "value", value: String(value) }];
}

function compareMemoryResults(a, b) {
  const scoreA = a.match?.score || (a.match?.kind === "phrase" ? 2 : 1);
  const scoreB = b.match?.score || (b.match?.kind === "phrase" ? 2 : 1);
  if (scoreA !== scoreB) return scoreB - scoreA;
  return compareTimestampsDesc(a.ts, b.ts);
}

function compareSnippetCandidates(a, b) {
  const areaScore = { description: 3, heading: 2, body: 1 };
  const matchScore = { phrase: 2, terms: 1 };
  return (matchScore[b.match.kind] - matchScore[a.match.kind])
    || (areaScore[b.area] - areaScore[a.area])
    || (a.line - b.line);
}

function scoreMarkdownResult({ snippets, pathMatch, titleMatch }) {
  const bestSnippet = snippets[0];
  const matchScore = bestSnippet?.match === "phrase" ? 100 : 60;
  const areaBoost = bestSnippet?.area === "description" ? 30 : bestSnippet?.area === "heading" ? 20 : 0;
  const titleBoost = titleMatch.matched ? 25 : 0;
  const pathBoost = pathMatch.matched ? 10 : 0;
  return matchScore + areaBoost + titleBoost + pathBoost;
}

async function listSearchFiles(dir, { extensions, includeFile }) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listSearchFiles(fullPath, { extensions, includeFile }));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.includes(ext)) continue;
      if (includeFile && !includeFile(fullPath)) continue;
      results.push(fullPath);
    }
  }
  return results.sort();
}

function shouldSkipEntry(name) {
  if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) return true;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

async function readJsonl(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function readTitle(content) {
  const stripped = stripFrontmatter(content);
  const heading = stripped.split("\n").find((line) => line.startsWith("# "));
  return heading?.replace(/^#\s+/, "").trim() || null;
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

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function queryTerms(query) {
  return normalizeQuery(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function termLineIndexes(lines, query) {
  const terms = queryTerms(query);
  const indexes = [];
  const seen = new Set();
  for (const term of terms) {
    const index = lines.findIndex((line) => line.toLowerCase().includes(term));
    if (index !== -1 && !seen.has(index)) {
      indexes.push(index);
      seen.add(index);
    }
  }
  return indexes.sort((a, b) => a - b);
}

function compareTimestampsDesc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
