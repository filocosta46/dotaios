import localFilesystem from "node:fs/promises";
import path from "node:path";

import {
  assertContainedDirectorySnapshotsUnchanged,
  ContainedReadError,
  createContainedReadBudget,
  inspectContainedDirectory,
  inspectNearestContainedDirectory,
  inspectContainedPathEntry,
  readContainedDirectory,
  readContainedFile,
  readContainedSnapshotDirectory,
  readContainedSnapshotFile,
  sameContainedDirectorySnapshot
} from "./contained-read.mjs";
import { isPathWithinLexically } from "./paths.mjs";

// These bound an explicit, user-invoked read of the person's own folder —
// search, skill resolution, project-source retrieval. That is a different job
// from the bounded startup projection, which must stay small on every launch
// and keeps its own much tighter budget in working-context.mjs.
//
// They were the projection's numbers: 512 files, 4,096 entries, 16 MiB. A
// lived-in AIOS passes all three long before it feels large — one real folder
// measured ~3,300 markdown files, ~53,000 traversed entries, and 39 MB of
// markdown — so every query on it failed closed, including queries that should
// have matched nothing. Sized here for a corpus someone has actually
// accumulated, with the ceilings kept as a runaway guard rather than a working
// limit. Raising one alone only moves the failure to the next.
export const DEFAULT_EVIDENCE_READ_LIMITS = Object.freeze({
  maxBytes: 256 * 1024 * 1024,
  maxFiles: 50_000,
  maxEntries: 500_000,
  maxFileBytes: 4 * 1024 * 1024,
  maxDirectoryEntries: 8192
});

// A refusal the person cannot act on is barely better than a crash. Name what
// stopped the read and what they can do about it — without naming a path, which
// would leak the shape of their disk to an agent.
//
// This error reaches `search`, `skills`, `activate`, and MCP alike, so the
// remedy has to be true for all of them: no command-specific flags, and nothing
// that names a command which would not actually help. `dotaios cleanup` in
// particular does not shrink a byte budget — it moves entries into
// events-archive.jsonl and signals-archive.jsonl, which search.mjs:317-318 then
// reads as well.
const EVIDENCE_READ_FAILURES = {
  DOTAIOS_EVIDENCE_BUDGET_EXCEEDED:
    "DotAIOS stopped reading: this folder is past the safe read budget for one request. "
    + "Ask for a narrower part of it, or move older material out of the folder.",
  DOTAIOS_EVIDENCE_FILE_TOO_LARGE:
    "DotAIOS stopped reading: one file is past the safe per-file size limit. "
    + "Split that file, or move it out of the folder.",
  DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE:
    "DotAIOS stopped reading: one directory holds more entries than the safe limit. "
    + "Move some of its entries elsewhere.",
  DOTAIOS_EVIDENCE_BYTE_BUDGET_EXCEEDED:
    "DotAIOS stopped reading: this folder is past the safe aggregate byte limit for one request.",
  DOTAIOS_EVIDENCE_FILE_COUNT_EXCEEDED:
    "DotAIOS stopped reading: this folder contains more files than one request can safely inspect.",
  DOTAIOS_EVIDENCE_ENTRY_COUNT_EXCEEDED:
    "DotAIOS stopped reading: this folder contains more entries than one request can safely inspect."
};

const SKIPPABLE_SCOPE_CODES = new Set([
  "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
  "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE",
  "DOTAIOS_EVIDENCE_BYTE_BUDGET_EXCEEDED",
  "DOTAIOS_EVIDENCE_FILE_COUNT_EXCEEDED",
  "DOTAIOS_EVIDENCE_ENTRY_COUNT_EXCEEDED"
]);

const OMITTED_SCOPE_LIMIT = 32;

export class EvidenceReadError extends Error {
  constructor(code = "DOTAIOS_EVIDENCE_READ_FAILED") {
    super(EVIDENCE_READ_FAILURES[code] || "DotAIOS could not read the evidence corpus safely.");
    this.name = "EvidenceReadError";
    this.code = code;
  }
}

/**
 * Create one request-scoped reader for searchable evidence. A caller may add
 * roots learned from already-contained configuration; every view shares one
 * file, byte, entry, and directory-snapshot ledger.
 */
export function createEvidenceReader({ roots, filesystem = localFilesystem, limits = {} }) {
  const effectiveLimits = { ...DEFAULT_EVIDENCE_READ_LIMITS, ...limits };
  const budget = createContainedReadBudget({
    maxBytes: effectiveLimits.maxBytes,
    maxFiles: effectiveLimits.maxFiles,
    maxEntries: effectiveLimits.maxEntries
  });
  return createEvidenceReaderView(roots, {
    filesystem,
    effectiveLimits,
    budget,
    observedDirectories: new Map()
  });
}

function createEvidenceReaderView(roots, state) {
  const {
    filesystem,
    effectiveLimits,
    budget,
    observedDirectories,
    collectRequestObservations = false,
    dimensionCodes = false
  } = state;
  const authorizedRoots = [...new Set((roots || []).map((root) => path.resolve(root)))];
  if (authorizedRoots.length === 0) throw new TypeError("Evidence readers require an authorized root.");

  function assertAuthorizedRoot(root) {
    const resolved = path.resolve(root);
    if (!authorizedRoots.includes(resolved)) throw new EvidenceReadError("DOTAIOS_EVIDENCE_ROOT_UNAUTHORIZED");
    return resolved;
  }

  async function readText(root, filePath, options = {}) {
    const authorizedRoot = assertAuthorizedRoot(root);
    if (!isPathWithinLexically(authorizedRoot, filePath)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    try {
      await rememberReadParent(authorizedRoot, filePath);
      return await readContainedFile(authorizedRoot, filePath, {
        filesystem,
        encoding: "utf8",
        budget,
        maxBytes: options.maxBytes ?? effectiveLimits.maxFileBytes,
        tooLargeCode: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
        returnSnapshot: options.returnSnapshot === true,
        expectedDirectories: expectedDirectoriesFor(authorizedRoot, filePath)
      });
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  async function readJsonl(root, filePath, options = {}) {
    const content = await readText(root, filePath, options);
    if (content === null) return [];
    const entries = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        budget.reserveEntries(1);
      } catch (error) {
        throw normalizeEvidenceReadError(error);
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Search is read-only. Corrupt source lines remain untouched and are
        // simply absent from this derived result set.
      }
    }
    return entries;
  }

  async function readJson(root, filePath, options = {}) {
    const content = await readText(root, filePath, options);
    if (content === null) {
      throw new EvidenceReadError(options.invalidCode || "DOTAIOS_EVIDENCE_JSON_INVALID");
    }
    try {
      return JSON.parse(content);
    } catch {
      throw new EvidenceReadError(options.invalidCode || "DOTAIOS_EVIDENCE_JSON_INVALID");
    }
  }

  async function readFrontmatter(root, filePath, options = {}) {
    const authorizedRoot = assertAuthorizedRoot(root);
    if (!isPathWithinLexically(authorizedRoot, filePath)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    try {
      const bytes = await readContainedFile(authorizedRoot, filePath, {
        filesystem,
        budget,
        prefixBytes: options.maxBytes ?? 64 * 1024,
        frontmatterOnly: true,
        stopOnMissingFrontmatter: options.stopOnMissingFrontmatter === true,
        maxSourceBytes: options.maxFileBytes ?? effectiveLimits.maxFileBytes,
        reserveSourceBytes: true,
        tooLargeCode: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
        expectedSnapshot: options.expectedEntry,
        expectedDirectories: expectedDirectoriesFor(authorizedRoot, filePath)
      });
      if (bytes === null) return null;
      const hasOpeningMarker = startsWithFrontmatter(bytes);
      const end = findFrontmatterEnd(bytes);
      if (end === -1) {
        if (options.allowMissing === true && !hasOpeningMarker) {
          decodeEvidenceUtf8(bytes);
          return "";
        }
        throw new EvidenceReadError("DOTAIOS_EVIDENCE_FRONTMATTER_INVALID");
      }
      return decodeEvidenceUtf8(bytes.subarray(0, end));
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  async function inspectEntry(root, filePath, options = {}) {
    const authorizedRoot = assertAuthorizedRoot(root);
    if (!isPathWithinLexically(authorizedRoot, filePath)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    try {
      return await inspectContainedPathEntry(authorizedRoot, filePath, {
        filesystem,
        expectedDirectories: expectedDirectoriesFor(authorizedRoot, filePath),
        ...(Object.hasOwn(options, "expectedEntry")
          ? { expectedSnapshot: options.expectedEntry }
          : {})
      });
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  async function listFiles(root, directoryPath, options = {}) {
    const authorizedRoot = assertAuthorizedRoot(root);
    if (!isPathWithinLexically(authorizedRoot, directoryPath)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    const files = [];
    try {
      await walkDirectory(authorizedRoot, directoryPath, files, options);
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
    return files.sort();
  }

  async function listDirectories(root, directoryPath, options = {}) {
    const entries = await listDirectory(root, directoryPath, {
      maxEntries: options.maxEntries ?? effectiveLimits.maxDirectoryEntries,
      tooManyCode: "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE"
    });
    try {
      const directories = [];
      for (const entry of entries) {
        if (options.skipEntry?.(entry.name)) continue;
        if (entry.isSymbolicLink()) {
          if (options.skipLinkedEntries === true) continue;
          throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
        }
        if (!entry.isDirectory()) continue;
        const childPath = path.join(directoryPath, entry.name);
        const snapshot = await inspectContainedDirectory(root, childPath, {
          filesystem,
          returnSnapshot: true
        });
        if (snapshot === null) throw new EvidenceReadError("DOTAIOS_EVIDENCE_CHANGED");
        rememberDirectory(root, childPath, snapshot);
        directories.push(childPath);
      }
      return directories;
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  async function listDirectory(root, directoryPath, options = {}) {
    const authorizedRoot = assertAuthorizedRoot(root);
    if (!isPathWithinLexically(authorizedRoot, directoryPath)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    try {
      if (collectRequestObservations) {
        const before = await inspectContainedDirectory(authorizedRoot, directoryPath, {
          filesystem,
          returnSnapshot: true
        });
        if (before !== null) rememberDirectory(authorizedRoot, directoryPath, before);
      }
      const observed = await readContainedDirectory(authorizedRoot, directoryPath, {
        filesystem,
        budget,
        maxEntries: options.maxEntries ?? effectiveLimits.maxDirectoryEntries,
        tooManyCode: options.tooManyCode || "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE",
        readdirOptions: { withFileTypes: true },
        returnSnapshot: true
      });
      if (observed !== null) rememberDirectory(authorizedRoot, directoryPath, observed.snapshot);
      return observed === null
        ? []
        : [...observed.entries].sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  /**
   * Enumerate and read one text corpus inside an evidence-reader-owned
   * transaction. The callback may derive any request result it needs, but the
   * outer promise cannot resolve successfully until the complete observed
   * root/directory/ancestor generation has been revalidated.
   */
  async function withTextCorpus(root, directoryPath, options, callback) {
    const authorizedRoot = assertAuthorizedRoot(root);
    if (!isPathWithinLexically(authorizedRoot, directoryPath)) {
      throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Evidence corpus options must be an object.");
    }
    if (typeof callback !== "function") {
      throw new TypeError("Evidence corpus transactions require a callback.");
    }

    let canonicalRoot;
    let observation;
    try {
      const rootSnapshot = await inspectContainedDirectory(authorizedRoot, authorizedRoot, {
        filesystem,
        returnSnapshot: true
      });
      if (rootSnapshot === null) {
        throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
      }
      canonicalRoot = await filesystem.realpath(authorizedRoot);
      observation = {
        directories: [{ path: authorizedRoot, snapshot: rootSnapshot }],
        files: []
      };
      rememberDirectory(authorizedRoot, authorizedRoot, rootSnapshot);
      const resolvedDirectory = path.resolve(directoryPath);
      const startingSnapshot = resolvedDirectory === authorizedRoot
        ? rootSnapshot
        : await inspectContainedDirectory(authorizedRoot, resolvedDirectory, {
          filesystem,
          returnSnapshot: true
        });
      if (startingSnapshot !== null) {
        rememberDirectory(authorizedRoot, resolvedDirectory, startingSnapshot);
        await walkTextCorpus(
          authorizedRoot,
          resolvedDirectory,
          options,
          observation,
          {
            canonicalRoot,
            expectedSnapshot: startingSnapshot,
            ...containedParentObservation(resolvedDirectory, authorizedRoot, startingSnapshot)
          }
        );
      } else {
        const nearest = await inspectNearestContainedDirectory(
          authorizedRoot,
          resolvedDirectory,
          { filesystem }
        );
        rememberCorpusDirectory(observation, nearest.path, nearest.snapshot);
        rememberDirectory(authorizedRoot, nearest.path, nearest.snapshot);
      }
      observation.files.sort((left, right) => left.filePath.localeCompare(right.filePath));
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }

    let active = true;
    let consumed = false;
    let mappingPromise = null;
    const transaction = Object.freeze({
      mapFiles(mapper) {
        if (!active) throw new EvidenceReadError("DOTAIOS_EVIDENCE_TRANSACTION_CLOSED");
        if (consumed) throw new EvidenceReadError("DOTAIOS_EVIDENCE_TRANSACTION_CONSUMED");
        if (typeof mapper !== "function") {
          throw new TypeError("Evidence corpus mapping requires a callback.");
        }
        consumed = true;
        mappingPromise = mapObservedTextFiles(
          authorizedRoot,
          canonicalRoot,
          observation.files,
          options,
          mapper
        );
        return mappingPromise;
      }
    });

    let result;
    let callbackError;
    try {
      result = await callback(transaction);
    } catch (error) {
      callbackError = error;
    }
    active = false;
    if (mappingPromise) {
      try {
        await mappingPromise;
      } catch (error) {
        if (!callbackError) callbackError = error;
      }
    }
    if (callbackError) throw callbackError;
    try {
      await assertContainedDirectorySnapshotsUnchanged(
        authorizedRoot,
        observation.directories,
        { filesystem }
      );
      return result;
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  async function walkTextCorpus(root, directoryPath, options, observation, containment) {
    if (containment.expectedSnapshot) {
      rememberDirectory(root, directoryPath, containment.expectedSnapshot);
    }
    const observed = await readContainedSnapshotDirectory(root, directoryPath, {
      filesystem,
      canonicalRoot: containment.canonicalRoot,
      expectedSnapshot: containment.expectedSnapshot,
      parentPath: containment.parentPath,
      parentSnapshot: containment.parentSnapshot,
      budget,
      maxEntries: options.maxDirectoryEntries ?? effectiveLimits.maxDirectoryEntries,
      tooManyCode: "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE",
      readdirOptions: { withFileTypes: true },
      returnSnapshot: true
    });
    if (observed === null) return;
    rememberCorpusDirectory(observation, directoryPath, observed.snapshot);

    const entries = [...observed.entries]
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (options.skipEntry?.(entry.name)) continue;
      const filePath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        const acceptedLink = options.includeFile
          ? options.includeFile(filePath)
          : !options.extensions || options.extensions.includes(path.extname(entry.name).toLowerCase());
        if (acceptedLink) throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
        continue;
      }
      if (entry.isDirectory()) {
        if (options.recursive !== false) {
          const childSnapshot = await inspectContainedDirectory(root, filePath, {
            filesystem,
            returnSnapshot: true
          });
          if (childSnapshot === null) throw new EvidenceReadError("DOTAIOS_EVIDENCE_CHANGED");
          await walkTextCorpus(root, filePath, options, observation, {
            canonicalRoot: containment.canonicalRoot,
            expectedSnapshot: childSnapshot,
            parentPath: path.resolve(directoryPath),
            parentSnapshot: observed.snapshot
          });
        }
        continue;
      }

      const accepted = options.includeFile
        ? options.includeFile(filePath)
        : !options.extensions || options.extensions.includes(path.extname(entry.name).toLowerCase());
      if (!accepted) continue;
      if (!entry.isFile()) throw new EvidenceReadError("DOTAIOS_EVIDENCE_NOT_REGULAR_FILE");
      if (observation.files.length >= effectiveLimits.maxFiles) {
        throw new EvidenceReadError(dimensionCodes
          ? "DOTAIOS_EVIDENCE_FILE_COUNT_EXCEEDED"
          : "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED");
      }
      observation.files.push(Object.freeze({
        filePath,
        parentPath: path.resolve(directoryPath),
        parentSnapshot: observed.snapshot
      }));
    }
  }

  async function mapObservedTextFiles(root, canonicalRoot, files, options, mapper) {
    const concurrency = normalizeCorpusConcurrency(options.concurrency);
    const mapped = new Array(files.length);
    for (let index = 0; index < files.length; index += concurrency) {
      const batch = files.slice(index, index + concurrency);
      const values = await Promise.all(batch.map(async (file) => {
        let observed;
        try {
          observed = await readContainedSnapshotFile(root, file.filePath, {
            filesystem,
            canonicalRoot,
            parentPath: file.parentPath,
            parentSnapshot: file.parentSnapshot,
            encoding: "utf8",
            budget,
            maxBytes: options.maxBytes ?? effectiveLimits.maxFileBytes,
            tooLargeCode: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE"
          });
        } catch (error) {
          throw normalizeEvidenceReadError(error);
        }
        return mapper(Object.freeze({
          filePath: file.filePath,
          content: observed.content,
          mtimeMs: observed.stats.mtimeMs
        }));
      }));
      for (const [offset, value] of values.entries()) mapped[index + offset] = value;
    }
    return mapped;
  }

  async function walkDirectory(root, directoryPath, files, options) {
    const observed = await readContainedDirectory(root, directoryPath, {
      filesystem,
      budget,
      maxEntries: effectiveLimits.maxDirectoryEntries,
      tooManyCode: "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE",
      readdirOptions: { withFileTypes: true },
      returnSnapshot: true
    });
    if (observed === null) return;
    rememberDirectory(root, directoryPath, observed.snapshot);

    for (const entry of [...observed.entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (options.skipEntry?.(entry.name)) continue;
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        const acceptedLink = options.includeFile
          ? options.includeFile(fullPath)
          : !options.extensions || options.extensions.includes(path.extname(entry.name).toLowerCase());
        if (acceptedLink) throw new EvidenceReadError("DOTAIOS_EVIDENCE_PATH_UNSAFE");
        // An ineligible final-component link is not evidence and is never
        // traversed. Inspecting its target just to distinguish file/directory
        // would itself cross the authorized boundary for an outside link.
        continue;
      }
      if (entry.isDirectory()) {
        if (options.recursive !== false) await walkDirectory(root, fullPath, files, options);
        continue;
      }

      const accepted = options.includeFile
        ? options.includeFile(fullPath)
        : !options.extensions || options.extensions.includes(path.extname(entry.name).toLowerCase());
      if (!accepted) continue;
      if (!entry.isFile()) throw new EvidenceReadError("DOTAIOS_EVIDENCE_NOT_REGULAR_FILE");
      files.push(fullPath);
    }
  }

  /**
   * Run query-dependent, bounded scope preparation exactly once per logical
   * scope, then allocate the request budget deterministically. Prepared values
   * remain callback-scoped and cannot resolve successfully until every
   * observed root/directory generation has been revalidated.
   */
  async function withScopePreflight(scopes, prepareScope, callback) {
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || !scope)) {
      throw new TypeError("Evidence scope preflight requires named logical scopes.");
    }
    if (new Set(scopes).size !== scopes.length) {
      throw new TypeError("Evidence scope preflight requires unique logical scopes.");
    }
    if (typeof prepareScope !== "function" || typeof callback !== "function") {
      throw new TypeError("Evidence scope preflight requires preparation and result callbacks.");
    }

    const available = budget.remaining();
    const scopeLimits = Object.freeze({
      ...effectiveLimits,
      maxBytes: available.bytes,
      maxFiles: available.files,
      maxEntries: available.entries
    });
    const prepared = await Promise.all(scopes.map(async (scope) => {
      const scopeBudget = createContainedReadBudget({
        maxBytes: scopeLimits.maxBytes,
        maxFiles: scopeLimits.maxFiles,
        maxEntries: scopeLimits.maxEntries,
        dimensionCodes: true
      });
      const scopeReader = createEvidenceReaderView(authorizedRoots, {
        filesystem,
        effectiveLimits: scopeLimits,
        budget: scopeBudget,
        observedDirectories: new Map(),
        collectRequestObservations: true,
        dimensionCodes: true
      });
      let scopeObservations = new Map();
      try {
        let value;
        try {
          value = await prepareScope(scope, scopeReader);
        } finally {
          scopeObservations = scopeReader.observations();
        }
        return Object.freeze({
          scope,
          value,
          demand: scopeBudget.snapshot(),
          error: null,
          observations: scopeObservations
        });
      } catch (error) {
        const normalized = normalizeEvidenceReadError(error);
        return Object.freeze({
          scope,
          value: null,
          demand: scopeBudget.snapshot(),
          error: normalized,
          observations: scopeObservations
        });
      }
    }));

    for (const item of prepared) {
      for (const [key, observation] of item.observations) {
        const retained = observedDirectories.get(key);
        if (retained && !sameContainedDirectorySnapshot(retained.snapshot, observation.snapshot)) {
          throw new EvidenceReadError("DOTAIOS_EVIDENCE_CHANGED");
        }
        if (!retained) observedDirectories.set(key, observation);
      }
    }

    const fatal = prepared.find(({ error }) => error && !SKIPPABLE_SCOPE_CODES.has(error.code));
    if (fatal) throw fatal.error;

    const allocation = allocateScopeDemands(prepared, available);
    const admitted = new Map();
    for (const item of prepared) {
      if (allocation.admitted.has(item.scope)) admitted.set(item.scope, item.value);
    }
    const committed = [...prepared]
      .filter((item) => allocation.admitted.has(item.scope))
      .reduce((sum, item) => addDemand(sum, item.demand), emptyDemand());
    try {
      budget.reserveDemand(committed);
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }

    let active = true;
    const transaction = Object.freeze({
      has(scope) {
        if (!active) throw new EvidenceReadError("DOTAIOS_EVIDENCE_TRANSACTION_CLOSED");
        return admitted.has(scope);
      },
      get(scope) {
        if (!active) throw new EvidenceReadError("DOTAIOS_EVIDENCE_TRANSACTION_CLOSED");
        return admitted.get(scope);
      },
      omissions: allocation.omissions
    });

    let result;
    try {
      result = await callback(transaction);
    } finally {
      active = false;
    }
    try {
      await revalidateObservedDirectories();
      return result;
    } catch (error) {
      throw normalizeEvidenceReadError(error);
    }
  }

  return Object.freeze({
    roots: Object.freeze([...authorizedRoots]),
    withAuthorizedRoots(additionalRoots) {
      const additions = Array.isArray(additionalRoots) ? additionalRoots : [additionalRoots];
      if (additions.some((root) => typeof root !== "string" || root.length === 0)) {
        throw new TypeError("Authorized evidence roots must be non-empty paths.");
      }
      return createEvidenceReaderView([...authorizedRoots, ...additions], state);
    },
    readText,
    readJson,
    readJsonl,
    readFrontmatter,
    inspectEntry,
    listFiles,
    listDirectories,
    listDirectory,
    withTextCorpus,
    withScopePreflight,
    observations: () => new Map(observedDirectories),
    snapshot: () => budget.snapshot()
  });

  function rememberDirectory(root, directoryPath, snapshot) {
    const resolvedRoot = path.resolve(root);
    const resolvedDirectory = path.resolve(directoryPath);
    const key = `${resolvedRoot}\0${resolvedDirectory}`;
    const retained = observedDirectories.get(key);
    if (retained) {
      if (collectRequestObservations && !sameContainedDirectorySnapshot(retained.snapshot, snapshot)) {
        throw new EvidenceReadError("DOTAIOS_EVIDENCE_CHANGED");
      }
      return;
    }
    observedDirectories.set(key, {
      root: resolvedRoot,
      path: resolvedDirectory,
      snapshot
    });
  }

  async function rememberReadParent(root, filePath) {
    if (!collectRequestObservations) return;
    const parentPath = path.dirname(path.resolve(filePath));
    const key = `${path.resolve(root)}\0${parentPath}`;
    if (observedDirectories.has(key)) return;
    const snapshot = await inspectContainedDirectory(root, parentPath, {
      filesystem,
      returnSnapshot: true
    });
    if (snapshot !== null) {
      rememberDirectory(root, parentPath, snapshot);
      return;
    }
    const nearest = await inspectNearestContainedDirectory(root, parentPath, { filesystem });
    rememberDirectory(root, nearest.path, nearest.snapshot);
  }

  async function revalidateObservedDirectories() {
    for (const root of authorizedRoots) {
      const directories = [...observedDirectories.values()]
        .filter((entry) => entry.root === root)
        .map(({ path: directoryPath, snapshot }) => ({ path: directoryPath, snapshot }));
      if (directories.length > 0) {
        await assertContainedDirectorySnapshotsUnchanged(root, directories, { filesystem });
      }
    }
  }

  function expectedDirectoriesFor(root, filePath) {
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(filePath);
    return [...observedDirectories.values()]
      .filter((entry) => entry.root === resolvedRoot && isPathWithinLexically(entry.path, resolvedFile))
      .map(({ path: directoryPath, snapshot }) => ({ path: directoryPath, snapshot }));
  }
}

function allocateScopeDemands(prepared, capacity) {
  const requestedCount = prepared.length;
  const protectedShare = {
    bytes: Math.floor(Math.floor(capacity.bytes / 2) / requestedCount),
    files: Math.floor(Math.floor(capacity.files / 2) / requestedCount),
    entries: Math.floor(Math.floor(capacity.entries / 2) / requestedCount)
  };
  const reservations = new Map();
  let pool = { ...capacity };

  for (const item of prepared) {
    if (item.error) continue;
    const protectedDemand = minDemand(item.demand, protectedShare);
    reservations.set(item.scope, protectedDemand);
    pool = subtractDemand(pool, protectedDemand);
  }

  const admitted = new Set();
  for (const item of prepared) {
    if (item.error) continue;
    const reserved = reservations.get(item.scope) || emptyDemand();
    const remainder = subtractDemand(item.demand, reserved);
    if (!fitsDemand(remainder, pool)) continue;
    reservations.set(item.scope, item.demand);
    pool = subtractDemand(pool, remainder);
    admitted.add(item.scope);
  }

  for (const item of prepared) {
    if (item.error || admitted.has(item.scope)) continue;
    pool = addDemand(pool, reservations.get(item.scope) || emptyDemand());
    reservations.delete(item.scope);
  }

  for (const item of prepared) {
    if (item.error || admitted.has(item.scope) || !fitsDemand(item.demand, pool)) continue;
    pool = subtractDemand(pool, item.demand);
    reservations.set(item.scope, item.demand);
    admitted.add(item.scope);
  }

  const omissions = [];
  for (const item of prepared) {
    if (admitted.has(item.scope)) continue;
    const reason = item.error
      ? omissionReasonForError(item.error.code)
      : firstExceededDimension(item.demand, pool);
    omissions.push(createScopeOmission(item.scope, reason, item.demand, capacity));
  }
  return Object.freeze({ admitted, omissions: freezeOmissions(omissions) });
}

function omissionReasonForError(code) {
  const reasons = {
    DOTAIOS_EVIDENCE_FILE_TOO_LARGE: "file_too_large",
    DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE: "directory_entries_exceeded",
    DOTAIOS_EVIDENCE_BYTE_BUDGET_EXCEEDED: "aggregate_bytes_exceeded",
    DOTAIOS_EVIDENCE_FILE_COUNT_EXCEEDED: "file_count_exceeded",
    DOTAIOS_EVIDENCE_ENTRY_COUNT_EXCEEDED: "entry_count_exceeded"
  };
  return reasons[code];
}

function firstExceededDimension(demand, available) {
  if (demand.bytes > available.bytes) return "aggregate_bytes_exceeded";
  if (demand.files > available.files) return "file_count_exceeded";
  return "entry_count_exceeded";
}

function createScopeOmission(scope, reason, demand, limits) {
  const recovery = {
    file_too_large: {
      code: "split_or_move_file",
      message: "Split the oversized file, or move it outside this search scope."
    },
    directory_entries_exceeded: {
      code: "reduce_directory_entries",
      message: "Move some directory entries elsewhere, then retry the same search."
    },
    aggregate_bytes_exceeded: {
      code: "narrow_or_reduce_scope",
      message: "Search a narrower scope, or move older material outside this scope."
    },
    file_count_exceeded: {
      code: "narrow_or_reduce_scope",
      message: "Search a narrower scope, or move some files outside this scope."
    },
    entry_count_exceeded: {
      code: "narrow_or_reduce_scope",
      message: "Search a narrower scope, or archive entries outside this scope."
    }
  }[reason];
  const observed = {
    files: Math.min(demand.files, limits.files + 1),
    bytes: Math.min(demand.bytes, limits.bytes + 1),
    entries: Math.min(demand.entries, limits.entries + 1)
  };
  if (reason === "file_count_exceeded") observed.files = limits.files + 1;
  if (reason === "aggregate_bytes_exceeded") observed.bytes = limits.bytes + 1;
  if (reason === "entry_count_exceeded") observed.entries = limits.entries + 1;
  return {
    scope,
    reason,
    observed,
    inspection: reason === "directory_entries_exceeded" ? "partially_enumerated" : "not_searched",
    recovery
  };
}

function freezeOmissions(omissions) {
  const selected = omissions.slice(0, OMITTED_SCOPE_LIMIT).map(deepFreezeOmission);
  if (omissions.length > OMITTED_SCOPE_LIMIT) {
    selected.push(deepFreezeOmission({
      scope: "all",
      reason: "omissions_truncated",
      observed: { files: 0, bytes: 0, entries: omissions.length - OMITTED_SCOPE_LIMIT },
      inspection: "not_searched",
      recovery: {
        code: "narrow_scope",
        message: "Search one logical scope at a time to inspect every omission."
      }
    }));
  }
  return Object.freeze(selected);
}

function deepFreezeOmission(omission) {
  return Object.freeze({
    ...omission,
    observed: Object.freeze({ ...omission.observed }),
    recovery: Object.freeze({ ...omission.recovery })
  });
}

function emptyDemand() {
  return { bytes: 0, files: 0, entries: 0 };
}

function minDemand(left, right) {
  return {
    bytes: Math.min(left.bytes, right.bytes),
    files: Math.min(left.files, right.files),
    entries: Math.min(left.entries, right.entries)
  };
}

function addDemand(left, right) {
  return {
    bytes: left.bytes + right.bytes,
    files: left.files + right.files,
    entries: left.entries + right.entries
  };
}

function subtractDemand(left, right) {
  return {
    bytes: left.bytes - right.bytes,
    files: left.files - right.files,
    entries: left.entries - right.entries
  };
}

function fitsDemand(demand, capacity) {
  return demand.bytes <= capacity.bytes
    && demand.files <= capacity.files
    && demand.entries <= capacity.entries;
}

function rememberCorpusDirectory(observation, directoryPath, snapshot) {
  const resolvedDirectory = path.resolve(directoryPath);
  observation.directories.push(Object.freeze({ path: resolvedDirectory, snapshot }));
}

function containedParentObservation(directoryPath, root, snapshot) {
  const resolvedDirectory = path.resolve(directoryPath);
  if (resolvedDirectory === path.resolve(root)) return {};
  const parentPath = path.dirname(resolvedDirectory);
  const parent = snapshot.ancestors?.find(
    (ancestor) => path.resolve(ancestor.path) === parentPath
  );
  if (!parent) throw new ContainedReadError();
  return { parentPath, parentSnapshot: { stats: parent.stats } };
}

function normalizeCorpusConcurrency(value) {
  if (value === undefined) return 32;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 64) {
    throw new TypeError("Evidence corpus concurrency must be an integer from 1 to 64.");
  }
  return normalized;
}

function findFrontmatterEnd(bytes) {
  const startsWithLf = bytes.subarray(0, 4).toString("ascii") === "---\n";
  const startsWithCrlf = bytes.subarray(0, 5).toString("ascii") === "---\r\n";
  if (!startsWithLf && !startsWithCrlf) return -1;
  const marker = Buffer.from("\n---");
  let offset = startsWithLf ? 4 : 5;
  while (offset < bytes.length) {
    const index = bytes.indexOf(marker, offset);
    if (index === -1) return -1;
    const suffix = bytes[index + marker.length];
    if (suffix === 0x0a) return index + marker.length + 1;
    if (suffix === 0x0d && bytes[index + marker.length + 1] === 0x0a) {
      return index + marker.length + 2;
    }
    if (index + marker.length === bytes.length) return index + marker.length;
    offset = index + marker.length;
  }
  return -1;
}

function startsWithFrontmatter(bytes) {
  return bytes.subarray(0, 4).toString("ascii") === "---\n"
    || bytes.subarray(0, 5).toString("ascii") === "---\r\n";
}

function decodeEvidenceUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvidenceReadError("DOTAIOS_EVIDENCE_INVALID_UTF8");
  }
}

function normalizeEvidenceReadError(error) {
  if (error instanceof EvidenceReadError) return error;
  if (!(error instanceof ContainedReadError)) {
    return new EvidenceReadError();
  }
  const codes = {
    DOTAIOS_UNSAFE_READ_PATH: "DOTAIOS_EVIDENCE_PATH_UNSAFE",
    DOTAIOS_CONTEXT_SOURCE_CHANGED: "DOTAIOS_EVIDENCE_CHANGED",
    DOTAIOS_INVALID_UTF8: "DOTAIOS_EVIDENCE_INVALID_UTF8",
    DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED: "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED",
    DOTAIOS_PROJECTION_BYTE_BUDGET_EXCEEDED: "DOTAIOS_EVIDENCE_BYTE_BUDGET_EXCEEDED",
    DOTAIOS_PROJECTION_FILE_COUNT_EXCEEDED: "DOTAIOS_EVIDENCE_FILE_COUNT_EXCEEDED",
    DOTAIOS_PROJECTION_ENTRY_COUNT_EXCEEDED: "DOTAIOS_EVIDENCE_ENTRY_COUNT_EXCEEDED",
    DOTAIOS_EVIDENCE_FILE_TOO_LARGE: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
    DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE: "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE",
    DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE: "DOTAIOS_EVIDENCE_BOUNDED_READ_UNAVAILABLE",
    DOTAIOS_BOUNDED_DIRECTORY_READ_UNAVAILABLE: "DOTAIOS_EVIDENCE_BOUNDED_READ_UNAVAILABLE"
  };
  return new EvidenceReadError(codes[error.code] || "DOTAIOS_EVIDENCE_READ_FAILED");
}
