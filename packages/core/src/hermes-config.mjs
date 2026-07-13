import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function discoverHermesConfigPaths(homePath) {
  const root = path.join(homePath, ".hermes");
  const configPaths = [path.join(root, "config.yaml")];
  try {
    const entries = await fs.readdir(path.join(root, "profiles"), { withFileTypes: true });
    for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      configPaths.push(path.join(root, "profiles", entry.name, "config.yaml"));
    }
  } catch {
    // A machine without Hermes profiles still gets the root config target.
  }
  return configPaths;
}

// Conservative editor for `skills.external_dirs` in Hermes config.yaml.
// Handles: inline empty `external_dirs: []` and block list under `skills:`.
// Anything else → { action: "manual" } and leaves the file untouched.
export async function ensureExternalSkillsDir({ configPath, skillsPath, dryRun = false, createMissing = false }) {
  let text;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return { action: "manual", reason: "config not found" };
  }
  const lines = text.split("\n");
  const skillsIdx = lines.findIndex((l) => /^skills:\s*$/.test(l));
  if (skillsIdx === -1) {
    if (!createMissing) return { action: "manual", reason: "no skills: section" };
    const prefix = text.endsWith("\n") ? text : `${text}\n`;
    const addition = `skills:\n  external_dirs:\n    - ${skillsPath}\n`;
    if (!dryRun) await fs.writeFile(configPath, `${prefix}${addition}`);
    return { action: dryRun ? "would-add-section" : "added-section" };
  }

  // find `external_dirs:` within the skills block (2-space indented)
  let edIdx = -1;
  for (let i = skillsIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;                 // left the skills: block
    if (/^\s{2}external_dirs:/.test(lines[i])) { edIdx = i; break; }
  }
  if (edIdx === -1) {
    if (!createMissing) return { action: "manual", reason: "no external_dirs key" };
    let insertAt = skillsIdx + 1;
    while (insertAt < lines.length && (!lines[insertAt].trim() || /^\s{2,}/.test(lines[insertAt]))) insertAt += 1;
    lines.splice(insertAt, 0, "  external_dirs:", `    - ${skillsPath}`);
    if (!dryRun) await fs.writeFile(configPath, lines.join("\n"));
    return { action: dryRun ? "would-add-key" : "added-key" };
  }

  const item = `    - ${skillsPath}`;
  let prunedStale = false;
  if (/external_dirs:\s*\[\s*\]\s*$/.test(lines[edIdx])) {
    lines[edIdx] = "  external_dirs:";
    lines.splice(edIdx + 1, 0, item);
  } else if (/external_dirs:\s*$/.test(lines[edIdx])) {
    // Remove dead DotAIOS setup paths, then insert after the last existing
    // item. Foreign external directories are never touched.
    const itemIndent = detectListItemIndent(lines, edIdx + 1);
    let insertAt = edIdx + 1;
    const listEnd = () => {
      let end = edIdx + 1;
      while (end < lines.length && isListItem(lines[end], itemIndent)) end++;
      return end;
    };
    const staleIndexes = [];
    for (let index = edIdx + 1; index < listEnd(); index += 1) {
      const value = parseListValue(lines[index], itemIndent);
      if (await isStaleDotaiosTempPath(value)) staleIndexes.push(index);
    }
    for (const index of staleIndexes.reverse()) {
      lines.splice(index, 1);
      prunedStale = true;
    }
    if (lines.slice(edIdx + 1).some((line) => parseListValue(line, itemIndent) === skillsPath)) {
      if (!prunedStale) return { action: "already-present" };
      if (!dryRun) await fs.writeFile(configPath, lines.join("\n"));
      return { action: dryRun ? "would-prune-stale" : "pruned-stale" };
    }
    insertAt = edIdx + 1;
    while (insertAt < lines.length && isListItem(lines[insertAt], itemIndent)) insertAt++;
    lines.splice(insertAt, 0, `${" ".repeat(itemIndent)}- ${skillsPath}`);
  } else {
    const scalarMatch = lines[edIdx].match(/^\s{2}external_dirs:\s+(.+?)\s*$/);
    const scalarValue = unquoteScalar(scalarMatch?.[1]);
    if (!scalarValue || /^[\[{|>]/.test(scalarValue)) {
      return { action: "manual", reason: "unexpected external_dirs shape" };
    }
    lines[edIdx] = "  external_dirs:";
    const scalarIsStale = await isStaleDotaiosTempPath(scalarValue);
    if (!scalarIsStale) lines.splice(edIdx + 1, 0, `    - ${scalarValue}`);
    if (scalarValue !== skillsPath) lines.splice(edIdx + 1 + (scalarIsStale ? 0 : 1), 0, item);
    prunedStale = scalarIsStale;
  }

  if (!dryRun) await fs.writeFile(configPath, lines.join("\n"));
  if (prunedStale) return { action: dryRun ? "would-prune-stale" : "pruned-stale" };
  return { action: dryRun ? "would-add" : "added" };
}

async function isStaleDotaiosTempPath(value) {
  const resolved = path.resolve(unquoteScalar(value));
  const tempRoot = path.resolve(os.tmpdir());
  if (!isWithin(tempRoot, resolved)) return false;
  if (!/(?:^|[\\/])dotaios-[^\\/]+[\\/]aios[\\/]skills$/.test(resolved)) return false;
  try {
    await fs.access(resolved);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return true;
  }
}

function unquoteScalar(value) {
  return String(value || "").trim().replace(/^(['"])(.*)\1$/, "$2");
}

function parseListValue(line, indent = null) {
  const indentation = indent == null ? "\\s*" : `\\s{${indent}}`;
  const match = String(line || "").match(new RegExp(`^${indentation}-\\s+(.+?)\\s*$`));
  return unquoteScalar(match?.[1]);
}

function detectListItemIndent(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const match = lines[index].match(/^(\s*)-\s+/);
    if (!match) break;
    return match[1].length;
  }
  return 4;
}

function isListItem(line, indent) {
  return new RegExp(`^\\s{${indent}}-\\s+`).test(String(line || ""));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
