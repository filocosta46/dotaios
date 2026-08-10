import fs from "node:fs/promises";

// The ONE JSONL reader for the whole codebase. Every reader (memory, search,
// digest, audit) goes through here so corrupt lines are handled in exactly one
// place: preserved to a `<file>.bad.jsonl` quarantine and surfaced with one
// structured warning — never silently dropped, never returned as data.

export function parseJsonlLine(line) {
  if (!line.trim()) return null;
  return JSON.parse(line);
}

export function formatJsonlEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}

const warnedFiles = new Set();

/**
 * Read all entries from a JSONL file. Returns an empty array if file is missing.
 * Unparseable lines are appended verbatim to `<file>.bad.jsonl` (idempotently)
 * and reported once per file per process on stderr.
 */
export async function readJsonl(filePath, options = {}) {
  const fileSystem = options.filesystem || fs;
  let content;
  try {
    content = await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  const badLines = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      badLines.push(line);
    }
  }
  if (
    options.quarantine !== false
    && badLines.length > 0
    && !String(filePath).endsWith(".bad.jsonl")
  ) {
    await quarantineBadLines(filePath, badLines, fileSystem);
  }
  return entries;
}

async function quarantineBadLines(filePath, badLines, fileSystem) {
  const badPath = `${filePath}.bad.jsonl`;
  if (!warnedFiles.has(String(filePath))) {
    warnedFiles.add(String(filePath));
    console.warn(JSON.stringify({
      warning: "jsonl-corrupt-lines",
      file: String(filePath),
      count: badLines.length,
      preserved: badPath
    }));
  }
  try {
    let existing = "";
    try {
      existing = await fileSystem.readFile(badPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const seen = new Set(existing.split("\n").filter((line) => line.trim()));
    const fresh = badLines.filter((line) => !seen.has(line));
    if (fresh.length > 0) {
      await fileSystem.appendFile(badPath, fresh.map((line) => `${line}\n`).join(""));
    }
  } catch {
    // Quarantine is best-effort: a read must never fail because the sidecar
    // could not be written (read-only mounts, permissions).
  }
}
