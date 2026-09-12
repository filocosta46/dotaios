#!/usr/bin/env node
// Usage: node scripts/skill-drift.mjs [additional-root ...]
// Standalone, read-only survey. Names are top-level directory handles; a skill
// must contain SKILL.md. No skill content is read and no routing is performed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES_PER_ROOT = 512;
const MAX_SUMMARY_COLLISION_NAMES = 12;
const home = os.homedir();
const roots = [
  ["Claude", path.join(home, ".claude", "skills")],
  ["Agents", path.join(home, ".agents", "skills")],
  ["Factory", path.join(home, ".factory", "skills")],
  ["AIOS", path.join(home, "aios", "skills")],
  ["Codex", path.join(home, ".codex", "skills")],
  ["Gemini", path.join(home, ".gemini", "skills")],
  ["Cursor", path.join(home, ".cursor", "skills")],
  ...process.argv.slice(2).map((root, index) => [`Extra ${index + 1}`, path.resolve(root)]),
];

const identities = new Map();
const reports = [];
for (const [label, root] of roots) {
  const report = { label, raw: 0, distinct: new Set(), entries: 0, unreadable: 0, status: "complete" };
  let directory;
  let rootExists = false;
  try {
    await fs.lstat(root);
    rootExists = true;
    directory = await fs.opendir(root, { bufferSize: 1 });
    while (report.entries < MAX_ENTRIES_PER_ROOT) {
      const entry = await directory.read();
      if (entry === null) break;
      report.entries += 1;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const real = await fs.realpath(path.join(root, entry.name));
        if (!(await fs.stat(real)).isDirectory()) continue;
        let skillFile;
        try {
          skillFile = await fs.stat(path.join(real, "SKILL.md"));
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (!skillFile.isFile()) continue;
        report.raw += 1;
        report.distinct.add(real);
        const identity = identities.get(real) || { names: new Map() };
        const visibleRoots = identity.names.get(entry.name) || new Set();
        visibleRoots.add(label);
        identity.names.set(entry.name, visibleRoots);
        identities.set(real, identity);
      } catch {
        report.unreadable += 1;
      }
    }
    // One lookahead detects truncation without processing an extra candidate.
    if (report.entries === MAX_ENTRIES_PER_ROOT && await directory.read() !== null) {
      report.status = "limited";
    }
  } catch (error) {
    report.status = error.code === "ENOENT" && !rootExists ? "missing" : "unreadable";
  } finally {
    try {
      await directory?.close();
    } catch {
      report.status = "unreadable";
    }
  }
  if (report.status === "complete" && report.unreadable > 0) report.status = "partial";
  reports.push(report);
}

const names = new Map();
for (const [real, identity] of identities) {
  for (const name of identity.names.keys()) {
    const realpaths = names.get(name) || new Set();
    realpaths.add(real);
    names.set(name, realpaths);
  }
}
const collisions = [...names].filter(([, realpaths]) => realpaths.size > 1).sort(([a], [b]) => compare(a, b));
const collisionSummary = collisions.slice(0, MAX_SUMMARY_COLLISION_NAMES)
  .map(([name, realpaths]) => `${displayName(name)} (${realpaths.size})`);
if (collisions.length > MAX_SUMMARY_COLLISION_NAMES) {
  collisionSummary.push(`and ${collisions.length - MAX_SUMMARY_COLLISION_NAMES} more`);
}
const totalRaw = reports.reduce((sum, report) => sum + report.raw, 0);
const summary = [
  "Skill drift summary",
  `Entry cap per root: ${MAX_ENTRIES_PER_ROOT}; no recursive scan`,
  reports.some((report) => !["complete", "missing"].includes(report.status))
    ? "Coverage: partial; counts are lower bounds"
    : "Coverage: complete for top-level entries",
  `Raw skill entries: ${totalRaw}`,
  `Distinct skills (realpaths): ${identities.size}`,
  `Distinct names: ${names.size}`,
  `Name collisions (${collisions.length}): ${collisionSummary.join(", ") || "none"}`,
  ...reports.map((report) => `${report.label}: ${report.raw} raw, ${report.distinct.size} distinct; ${report.status}; ${report.entries} entries checked; ${report.unreadable} unreadable`),
];
console.log(summary.join("\n"));
console.log("\nVisibility (one line per distinct skill; names are directory handles):");
const visibility = [...identities.values()].map((identity) => [...identity.names]
  .sort(([left], [right]) => compare(left, right))
  .map(([name, visibleRoots]) => `${displayName(name)}: ${[...visibleRoots].join(", ")}`)
  .join("; ")).sort(compare);
console.log(visibility.join("\n") || "none");

function compare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function displayName(name) {
  if (/^[a-zA-Z0-9._-]+$/.test(name)) return name;
  return JSON.stringify(name).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
