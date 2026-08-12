import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { replaceFileIfUnchanged, validateManagedFilePath } from "./files.mjs";
import { isPathWithinLexically } from "./paths.mjs";
import { isSafeRegistryPathText, parseExternalSkillsKey } from "./skill-config-key.mjs";

export async function discoverHermesConfigPaths(homePath, registry = []) {
  const targets = await discoverHermesConfigTargets(homePath, registry);
  return [...new Set(targets.map((target) => target.configPath))];
}

export async function discoverHermesConfigTargets(homePath, registry = []) {
  const root = path.join(homePath, ".hermes");
  const targets = [];
  const seen = new Set();
  const push = (configPath, key = "skills.external_dirs") => {
    if (!parseExternalSkillsKey(key)) return;
    const identity = `${configPath}\0${key}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    targets.push({ configPath, key });
  };
  push(path.join(root, "config.yaml"));
  try {
    const entries = await fs.readdir(path.join(root, "profiles"), { withFileTypes: true });
    for (const entry of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      push(path.join(root, "profiles", entry.name, "config.yaml"));
    }
  } catch {
    // A machine without Hermes profiles still gets the root config target.
  }
  for (const agent of Array.isArray(registry) ? registry : []) {
    if (
      agent.skills?.mode !== "config-external-dir"
      || !isSafeRegistryPathText(agent.skills.configFile)
      || !parseExternalSkillsKey(agent.skills.key)
    ) continue;
    const customPath = path.resolve(homePath, agent.skills.configFile);
    if (!isPathWithinLexically(homePath, customPath)) continue;
    push(customPath, agent.skills.key);
  }
  return targets;
}

export async function inspectExternalSkillsDirs(
  configPath,
  key = "skills.external_dirs",
  boundaryRoot = path.dirname(configPath)
) {
  const keyParts = parseExternalSkillsKey(key);
  if (!keyParts) return { status: "invalid-key", values: [] };
  if (!isSafeRegistryPathText(configPath)) return { status: "invalid-target", values: [] };
  let stats;
  try {
    stats = await fs.lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", values: null };
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { status: "unsafe", values: [] };
  }
  try {
    await validateManagedFilePath(configPath, boundaryRoot);
  } catch {
    return { status: "unsafe", values: [] };
  }
  let bytes;
  try {
    bytes = await fs.readFile(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", values: null };
    throw error;
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    return { status: "invalid-encoding", values: [] };
  }
  try {
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || !isMap(document.contents)) {
      return { status: "invalid-yaml", values: [] };
    }
    const value = document.getIn(keyParts, true);
    if (isSeq(value) && value.items.every((entry) => isScalar(entry))) {
      return {
        status: "readable",
        values: value.items.map((entry) => String(entry.value ?? ""))
      };
    }
    if (isScalar(value) && value.value != null) {
      return { status: "readable", values: [String(value.value)] };
    }
    return { status: "readable", values: [] };
  } catch {
    return { status: "invalid-yaml", values: [] };
  }
}

// Conservative, semantic-guarded editor for `skills.external_dirs` in Hermes
// config.yaml. The line editor preserves ordinary formatting and comments;
// YAML preflight plus candidate validation fail closed on shapes it cannot
// preserve safely.
export async function ensureExternalSkillsDir({
  configPath,
  skillsPath,
  key = "skills.external_dirs",
  dryRun = false,
  createMissing = false,
  boundaryRoot = path.dirname(configPath),
  beforeReplace = null,
  beforePublish = null,
  beforeCommit = null,
  beforeRename = null
}) {
  const keyParts = parseExternalSkillsKey(key);
  if (!keyParts) {
    return { action: "manual", reason: "unsupported external_dirs key" };
  }
  if (!isSafeRegistryPathText(configPath)) {
    return { action: "manual", reason: "unsafe config path" };
  }
  const [sectionName, externalDirsKey] = keyParts;
  const renderedSkillsPath = renderYamlPath(skillsPath);
  if (!renderedSkillsPath) {
    return { action: "manual", reason: "unsafe skills path" };
  }
  let stats;
  try {
    stats = await fs.lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { action: "manual", reason: "config not found" };
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { action: "manual", reason: "existing config path is not a regular file" };
  }
  try {
    stats = await validateManagedFilePath(configPath, boundaryRoot);
  } catch (error) {
    return { action: "manual", reason: error.message };
  }
  let sourceBytes;
  try {
    sourceBytes = await fs.readFile(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { action: "manual", reason: "config not found" };
    throw error;
  }
  const text = sourceBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(sourceBytes)) {
    return { action: "manual", reason: "config is not valid UTF-8" };
  }
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n/);
  const sectionPattern = new RegExp(`^${escapeRegExp(sectionName)}:\\s*$`);
  const skillsIdx = lines.findIndex((l) => sectionPattern.test(l));

  let document;
  try {
    document = parseDocument(text, { strict: true, uniqueKeys: true });
  } catch {
    return { action: "manual", reason: "invalid YAML" };
  }
  if (document.errors.length > 0) {
    return { action: "manual", reason: "invalid YAML" };
  }
  const root = document.contents;
  if (root != null && !isMap(root)) {
    return { action: "manual", reason: "unsupported YAML document shape" };
  }
  const semanticSectionPresent = isMap(root) && root.has(sectionName);
  if (semanticSectionPresent && skillsIdx === -1) {
    return { action: "manual", reason: `unsupported ${sectionName} section spelling` };
  }
  if (skillsIdx === -1) {
    if (!createMissing) return { action: "manual", reason: "no skills: section" };
    const prefix = text.endsWith(lineEnding) ? text : `${text}${lineEnding}`;
    const addition = [
      `${sectionName}:`,
      `  ${externalDirsKey}:`,
      `    - ${renderedSkillsPath}`,
      ""
    ].join(lineEnding);
    return publishCandidate(`${prefix}${addition}`, dryRun ? "would-add-section" : "added-section");
  }

  const semanticSection = semanticSectionPresent ? root.get(sectionName, true) : null;
  const semanticExternalDirsPair = isMap(semanticSection)
    ? semanticSection.items.find((pair) => isScalar(pair.key) && pair.key.value === externalDirsKey)
    : null;
  const semanticExternalDirsPresent = Boolean(semanticExternalDirsPair);
  const edIdx = semanticExternalDirsPair?.key?.range
    ? lineIndexAtOffset(text, semanticExternalDirsPair.key.range[0])
    : -1;
  const childMatch = edIdx >= 0
    ? lines[edIdx].match(new RegExp(`^(\\s+)${escapeRegExp(externalDirsKey)}:`))
    : null;
  if (semanticExternalDirsPresent && edIdx === -1) {
    return { action: "manual", reason: `unsupported ${externalDirsKey} key spelling` };
  }
  if (semanticExternalDirsPresent && !childMatch) {
    return { action: "manual", reason: `unsupported ${externalDirsKey} key spelling` };
  }
  if (edIdx === -1) {
    if (!createMissing) return { action: "manual", reason: "no external_dirs key" };
    let insertAt = skillsIdx + 1;
    while (insertAt < lines.length && (!lines[insertAt].trim() || /^\s{2,}/.test(lines[insertAt]))) insertAt += 1;
    lines.splice(insertAt, 0, `  ${externalDirsKey}:`, `    - ${renderedSkillsPath}`);
    return publishCandidate(lines.join(lineEnding), dryRun ? "would-add-key" : "added-key");
  }

  const childIndent = childMatch?.[1] || "  ";
  const defaultItemIndent = childIndent.length + 2;
  const item = `${" ".repeat(defaultItemIndent)}- ${renderedSkillsPath}`;
  let prunedStale = false;
  const semanticExternalDirs = semanticExternalDirsPresent
    ? semanticSection.get(externalDirsKey, true)
    : null;
  if (
    isScalar(semanticExternalDirs)
    && semanticExternalDirs.value === skillsPath
    && semanticExternalDirs.comment != null
  ) {
    return { action: "already-present" };
  }
  const emptyListPattern = new RegExp(
    `${escapeRegExp(externalDirsKey)}:\\s*\\[\\s*\\](\\s+#.*)?\\s*$`
  );
  const listPattern = new RegExp(`${escapeRegExp(externalDirsKey)}:(?:\\s*|\\s+#.*)$`);
  const emptyListMatch = lines[edIdx].match(emptyListPattern);
  if (emptyListMatch) {
    lines[edIdx] = `${childIndent}${externalDirsKey}:${emptyListMatch[1] || ""}`;
    lines.splice(edIdx + 1, 0, item);
  } else if (listPattern.test(lines[edIdx])) {
    if (
      !isSeq(semanticExternalDirs)
      && !(isScalar(semanticExternalDirs) && semanticExternalDirs.value == null)
    ) {
      return { action: "manual", reason: "unexpected external_dirs shape" };
    }
    // Remove dead DotAIOS setup paths, then insert after the last existing
    // item. Foreign external directories are never touched.
    const itemIndent = detectListItemIndent(lines, edIdx + 1, defaultItemIndent);
    let itemIndexes = collectListItemIndexes(lines, edIdx + 1, itemIndent);
    if (isSeq(semanticExternalDirs)) {
      const semanticItems = semanticExternalDirs.items;
      const editorCanPreserveItems = semanticItems.length === itemIndexes.length
        && semanticItems.every((semanticItem, index) => (
          isEditableScalar(semanticItem)
          && parseListValue(lines[itemIndexes[index]], itemIndent) === String(semanticItem.value ?? "")
        ));
      if (!editorCanPreserveItems) {
        return { action: "manual", reason: "unexpected external_dirs list shape" };
      }
    }
    const staleIndexes = [];
    for (const index of itemIndexes) {
      const value = parseListValue(lines[index], itemIndent);
      if (value !== skillsPath && await isStaleDotaiosTempPath(value)) staleIndexes.push(index);
    }
    for (const index of staleIndexes.reverse()) {
      lines.splice(index, 1);
      prunedStale = true;
    }
    itemIndexes = collectListItemIndexes(lines, edIdx + 1, itemIndent);
    if (itemIndexes.some((index) => parseListValue(lines[index], itemIndent) === skillsPath)) {
      if (!prunedStale) return { action: "already-present" };
      return publishCandidate(
        lines.join(lineEnding),
        dryRun ? "would-prune-stale" : "pruned-stale"
      );
    }
    const insertAt = itemIndexes.length > 0 ? itemIndexes.at(-1) + 1 : edIdx + 1;
    lines.splice(insertAt, 0, `${" ".repeat(itemIndent)}- ${renderedSkillsPath}`);
  } else {
    const scalarMatch = lines[edIdx].match(
      new RegExp(`^\\s+${escapeRegExp(externalDirsKey)}:\\s+(.+?)\\s*$`)
    );
    const rawScalarValue = scalarMatch?.[1]?.trim();
    const scalarValue = isScalar(semanticExternalDirs)
      ? String(semanticExternalDirs.value ?? "")
      : "";
    const isolatedScalar = parseSingleLineScalar(rawScalarValue);
    if (
      !isEditableScalar(semanticExternalDirs)
      || !isolatedScalar.ok
      || isolatedScalar.value !== scalarValue
      || !scalarValue
      || /^[\[{|>]/.test(scalarValue)
    ) {
      return { action: "manual", reason: "unexpected external_dirs shape" };
    }
    lines[edIdx] = `${childIndent}${externalDirsKey}:`;
    const scalarIsStale = await isStaleDotaiosTempPath(scalarValue);
    if (!scalarIsStale) {
      lines.splice(edIdx + 1, 0, `${" ".repeat(defaultItemIndent)}- ${rawScalarValue}`);
    }
    if (scalarValue !== skillsPath) lines.splice(edIdx + 1 + (scalarIsStale ? 0 : 1), 0, item);
    prunedStale = scalarIsStale;
  }

  return publishCandidate(
    lines.join(lineEnding),
    prunedStale
      ? (dryRun ? "would-prune-stale" : "pruned-stale")
      : (dryRun ? "would-add" : "added")
  );

  async function publishCandidate(candidate, action) {
    if (!candidateHasExternalSkillsPath(candidate, sectionName, externalDirsKey, skillsPath)) {
      return { action: "manual", reason: "generated config failed semantic validation" };
    }
    if (dryRun) return { action };
    let replacement;
    try {
      replacement = await replaceFileIfUnchanged(configPath, text, candidate, {
        boundaryRoot,
        expectedStats: stats,
        mode: stats.mode & 0o777,
        beforeReplace,
        beforePublish,
        beforeCommit,
        beforeRename,
        expectedBytes: sourceBytes
      });
    } catch (error) {
      if (/unsafe managed|outside the managed|unsafe file destination/i.test(error?.message || "")) {
        return { action: "manual", reason: error.message };
      }
      throw error;
    }
    if (!replacement.replaced) {
      return {
        action: "conflict",
        reason: `config changed during activation; left the concurrent edit untouched${
          replacement.preservedPath ? ` and preserved the previous file at ${path.basename(replacement.preservedPath)}` : ""
        }`
      };
    }
    return {
      action,
      reason: replacement.preservedPath
        ? `preserved the previous config at ${path.basename(replacement.preservedPath)}`
        : undefined
    };
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineIndexAtOffset(text, offset) {
  return text.slice(0, offset).split(/\r\n|\n/).length - 1;
}

async function isStaleDotaiosTempPath(value) {
  const resolved = path.resolve(unquoteScalar(value));
  const tempRoot = path.resolve(os.tmpdir());
  if (!isPathWithinLexically(tempRoot, resolved)) return false;
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
  if (!match) return "";
  try {
    const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || !isScalar(document.contents)) return "";
    return String(document.contents.value ?? "");
  } catch {
    return "";
  }
}

function parseSingleLineScalar(value) {
  if (!value || String(value).includes("\n")) return { ok: false, value: "" };
  try {
    const document = parseDocument(String(value), { strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || !isEditableScalar(document.contents)) {
      return { ok: false, value: "" };
    }
    return { ok: true, value: String(document.contents.value ?? "") };
  } catch {
    return { ok: false, value: "" };
  }
}

function renderYamlPath(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) return null;
  if (/[\u2028\u2029]/.test(value)) {
    return JSON.stringify(value)
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
  }
  const plain = parseSingleLineScalar(value);
  if (plain.ok && plain.value === value) return value;
  return JSON.stringify(value);
}

function candidateHasExternalSkillsPath(candidate, sectionName, externalDirsKey, skillsPath) {
  try {
    const document = parseDocument(candidate, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0 || !isMap(document.contents)) return false;
    const section = document.contents.get(sectionName, true);
    if (!isMap(section)) return false;
    const externalDirs = section.get(externalDirsKey, true);
    return isSeq(externalDirs)
      && externalDirs.items.every((entry) => isScalar(entry))
      && externalDirs.items.some((entry) => entry.value === skillsPath);
  } catch {
    return false;
  }
}

function isEditableScalar(node) {
  return isScalar(node) && ["PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"].includes(node.type);
}

function detectListItemIndent(lines, startIndex, fallback = 4) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isListTrivia(lines[index])) continue;
    const match = lines[index].match(/^(\s*)-\s+/);
    if (!match) break;
    return match[1].length;
  }
  return fallback;
}

function isListItem(line, indent) {
  return new RegExp(`^\\s{${indent}}-\\s+`).test(String(line || ""));
}

function isListTrivia(line) {
  return !String(line || "").trim() || /^\s*#/.test(String(line || ""));
}

function collectListItemIndexes(lines, startIndex, indent) {
  const indexes = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isListTrivia(lines[index])) continue;
    if (!isListItem(lines[index], indent)) break;
    indexes.push(index);
  }
  return indexes;
}
