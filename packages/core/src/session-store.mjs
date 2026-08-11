import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compareTurnSequences,
  contentHash,
  deriveProjectionRows,
  generateSessionId,
  normalizeSession,
  parseSessionMarkdown,
  renderSessionBody,
  renderSessionMarkdown,
  SESSION_CODEC_LIMITS,
  sessionFilename,
  strictDecodeUtf8,
} from "./session-codec.mjs";
import {
  inspectContainedFileMetadata,
  readContainedFile,
  sameContainedFileMetadataSnapshot,
} from "./contained-read.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import { isPathWithinLexically } from "./paths.mjs";
import { SESSIONS_RELATIVE } from "./session-paths.mjs";
import { createSessionInventory } from "./session-store-inventory.mjs";
import { createSessionTransactionManager } from "./session-store-transactions.mjs";

const STORE_RELATIVE = ".dotaios/session-store";
const LOCK_FORMAT = "dotaios-session-store-lock/v1";

// Losing a race for the lock arrives as a thrown error, not as a failed
// acquisition. Both of these are raised while inspecting a lock another
// process is publishing or releasing at that exact moment: the caller never
// reached the stored sessions, so there is nothing to distrust and nothing to
// roll back. The outer loop already owns the retry budget, so it retries.
//
// Tampering is not caught here. prepareOperationalRoot() checks ownership,
// permissions and symlinks before the loop starts, and it rejects in 0 ms
// without ever entering a retry -- see tests/core/session-store-contention.test.mjs.
const CONTENDED_ACQUISITION_CODES = new Set([
  "DOTAIOS_OWNED_STATE_INVALID",
  "DOTAIOS_OPERATION_LOCK_REMOVED",
]);
const DEFAULT_LIMITS = Object.freeze({
  maxCanonicalFiles: 512,
  maxCanonicalBytes: 16 * 1024 * 1024,
  maxEntries: 10_000,
  maxProjectionBytes: 8 * 1024 * 1024,
  lockTimeoutMs: 10_000,
});

export class SessionStoreError extends Error {
  constructor(code, message = "SessionStore refused unsafe or inconsistent local state.") {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new SessionStoreError(code, message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function projectionBytes(rows) {
  return rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function sessionRelativePath(session) {
  return `${SESSIONS_RELATIVE}/${session.captured_at.slice(0, 10)}/${sessionFilename(session)}`;
}

function publicError(error) {
  if (error instanceof SessionStoreError) return error;
  if (typeof error?.code === "string" && error.code.startsWith("DOTAIOS_")) {
    return new SessionStoreError(error.code);
  }
  return new SessionStoreError("DOTAIOS_SESSION_STORE_IO");
}

export function createSessionStore(options = {}) {
  const aiosPath = path.resolve(options.aiosPath || "");
  if (!options.aiosPath || aiosPath === path.parse(aiosPath).root) {
    throw new TypeError("SessionStore requires a concrete AIOS path.");
  }
  const filesystem = options.filesystem || fs;
  const clock = options.clock || (() => new Date());
  const faultInjector = options.faultInjector || (() => {});
  const sessionIdGenerator = options.sessionIdGenerator || generateSessionId;
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits, lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LIMITS.lockTimeoutMs });
  const sessionsRoot = path.join(aiosPath, "memory", "sessions");
  const indexPath = path.join(sessionsRoot, "index.jsonl");
  const dotaiosRoot = path.join(aiosPath, ".dotaios");
  const storeRoot = path.join(aiosPath, STORE_RELATIVE);
  const pendingPath = path.join(storeRoot, "pending");
  const lockPath = path.join(storeRoot, "store.lock");
  const {
    assertMutationProjection,
    assertReadableProjection,
    buildReconcileReport,
    loadSnapshot,
    reportIsClean,
  } = createSessionInventory({
    aiosPath,
    filesystem,
    indexPath,
    limits,
    projectionBytes,
    refuse,
    sessionsRoot,
    stableJson,
  });
  const {
    inspectOperationalState,
    prepareOperationalRoot,
    prepareMutation,
    publishMutation,
  } = createSessionTransactionManager({
    aiosPath,
    dotaiosRoot,
    faultInjector,
    filesystem,
    indexPath,
    loadSnapshot,
    pendingPath,
    projectionBytes,
    refuse,
    sessionsRoot,
    storeRoot,
  });

  async function capture(request = {}) {
    return mutate(async () => {
      const candidate = await candidateFromRequest(request);
      if (candidate?.refused) {
        return Object.freeze({ outcome: "refused", committed: false, reason: candidate.refused });
      }
      const snapshot = await loadSnapshot();
      assertMutationProjection(snapshot);
      const sourceIdentity = candidate.source_path || null;
      const group = sourceIdentity
        ? snapshot.records.filter((record) => record.session.source_path === sourceIdentity)
        : [];
      return captureCandidate(candidate, snapshot, group);
    }, "capture");
  }

  async function captureCandidate(candidate, snapshot, group) {
    if (group.length > 1) {
      return Object.freeze({ outcome: "reconciliation_required", committed: false });
    }
    if (group.length === 0) {
      return publishAddition("create", candidate, snapshot, { outcome: "created", committed: true });
    }
    const prior = group[0];
    const relation = compareTurnSequences(prior.session, candidate);
    if (relation === "equal" || relation === "candidate_prefix") {
      return Object.freeze({ outcome: "idempotent", committed: true, session: prior.session, row: prior.row });
    }
    if (relation === "existing_prefix") return publishGrowth(candidate, prior, snapshot);
    return publishAddition("conflict", candidate, snapshot, {
      outcome: "conflict_preserved",
      committed: false,
    });
  }

  async function publishGrowth(candidate, prior, snapshot) {
    const grown = normalizeSession({
      ...candidate,
      session_id: prior.session.session_id,
      captured_at: prior.session.captured_at,
      agent: prior.session.agent,
      source_type: prior.session.source_type,
      source_path: prior.session.source_path,
      ...(prior.session.project ? { project: prior.session.project } : { project: undefined }),
      ...(prior.session.project_id ? { project_id: prior.session.project_id } : { project_id: undefined }),
    });
    const markdown = renderSessionMarkdown(grown);
    const records = snapshot.records.map((record) => (
      record.relativePath === prior.relativePath
        ? makeRecord(grown, prior.relativePath, markdown)
        : record
    ));
    await publishMutation({
      kind: "grow",
      targetRelative: prior.relativePath,
      canonicalBefore: prior.markdown,
      canonicalBeforeIdentity: prior.identity,
      canonicalAfter: markdown,
      projectionBefore: snapshot.projectionText,
      projectionBeforeIdentity: snapshot.projectionIdentity,
      projectionAfter: projectionBytes(deriveProjectionRows(records)),
    });
    const after = await loadSnapshot();
    const record = after.records.find((entry) => entry.session.session_id === grown.session_id);
    return Object.freeze({ outcome: "grown", committed: true, session: record.session, row: record.row, relativePath: record.relativePath });
  }

  async function publishAddition(kind, candidate, snapshot, result) {
    const session = reserveIdentity(candidate, snapshot.records);
    const relativePath = reserveRelativePath(session, snapshot.records);
    const markdown = renderSessionMarkdown(session);
    const records = [...snapshot.records, makeRecord(session, relativePath, markdown)];
    await publishMutation({
      kind,
      targetRelative: relativePath,
      canonicalBefore: null,
      canonicalAfter: markdown,
      projectionBefore: snapshot.projectionText,
      projectionBeforeIdentity: snapshot.projectionIdentity,
      projectionAfter: projectionBytes(deriveProjectionRows(records)),
    });
    const after = await loadSnapshot();
    const record = after.records.find((entry) => entry.relativePath === relativePath);
    return Object.freeze({ ...result, session: record.session, row: record.row, relativePath });
  }

  async function reconcile({ apply = false } = {}) {
    if (!apply) return reconcileReport();
    return mutate(async () => {
      const snapshot = await loadSnapshot({ report: true });
      if (snapshot.invalidMarkdown.length > 0 || snapshot.unsafeCanonical) {
        refuse("DOTAIOS_SESSION_RECONCILE_UNSAFE");
      }
      const report = buildReconcileReport(snapshot);
      const afterBytes = projectionBytes(snapshot.derivedRows);
      if (snapshot.projectionText === afterBytes && reportIsClean(report)) {
        return Object.freeze({ outcome: snapshot.conflictingSources.length ? "rebuilt_with_conflicts" : "rebuilt", rows: snapshot.derivedRows.length, report });
      }
      await publishMutation({
        kind: "reconcile",
        targetRelative: null,
        canonicalBefore: null,
        canonicalAfter: null,
        projectionBefore: snapshot.projectionText,
        projectionBeforeIdentity: snapshot.projectionIdentity,
        projectionAfter: afterBytes,
      });
      return Object.freeze({ outcome: snapshot.conflictingSources.length ? "rebuilt_with_conflicts" : "rebuilt", rows: snapshot.derivedRows.length, report });
    }, "reconcile");
  }

  async function reconcileReport() {
    try {
      const snapshot = await loadSnapshot({ report: true });
      const operational = await inspectOperationalState();
      return Object.freeze({
        ...buildReconcileReport(snapshot),
        operational_state: operational.status,
      });
    } catch (error) {
      throw publicError(error);
    }
  }

  async function search(request = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await readSearch(request);
      } catch (error) {
        lastError = publicError(error);
        if (attempt === 0) {
          if (lastError.code === "DOTAIOS_SESSION_INVENTORY_CHANGED") {
            continue;
          }
          let operational;
          try { operational = await inspectOperationalState(); } catch (pendingError) {
            throw publicError(pendingError);
          }
          if (operational.status === "pending") {
            await delay(20);
            continue;
          }
        }
        throw lastError;
      }
    }
    throw lastError;
  }

  async function readSearch(request) {
    const snapshot = await loadSnapshot({ reader: request.reader });
    assertReadableProjection(snapshot);
    const purpose = normalizePurpose(request.purpose);
    const bodies = new Map();
    const bodyFor = (record) => {
      if (!bodies.has(record)) bodies.set(record, renderSessionBody(record.session));
      return bodies.get(record);
    };
    const conflicts = snapshot.records.filter((record) => record.row.conflict_group);
    const records = selectSearchRecords(snapshot.records, request, purpose, bodyFor);
    return buildSearchResult(records, conflicts, snapshot, purpose, bodyFor);
  }

  function selectSearchRecords(allRecords, request, purpose, bodyFor) {
    let records = allRecords;
    if (purpose === "working-context" || purpose === "compact-digest") {
      records = records.filter((record) => !record.row.conflict_group);
    }
    if (purpose === "exact") {
      if (typeof request.sessionId !== "string" || !request.sessionId) refuse("DOTAIOS_SESSION_SELECTOR_INVALID");
      records = records.filter((record) => record.row.session_id === request.sessionId);
    } else {
      const since = request.since ? parseSince(request.since, clock) : null;
      records = records.filter((record) => matchesSearchFilters(record, request, since));
      const query = String(request.query || "").toLowerCase();
      if (query) records = records.filter((record) => matchesSearchQuery(record, query, bodyFor));
    }
    return records.slice().reverse().slice(0, normalizeLimit(request.limit));
  }

  function buildSearchResult(records, conflicts, snapshot, purpose, bodyFor) {
    const includeBody = purpose === "body" || purpose === "exact";
    const omitsConflicts = purpose === "working-context" || purpose === "compact-digest";
    return Object.freeze({
      rows: Object.freeze(records.map((record) => Object.freeze(includeBody ? {
        ...record.row,
        body: bodyFor(record),
        canonical_hash: sha256(record.markdown),
      } : { ...record.row }))),
      warnings: Object.freeze({ malformed_rows: snapshot.malformedRows }),
      conflicts_omitted: omitsConflicts ? conflicts.length : 0,
      conflict_attributions: omitsConflicts
        ? Object.freeze(conflicts.map(({ row }) => conflictAttribution(row)))
        : Object.freeze([]),
    });
  }

  async function remove({ sessionId } = {}) {
    return mutate(async () => {
      if (typeof sessionId !== "string" || !sessionId) refuse("DOTAIOS_SESSION_SELECTOR_INVALID");
      const snapshot = await loadSnapshot({ deleteExact: true });
      assertMutationProjection(snapshot);
      const matches = snapshot.records.filter((record) => record.session.session_id === sessionId);
      if (matches.length === 0) refuse("DOTAIOS_SESSION_NOT_FOUND", "Session not found.");
      if (matches.length !== 1) refuse("DOTAIOS_SESSION_AMBIGUOUS");
      const target = matches[0];
      const records = snapshot.records.filter((record) => record.relativePath !== target.relativePath);
      await publishMutation({
        kind: "delete",
        targetRelative: target.relativePath,
        canonicalBefore: target.markdown,
        canonicalBeforeIdentity: target.identity,
        canonicalAfter: null,
        projectionBefore: snapshot.projectionText,
        projectionBeforeIdentity: snapshot.projectionIdentity,
        projectionAfter: projectionBytes(deriveProjectionRows(records, { maxRecords: limits.maxEntries })),
      });
      return Object.freeze({ outcome: "deleted", committed: true, session: target.session, row: target.row });
    }, "delete");
  }

  async function mutate(callback, operation) {
    try { await prepareOperationalRoot(); } catch (error) { throw publicError(error); }
    const deadline = Date.now() + limits.lockTimeoutMs;
    let unresolved = null;
    const mutation = Object.freeze({
      check() {
        if (Date.now() > deadline) refuse("DOTAIOS_SESSION_STORE_DEADLINE");
      },
    });
    while (Date.now() <= deadline) {
      try {
        const result = await withOperationLock(lockPath, async () => {
          await prepareMutation(mutation.check);
          return callback(mutation);
        }, {
          filesystem,
          format: LOCK_FORMAT,
          strictOwnedState: true,
          ownsParent: false,
          ownedDirectories: [{ path: dotaiosRoot, sharedParent: true }, storeRoot],
          retainOnError: (error) => error?.code === "DOTAIOS_SESSION_STORE_POISONED",
        });
        if (result.acquired) return result.value;
        // A clean "busy" answer means the condition the previous attempt hit
        // has cleared, so it is no longer the caller's news.
        unresolved = null;
      } catch (error) {
        if (error?.code === "DOTAIOS_SESSION_STORE_DEADLINE") break;
        if (!CONTENDED_ACQUISITION_CODES.has(error?.code)) throw publicError(error);
        unresolved = error;
      }
      await delay(25 + Math.floor(Math.random() * 20));
    }
    // Retrying is only allowed to hide a condition that went away. One that
    // outlived the whole budget is not contention -- a symlinked lock reports
    // the same code every single attempt -- and reporting it as "busy, try
    // again" would turn a tampered store into an install that quietly never
    // saves. Whatever the last attempt saw is what the caller hears.
    if (unresolved) throw publicError(unresolved);
    if (operation === "capture") return Object.freeze({ outcome: "refused", committed: false, reason: "contention" });
    refuse("DOTAIOS_SESSION_STORE_CONTENTION");
  }

  async function candidateFromRequest(request) {
    let candidate;
    if (request.source) candidate = await candidateFromSource(request.source, request);
    else if (request.preparedMarkdown !== undefined) {
      candidate = parseSessionMarkdown(request.preparedMarkdown, { allowMissingSessionId: true });
      if (candidate.source_path) refuse("DOTAIOS_SESSION_SOURCE_IDENTITY_FORBIDDEN");
      candidate = { ...candidate, agent: "prepared", source_type: "prepared" };
    } else if (request.session) {
      candidate = normalizeCaptureCandidate(request.session);
      if (candidate.source_path) refuse("DOTAIOS_SESSION_SOURCE_IDENTITY_FORBIDDEN");
      candidate = { ...candidate, agent: "paste", source_type: "paste" };
    } else {
      refuse("DOTAIOS_SESSION_CAPTURE_INVALID");
    }
    if (candidate?.refused) return candidate;
    return normalizeCaptureCandidate({
      ...candidate,
      ...(request.project ? { project: request.project } : {}),
      ...(request.projectId ? { project_id: request.projectId } : {}),
    });
  }

  async function candidateFromSource(source, request) {
    if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.parser !== "function") {
      refuse("DOTAIOS_SESSION_SOURCE_INVALID");
    }
    if (!path.isAbsolute(source.path || "") || source.path.includes("\0")) refuse("DOTAIOS_SESSION_SOURCE_INVALID");
    const sourcePath = path.resolve(source.path);
    let authorizedRoot;
    if (source.policy === "manual-exact") authorizedRoot = path.dirname(sourcePath);
    else if (source.policy === "claude-code-root") {
      authorizedRoot = path.resolve(options.claudeRoot || path.join(os.homedir(), ".claude", "projects"));
      if (!isPathWithinLexically(authorizedRoot, sourcePath)) refuse("DOTAIOS_SESSION_SOURCE_UNAUTHORIZED");
    } else refuse("DOTAIOS_SESSION_SOURCE_POLICY_INVALID");

    let before;
    try {
      before = await inspectContainedFileMetadata(authorizedRoot, sourcePath, { filesystem });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        refuse("DOTAIOS_SESSION_SOURCE_UNAVAILABLE");
      }
      throw error;
    }
    const bytes = await readContainedFile(authorizedRoot, sourcePath, {
      filesystem,
      maxBytes: SESSION_CODEC_LIMITS.documentBytes,
      tooLargeCode: "DOTAIOS_SESSION_SOURCE_TOO_LARGE",
    });
    const after = await inspectContainedFileMetadata(authorizedRoot, sourcePath, { filesystem });
    if (!sameContainedFileMetadataSnapshot(before, after)) refuse("DOTAIOS_SESSION_SOURCE_CHANGED");
    const text = strictDecodeUtf8(bytes);
    let parsed;
    try {
      parsed = await source.parser(text, {
        project: request.project || null,
        projectId: request.projectId || null,
        sourcePath,
      });
    } catch {
      return Object.freeze({ refused: "malformed_source" });
    }
    if (!parsed) return Object.freeze({ refused: "empty_source" });
    const canonicalPath = await filesystem.realpath(sourcePath);
    const finalSource = await inspectContainedFileMetadata(authorizedRoot, sourcePath, { filesystem });
    if (!sameContainedFileMetadataSnapshot(after, finalSource)) refuse("DOTAIOS_SESSION_SOURCE_CHANGED");
    if (source.policy === "manual-exact" && path.resolve(source.path) !== sourcePath) refuse("DOTAIOS_SESSION_SOURCE_UNAUTHORIZED");
    const sourceAuthority = source.policy === "manual-exact"
      ? { agent: "manual", source_type: "import" }
      : { agent: "claude-code", source_type: "claude-code" };
    const candidate = normalizeCaptureCandidate({ ...parsed, ...sourceAuthority, source_path: canonicalPath });
    if (request.capturedAfter !== undefined) {
      if (
        typeof request.capturedAfter !== "string"
        || Number.isNaN(Date.parse(request.capturedAfter))
      ) refuse("DOTAIOS_SESSION_CAPTURE_CUTOFF_INVALID");
      if (candidate.captured_at < request.capturedAfter) {
        return Object.freeze({ refused: "before_cutoff" });
      }
    }
    return candidate;
  }

  function reserveIdentity(candidate, records) {
    const existing = new Set(records.map((record) => record.session.session_id));
    const prefixes = new Set(records.map((record) => record.session.session_id.slice(0, 6)));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const sessionId = sessionIdGenerator();
      if (!existing.has(sessionId) && !prefixes.has(sessionId.slice(0, 6))) {
        return normalizeSession({ ...candidate, session_id: sessionId });
      }
    }
    refuse("DOTAIOS_SESSION_ID_COLLISION");
  }

  function normalizeCaptureCandidate(candidate) {
    return normalizeSession({ ...candidate, session_id: "capture-candidate" });
  }

  function reserveRelativePath(session, records) {
    const relativePath = sessionRelativePath(session);
    if (records.some((record) => record.relativePath === relativePath)) refuse("DOTAIOS_SESSION_PATH_COLLISION");
    return relativePath;
  }


  return Object.freeze({ capture, reconcile, search, delete: remove });
}

function makeRecord(session, relativePath, markdown, identity = null) {
  return Object.freeze({ session, relativePath, markdown, identity });
}

function normalizeLimit(limit) {
  if (limit === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) refuse("DOTAIOS_SESSION_LIMIT_INVALID");
  return limit;
}

function normalizePurpose(purpose = "body") {
  if (!["catalog", "metadata", "body", "exact", "working-context", "compact-digest"].includes(purpose)) {
    refuse("DOTAIOS_SESSION_PURPOSE_INVALID");
  }
  return purpose;
}

function matchesSearchFilters(record, request, since) {
  if (request.agent && record.row.agent !== request.agent) return false;
  if (request.project && record.row.project !== request.project) return false;
  return !since || record.row.captured_at >= since;
}

function matchesSearchQuery(record, query, bodyFor) {
  const metadata = [record.row.title, record.row.agent, record.row.project]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return metadata.includes(query) || bodyFor(record).toLowerCase().includes(query);
}

function conflictAttribution(row) {
  return Object.freeze({
    ...(row.project ? { project: row.project } : {}),
    ...(row.project_id ? { project_id: row.project_id } : {}),
  });
}

function parseSince(value, clock) {
  const match = String(value).match(/^(\d+)d$/);
  if (!match) refuse("DOTAIOS_SESSION_SINCE_INVALID");
  return new Date(clock().getTime() - Number(match[1]) * 86_400_000).toISOString();
}
