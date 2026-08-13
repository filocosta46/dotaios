import path from "node:path";
import { createEvidenceReader, EvidenceReadError } from "./evidence-reader.mjs";
import { isPathWithinLexically } from "./paths.mjs";
import { resolvePortableProjectIdentity, validateProjectSelector } from "./projects.mjs";
import { haystackHasInflectionOf } from "./search-inflections.mjs";

export const SEARCH_SCOPES = ["memory", "vault", "context", "projects", "decisions", "skills", "references", "plugins", "sessions", "all"];

const DEFAULT_LIMIT = 20;

// memory/ holds two corpora, not one. events.jsonl and signals/ are append-only
// streams; daily/ and inbox/ are Markdown notes a human wrote. Both are "my
// memory" to the person asking, so a memory search has to read both. Missing
// directories yield no files, so listing them here is safe on a fresh AIOS.
const MEMORY_NOTE_DIRS = ["daily", "inbox"];

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
export const RECENCY_HALF_LIFE_DAYS = 30;
const RANK_TIER_WEIGHT = 1_000_000;
// Tiers are absolute: any phrase hit outranks every terms hit, and so on down.
// "inflected" sits at the bottom because it is the only kind that did not match
// the words the person actually typed.
const RANK_TIERS = { phrase: 4, terms: 3, partial: 2, inflected: 1 };
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

  return reader.withScopePreflight(
    scopes,
    (name, scopeReader) => inspectSearchScope(name, {
      aiosPath: resolvedAiosPath,
      vaultPath: resolvedVaultPath,
      vaultRoot,
      query,
      limit,
      projectIdentity,
      sessionFilters,
      reader: scopeReader
    }),
    (name, scopeReader, prepared) => discoverSearchScope(name, prepared, {
      aiosPath: resolvedAiosPath,
      query,
      limit,
      sessionFilters,
      reader: scopeReader
    }),
    (name, scopeReader, prepared) => executeDiscoveredScope(name, prepared, {
      aiosPath: resolvedAiosPath,
      query,
      limit,
      sessionFilters,
      reader: scopeReader
    }),
    async (transaction) => {
      const groups = scopes
        .filter((name) => transaction.has(name))
        .map((name) => ({
          scope: name,
          results: transaction.get(name)
        }));
      return attachSearchMetadata(groups, {
        requested: scope,
        project: projectIdentity?.slug || null,
        project_id: projectIdentity?.id || null,
        projects_omitted: scope === "all" && projectIdentity === null
      }, transaction.omissions);
    }
  );
}

function attachSearchMetadata(groups, scope, omissions) {
  Object.defineProperties(groups, {
    scope: {
      value: Object.freeze({ ...scope }),
      enumerable: false,
      configurable: false,
      writable: false
    },
    omissions: {
      value: omissions,
      enumerable: false,
      configurable: false,
      writable: false
    }
  });
  return groups;
}

async function inspectSearchScope(scope, {
  aiosPath,
  vaultPath,
  vaultRoot,
  query,
  limit,
  projectIdentity,
  sessionFilters,
  reader
}) {
  if (scope === "sessions") {
    return inspectSessionsScope(aiosPath, { reader });
  }
  if (scope === "memory") {
    return inspectMemoryScope(path.join(aiosPath, "memory"), {
      reader,
      root: aiosPath
    });
  }
  const config = markdownScopeConfig(scope, {
    aiosPath,
    vaultPath,
    vaultRoot,
    projectIdentity
  });
  if (!config) return Object.freeze({ kind: "empty" });
  const prepared = await reader.prepareTextCorpus(
    config.root,
    config.dir,
    {
      extensions: config.extensions,
      includeFile: config.includeFile,
      skipEntry: shouldSkipEntry,
      concurrency: 32
    }
  );
  return Object.freeze({ kind: "markdown", config, prepared });
}

async function discoverSearchScope(scope, prepared, {
  aiosPath,
  query,
  limit,
  sessionFilters,
  reader
}) {
  if (scope === "sessions") {
    return discoverSessionsScope(aiosPath, query, prepared, { limit, reader, ...sessionFilters });
  }
  if (scope === "memory") {
    return discoverMemoryScope(prepared, { reader });
  }
  return prepared;
}

async function executeDiscoveredScope(_scope, prepared, {
  aiosPath,
  query,
  limit,
  sessionFilters,
  reader
}) {
  if (prepared?.kind === "sessions") {
    return searchDiscoveredSessions(aiosPath, query, prepared, {
      limit,
      reader,
      ...sessionFilters
    });
  }
  if (prepared?.kind === "memory") {
    return searchDiscoveredMemory(prepared, query, { limit, reader });
  }
  if (prepared?.kind === "markdown") {
    return searchPreparedMarkdownDir(prepared.prepared, prepared.config, query, { limit, reader });
  }
  return [];
}

function markdownScopeConfig(scope, { aiosPath, vaultPath, vaultRoot, projectIdentity }) {
  if (scope === "context") {
    return Object.freeze({ dir: path.join(aiosPath, "context"), root: aiosPath, sourcePrefix: "context", extensions: [".md"] });
  }
  if (scope === "vault") {
    return Object.freeze({ dir: vaultPath, root: vaultRoot, sourcePrefix: "vault", extensions: [".md"] });
  }
  if (scope === "projects") {
    if (!projectIdentity) validateProjectSelector(null);
    return Object.freeze({
      dir: path.join(aiosPath, "projects", projectIdentity.slug),
      root: aiosPath,
      sourcePrefix: `projects/${projectIdentity.slug}`,
      extensions: [".md"]
    });
  }
  if (scope === "decisions") {
    return Object.freeze({ dir: path.join(aiosPath, "decisions"), root: aiosPath, sourcePrefix: "decisions", extensions: [".md"] });
  }
  if (scope === "skills") {
    return Object.freeze({ dir: path.join(aiosPath, "skills"), root: aiosPath, sourcePrefix: "skills", extensions: [".md"] });
  }
  if (scope === "references") {
    return Object.freeze({ dir: path.join(aiosPath, "references"), root: aiosPath, sourcePrefix: "references", extensions: [".md"] });
  }
  if (scope === "plugins") {
    return Object.freeze({
      dir: path.join(aiosPath, "plugins"),
      root: aiosPath,
      sourcePrefix: "plugins",
      extensions: [".md", ".json"],
      includeFile: (filePath) => filePath.endsWith(".md") || path.basename(filePath) === "manifest.json"
    });
  }
  return null;
}

// Each corpus arrives already ranked and already capped at the limit, but their
// scores are not comparable: a JSONL entry and a Markdown line are scored by
// different functions. Concatenating them would let a busy events.jsonl fill
// the limit and hide every note, which is the bug this scope was widened to
// fix. Round-robin keeps the best of each corpus at the top and guarantees a
// note is reachable whenever one matched.
function interleaveByRank(corpora, limit) {
  const merged = [];
  const deepest = Math.max(0, ...corpora.map((corpus) => corpus.length));
  for (let position = 0; position < deepest && merged.length < limit; position += 1) {
    for (const corpus of corpora) {
      if (position >= corpus.length) continue;
      merged.push(corpus[position]);
      if (merged.length >= limit) break;
    }
  }
  return merged;
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

  // Last resort: the same words in a different tense or number. Ranked below
  // every literal kind, and only reached once all of them have failed, so it
  // adds recall without moving anything that already matched.
  const inflected = terms.filter((term) => haystackHasInflectionOf(haystack, term));
  if (inflected.length === terms.length) {
    return { matched: true, kind: "inflected", score: inflected.length };
  }

  return { matched: false, kind: null, score: 0 };
}

export async function searchMemoryDir(memoryDir, query, {
  limit = DEFAULT_LIMIT,
  reader = null,
  root = memoryDir
} = {}) {
  const activeReader = reader || createEvidenceReader({ roots: [path.resolve(root)] });
  const sources = await memorySourceDescriptors(memoryDir, { reader: activeReader, root });
  const entriesBySource = new Map();
  for (const { filePath, source } of sources) {
    entriesBySource.set(source, await activeReader.readJsonl(root, filePath));
  }
  return rankMemorySources(sources, entriesBySource, query, limit);
}

async function inspectMemoryScope(memoryDir, { reader, root }) {
  const sources = await memorySourceDescriptors(memoryDir, { reader, root });
  const entriesBySource = new Map();
  for (const { filePath, source } of sources) {
    entriesBySource.set(source, await reader.prepareJsonlMetadata(root, filePath));
  }
  const noteCorpora = [];
  for (const relative of MEMORY_NOTE_DIRS) {
    const dir = path.join(memoryDir, relative);
    noteCorpora.push(Object.freeze({
      relative,
      dir,
      prepared: await reader.prepareTextCorpus(
        root,
        dir,
        { extensions: [".md"], skipEntry: shouldSkipEntry, concurrency: 32 }
      )
    }));
  }
  return Object.freeze({ kind: "memory", sources, entriesBySource, noteCorpora });
}

async function discoverMemoryScope(prepared, { reader }) {
  const entriesBySource = new Map();
  for (const [source, metadata] of prepared.entriesBySource) {
    entriesBySource.set(source, await reader.materializePreparedJsonl(metadata));
  }
  return Object.freeze({ ...prepared, entriesBySource });
}

async function searchDiscoveredMemory(prepared, query, { limit, reader }) {
  const entriesBySource = new Map(
    [...prepared.entriesBySource].map(([source, entries]) => [source, reader.readPreparedJsonl(entries)])
  );
  const corpora = [rankMemorySources(prepared.sources, entriesBySource, query, limit)];
  for (const note of prepared.noteCorpora) {
    corpora.push(await searchPreparedMarkdownDir(
      note.prepared,
      { dir: note.dir, sourcePrefix: `memory/${note.relative}` },
      query,
      { limit, reader }
    ));
  }
  return interleaveByRank(corpora, limit);
}

async function memorySourceDescriptors(memoryDir, { reader, root }) {
  const archives = await listMemoryArchiveSources(memoryDir, { reader, root });
  const eventSource = {
    filePath: path.join(memoryDir, "events.jsonl"),
    source: "memory/events.jsonl",
    family: "events",
    generation: "live"
  };
  const signalSources = (await listSignalSources(path.join(memoryDir, "signals"), { reader, root }))
    .map((source) => ({
      ...source,
      family: "signals",
      generation: "live"
    }));
  const liveSourcesByFamily = new Map([
    ["events", [eventSource.source]],
    ["signals", signalSources.map(({ source }) => source)]
  ]);
  return [
    eventSource,
    ...archives.map((source) => source.generation === "archive-active"
      ? {
        ...source,
        retryAgainst: [
          ...source.retryAgainst,
          ...liveSourcesByFamily.get(source.family)
        ]
      }
      : source),
    ...signalSources
  ];
}

function rankMemorySources(sources, entriesBySource, query, limit) {
  // Every scanned entry (matched or not) feeds the corpus so IDF reflects how
  // common a term actually is in this folder, not just among the hits.
  const docs = [];
  const candidates = [];
  for (const { source, retryAgainst = [] } of sources) {
    const retryOverlap = serializedEntryCounts(
      retryAgainst.flatMap((counterpart) => entriesBySource.get(counterpart) || [])
    );
    const entries = entriesBySource.get(source) || [];
    for (const entry of entries) {
      const text = JSON.stringify(entry);
      if (consumeSerializedEntry(retryOverlap, text)) continue;
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

async function listMemoryArchiveSources(memoryDir, { reader, root }) {
  const entries = await reader.listDirectory(root, memoryDir);
  const families = ["events-archive", "signals-archive"];
  const sources = [];
  for (const family of families) {
    const matcher = new RegExp(`^${family}\\.(\\d{6})\\.jsonl$`);
    const shards = entries
      .map((entry) => ({ entry, match: entry.name.match(matcher) }))
      .filter(({ match }) => match)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
    let newestShardSource = null;
    for (const { entry } of shards) {
      const source = `memory/${entry.name}`;
      sources.push({
        filePath: path.join(memoryDir, entry.name),
        source,
        family: family === "events-archive" ? "events" : "signals",
        generation: "archive-shard"
      });
      newestShardSource = source;
    }
    const source = `memory/${family}.jsonl`;
    sources.push({
      filePath: path.join(memoryDir, `${family}.jsonl`),
      source,
      family: family === "events-archive" ? "events" : "signals",
      generation: "archive-active",
      retryAgainst: newestShardSource ? [newestShardSource] : []
    });
  }
  return sources;
}

function serializedEntryCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    counts.set(serialized, (counts.get(serialized) || 0) + 1);
  }
  return counts;
}

function consumeSerializedEntry(counts, serialized) {
  const remaining = counts.get(serialized) || 0;
  if (remaining === 0) return false;
  if (remaining === 1) counts.delete(serialized);
  else counts.set(serialized, remaining - 1);
  return true;
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
  const CONCURRENCY = 32;
  return activeReader.withTextCorpus(
    root,
    dir,
    { extensions, includeFile, skipEntry: shouldSkipEntry, concurrency: CONCURRENCY },
    (transaction) => rankMarkdownTransaction(transaction, dir, query, sourcePrefix, limit)
  );
}

async function searchPreparedMarkdownDir(prepared, config, query, { limit, reader }) {
  return reader.withPreparedTextCorpus(
    prepared,
    (transaction) => rankMarkdownTransaction(
      transaction,
      config.dir,
      query,
      config.sourcePrefix,
      limit
    )
  );
}

async function rankMarkdownTransaction(transaction, dir, query, sourcePrefix, limit) {
  // Every accepted file is observed once by the transaction. Matching,
  // snippet construction, corpus statistics, and ranking all stay inside
  // its callback, so no derived result can escape before final validation.
  const observedFiles = await transaction.mapFiles((observed) =>
    collectSearchFile(observed, dir, query, sourcePrefix)
  );
  const docs = [];
  const candidates = [];
  for (const item of observedFiles) {
    if (!item) continue;
    docs.push(item.content);
    if (item.candidate) candidates.push(item.candidate);
  }

  const corpus = buildCorpusStats(docs);
  const now = Date.now();
  const terms = queryTerms(query);
  const ranked = candidates.map((candidate) => {
    const ageMs = candidate.mtimeMs === null ? null : now - candidate.mtimeMs;
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

  return ranked
    .sort((a, b) => (b.rank - a.rank) || a.result.file.localeCompare(b.result.file))
    .slice(0, limit)
    .map(({ result }) => result);
}

function collectSearchFile({ filePath, content, mtimeMs }, dir, query, sourcePrefix) {
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

async function inspectSessionsScope(aiosPath, { reader }) {
  const sessionsRoot = path.resolve(aiosPath, "memory", "sessions");
  const indexPath = path.join(sessionsRoot, "index.jsonl");
  return Object.freeze({
    kind: "sessions-metadata",
    index: await reader.prepareJsonlMetadata(aiosPath, indexPath)
  });
}

async function discoverSessionsScope(aiosPath, _query, inspected, {
  agent,
  project,
  since,
  reader
} = {}) {
  const sessionsRoot = path.resolve(aiosPath, "memory", "sessions");
  const index = await reader.materializePreparedJsonl(inspected.index);
  const { filterSessions } = await import("./sessions.mjs");
  const entries = await filterSessions(aiosPath, {
    agent,
    project,
    since,
    readOnly: true,
    root: aiosPath,
    reader: {
      readJsonl: async () => reader.readPreparedJsonl(index)
    }
  });
  const bodies = new Map();
  for (const entry of entries) {
    if (typeof entry.path !== "string" || entry.path.length === 0 || path.isAbsolute(entry.path)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    const filePath = path.resolve(aiosPath, entry.path);
    if (
      !isPathWithinLexically(path.resolve(aiosPath), filePath)
      || !isPathWithinLexically(sessionsRoot, filePath)
    ) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    bodies.set(filePath, await reader.prepareTextMetadata(aiosPath, filePath));
  }
  return Object.freeze({ kind: "sessions", index, bodies });
}

async function searchDiscoveredSessions(aiosPath, query, prepared, options) {
  const bodyContents = new Map();
  const replayReader = {
    readJsonl: async () => options.reader.readPreparedJsonl(prepared.index),
    readText: async (_root, filePath) => {
      const resolved = path.resolve(filePath);
      const body = prepared.bodies.get(resolved);
      if (!body) return null;
      if (!bodyContents.has(resolved)) {
        bodyContents.set(resolved, options.reader.materializePreparedText(body));
      }
      return options.reader.readPreparedText(await bodyContents.get(resolved));
    }
  };
  return searchSessionsScope(aiosPath, query, { ...options, reader: replayReader });
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
