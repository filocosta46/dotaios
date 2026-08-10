import path from "node:path";
import { createEvidenceReader } from "./evidence-reader.mjs";
import { isPathWithinLexically } from "./paths.mjs";
import { resolvePortableProjectIdentity, validateProjectSelector } from "./projects.mjs";

export const SEARCH_SCOPES = ["memory", "vault", "context", "projects", "decisions", "skills", "references", "plugins", "sessions", "all"];

const DEFAULT_LIMIT = 20;
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".obsidian", ".trash"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/,
  /^credentials(?:\.|$)/i,
  /^token(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i
];

// --- Ranking ---
//
// The ONE ranking function for every reader (CLI search, MCP search_aios, the
// session digest all funnel through searchAios/searchMemoryDir/searchMarkdownDir).
// Scores are deterministic and composed as:
//
//   rank = tier(kind) * 1e6  +  (Σ idf(matched term) + structuralBoost) * decay(age)
//
//   tier:  phrase 3, all-terms 2, partial 1. An exact substring hit sits in a
//          tier no amount of recency or rarity can cross — a literal error
//          string always beats a paraphrase.
//   idf:   BM25-style log(1 + (N − df + ½)/(df + ½)) over the scanned corpus.
//          A term present in every document weighs ~0 ("thanks!"), a rare
//          token (an error string, a flag name) dominates.
//   decay: 2^(−age / RECENCY_HALF_LIFE_DAYS), from the entry ts (memory) or
//          the file mtime (markdown). Missing age means no penalty. Newer wins
//          when lexical relevance is otherwise close.
//
// TODO(L1-5): buildCorpusStats tokenizes the scanned candidate set per query.
// The persistent incremental term-frequency cache replaces buildCorpusStats
// call sites (rebuild on changed files only) without touching rankSearchHit.

export const RECENCY_HALF_LIFE_DAYS = 30;
const RANK_TIER_WEIGHT = 1_000_000;
const RANK_TIERS = { phrase: 3, terms: 2, partial: 1 };
const TOKEN_SPLIT_RE = /[^a-z0-9_-]+/;

export function tokenizeForCorpus(text) {
  return String(text || "").toLowerCase().split(TOKEN_SPLIT_RE).filter(Boolean);
}

export function buildCorpusStats(docs) {
  const docFrequency = new Map();
  let docCount = 0;
  for (const doc of docs) {
    docCount += 1;
    for (const token of new Set(tokenizeForCorpus(doc))) {
      docFrequency.set(token, (docFrequency.get(token) || 0) + 1);
    }
  }
  return { docCount, docFrequency };
}

export function idfWeight(term, corpus) {
  if (!corpus || !corpus.docCount) return 1;
  const df = corpus.docFrequency.get(String(term).toLowerCase()) || 0;
  return Math.log(1 + (corpus.docCount - df + 0.5) / (df + 0.5));
}

export function recencyDecay(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  // Whole-day buckets: entries from the same day decay identically, so
  // sub-second mtime jitter can never reorder otherwise-equal results —
  // "newer wins" only when the age difference is a real one.
  const ageDays = Math.floor(ageMs / 86_400_000);
  return Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function rankSearchHit({ kind, matchedTerms = [], corpus = null, ageMs = null, structuralBoost = 0 }) {
  const tier = RANK_TIERS[kind] || 0;
  if (tier === 0) return 0;
  const idfSum = matchedTerms.reduce((sum, term) => sum + idfWeight(term, corpus), 0);
  const within = Math.min((idfSum + structuralBoost) * recencyDecay(ageMs), RANK_TIER_WEIGHT - 1);
  return tier * RANK_TIER_WEIGHT + within;
}

export async function searchAios({
  aiosPath,
  vaultPath,
  query,
  scope = "all",
  limit = DEFAULT_LIMIT,
  sessionFilters = {},
  projectSelector = null,
  evidenceReader = null
}) {
  const resolvedAiosPath = path.resolve(aiosPath);
  const resolvedVaultPath = path.resolve(vaultPath || path.join(aiosPath, "vault"));
  const vaultRoot = isPathWithinLexically(resolvedAiosPath, resolvedVaultPath)
    ? resolvedAiosPath
    : resolvedVaultPath;
  const reader = evidenceReader || createEvidenceReader({ roots: [resolvedAiosPath, vaultRoot] });
  if (scope === "projects" && !projectSelector) validateProjectSelector(projectSelector);
  const projectIdentity = projectSelector
    ? await resolvePortableProjectIdentity({
        aiosPath: resolvedAiosPath,
        projectSelector,
        evidenceReader: reader
      })
    : null;
  const scopes = scope === "all"
    ? [
        "sessions",
        "context",
        "memory",
        "vault",
        ...(projectIdentity ? ["projects"] : []),
        "decisions",
        "skills",
        "references",
        "plugins"
      ]
    : [scope];

  // Scopes are independent; run them concurrently. Promise.all preserves input
  // order, so the returned groups stay in the same order as before.
  const groups = await Promise.all(
    scopes.map(async (name) => ({
      scope: name,
      results: await searchScope(name, {
        aiosPath: resolvedAiosPath,
        vaultPath: resolvedVaultPath,
        vaultRoot,
        query,
        limit,
        projectIdentity,
        sessionFilters,
        reader
      })
    }))
  );
  return new Proxy(groups, {
    get(target, property, receiver) {
      if (property === "scope") {
        return Object.freeze({
          requested: scope,
          project: projectIdentity?.slug || null,
          project_id: projectIdentity?.id || null,
          projects_omitted: scope === "all" && projectIdentity === null
        });
      }
      return Reflect.get(target, property, receiver);
    }
  });
}

async function searchScope(scope, {
  aiosPath,
  vaultPath,
  vaultRoot,
  query,
  limit = DEFAULT_LIMIT,
  projectIdentity = null,
  sessionFilters = {},
  reader
}) {
  if (scope === "sessions") {
    return searchSessionsScope(aiosPath, query, { limit, reader, ...sessionFilters });
  }
  if (scope === "memory") {
    return searchMemoryDir(path.join(aiosPath, "memory"), query, {
      limit,
      reader,
      root: aiosPath
    });
  }
  if (scope === "context") {
    return searchMarkdownDir(path.join(aiosPath, "context"), query, {
      limit,
      sourcePrefix: "context",
      reader,
      root: aiosPath
    });
  }
  if (scope === "vault") {
    return searchMarkdownDir(vaultPath, query, {
      limit,
      sourcePrefix: "vault",
      reader,
      root: vaultRoot
    });
  }
  if (scope === "projects") {
    if (!projectIdentity) validateProjectSelector(null);
    return searchMarkdownDir(path.join(aiosPath, "projects", projectIdentity.slug), query, {
      limit,
      sourcePrefix: `projects/${projectIdentity.slug}`,
      reader,
      root: aiosPath
    });
  }
  if (scope === "decisions") {
    return searchMarkdownDir(path.join(aiosPath, "decisions"), query, {
      limit,
      sourcePrefix: "decisions",
      reader,
      root: aiosPath
    });
  }
  if (scope === "skills") {
    return searchMarkdownDir(path.join(aiosPath, "skills"), query, {
      limit,
      sourcePrefix: "skills",
      extensions: [".md"],
      reader,
      root: aiosPath
    });
  }
  if (scope === "references") {
    return searchMarkdownDir(path.join(aiosPath, "references"), query, {
      limit,
      sourcePrefix: "references",
      extensions: [".md"],
      reader,
      root: aiosPath
    });
  }
  if (scope === "plugins") {
    return searchMarkdownDir(path.join(aiosPath, "plugins"), query, {
      limit,
      sourcePrefix: "plugins",
      extensions: [".md", ".json"],
      includeFile: (filePath) => filePath.endsWith(".md") || path.basename(filePath) === "manifest.json",
      reader,
      root: aiosPath
    });
  }
  return [];
}

export function matchQuery(text, query) {
  const haystack = String(text || "").toLowerCase();
  const phrase = normalizeQuery(query);
  if (!phrase) return { matched: false, kind: null, score: 0 };

  if (haystack.includes(phrase)) {
    const freq = countOccurrences(haystack, phrase);
    return { matched: true, kind: "phrase", score: 10 + Math.min(freq - 1, 5) };
  }

  const terms = queryTerms(query);
  if (terms.length > 1) {
    const present = terms.filter((term) => haystack.includes(term));
    if (present.length === terms.length) {
      const freq = terms.reduce((sum, term) => sum + countOccurrences(haystack, term), 0);
      return { matched: true, kind: "terms", score: 5 + Math.min(freq - terms.length, 5) };
    }
    // Partial matches are rankable (IDF decides their weight) instead of
    // being dropped — a rare token alone must be findable.
    if (present.length > 0) {
      return { matched: true, kind: "partial", score: present.length };
    }
  }

  return { matched: false, kind: null, score: 0 };
}

export async function searchMemoryDir(memoryDir, query, {
  limit = DEFAULT_LIMIT,
  reader = null,
  root = memoryDir
} = {}) {
  const activeReader = reader || createEvidenceReader({ roots: [path.resolve(root)] });
  const sources = [
    { filePath: path.join(memoryDir, "events.jsonl"), source: "memory/events.jsonl" },
    { filePath: path.join(memoryDir, "events-archive.jsonl"), source: "memory/events-archive.jsonl" },
    { filePath: path.join(memoryDir, "signals-archive.jsonl"), source: "memory/signals-archive.jsonl" },
    ...await listSignalSources(path.join(memoryDir, "signals"), { reader: activeReader, root })
  ];

  // Every scanned entry (matched or not) feeds the corpus so IDF reflects how
  // common a term actually is in this folder, not just among the hits.
  const docs = [];
  const candidates = [];
  for (const { filePath, source } of sources) {
    const entries = await activeReader.readJsonl(root, filePath);
    for (const entry of entries) {
      const text = JSON.stringify(entry);
      docs.push(text);
      const match = matchJsonEntry(entry, query);
      if (!match) continue;
      candidates.push({
        text,
        result: {
          source,
          match,
          matchedField: match.field === "summary" ? null : match.field,
          matchedSnippet: match.field === "summary" ? null : match.value,
          ...entry
        }
      });
    }
  }

  const corpus = buildCorpusStats(docs);
  const now = Date.now();
  const terms = queryTerms(query);
  return candidates
    .map(({ text, result }) => {
      const haystack = text.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const ageMs = result.ts ? now - Date.parse(result.ts) : null;
      return { result, rank: rankSearchHit({ kind: result.match.kind, matchedTerms, corpus, ageMs }) };
    })
    .sort((a, b) => (b.rank - a.rank) || compareTimestampsDesc(a.result.ts, b.result.ts))
    .slice(0, limit)
    .map(({ result }) => result);
}

export async function searchJsonlEntries(filePath, query, { source, reader = null, root = path.dirname(filePath) }) {
  const activeReader = reader || createEvidenceReader({ roots: [path.resolve(root)] });
  const entries = await activeReader.readJsonl(root, filePath);
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
  includeFile = null,
  reader = null,
  root = dir
} = {}) {
  const activeReader = reader || createEvidenceReader({ roots: [path.resolve(root)] });
  const files = await activeReader.listFiles(root, dir, { extensions, includeFile, skipEntry: shouldSkipEntry });
  const docs = [];
  const candidates = [];

  // Read files concurrently in bounded batches — I/O is the bottleneck, and a
  // cap keeps us well under the open-file limit on large vaults. Every read
  // file feeds the IDF corpus; only files with snippets become candidates.
  const CONCURRENCY = 32;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      files.slice(i, i + CONCURRENCY).map((filePath) =>
        collectSearchFile(filePath, dir, query, sourcePrefix, { reader: activeReader, root })
      )
    );
    for (const item of batch) {
      if (!item) continue;
      docs.push(item.content);
      if (item.candidate) candidates.push(item.candidate);
    }
  }

  const corpus = buildCorpusStats(docs);
  const now = Date.now();
  const terms = queryTerms(query);
  const ranked = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY).map((candidate) => {
      let ageMs = candidate.mtimeMs === null ? null : now - candidate.mtimeMs;
      const haystack = candidate.content.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const rank = rankSearchHit({
        kind: candidate.kind,
        matchedTerms,
        corpus,
        ageMs,
        structuralBoost: candidate.structuralBoost
      });
      return { result: candidate.result, rank };
    });
    ranked.push(...batch);
  }

  return ranked
    .sort((a, b) => (b.rank - a.rank) || a.result.file.localeCompare(b.result.file))
    .slice(0, limit)
    .map(({ result }) => result);
}

async function collectSearchFile(filePath, dir, query, sourcePrefix, { reader, root = dir } = {}) {
  const observed = await reader.readText(root, filePath, { returnSnapshot: true });
  if (observed === null) {
    const error = new Error("Search evidence changed while it was being read.");
    error.code = "DOTAIOS_EVIDENCE_CHANGED";
    throw error;
  }
  const { content } = observed;
  const mtimeMs = observed.stats.mtimeMs;

  const snippets = buildMarkdownSnippets(content, query);
  if (snippets.length === 0) return { content, candidate: null };

  const relative = path.relative(dir, filePath);
  const title = readTitle(content) || relative;
  const pathMatch = matchQuery(relative, query);
  const titleMatch = matchQuery(title, query);

  return {
    content,
    candidate: {
      filePath,
      content,
      mtimeMs,
      // The file's tier comes from a whole-file match: a doc containing every
      // query term across separate lines is a terms-tier hit even though each
      // individual snippet line is only a partial one.
      kind: matchQuery(content, query).kind || "partial",
      structuralBoost: markdownStructuralBoost({ snippets, pathMatch, titleMatch }),
      result: {
        source: `${sourcePrefix}/${relative}`,
        file: relative,
        title,
        matches: snippets.slice(0, 5)
      }
    }
  };
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

async function listSignalSources(signalsDir, { reader, root = signalsDir } = {}) {
  const files = (await reader.listFiles(root, signalsDir, {
    extensions: [".jsonl"],
    recursive: false,
    skipEntry: shouldSkipEntry
  })).map((filePath) => path.basename(filePath)).sort().reverse();
  return files.map((file) => ({
    filePath: path.join(signalsDir, file),
    source: `memory/signals/${file}`
  }));
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
      score: match.score
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
    score: whole.score
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

function compareSnippetCandidates(a, b) {
  const areaScore = { description: 3, heading: 2, body: 1 };
  const matchScore = { phrase: 3, terms: 2, partial: 1 };
  return (matchScore[b.match.kind] - matchScore[a.match.kind])
    || (areaScore[b.area] - areaScore[a.area])
    || (a.line - b.line);
}

// Structural boosts sit alongside the IDF sum inside a tier: same order of
// magnitude, so placement helps but cannot fake rarity or freshness.
function markdownStructuralBoost({ snippets, pathMatch, titleMatch }) {
  const bestSnippet = snippets[0];
  const areaBoost = bestSnippet?.area === "description" ? 3 : bestSnippet?.area === "heading" ? 2 : 0;
  const titleBoost = titleMatch.matched ? 2.5 : 0;
  const pathBoost = pathMatch.matched ? 1 : 0;
  return areaBoost + titleBoost + pathBoost;
}

function shouldSkipEntry(name) {
  if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) return true;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}


function readTitle(content) {
  const stripped = stripFrontmatter(content);
  const heading = stripped.split("\n").find((line) => line.startsWith("# "));
  return heading?.replace(/^#\s+/, "").trim() || null;
}

/**
 * Read one scalar frontmatter field. This is THE parser behind both search
 * descriptions and the live OKF index generator — one field convention,
 * one implementation.
 */
export function readFrontmatterField(content, field) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = content.slice(4, end);
  const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`);
  for (const line of block.split("\n")) {
    const match = line.match(pattern);
    if (match) return stripQuotes(match[1].trim());
  }
  return null;
}

function readFrontmatterDescription(content) {
  return readFrontmatterField(content, "description");
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

async function searchSessionsScope(aiosPath, query, {
  limit = DEFAULT_LIMIT,
  agent,
  project,
  since,
  reader
} = {}) {
  const { searchSessions } = await import("./sessions.mjs");
  const hits = await searchSessions(aiosPath, query, {
    agent,
    project,
    since,
    limit,
    readOnly: true,
    reader,
    root: aiosPath
  });
  return hits.map(({ entry, bodyMatch, snippet }) => ({
    source: `sessions/${entry.path}`,
    file: entry.path,
    title: entry.title || "(untitled)",
    agent: entry.agent,
    date: entry.captured_at?.slice(0, 10),
    session_id: entry.session_id,
    project: entry.project,
    matches: snippet ? [{ line: 0, content: snippet, match: "phrase", area: "body" }] : [],
  }));
}

function compareTimestampsDesc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
