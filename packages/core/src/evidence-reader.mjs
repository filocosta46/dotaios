import localFilesystem from "node:fs/promises";
import path from "node:path";

import {
  ContainedReadError,
  createContainedReadBudget,
  inspectContainedDirectory,
  readContainedDirectory,
  readContainedFile
} from "./contained-read.mjs";
import { isPathWithinLexically } from "./paths.mjs";

export const DEFAULT_EVIDENCE_READ_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxFiles: 512,
  maxEntries: 4096,
  maxFileBytes: 1024 * 1024,
  maxDirectoryEntries: 1024
});

export class EvidenceReadError extends Error {
  constructor(code = "DOTAIOS_EVIDENCE_READ_FAILED") {
    super("DotAIOS could not read the evidence corpus safely.");
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
  const { filesystem, effectiveLimits, budget, observedDirectories } = state;
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
        maxSourceBytes: options.maxFileBytes ?? effectiveLimits.maxFileBytes,
        reserveSourceBytes: true,
        tooLargeCode: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
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
    listFiles,
    listDirectories,
    listDirectory,
    snapshot: () => budget.snapshot()
  });

  function rememberDirectory(root, directoryPath, snapshot) {
    const resolvedRoot = path.resolve(root);
    const resolvedDirectory = path.resolve(directoryPath);
    observedDirectories.set(`${resolvedRoot}\0${resolvedDirectory}`, {
      root: resolvedRoot,
      path: resolvedDirectory,
      snapshot
    });
  }

  function expectedDirectoriesFor(root, filePath) {
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(filePath);
    return [...observedDirectories.values()]
      .filter((entry) => entry.root === resolvedRoot && isPathWithinLexically(entry.path, resolvedFile))
      .map(({ path: directoryPath, snapshot }) => ({ path: directoryPath, snapshot }));
  }
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
    DOTAIOS_EVIDENCE_FILE_TOO_LARGE: "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
    DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE: "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE",
    DOTAIOS_BOUNDED_FILE_READ_UNAVAILABLE: "DOTAIOS_EVIDENCE_BOUNDED_READ_UNAVAILABLE",
    DOTAIOS_BOUNDED_DIRECTORY_READ_UNAVAILABLE: "DOTAIOS_EVIDENCE_BOUNDED_READ_UNAVAILABLE"
  };
  return new EvidenceReadError(codes[error.code] || "DOTAIOS_EVIDENCE_READ_FAILED");
}
