import path from "node:path";

import {
  compareTurnSequences,
  contentHash,
  deriveProjectionRows,
  parseSessionMarkdown,
  SESSION_CODEC_LIMITS,
  strictDecodeUtf8,
} from "./session-codec.mjs";
import {
  createContainedReadBudget,
  inspectContainedDirectory,
  inspectContainedFileMetadata,
  readContainedDirectory,
  readContainedFile,
  sameContainedDirectorySnapshot,
  sameContainedFileMetadataSnapshot,
} from "./contained-read.mjs";
import { isPathWithinLexically } from "./paths.mjs";
import {
  isSessionDateDirectory,
  isSessionMarkdownFilename,
  parseSessionRelativePath,
  SESSIONS_RELATIVE,
} from "./session-paths.mjs";
import { fileIdentity } from "./session-store-files.mjs";

export function createSessionInventory(context) {
  const {
    aiosPath,
    filesystem,
    indexPath,
    limits,
    projectionBytes,
    refuse,
    sessionsRoot,
    stableJson,
  } = context;
  async function loadSnapshot({ report = false, reader = null, deleteExact = false } = {}) {
    const inventory = await inventoryCanonical({ report, reader, deleteExact });
    const projection = await readProjection({ report, reader });
    await revalidateInventory(inventory.validation);
    const derivedRows = deriveProjectionRows(inventory.records, {
      maxRecords: deleteExact ? limits.maxEntries : limits.maxCanonicalFiles,
    });
    const derivedByPath = new Map(derivedRows.map((row) => [row.path, row]));
    const records = inventory.records.map((record) => ({ ...record, row: derivedByPath.get(record.relativePath) }));
    const analyzed = analyzeProjection(projection, derivedRows, { report });
    const sourceGroups = classifySources(records);
    return Object.freeze({
      records: Object.freeze(records),
      derivedRows,
      projectionText: projection.text,
      projectionIdentity: projection.identity,
      projectionMissing: projection.missing,
      malformedRows: projection.malformedRows,
      invalidMarkdown: inventory.invalidMarkdown,
      unsafeCanonical: inventory.unsafe,
      ...analyzed,
      ...sourceGroups,
    });
  }

  async function inventoryCanonical({ report = false, reader = null, deleteExact = false } = {}) {
    const maxCanonicalFiles = deleteExact ? limits.maxEntries : limits.maxCanonicalFiles;
    const state = {
      budget: createContainedReadBudget({
        maxBytes: limits.maxCanonicalBytes,
        maxFiles: maxCanonicalFiles,
        maxEntries: limits.maxEntries,
      }),
      invalidMarkdown: [],
      reader,
      records: [],
      report,
      unsafe: false,
      validation: { directories: [], files: [] },
    };
    let rootEntries;
    try {
      const rootSnapshot = await inspectContainedDirectory(aiosPath, sessionsRoot, {
        filesystem,
        returnSnapshot: true,
      });
      if (rootSnapshot) state.validation.directories.push({ path: sessionsRoot, snapshot: rootSnapshot });
      rootEntries = state.reader
        ? await state.reader.listDirectory(aiosPath, sessionsRoot, {
            maxEntries: limits.maxEntries,
            tooManyCode: "DOTAIOS_SESSION_INVENTORY_TOO_LARGE",
          })
        : await readContainedDirectory(aiosPath, sessionsRoot, {
            filesystem,
            budget: state.budget,
            maxEntries: limits.maxEntries,
            readdirOptions: { withFileTypes: true },
          });
    } catch (error) {
      if (!report) throw error;
      return canonicalInventoryResult(state, { rootInvalid: true });
    }
    if (rootEntries === null) return canonicalInventoryResult(state);
    for (const entry of [...rootEntries].sort((left, right) => left.name.localeCompare(right.name))) {
      await inventoryRootEntry(entry, state);
    }
    if (state.records.length > maxCanonicalFiles) refuse("DOTAIOS_SESSION_INVENTORY_TOO_LARGE");
    return canonicalInventoryResult(state);
  }

  async function inventoryRootEntry(entry, state) {
    if (entry.name === "index.jsonl") return;
    if (entry.isSymbolicLink()) {
      markUnsafeCanonical(state);
      return;
    }
    if (!entry.isDirectory()) {
      if (entry.name.endsWith(".md")) {
        markUnsafeCanonical(state, `${SESSIONS_RELATIVE}/${entry.name}`);
      }
      return;
    }
    if (!isSessionDateDirectory(entry.name)) {
      markUnsafeCanonical(state);
      return;
    }
    const datePath = path.join(sessionsRoot, entry.name);
    let files;
    try {
      const snapshot = await inspectContainedDirectory(aiosPath, datePath, {
        filesystem,
        returnSnapshot: true,
      });
      if (!snapshot) refuse("DOTAIOS_SESSION_CANONICAL_CHANGED");
      state.validation.directories.push({ path: datePath, snapshot });
      files = await readCanonicalDirectory(datePath, state);
    } catch (error) {
      if (!state.report) throw error;
      markUnsafeCanonical(state, `${SESSIONS_RELATIVE}/${entry.name}`);
      return;
    }
    for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
      await inventoryCanonicalFile(entry.name, datePath, file, state);
    }
  }

  function readCanonicalDirectory(datePath, state) {
    return state.reader
      ? state.reader.listDirectory(aiosPath, datePath, {
          maxEntries: limits.maxEntries,
          tooManyCode: "DOTAIOS_SESSION_INVENTORY_TOO_LARGE",
        })
      : readContainedDirectory(aiosPath, datePath, {
          filesystem,
          budget: state.budget,
          maxEntries: limits.maxEntries,
          readdirOptions: { withFileTypes: true },
        });
  }

  async function inventoryCanonicalFile(date, datePath, file, state) {
    const relativePath = `${SESSIONS_RELATIVE}/${date}/${file.name}`;
    const absolutePath = path.join(datePath, file.name);
    if (!file.isFile() || file.isSymbolicLink() || !isSessionMarkdownFilename(file.name)) {
      markUnsafeCanonical(state, relativePath);
      return;
    }
    try {
      const before = await inspectContainedFileMetadata(aiosPath, absolutePath, { filesystem });
      assertCurrentUserFile(before, "DOTAIOS_SESSION_CANONICAL_UNSAFE", refuse);
      const markdown = await readCanonicalMarkdown(absolutePath, state);
      const after = await inspectContainedFileMetadata(aiosPath, absolutePath, { filesystem });
      if (!sameContainedFileMetadataSnapshot(before, after)) refuse("DOTAIOS_SESSION_CANONICAL_CHANGED");
      assertCurrentUserFile(after, "DOTAIOS_SESSION_CANONICAL_UNSAFE", refuse);
      state.validation.files.push({ path: absolutePath, snapshot: after });
      const markdownText = strictDecodeUtf8(markdown);
      state.records.push(makeRecord(
        parseSessionMarkdown(markdownText),
        relativePath,
        markdownText,
        fileIdentity(after.stats),
      ));
    } catch (error) {
      if (!state.report) throw error;
      state.invalidMarkdown.push(relativePath);
    }
  }

  function readCanonicalMarkdown(absolutePath, state) {
    return state.reader
      ? state.reader.readText(aiosPath, absolutePath, { maxBytes: SESSION_CODEC_LIMITS.documentBytes })
      : readContainedFile(aiosPath, absolutePath, {
          filesystem,
          budget: state.budget,
          maxBytes: SESSION_CODEC_LIMITS.documentBytes,
          tooLargeCode: "DOTAIOS_SESSION_DOCUMENT_TOO_LARGE",
        });
  }

  function markUnsafeCanonical(state, reportPath = null) {
    state.unsafe = true;
    if (reportPath) state.invalidMarkdown.push(reportPath);
    if (!state.report) refuse("DOTAIOS_SESSION_CANONICAL_UNSAFE");
  }

  function canonicalInventoryResult(state, { rootInvalid = false } = {}) {
    return {
      records: state.records,
      invalidMarkdown: rootInvalid
        ? [SESSIONS_RELATIVE]
        : [...new Set(state.invalidMarkdown)].sort(),
      unsafe: rootInvalid || state.unsafe,
      validation: state.validation,
    };
  }

  async function revalidateInventory(validation) {
    if (!validation) return;
    for (const observed of validation.directories) {
      const current = await inspectContainedDirectory(aiosPath, observed.path, {
        filesystem,
        returnSnapshot: true,
      });
      if (!sameContainedDirectorySnapshot(observed.snapshot, current)) {
        refuse("DOTAIOS_SESSION_INVENTORY_CHANGED");
      }
    }
    for (const observed of validation.files) {
      const current = await inspectContainedFileMetadata(aiosPath, observed.path, { filesystem });
      if (!sameContainedFileMetadataSnapshot(observed.snapshot, current)) {
        refuse("DOTAIOS_SESSION_INVENTORY_CHANGED");
      }
    }
  }

  async function readProjection({ report = false, reader = null } = {}) {
    let metadata;
    try {
      metadata = await inspectContainedFileMetadata(aiosPath, indexPath, { filesystem });
      assertCurrentUserFile(metadata, "DOTAIOS_SESSION_PROJECTION_ROW_UNSAFE", refuse);
    } catch (error) {
      if (error?.code === "ENOENT") return { text: null, identity: null, missing: true, rows: [], malformedRows: 0 };
      if (report) return { text: null, identity: null, missing: false, rows: [], malformedRows: 0, unsafe: true };
      throw error;
    }
    let text;
    try {
      text = reader
        ? await reader.readText(aiosPath, indexPath, { maxBytes: limits.maxProjectionBytes })
        : await readContainedFile(aiosPath, indexPath, { filesystem, encoding: "utf8", maxBytes: limits.maxProjectionBytes });
      const after = await inspectContainedFileMetadata(aiosPath, indexPath, { filesystem });
      if (!sameContainedFileMetadataSnapshot(metadata, after)) refuse("DOTAIOS_SESSION_PROJECTION_CHANGED");
      assertCurrentUserFile(after, "DOTAIOS_SESSION_PROJECTION_ROW_UNSAFE", refuse);
      metadata = after;
    } catch (error) {
      if (report) return { text: null, identity: null, missing: false, rows: [], malformedRows: 0, unsafe: true };
      throw error;
    }
    const rows = [];
    let malformedRows = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (rows.length + malformedRows >= limits.maxEntries) {
        refuse("DOTAIOS_SESSION_INVENTORY_TOO_LARGE");
      }
      try { rows.push(JSON.parse(line)); } catch { malformedRows += 1; }
    }
    return { text, identity: fileIdentity(metadata.stats), missing: false, rows, malformedRows, unsafe: false };
  }

  function analyzeProjection(projection, derivedRows, { report }) {
    const derivedByPath = new Map(derivedRows.map((row) => [row.path, row]));
    const seenPaths = new Set();
    const seenIds = new Set();
    const duplicatePaths = new Set();
    const duplicateIds = new Set();
    const staleRows = [];
    const matched = new Set();
    let unsafeRows = projection.unsafe ? 1 : 0;
    for (const row of projection.rows) {
      try {
        assertSafeProjectionRow(row);
      } catch (error) {
        unsafeRows += 1;
        if (!report) throw error;
        continue;
      }
      if (seenPaths.has(row.path)) duplicatePaths.add(row.path);
      if (seenIds.has(row.session_id)) duplicateIds.add(row.session_id);
      seenPaths.add(row.path);
      seenIds.add(row.session_id);
      const expected = derivedByPath.get(row.path);
      if (!expected || stableJson(expected) !== stableJson(row)) staleRows.push(row.path);
      else matched.add(row.path);
    }
    const orphanMarkdown = derivedRows.map((row) => row.path).filter((relativePath) => !matched.has(relativePath));
    return {
      orphanMarkdown: Object.freeze(orphanMarkdown.sort()),
      staleRows: Object.freeze(staleRows.sort()),
      duplicatePaths: Object.freeze([...duplicatePaths].sort()),
      duplicateIds: Object.freeze([...duplicateIds].sort()),
      unsafeRows,
    };
  }

  function classifySources(records) {
    const groups = new Map();
    for (const record of records) {
      if (!record.session.source_path) continue;
      const group = groups.get(record.session.source_path) || [];
      group.push(record);
      groups.set(record.session.source_path, group);
    }
    const duplicateSources = [];
    const conflictingSources = [];
    for (const [identity, group] of groups) {
      if (group.length < 2) continue;
      const first = group[0].session;
      const equal = group.slice(1).every((record) => compareTurnSequences(first, record.session) === "equal");
      (equal ? duplicateSources : conflictingSources).push({
        source: contentHash(identity),
        sessions: group.map((record) => record.session.session_id).sort(),
      });
    }
    return { duplicateSources: Object.freeze(duplicateSources), conflictingSources: Object.freeze(conflictingSources) };
  }

  function buildReconcileReport(snapshot) {
    return {
      orphan_markdown: snapshot.orphanMarkdown,
      stale_rows: snapshot.staleRows,
      malformed_rows: snapshot.malformedRows,
      unsafe_rows: snapshot.unsafeRows,
      invalid_markdown: snapshot.invalidMarkdown,
      duplicate_ids: snapshot.duplicateIds,
      duplicate_paths: snapshot.duplicatePaths,
      duplicate_sources: snapshot.duplicateSources,
      conflicting_sources: snapshot.conflictingSources,
      projection_missing: snapshot.projectionMissing,
    };
  }

  function reportIsClean(report) {
    return report.malformed_rows === 0
      && report.unsafe_rows === 0
      && !report.projection_missing
      && ["orphan_markdown", "stale_rows", "invalid_markdown", "duplicate_ids", "duplicate_paths"].every((key) => report[key].length === 0);
  }

  function assertMutationProjection(snapshot) {
    if (
      snapshot.invalidMarkdown.length
      || snapshot.unsafeCanonical
      || snapshot.malformedRows
      || snapshot.unsafeRows
      || snapshot.staleRows.length
      || snapshot.orphanMarkdown.length
      || snapshot.duplicateIds.length
      || snapshot.duplicatePaths.length
      || (snapshot.projectionMissing && snapshot.records.length > 0)
      || (!snapshot.projectionMissing && snapshot.projectionText !== projectionBytes(snapshot.derivedRows))
    ) refuse("DOTAIOS_SESSION_RECONCILIATION_REQUIRED");
  }

  function assertReadableProjection(snapshot) {
    if (
      snapshot.invalidMarkdown.length
      || snapshot.unsafeCanonical
      || snapshot.unsafeRows
      || snapshot.staleRows.length
      || snapshot.orphanMarkdown.length
      || snapshot.duplicateIds.length
      || snapshot.duplicatePaths.length
      || (snapshot.projectionMissing && snapshot.records.length > 0)
    ) refuse("DOTAIOS_SESSION_PROJECTION_DRIFT", "Session memory requires report-only reconciliation.");
  }

  function assertSafeProjectionRow(row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) refuse("DOTAIOS_SESSION_PROJECTION_ROW_UNSAFE");
    const relativePath = row.path;
    if (
      typeof relativePath !== "string"
      || !parseSessionRelativePath(relativePath)
      || path.isAbsolute(relativePath)
      || relativePath.includes("\\")
      || relativePath.includes("\0")
      || relativePath.split("/").some((part) => part === "." || part === ".." || part === "")
      || !isPathWithinLexically(sessionsRoot, path.resolve(aiosPath, relativePath))
    ) refuse("DOTAIOS_SESSION_PROJECTION_ROW_UNSAFE");
    if (typeof row.session_id !== "string" || !row.session_id) refuse("DOTAIOS_SESSION_PROJECTION_ROW_UNSAFE");
  }

  return Object.freeze({
    assertMutationProjection,
    assertReadableProjection,
    buildReconcileReport,
    loadSnapshot,
    reportIsClean,
  });
}

function makeRecord(session, relativePath, markdown, identity = null) {
  return Object.freeze({ session, relativePath, markdown, identity });
}

function assertCurrentUserFile(metadata, code, refuse) {
  if (
    process.platform !== "win32"
    && typeof process.getuid === "function"
    && Number(metadata.stats.uid) !== process.getuid()
  ) refuse(code);
}
