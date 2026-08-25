import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { readContainedDirectory, readContainedFile, ContainedReadError } from "./contained-read.mjs";
import { EvidenceReadError } from "./evidence-reader.mjs";
import { validateManagedFilePath, writeFileSafe } from "./files.mjs";
import { repeatedJsonObjectKey } from "./json.mjs";
import { formatJsonlEntry, readJsonl } from "./memory.mjs";
import { acquireOperationLock, releaseOperationLock } from "./operation-lock.mjs";
import { sameFileIdentity } from "./owned-state.mjs";
import { isPathWithinLexically } from "./paths.mjs";

export const SESSIONS_SUBDIR = "memory/sessions";
const INDEX_FILENAME = "index.jsonl";
const DELETION_STAGING_DIR = ".deletions";
const LOCKS_SUBDIR = "tmp/.dotaios-locks";
const INDEX_STEAL_GUARD_FILENAME = "index-steal.lock";
const STAGED_DELETION_PATTERN = /^(.+\.md)\.delete-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_STEAL_GUARD_FORMAT = "dotaios-session-index-steal-guard/v1";

export function generateSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

export function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function operationHash(operationId) {
  return crypto.createHash("sha256").update(operationId).digest("hex");
}

export function sessionFilename(session) {
  const ts = (session.captured_at || new Date().toISOString())
    .slice(0, 19)
    .replace(/:/g, "-");
  const agent = (session.agent || "manual").replace(/[^a-z0-9]/g, "-").toLowerCase();
  const shortId = (session.session_id || "").slice(0, 6);
  const operationSuffix = session.operation_id ? `_${operationHash(session.operation_id)}` : "";
  return `${ts}_${agent}_${shortId}${operationSuffix}.md`;
}

export function sessionDateDir(session) {
  return (session.captured_at || new Date().toISOString()).slice(0, 10);
}

export function inferTitle(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const first = turns.find((t) => t.role === "user");
  if (!first?.content) return null;
  const text = String(first.content).trim().replace(/\s+/g, " ");
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

export function renderSessionBody(session) {
  if (typeof session.summary === "string") return session.summary;

  const lines = [];
  for (const turn of session.turns || []) {
    const timeStr = turn.ts ? ` · ${String(turn.ts).slice(11, 16)}` : "";
    lines.push(`**${turn.role}${timeStr}**`);
    lines.push("");
    if (turn.content) lines.push(String(turn.content));
    lines.push("");
  }
  return lines.join("\n");
}

export function renderSessionMarkdown(session) {
  const turnCount = Array.isArray(session.turns) ? session.turns.length : 0;
  const authorityValue = session.operation_id
    ? (value) => JSON.stringify(String(value))
    : (value) => String(value);
  const lines = [
    "---",
    `agent: ${authorityValue(session.agent || "manual")}`,
    `session_id: ${authorityValue(session.session_id)}`,
  ];
  if (session.operation_id) lines.push(`operation_id: ${authorityValue(session.operation_id)}`);
  if (session.request_hash) lines.push(`request_hash: ${authorityValue(session.request_hash)}`);
  lines.push(`captured_at: ${authorityValue(session.captured_at)}`);
  lines.push(`source_type: ${authorityValue(session.source_type || "manual")}`);
  if (session.source_path) lines.push(`source_path: ${authorityValue(session.source_path)}`);
  if (session.project) lines.push(`project: ${authorityValue(session.project)}`);
  if (session.project_id) lines.push(`project_id: ${authorityValue(session.project_id)}`);
  lines.push(`turns: ${turnCount}`);
  if (session.title) lines.push(`title: ${JSON.stringify(String(session.title))}`);
  lines.push("schema: 1");
  lines.push("---");
  lines.push("");
  lines.push(renderSessionBody(session));

  return lines.join("\n");
}

export async function writeSession(aiosPath, session) {
  return withIndexLock(aiosPath, async (safeAiosPath) => writeSessionUnderLock(safeAiosPath, session));
}

/**
 * Publish one agent-authored session summary and return only after its canonical
 * Markdown record and derived index row have been read back under one index lock.
 */
export async function saveSessionSummary(aiosPath, summary) {
  const proposed = {
    agent: summary.agent,
    session_id: generateSessionId(),
    operation_id: summary.operation_id,
    request_hash: summary.request_hash,
    captured_at: new Date().toISOString(),
    source_type: "save-session",
    ...(summary.project && { project: summary.project }),
    ...(summary.project_id && { project_id: summary.project_id }),
    title: summary.title,
    turns: [],
    summary: summary.summary,
  };

  return withIndexLock(aiosPath, async (safeAiosPath) => {
    const entries = await readSessionIndex(safeAiosPath, { strict: true });
    const operationEntries = entries.filter((entry) => entry.operation_id === proposed.operation_id);
    const operationFiles = await findOperationSessionFiles(safeAiosPath, proposed.operation_id);

    if (operationEntries.length > 1 || operationFiles.length > 1) {
      throw new Error(`Session save operation is ambiguous: ${proposed.operation_id}`);
    }
    if (operationEntries.length === 1 && operationFiles.length === 0) {
      throw new Error(`Session save operation has an index row without its session file: ${proposed.operation_id}`);
    }

    if (operationFiles.length === 1) {
      const relativePath = operationFiles[0];
      const persisted = await readOperationSummary(safeAiosPath, relativePath, proposed.operation_id);
      assertSummaryMatches(proposed, persisted);
      const canonicalEntry = sessionIndexEntry(
        persisted.metadata,
        relativePath,
        contentHash(persisted.body),
      );
      assertNoConflictingIndexClaims(entries, canonicalEntry, proposed.operation_id);

      if (operationEntries.length === 1) {
        if (!sameIndexEntry(operationEntries[0], canonicalEntry)) {
          throw new Error(`Session save operation index and frontmatter do not match: ${proposed.operation_id}`);
        }
      } else {
        await appendSessionIndexLine(safeAiosPath, canonicalEntry);
      }

      const published = {
        relativePath,
        markdown: persisted.markdown,
        indexEntry: canonicalEntry,
      };
      await verifySessionPublication(safeAiosPath, proposed, published);
      return sessionReceipt(persisted.metadata, relativePath);
    }

    const proposedPath = path.posix.join(
      SESSIONS_SUBDIR,
      sessionDateDir(proposed),
      sessionFilename(proposed),
    );
    assertNoConflictingIndexClaims(
      entries,
      sessionIndexEntry(proposed, proposedPath, contentHash(proposed.summary)),
      proposed.operation_id,
    );
    const published = await publishSessionUnderLock(safeAiosPath, proposed, { exclusive: true });
    await verifySessionPublication(safeAiosPath, proposed, published);
    return sessionReceipt(proposed, published.relativePath);
  });
}

async function findOperationSessionFiles(aiosPath, operationId) {
  const sessionsRoot = path.resolve(aiosPath, SESSIONS_SUBDIR);
  const dateEntries = await readContainedDirectory(aiosPath, sessionsRoot, {
    readdirOptions: { withFileTypes: true },
  }) || [];
  const operationSuffix = `_${operationHash(operationId)}.md`;

  const matches = [];
  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
    const datePath = path.join(sessionsRoot, dateEntry.name);
    const fileEntries = await readContainedDirectory(aiosPath, datePath, {
      readdirOptions: { withFileTypes: true },
    }) || [];
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(operationSuffix)) continue;
      matches.push(path.posix.join(SESSIONS_SUBDIR, dateEntry.name, fileEntry.name));
    }
  }
  return matches;
}

function resolveSessionFilePath(aiosPath, relativePath, subject) {
  const normalized = normalizeSessionIndexPath(relativePath);
  if (normalized === null) {
    throw new Error(`${subject} has an unsafe session file path.`);
  }
  return path.resolve(aiosPath, normalized);
}

async function readOperationSummary(aiosPath, relativePath, operationId) {
  const filePath = resolveSessionFilePath(
    aiosPath,
    relativePath,
    `Session save operation ${operationId}`,
  );

  let markdown;
  try {
    markdown = await readContainedFile(aiosPath, filePath, {
      encoding: "utf8",
      maxBytes: 128 * 1024,
    });
  } catch (error) {
    if (error instanceof ContainedReadError) {
      if (error.code === "DOTAIOS_INVALID_UTF8") {
        throw new Error(`Session save operation file ${operationId} is not valid UTF-8.`);
      }
      throw new Error(`Session save operation has an unsafe file path: ${operationId}`);
    }
    if (error?.code === "ENOENT") {
      throw new Error(`Session save operation file disappeared during verification: ${operationId}`);
    }
    throw error;
  }
  if (markdown === null) {
    throw new Error(`Session save operation file disappeared during verification: ${operationId}`);
  }
  const persisted = parseSessionMarkdown(markdown, operationId);
  const canonicalPath = path.posix.join(
    SESSIONS_SUBDIR,
    sessionDateDir(persisted.metadata),
    sessionFilename(persisted.metadata),
  );
  if (relativePath !== canonicalPath || renderSessionMarkdown({
    ...persisted.metadata,
    turns: [],
    summary: persisted.body,
  }) !== markdown) {
    throw new Error(`Session save operation file is not canonical: ${operationId}`);
  }
  return { ...persisted, markdown };
}

function parseSessionMarkdown(markdown, operationId) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    throw new Error(`Session save operation has invalid frontmatter: ${operationId}`);
  }
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Session save operation has invalid frontmatter: ${operationId}`);
  }
  let metadata;
  try {
    metadata = document.toJS();
  } catch {
    throw new Error(`Session save operation has invalid frontmatter: ${operationId}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Session save operation has invalid frontmatter: ${operationId}`);
  }
  const body = markdown.slice(match[0].length).replace(/^\r?\n/, "");
  return { metadata, body };
}

function assertSummaryMatches(expected, persisted) {
  const actual = persisted.metadata;
  if (
    actual.operation_id !== expected.operation_id
    || actual.request_hash !== expected.request_hash
    || typeof actual.session_id !== "string"
    || !/^[0-9a-f]{8}$/.test(actual.session_id)
    || actual.agent !== expected.agent
    || !isCanonicalIsoTimestamp(actual.captured_at)
    || actual.source_type !== "save-session"
    || actual.source_path !== undefined
    || actual.project !== expected.project
    || actual.project_id !== expected.project_id
    || actual.title !== expected.title
    || actual.turns !== 0
    || actual.schema !== 1
    || persisted.body !== expected.summary
  ) {
    throw new Error(`Session save operation reuse does not match the original summary: ${expected.operation_id}`);
  }
}

async function writeSessionUnderLock(aiosPath, session) {
  const sessionsBase = path.join(aiosPath, SESSIONS_SUBDIR);
  const bodyHash = contentHash(renderSessionBody(session));

  if (session.source_path) {
    const existing = await readSessionIndex(aiosPath);
    const priorEntry = existing.find((entry) => entry.source_path === session.source_path);

    if (priorEntry) {
      const priorPath = resolveSessionFilePath(aiosPath, priorEntry.path, "Session index row");
      const priorFile = await validateManagedFilePath(priorPath, sessionsBase);
      if (priorEntry.content_hash === bodyHash && priorFile) {
        return { filePath: null, relativePath: priorEntry.path, hash: bodyHash, skipped: true };
      }

      const stable = {
        ...session,
        session_id: priorEntry.session_id,
        captured_at: priorEntry.captured_at,
      };
      const updatedDir = sessionDateDir(stable);
      const updatedFilename = sessionFilename(stable);
      const updatedFilePath = path.join(sessionsBase, updatedDir, updatedFilename);
      const updatedRelative = path.posix.join(SESSIONS_SUBDIR, updatedDir, updatedFilename);

      if (!sameSessionIndexPath(priorEntry.path, updatedRelative)) {
        try { await fs.unlink(priorPath); } catch {}
      }

      await writeFileSafe(updatedFilePath, renderSessionMarkdown(stable), "overwrite", {
        boundaryRoot: sessionsBase,
      });

      const updatedEntry = {
        ...priorEntry,
        turns: Array.isArray(session.turns) ? session.turns.length : priorEntry.turns,
        title: session.title || priorEntry.title,
        ...(session.project && { project: session.project }),
        ...(session.project_id && { project_id: session.project_id }),
        path: updatedRelative,
        content_hash: bodyHash,
      };
      const current = await readSessionIndex(aiosPath);
      const rest = current.filter((entry) => entry.source_path !== session.source_path);
      await writeSessionIndex(aiosPath, [...rest, updatedEntry]);
      return {
        filePath: updatedFilePath,
        relativePath: updatedRelative,
        hash: bodyHash,
        skipped: false,
        updated: true,
      };
    }
  }

  const published = await publishSessionUnderLock(aiosPath, session);
  return {
    filePath: published.filePath,
    relativePath: published.relativePath,
    hash: published.hash,
    skipped: published.skipped,
  };
}

async function publishSessionUnderLock(aiosPath, session, { exclusive = false } = {}) {
  const sessionsBase = path.join(aiosPath, SESSIONS_SUBDIR);
  const dateDir = sessionDateDir(session);
  const filename = sessionFilename(session);
  const dirPath = path.join(sessionsBase, dateDir);
  const filePath = path.join(dirPath, filename);
  const relativePath = path.posix.join(SESSIONS_SUBDIR, dateDir, filename);
  const bodyHash = contentHash(renderSessionBody(session));
  const markdown = renderSessionMarkdown(session);
  const indexEntry = sessionIndexEntry(session, relativePath, bodyHash);

  const publication = await writeFileSafe(
    filePath,
    markdown,
    exclusive ? "preserve" : "overwrite",
    { boundaryRoot: sessionsBase },
  );
  if (exclusive && publication.action !== "created") {
    throw new Error(`Session save operation file already exists: ${session.operation_id}`);
  }
  await appendSessionIndexLine(aiosPath, indexEntry);

  return {
    filePath,
    relativePath,
    hash: bodyHash,
    skipped: false,
    markdown,
    indexEntry,
  };
}

function sessionIndexEntry(session, relativePath, bodyHash) {
  return {
    session_id: session.session_id,
    ...(session.operation_id && { operation_id: session.operation_id }),
    ...(session.request_hash && { request_hash: session.request_hash }),
    agent: session.agent || "manual",
    captured_at: session.captured_at,
    source_type: session.source_type || "manual",
    ...(session.source_path && { source_path: session.source_path }),
    ...(session.project && { project: session.project }),
    ...(session.project_id && { project_id: session.project_id }),
    turns: Array.isArray(session.turns) ? session.turns.length : 0,
    title: session.title || null,
    path: relativePath,
    content_hash: bodyHash,
  };
}

async function verifySessionPublication(aiosPath, session, published) {
  const persisted = await readOperationSummary(
    aiosPath,
    published.relativePath,
    session.operation_id,
  );
  assertSummaryMatches(session, persisted);
  if (persisted.markdown !== published.markdown) {
    throw new Error(`Session file verification failed for operation ${session.operation_id}.`);
  }

  const canonicalEntry = sessionIndexEntry(
    persisted.metadata,
    published.relativePath,
    contentHash(persisted.body),
  );
  if (!sameIndexEntry(canonicalEntry, published.indexEntry)) {
    throw new Error(`Session file verification failed for operation ${session.operation_id}.`);
  }

  const entries = await readSessionIndex(aiosPath, { strict: true });
  assertNoConflictingIndexClaims(entries, canonicalEntry, session.operation_id);
  const matches = entries.filter((entry) => entry.operation_id === session.operation_id);
  if (matches.length !== 1 || !sameIndexEntry(matches[0], canonicalEntry)) {
    throw new Error(`Session index verification failed for operation ${session.operation_id}.`);
  }
}

function sameIndexEntry(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

function assertNoConflictingIndexClaims(entries, expected, operationId) {
  const conflicting = entries.find((entry) => (
    entry.operation_id !== operationId
    && (entry.session_id === expected.session_id || sameSessionIndexPath(entry.path, expected.path))
  ));
  if (conflicting) {
    throw new Error(`Session save operation has a conflicting index row: ${operationId}`);
  }
}

function sessionReceipt(session, relativePath) {
  return {
    version: 1,
    status: "verified",
    operation_id: session.operation_id,
    session_id: session.session_id,
    path: relativePath,
  };
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isHistoricalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) return false;

  return match[8] === "Z" || (Number(match[9]) <= 23 && Number(match[10]) <= 59);
}

function normalizeReadableSessionIndexPath(value) {
  if (typeof value !== "string") return null;
  const hasForwardSlash = value.includes("/");
  const hasBackslash = value.includes("\\");
  if (hasForwardSlash && hasBackslash) return null;
  const normalized = hasBackslash ? value.replaceAll("\\", "/") : value;
  if (
    !/^memory\/sessions\/(?:\d{4}-\d{2}-\d{2}\/)?[^/\u0000-\u001f\u007f]+\.md$/u.test(normalized)
    || path.posix.normalize(normalized) !== normalized
  ) return null;
  return normalized;
}

// Mutation and repair only accept the dated shape emitted by sessionFilename.
// Read-only search also preserves the safe, directly nested shape accepted by
// older indexes and by the pre-2.0.11 reader contract.
function normalizeSessionIndexPath(value) {
  const normalized = normalizeReadableSessionIndexPath(value);
  if (
    normalized === null
    || !/^memory\/sessions\/\d{4}-\d{2}-\d{2}\/[^/\u0000-\u001f\u007f]+\.md$/u.test(normalized)
  ) return null;
  return normalized;
}

function isSafeSessionIndexPath(value) {
  return normalizeSessionIndexPath(value) !== null;
}

function sameSessionIndexPath(left, right) {
  const normalizedLeft = normalizeSessionIndexPath(left);
  return normalizedLeft !== null && normalizedLeft === normalizeSessionIndexPath(right);
}

function isValidSessionIndexEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.session_id !== "string" || entry.session_id.length === 0) return false;
  if (!isSafeSessionIndexPath(entry.path)) return false;

  const required = ["agent", "source_type", "turns", "title"];
  if (required.some((field) => !Object.hasOwn(entry, field))) return false;
  if (typeof entry.agent !== "string" || entry.agent.length === 0) return false;
  if (typeof entry.source_type !== "string" || entry.source_type.length === 0) return false;
  if (!Number.isInteger(entry.turns) || entry.turns < 0) return false;
  if (entry.title !== null && typeof entry.title !== "string") return false;
  if (
    entry.content_hash !== undefined
    && (
      typeof entry.content_hash !== "string"
      || !/^(?:[0-9a-f]{16}|sha256:[0-9a-f]{64})$/.test(entry.content_hash)
    )
  ) return false;

  for (const field of ["source_path", "project", "project_id"]) {
    if (entry[field] !== undefined && typeof entry[field] !== "string") return false;
  }

  if (entry.operation_id !== undefined) {
    if (
      typeof entry.operation_id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.operation_id)
      || !isCanonicalIsoTimestamp(entry.captured_at)
      || typeof entry.content_hash !== "string"
      || !/^[0-9a-f]{16}$/.test(entry.content_hash)
      || typeof entry.request_hash !== "string"
      || !/^[0-9a-f]{64}$/.test(entry.request_hash)
      || entry.source_type !== "save-session"
      || entry.source_path !== undefined
      || entry.turns !== 0
    ) return false;
  } else {
    if (entry.request_hash !== undefined || !isHistoricalIsoTimestamp(entry.captured_at)) return false;
  }
  return true;
}

export async function readSessionIndex(aiosPath, options = {}) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  if (!options.strict) return readJsonl(indexPath, options);

  const fileSystem = options.filesystem || fs;
  let content;
  try {
    content = await readContainedFile(aiosPath, indexPath, {
      filesystem: fileSystem,
      encoding: "utf8",
    });
  } catch (error) {
    if (error instanceof ContainedReadError) {
      if (error.code === "DOTAIOS_INVALID_UTF8") {
        throw new Error("Session index is malformed; refusing to classify a summary save operation.");
      }
      throw new Error("Session index is unsafe; refusing to classify a summary save operation.");
    }
    throw error;
  }
  if (content === null) return [];

  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("Session index is malformed; refusing to classify a summary save operation.");
    }
    if (repeatedJsonObjectKey(line) !== null || !isValidSessionIndexEntry(entry)) {
      throw new Error("Session index is malformed; refusing to classify a summary save operation.");
    }
    entries.push(entry);
  }
  return entries;
}

export async function filterSessions(aiosPath, {
  agent,
  project,
  since,
  readOnly = false,
  filesystem,
  reader,
  root = aiosPath
} = {}) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  const entries = reader
    ? await reader.readJsonl(root, indexPath)
    : await readSessionIndex(aiosPath, {
        ...(filesystem ? { filesystem } : {}),
        quarantine: !readOnly
      });
  const sinceTs = since ? parseSinceFlag(since) : null;

  return entries.filter((entry) => {
    if (agent && entry.agent !== agent) return false;
    if (project && entry.project !== project) return false;
    if (sinceTs && entry.captured_at < sinceTs) return false;
    return true;
  });
}

export async function deleteSession(aiosPath, sessionId) {
  return withIndexLock(aiosPath, async (safeAiosPath) => {
    const entries = await readSessionIndex(safeAiosPath);
    const matches = entries.filter((entry) => entry.session_id === sessionId);
    if (matches.length === 0) throw new Error(`Session not found: ${sessionId}`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous session index claims for session: ${sessionId}`);
    }
    const [found] = matches;

    const sessionsRoot = path.join(safeAiosPath, SESSIONS_SUBDIR);
    const filePath = resolveSessionFilePath(safeAiosPath, found.path, "Session index row");
    const pathClaims = entries.filter((entry) => sameSessionIndexPath(entry.path, found.path));
    if (pathClaims.length !== 1) {
      throw new Error(`Ambiguous session index claims for session: ${sessionId}`);
    }
    const existing = await validateManagedFilePath(filePath, sessionsRoot);
    const staging = existing ? deletionStagingPaths(sessionsRoot, found.path) : null;
    const stagedPath = staging
      ? path.join(staging.datePath, `${staging.filename}.delete-${process.pid}-${crypto.randomUUID()}`)
      : null;
    let staged = false;
    try {
      if (existing) {
        await ensureRealDirectory(staging.root);
        await ensureRealDirectory(staging.datePath);
        await validateManagedFilePath(stagedPath, sessionsRoot);
        await fs.rename(filePath, stagedPath);
        staged = true;
        const stagedStats = await validateManagedFilePath(stagedPath, sessionsRoot);
        if (!sameFileIdentity(existing, stagedStats)) {
          throw new Error("Session file changed while staging its deletion.");
        }
      }
      await writeSessionIndex(safeAiosPath, entries.filter((entry) => entry !== found));
    } catch (error) {
      if (staged) {
        try {
          const replacement = await validateManagedFilePath(filePath, sessionsRoot);
          if (replacement) throw new Error("the original session path was replaced during rollback");
          await fs.rename(stagedPath, filePath);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Session deletion failed and its file could not be restored: ${error.message}`,
          );
        }
      }
      if (staging) await removeEmptyDeletionStagingDirectories([staging.datePath], staging.root);
      throw error;
    }
    if (staged) await fs.unlink(stagedPath);
    if (staging) await removeEmptyDeletionStagingDirectories([staging.datePath], staging.root);
    return found;
  });
}

function deletionStagingPaths(sessionsRoot, relativePath) {
  const normalized = normalizeSessionIndexPath(relativePath);
  const relative = path.posix.relative(SESSIONS_SUBDIR, normalized);
  const date = path.posix.dirname(relative);
  const filename = path.posix.basename(relative);
  const root = path.join(sessionsRoot, DELETION_STAGING_DIR);
  return { root, datePath: path.join(root, date), filename };
}

async function removeEmptyDeletionStagingDirectories(datePaths, stagingRoot) {
  for (const directoryPath of [...new Set(datePaths)].reverse()) {
    try {
      await fs.rmdir(directoryPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
  try {
    await fs.rmdir(stagingRoot);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

async function findStagedSessionDeletions(aiosPath) {
  const sessionsRoot = path.resolve(aiosPath, SESSIONS_SUBDIR);
  const stagingRoot = path.join(sessionsRoot, DELETION_STAGING_DIR);
  const stagingStats = await lstatIfPresent(stagingRoot);
  if (!stagingStats) return { staged: [], datePaths: [], stagingRoot };
  if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
    throw new Error("Unsafe staged session deletion storage.");
  }
  const dateEntries = await readContainedDirectory(stagingRoot, stagingRoot, {
    readdirOptions: { withFileTypes: true },
  }) || [];
  const staged = [];
  const datePaths = [];

  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) {
      throw new Error("Ambiguous staged session deletion; refusing automatic recovery.");
    }
    const datePath = path.join(stagingRoot, dateEntry.name);
    datePaths.push(datePath);
    const fileEntries = await readContainedDirectory(stagingRoot, datePath, {
      readdirOptions: { withFileTypes: true },
    }) || [];
    for (const fileEntry of fileEntries) {
      const match = STAGED_DELETION_PATTERN.exec(fileEntry.name);
      if (!fileEntry.isFile() || !match) {
        throw new Error("Ambiguous staged session deletion; refusing automatic recovery.");
      }
      const originalRelative = path.posix.join(SESSIONS_SUBDIR, dateEntry.name, match[1]);
      const originalPath = resolveSessionFilePath(
        aiosPath,
        originalRelative,
        "Staged session deletion",
      );
      const stagedPath = path.join(datePath, fileEntry.name);
      await validateManagedFilePath(stagedPath, sessionsRoot);
      staged.push({ originalRelative, originalPath, stagedPath });
    }
  }
  return { staged, datePaths, stagingRoot };
}

// A delete first renames the canonical session, then atomically rewrites the
// index. A process death can therefore leave one of two recognizable states.
// The frontmatter is never used as a prepared request journal: this only
// restores or removes the exact canonical session file already being deleted.
async function recoverStagedSessionDeletions(aiosPath) {
  const { staged, datePaths, stagingRoot } = await findStagedSessionDeletions(aiosPath);
  if (staged.length === 0) {
    await removeEmptyDeletionStagingDirectories(datePaths, stagingRoot);
    return;
  }

  const byOriginal = new Map();
  for (const candidate of staged) {
    const group = byOriginal.get(candidate.originalRelative) || [];
    group.push(candidate);
    byOriginal.set(candidate.originalRelative, group);
  }
  if ([...byOriginal.values()].some((group) => group.length !== 1)) {
    throw new Error("Ambiguous staged session deletion; refusing automatic recovery.");
  }

  const entries = await readSessionIndex(aiosPath, { strict: true });
  const sessionsRoot = path.resolve(aiosPath, SESSIONS_SUBDIR);
  const recovery = [];
  for (const [originalRelative, [candidate]] of byOriginal) {
    const rows = entries.filter((entry) => sameSessionIndexPath(entry.path, originalRelative));
    if (rows.length > 1) {
      throw new Error("Ambiguous staged session deletion; refusing automatic recovery.");
    }
    const stagedStats = await validateManagedFilePath(candidate.stagedPath, sessionsRoot);
    const canonicalStats = await validateManagedFilePath(candidate.originalPath, sessionsRoot);
    if (canonicalStats) {
      if (rows.length === 1 && sameFileIdentity(stagedStats, canonicalStats)) {
        recovery.push({ action: "finish-restore", ...candidate });
        continue;
      }
      throw new Error("Ambiguous staged session deletion; refusing automatic recovery.");
    }
    recovery.push({ action: rows.length === 1 ? "restore" : "finish-delete", ...candidate });
  }

  for (const candidate of recovery) {
    if (candidate.action === "restore") {
      try {
        await fs.link(candidate.stagedPath, candidate.originalPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error("Ambiguous staged session deletion; refusing automatic recovery.");
        }
        throw error;
      }
    }
    await fs.unlink(candidate.stagedPath);
  }
  await removeEmptyDeletionStagingDirectories(datePaths, stagingRoot);
}

export async function searchSessions(aiosPath, query, {
  agent,
  project,
  since,
  limit = 20,
  readOnly = false,
  filesystem,
  reader,
  root = aiosPath
} = {}) {
  const entries = await filterSessions(aiosPath, {
    agent,
    project,
    since,
    readOnly,
    filesystem,
    reader,
    root
  });
  const lower = query.toLowerCase();
  const results = [];
  const sessionsRoot = path.resolve(aiosPath, SESSIONS_SUBDIR);
  const newestFirst = entries.slice().reverse();
  const exactIdMatches = newestFirst.filter((entry) => (
    typeof entry.session_id === "string" && entry.session_id.toLowerCase() === lower
  ));
  const exactIds = new Set(exactIdMatches);
  const candidates = [...exactIdMatches, ...newestFirst.filter((entry) => !exactIds.has(entry))];
  const includesQuery = (value) => typeof value === "string" && value.toLowerCase().includes(lower);

  for (const entry of candidates) {
    let filePath = null;
    if (reader) {
      const normalizedPath = normalizeReadableSessionIndexPath(entry.path);
      if (normalizedPath === null) {
        throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
      }
      filePath = path.resolve(aiosPath, normalizedPath);
      if (
        !isPathWithinLexically(path.resolve(root), filePath)
        || !isPathWithinLexically(sessionsRoot, filePath)
      ) {
        throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
      }
    }
    const titleMatch = includesQuery(entry.title);
    const sessionIdMatch = includesQuery(entry.session_id);
    const agentMatch = includesQuery(entry.agent);
    const projectMatch = includesQuery(entry.project);

    if (sessionIdMatch || titleMatch || agentMatch || projectMatch) {
      results.push({ entry, bodyMatch: false });
      if (results.length >= limit) break;
      continue;
    }

    const normalizedPath = normalizeReadableSessionIndexPath(entry.path);
    if (normalizedPath === null) continue;
    filePath ||= path.join(aiosPath, normalizedPath);
    let body;
    try {
      body = reader
        ? await reader.readText(root, filePath)
        : await fs.readFile(filePath, "utf8");
      if (body === null) continue;
    } catch (error) {
      if (reader) throw error;
      continue;
    }

    const bodyContent = stripFrontmatter(body);
    if (bodyContent.toLowerCase().includes(lower)) {
      const snippet = extractSnippet(bodyContent, lower);
      results.push({ entry, bodyMatch: true, snippet });
    }

    if (results.length >= limit) break;
  }

  return results;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long a held lock can sit (by mtime) before we assume the holder is wedged
// and reclaim it. Index mutations are sub-second, so this is a generous backstop
// for a holder whose liveness we cannot otherwise determine.
const LOCK_STALE_MS = 15000;
// Hard ceiling on how long we wait for a live holder before giving up. Reaching
// it means a real process held the lock continuously — we error rather than run
// fn() unlocked, which would defeat the lock and corrupt the index.
const LOCK_WAIT_MS = 30000;

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureRealDirectory(directoryPath) {
  try {
    await fs.mkdir(directoryPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe session storage directory: ${directoryPath}`);
  }
}

async function prepareSessionStorage(aiosPath) {
  const safeAiosPath = await fs.realpath(aiosPath);
  const rootStats = await fs.lstat(safeAiosPath);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Unsafe selected AIOS root for session storage: ${aiosPath}`);
  }

  await ensureRealDirectory(path.join(safeAiosPath, "memory"));
  const sessionsRoot = path.join(safeAiosPath, SESSIONS_SUBDIR);
  await ensureRealDirectory(sessionsRoot);
  await ensureRealDirectory(path.join(safeAiosPath, path.dirname(LOCKS_SUBDIR)));
  await ensureRealDirectory(path.join(safeAiosPath, LOCKS_SUBDIR));
  for (const leaf of [INDEX_FILENAME, `${INDEX_FILENAME}.lock`]) {
    const stats = await lstatIfPresent(path.join(sessionsRoot, leaf));
    if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
      throw new Error(`Unsafe session storage file: ${path.join(sessionsRoot, leaf)}`);
    }
  }
  const deletionStaging = await lstatIfPresent(path.join(sessionsRoot, DELETION_STAGING_DIR));
  if (deletionStaging && (!deletionStaging.isDirectory() || deletionStaging.isSymbolicLink())) {
    throw new Error("Unsafe staged session deletion storage.");
  }
  return safeAiosPath;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but owned by another user
  }
}

// A lock is stealable if the PID written in it is no longer alive, or — as a
// backstop for an unreadable/legacy lock — if it is older than LOCK_STALE_MS.
async function lockIsStealable(aiosPath, lockPath) {
  let handle;
  try {
    await validateManagedFilePath(lockPath, aiosPath);
    const before = await fs.lstat(lockPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Unsafe session index lock: ${lockPath}`);
    }
    handle = await fs.open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    const current = await fs.lstat(lockPath);
    if (
      !opened.isFile()
      || opened.size > 64
      || !sameFileIdentity(opened, before)
      || !sameFileIdentity(opened, current)
    ) return false;
    const raw = await handle.readFile("utf8");
    const completed = await handle.stat();
    if (!sameFileIdentity(opened, completed)) return false;
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid);
    return Date.now() - opened.mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false; // lock vanished; let the open() retry win the race
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Atomically remove a stale lock. rename() is atomic: if two processes race to
// steal the same lock, exactly one wins the rename and the other gets ENOENT —
// so two stealers can't both delete a fresh lock and double-acquire. Best-effort;
// any error means another process already moved it, so we just retry the loop.
async function stealLock(lockPath) {
  const moved = `${lockPath}.steal.${process.pid}.${Date.now()}`;
  try {
    await fs.rename(lockPath, moved);
  } catch {
    return; // someone else stole or replaced it first
  }
  await fs.rm(moved, { force: true });
}

// A stale decision must not be allowed to rename a newer live lock. Serialize
// the inspect-and-rename sequence itself so every contender rechecks the lock
// after it owns this short-lived guard.
async function tryStealLock(aiosPath, lockPath) {
  const guardPath = path.join(
    aiosPath,
    LOCKS_SUBDIR,
    INDEX_STEAL_GUARD_FILENAME,
  );
  await validateManagedFilePath(guardPath, aiosPath);
  const guard = await acquireOperationLock(guardPath, {
    format: INDEX_STEAL_GUARD_FORMAT,
    staleMs: LOCK_STALE_MS,
    ownsParent: false,
  });
  if (!guard) return false;
  try {
    if (!await lockIsStealable(aiosPath, lockPath)) return false;
    await stealLock(lockPath);
    return true;
  } finally {
    await releaseOperationLock(guard);
  }
}

// Serialize index mutations across processes so a concurrent append and a full
// rewrite can't drop each other's changes. The lock records the
// holder's PID so a crashed holder is reclaimed immediately; a still-live holder
// is waited on (never overrun). Bounded by LOCK_WAIT_MS so the CLI never hangs.
async function withIndexLock(aiosPath, fn) {
  const safeAiosPath = await prepareSessionStorage(aiosPath);
  const indexPath = path.join(safeAiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  const lockPath = `${indexPath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle = null;
  let lockIdentity = null;
  while (!handle) {
    // Checked every iteration (including after a steal) so the loop is bounded.
    if (Date.now() > deadline) {
      throw new Error(`Timed out acquiring the session index lock (${lockPath}); a live process is holding it.`);
    }
    try {
      await validateManagedFilePath(lockPath, safeAiosPath);
      handle = await fs.open(
        lockPath,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_WRONLY
          | (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      lockIdentity = await handle.stat();
      const current = await fs.lstat(lockPath);
      if (!lockIdentity.isFile() || lockIdentity.nlink !== 1 || !sameFileIdentity(lockIdentity, current)) {
        throw new Error(`Unsafe session index lock: ${lockPath}`);
      }
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
      }
      if (err.code !== "EEXIST") throw err;
      if (
        !await lockIsStealable(safeAiosPath, lockPath)
        || !await tryStealLock(safeAiosPath, lockPath)
      ) {
        await delay(50);
      }
    }
  }
  try {
    await handle.write(String(process.pid));
    await recoverStagedSessionDeletions(safeAiosPath);
    return await fn(safeAiosPath);
  } finally {
    await handle.close().catch(() => {});
    try {
      const current = await fs.lstat(lockPath);
      if (sameFileIdentity(lockIdentity, current)) await fs.unlink(lockPath);
    } catch {}
  }
}

// Callers hold withIndexLock. Keeping the append primitive lock-free prevents a
// same-process reentrant acquisition, which the exclusive PID lock cannot allow.
async function appendSessionIndexLine(aiosPath, entry) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  let existing;
  try {
    existing = await readContainedFile(aiosPath, indexPath, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof ContainedReadError) {
      throw new Error(`Unsafe session index file: ${indexPath}`);
    }
    throw error;
  }
  await writeFileSafe(
    indexPath,
    `${existing || ""}${existing && !existing.endsWith("\n") ? "\n" : ""}${formatJsonlEntry(entry)}`,
    "overwrite",
    { boundaryRoot: aiosPath },
  );
}

// Atomic replace. Callers must hold withIndexLock for the read-modify-write.
async function writeSessionIndex(aiosPath, entries) {
  const indexPath = path.join(aiosPath, SESSIONS_SUBDIR, INDEX_FILENAME);
  const content = entries.map(formatJsonlEntry).join("");
  await writeFileSafe(indexPath, content, "overwrite", { boundaryRoot: aiosPath });
}

function parseSinceFlag(since) {
  const match = since.match(/^(\d+)([dhwm])$/);
  if (!match) return since;
  const n = Number(match[1]);
  const ms = { d: 86400000, h: 3600000, w: 604800000, m: 2592000000 }[match[2]];
  return new Date(Date.now() - n * ms).toISOString();
}

function stripFrontmatter(content) {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  return content.slice(end + 4);
}

function extractSnippet(text, query) {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return "";
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "");
}
