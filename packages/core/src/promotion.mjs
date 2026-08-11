import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson } from "./files.mjs";
import { SIGNAL_RETENTION_DAYS, formatJsonlEntry, isoDate, withEventStoreLock } from "./memory.mjs";
import { expandHome, isPathWithin, resolveVaultPath } from "./paths.mjs";
import { createSessionStore } from "./session-store.mjs";

export const PROMOTION_DESTINATIONS = [
  "signal",
  "context",
  "project",
  "vault",
  "skill",
  "session-only"
];

export const PROMOTION_OPERATIONS = Object.freeze(["add", "replace", "remove", "supersede"]);

const MARKDOWN_DESTINATIONS = new Set(["context", "project", "vault", "skill"]);
const PROMOTION_PLAN_VERSION = 1;
const PROMOTION_PLAN_DIRECTORY = path.join(".dotaios", "promotion-plans");
const PROMOTION_PLAN_ID_LENGTH = 24;
const PROMOTION_PREVIEW_LINE_LIMIT = 12;

/**
 * Build a read-only promotion plan for captured session evidence.
 */
export async function planPromotion(aiosPath, options = {}) {
  const root = path.resolve(aiosPath);
  const destinationType = normalizeDestinationType(options.destinationType);
  const operation = normalizeOperation(options.operation);
  const match = normalizeMatch(options.match);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("Promotion requires a valid date.");

  const source = await resolveSessionSource(root, options.source);
  const summary = String(options.summary || "").trim();
  if (!summary) {
    throw new Error("Add --summary with the fact, state, or procedure you want to promote.");
  }

  const destination = await resolveDestination(root, {
    destinationType,
    destinationPath: options.destinationPath,
    project: options.project,
    now
  });
  const project = normalizeProject(options.project || destination.project || source.project);
  const sourceHash = source.canonicalHash;
  const promotedContentHash = contentHash(summary);
  const receiptPath = path.join(root, "memory", "events.jsonl");
  await assertSafeShelfPath(root, path.join(root, "memory"), receiptPath, "promotion receipt");

  let before = "";
  let destinationExists = false;
  let addition = "";
  let destinationEntry = null;
  let destinationAfter = before;
  let noop = false;
  let matchedContentHash = null;

  if (destinationType === "signal") {
    destinationExists = await pathExists(destination.absolutePath);
    before = await readTextIfPresent(destination.absolutePath);
    destinationEntry = {
      ts: now.toISOString(),
      type: "promoted-evidence",
      ...(project && { project }),
      summary,
      source: source.relativePath,
      content_hash: promotedContentHash
    };
    const change = buildSignalPromotionChange({
      before,
      destinationEntry,
      operation,
      match,
      sourcePath: source.relativePath,
      promotedContentHash
    });
    ({ addition, destinationAfter, noop, matchedContentHash } = change);
  } else if (MARKDOWN_DESTINATIONS.has(destinationType)) {
    destinationExists = await pathExists(destination.absolutePath);
    before = await readTextIfPresent(destination.absolutePath);
    const change = buildMarkdownPromotionChange({
      before,
      summary,
      sourcePath: source.relativePath,
      date: isoDate(now),
      operation,
      match,
      promotedContentHash
    });
    ({ addition, destinationAfter, noop, matchedContentHash } = change);
  } else if (operation !== "add") {
    throw new Error(`${operation} is not supported for session-only promotions.`);
  }

  const planInput = {
    source: source.sessionId,
    destinationType,
    destinationPath: destination.relativePath,
    project,
    summary,
    operation,
    match
  };

  return {
    version: PROMOTION_PLAN_VERSION,
    aiosPath: root,
    destinationType,
    destinationPath: destination.relativePath,
    destinationAbsolutePath: destination.absolutePath,
    destinationRoot: destination.root,
    destinationRootIsExternal: destination.rootIsExternal,
    operation,
    match,
    matchedContentHash,
    noop,
    project,
    summary,
    source: {
      sessionId: source.sessionId,
      relativePath: source.relativePath,
      hash: sourceHash
    },
    before,
    destinationExists,
    addition,
    destinationAfter,
    destinationEntry,
    contentHash: promotedContentHash,
    receiptPath,
    receiptRelativePath: path.relative(root, receiptPath),
    planId: promotionPlanId(planInput),
    planPath: promotionPlanPathFor(root, planInput),
    preview: renderPromotionDiff({
      destinationPath: destination.relativePath,
      destinationType,
      destinationExists,
      before,
      after: destinationAfter,
      addition,
      operation,
      noop
    })
  };
}

export const previewPromotion = planPromotion;

/** Return the deterministic local path for a preview's persisted plan. */
export function promotionPlanPathFor(aiosPath, options = {}) {
  const root = path.resolve(aiosPath);
  const planInput = {
    source: options.source,
    destinationType: options.destinationType,
    destinationPath: options.destinationPath || null,
    project: options.project || null,
    summary: String(options.summary || "").trim(),
    operation: normalizeOperation(options.operation),
    match: normalizeMatch(options.match)
  };
  return path.join(root, PROMOTION_PLAN_DIRECTORY, `${promotionPlanId(planInput)}.json`);
}

/** Persist a preview plan so a later apply can consume the exact reviewed state. */
export async function persistPromotionPlan(plan) {
  assertPromotionPlan(plan);
  await fs.mkdir(path.dirname(plan.planPath), { recursive: true });
  await fs.writeFile(plan.planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan.planPath;
}

/** Load and validate a previously persisted preview plan, if it exists. */
export async function loadPromotionPlan(planPath) {
  let content;
  try {
    content = await fs.readFile(planPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let plan;
  try {
    plan = JSON.parse(content);
  } catch {
    throw new Error(`Saved promotion plan is invalid JSON: ${planPath}`);
  }
  assertPromotionPlan(plan);
  return plan;
}

/** Remove a persisted plan after its apply attempt has completed. */
export async function consumePromotionPlan(plan) {
  assertPromotionPlan(plan);
  if (plan.planPath) await fs.rm(plan.planPath, { force: true });
}

/**
 * Apply a previously previewed plan. The source and destination must still
 * match the preview, otherwise the caller must build and show a fresh plan.
 */
export async function applyPromotion(plan, options = {}) {
  assertPromotionPlan(plan);

  if (plan.destinationType !== "session-only") {
    await assertSafeDestinationFromPlan(plan);
  }

  await assertSafeShelfPath(
    plan.aiosPath,
    path.join(plan.aiosPath, "memory"),
    plan.receiptPath,
    "promotion receipt"
  );
  return withEventStoreLock(plan.receiptPath, async () => {
    const sourceResult = await createSessionStore({ aiosPath: plan.aiosPath }).search({
      purpose: "exact",
      sessionId: plan.source.sessionId,
    });
    const [currentSource] = sourceResult.rows;
    if (
      sourceResult.rows.length !== 1
      || currentSource.path !== plan.source.relativePath
      || currentSource.canonical_hash !== plan.source.hash
    ) {
      throw new Error("The captured session changed after the preview. Preview the promotion again.");
    }

    let destinationChange = null;
    if (plan.destinationType !== "session-only") {
      const destinationExists = await pathExists(plan.destinationAbsolutePath);
      const currentDestination = await readTextIfPresent(plan.destinationAbsolutePath);
      if (destinationExists !== plan.destinationExists || currentDestination !== plan.before) {
        throw new Error("The destination changed after the preview. Preview the promotion again.");
      }
      destinationChange = {
        target: plan.destinationAbsolutePath,
        before: currentDestination,
        existed: destinationExists,
        after: plan.destinationAfter ?? (destinationExists
          ? `${currentDestination}${plan.addition}`
          : plan.addition.replace(/^\n+/, ""))
      };
    }

    const receiptBefore = await readTextIfPresent(plan.receiptPath);
    const receiptExists = await pathExists(plan.receiptPath);
    const receipt = {
      ts: new Date().toISOString(),
      type: "memory-promotion",
      source: plan.source.relativePath,
      source_session_id: plan.source.sessionId,
      destination_type: plan.destinationType,
      destination_path: plan.destinationPath,
      operation: plan.operation,
      ...(plan.matchedContentHash && { matched_content_hash: plan.matchedContentHash }),
      ...(plan.noop && { no_op: true, reason: "identical promoted content already exists at this destination" }),
      ...(plan.project && { project: plan.project }),
      summary: plan.summary,
      source_hash: plan.source.hash,
      content_hash: plan.contentHash,
      actor: "dotaios-cli"
    };
    const receiptChange = {
      target: plan.receiptPath,
      before: receiptBefore,
      existed: receiptExists,
      after: `${receiptBefore}${formatJsonlEntry(receipt)}`
    };
    await replaceFilesAtomically([
      receiptChange,
      ...(destinationChange ? [destinationChange] : [])
    ]);

    return {
      applied: true,
      noop: Boolean(plan.noop),
      destinationType: plan.destinationType,
      destinationPath: plan.destinationPath,
      receiptPath: plan.receiptRelativePath,
      receipt
    };
  }, options);
}

export function renderPromotionPreview(plan) {
  assertPromotionPlan(plan);
  const lines = [
    "DotAIOS memory promotion preview",
    `Source: ${plan.source.relativePath}`,
    `Destination type: ${plan.destinationType}`,
    `Destination: ${plan.destinationPath || "session-only (no knowledge file)"}`,
    `Operation: ${plan.operation}${plan.noop ? " (no-op; identical content already exists)" : ""}`,
    ...(plan.project ? [`Project: ${plan.project}`] : []),
    `Receipt: ${plan.receiptRelativePath}`,
    ...(plan.planPath ? [`Plan: ${plan.planPath}`] : []),
    // A signal is the one destination that expires. Say so where the choice is
    // being made, not in docs the user will never open.
    ...(plan.destinationType === "signal"
      ? [
        "",
        `Retention: signals are trimmed after ${SIGNAL_RETENTION_DAYS} days (archived, not deleted).`,
        "For a fact that should last, promote to context, project, or vault instead."
      ]
      : []),
    "",
    "Change preview:",
    plan.preview
  ];
  return lines.join("\n");
}

async function resolveSessionSource(aiosPath, sourceValue) {
  const source = String(sourceValue || "").trim();
  if (!source) throw new Error("Choose captured evidence with a session ID.");

  const result = await createSessionStore({ aiosPath }).search({ purpose: "body", query: "" });
  const entries = result.rows;
  const normalizedSource = normalizeRelativePath(source);
  const exact = entries.find((entry) => (
    entry.session_id === source || normalizeRelativePath(entry.path) === normalizedSource
  ));
  const prefixMatches = exact ? [] : entries.filter((entry) => (
    source.length >= 4 && String(entry.session_id || "").startsWith(source)
  ));
  if (prefixMatches.length > 1) {
    throw new Error(`Session ID is ambiguous: ${source}. Use the full ID from \`dotaios capture list\`.`);
  }
  const entry = exact || prefixMatches[0];
  if (!entry) {
    throw new Error(`Captured session not found: ${source}. Run \`dotaios capture list\` to see session IDs.`);
  }

  const relativePath = normalizeRelativePath(entry.path);
  return {
    sessionId: entry.session_id,
    relativePath,
    canonicalHash: entry.canonical_hash,
    project: entry.project
  };
}

async function resolveDestination(aiosPath, { destinationType, destinationPath, project, now }) {
  if (destinationType === "session-only") {
    if (destinationPath) throw new Error("session-only does not use --destination.");
    return { absolutePath: null, relativePath: null, root: null, rootIsExternal: false, project: null };
  }

  if (destinationType === "signal") {
    if (destinationPath) throw new Error("Signals use today's memory/signals file; omit --destination.");
    const root = path.join(aiosPath, "memory", "signals");
    const absolutePath = path.join(root, `${isoDate(now)}.jsonl`);
    await assertSafeShelfPath(aiosPath, root, absolutePath, "signal destination");
    return {
      absolutePath,
      relativePath: path.relative(aiosPath, absolutePath),
      root,
      rootIsExternal: false,
      project: null
    };
  }

  const config = await readJson(path.join(aiosPath, "aios.json"), {});
  const configuredVaultRoot = resolveConfiguredVaultRoot(aiosPath, config);
  const roots = {
    context: path.join(aiosPath, "context"),
    project: path.join(aiosPath, "projects"),
    vault: configuredVaultRoot,
    skill: path.join(aiosPath, "skills")
  };
  const prefixes = { context: "context", project: "projects", vault: "vault", skill: "skills" };
  const root = roots[destinationType];
  const rootIsExternal = destinationType === "vault" && !await isPathWithin(aiosPath, root);
  let requestedPath = destinationPath;

  if (!requestedPath && destinationType === "project" && project) {
    requestedPath = path.join(normalizeProject(project), "README.md");
  }
  if (!requestedPath) {
    throw new Error(`${destinationType} promotions need --destination <path>.`);
  }
  if (path.isAbsolute(requestedPath)) {
    throw new Error("--destination must be a relative path inside the selected shelf.");
  }

  let relativeToRoot = stripShelfPrefix(normalizeRelativePath(requestedPath), prefixes[destinationType]);
  const normalizedProject = normalizeProject(project);
  if (destinationType === "project" && normalizedProject) {
    const firstSegment = relativeToRoot.split("/")[0];
    if (!relativeToRoot.includes("/")) {
      relativeToRoot = path.posix.join(normalizedProject, relativeToRoot);
    } else if (firstSegment !== normalizedProject) {
      throw new Error(`Project destination must stay inside projects/${normalizedProject}.`);
    }
  }

  const absolutePath = path.resolve(root, relativeToRoot);
  if (path.extname(absolutePath).toLowerCase() !== ".md") {
    throw new Error(`${destinationType} promotions need a Markdown (.md) destination.`);
  }
  if (destinationType === "skill" && path.basename(absolutePath) !== "SKILL.md") {
    throw new Error("Skill promotions must target an existing skills/<name>/SKILL.md file.");
  }

  if (rootIsExternal) {
    await assertSafePath(root, absolutePath, "vault destination");
  } else {
    await assertSafeShelfPath(aiosPath, root, absolutePath, `${destinationType} destination`);
  }
  if (destinationType === "skill" && !await pathExists(absolutePath)) {
    throw new Error("Skill promotions append to an existing SKILL.md. Create and verify the skill first.");
  }

  const inferredProject = destinationType === "project"
    ? relativeToRoot.split("/")[0]
    : null;
  return {
    absolutePath,
    relativePath: rootIsExternal ? absolutePath : path.relative(aiosPath, absolutePath),
    root,
    rootIsExternal,
    project: inferredProject
  };
}

async function assertSafeDestinationFromPlan(plan) {
  if (plan.destinationRootIsExternal) {
    await assertSafePath(plan.destinationRoot, plan.destinationAbsolutePath, "vault destination");
    return;
  }
  await assertSafeShelfPath(
    plan.aiosPath,
    plan.destinationRoot,
    plan.destinationAbsolutePath,
    `${plan.destinationType} destination`
  );
}

async function assertSafeShelfPath(aiosPath, shelfRoot, candidate, label) {
  await assertSafeInternalPath(aiosPath, shelfRoot, `${label} shelf`);
  await assertSafePath(shelfRoot, candidate, label);
}

async function assertSafeInternalPath(aiosPath, candidate, label) {
  const root = path.resolve(aiosPath);
  await assertSafePath(root, candidate, label);
}

async function assertSafePath(allowedRoot, candidate, label) {
  const lexicalRoot = path.resolve(allowedRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (!isLexicallyWithin(lexicalRoot, lexicalCandidate)) {
    throw new Error(`Unsafe ${label}: path traversal is not allowed.`);
  }
  if (!await isPathWithin(lexicalRoot, lexicalCandidate)) {
    throw new Error(`Unsafe ${label}: a symlink points outside the allowed shelf or cannot be resolved.`);
  }
}

async function replaceFilesAtomically(changes) {
  const prepared = [];
  try {
    for (const change of changes) {
      await assertFileUnchanged(change);
      await fs.mkdir(path.dirname(change.target), { recursive: true });
      const token = crypto.randomUUID();
      const tempPath = path.join(
        path.dirname(change.target),
        `.${path.basename(change.target)}.tmp-${token}`
      );
      const backupPath = path.join(
        path.dirname(change.target),
        `.${path.basename(change.target)}.backup-${token}`
      );
      const mode = change.existed
        ? (await fs.stat(change.target)).mode & 0o777
        : 0o666;
      try {
        await writeDurableFile(tempPath, change.after, mode);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      prepared.push({
        ...change,
        backupPath,
        backedUp: false,
        committed: false,
        tempPath
      });
    }

    for (const item of prepared) {
      await assertFileUnchanged(item);
      if (item.existed) {
        await fs.rename(item.target, item.backupPath);
        item.backedUp = true;
      }
      await fs.rename(item.tempPath, item.target);
      item.committed = true;
    }

    await Promise.all([...new Set(prepared.map((item) => path.dirname(item.target)))].map(syncDirectory));
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...prepared].reverse()) {
      try {
        if (item.committed) {
          await fs.rm(item.target, { force: true });
        }
        if (item.backedUp) {
          await fs.rename(item.backupPath, item.target);
          item.backedUp = false;
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    await Promise.all(prepared.map((item) => fs.rm(item.tempPath, { force: true }).catch(() => {})));
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Promotion failed and its atomic rollback could not be completed."
      );
    }
    throw error;
  }

  await Promise.all(prepared.map(async (item) => {
    if (item.backedUp) await fs.rm(item.backupPath, { force: true }).catch(() => {});
  }));
}

async function assertFileUnchanged({ target, before, existed }) {
  const currentExists = await pathExists(target);
  const current = await readTextIfPresent(target);
  if (currentExists !== existed || current !== before) {
    throw new Error(`The file changed before the atomic promotion could be applied: ${target}`);
  }
}

async function writeDurableFile(filePath, content, mode) {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function buildSignalPromotionChange({ before, destinationEntry, operation, match, sourcePath, promotedContentHash }) {
  const entries = parseSignalEntries(before);
  const matched = findMatchingPromotion(entries, { match, sourcePath });
  if (operation === "add" && entries.some((entry) => promotionContentHash(entry) === promotedContentHash)) {
    return { addition: "", destinationAfter: before, noop: true, matchedContentHash: promotedContentHash };
  }
  if (operation !== "add" && !matched) {
    throw new Error(`${operation} requires --match <content-hash|summary> for an existing promoted block.`);
  }

  let nextEntries;
  if (operation === "add") {
    nextEntries = [...entries, destinationEntry];
  } else if (operation === "replace") {
    nextEntries = entries.map((entry) => entry === matched ? destinationEntry : entry);
  } else if (operation === "supersede") {
    nextEntries = entries.flatMap((entry) => entry === matched
      ? [{ ...entry, status: "superseded", superseded_by: promotedContentHash }, destinationEntry]
      : [entry]);
  } else {
    nextEntries = entries.filter((entry) => entry !== matched);
  }

  const destinationAfter = nextEntries.map((entry) => formatJsonlEntry(entry)).join("");
  return {
    addition: destinationAfter.slice(before.length),
    destinationAfter,
    noop: false,
    matchedContentHash: matched ? promotionContentHash(matched) : null
  };
}

function buildMarkdownPromotionChange({ before, summary, sourcePath, date, operation, match, promotedContentHash }) {
  const block = markdownBlock({ summary, sourcePath, date, contentHash: promotedContentHash });
  const blocks = parsePromotionBlocks(before);
  const matched = findMatchingPromotion(blocks, { match, sourcePath });
  if (operation === "add" && blocks.some((candidate) => candidate.contentHash === promotedContentHash)) {
    return { addition: "", destinationAfter: before, noop: true, matchedContentHash: promotedContentHash };
  }
  if (operation !== "add" && !matched) {
    throw new Error(`${operation} requires --match <content-hash|summary> for an existing promoted block.`);
  }

  if (operation === "add") {
    const addition = markdownAddition({ before, block });
    return {
      addition,
      destinationAfter: `${before}${addition}`,
      noop: false,
      matchedContentHash: null
    };
  }

  if (operation === "replace") {
    const destinationAfter = `${before.slice(0, matched.start)}${block}${before.slice(matched.end)}`;
    return {
      addition: block,
      destinationAfter,
      noop: false,
      matchedContentHash: matched.contentHash
    };
  }

  if (operation === "remove") {
    return {
      addition: "",
      destinationAfter: `${before.slice(0, matched.start)}${before.slice(matched.end)}`,
      noop: false,
      matchedContentHash: matched.contentHash
    };
  }

  const status = `<!-- dotaios-promotion-status: superseded-by=${promotedContentHash} -->`;
  const superseded = `${matched.raw.trimEnd()}\n\n${status}\n`;
  const withoutOld = `${before.slice(0, matched.start)}${superseded}${before.slice(matched.end)}`;
  const addition = markdownAddition({ before: withoutOld, block });
  return {
    addition,
    destinationAfter: `${withoutOld}${addition}`,
    noop: false,
    matchedContentHash: matched.contentHash
  };
}

function markdownAddition({ before, block }) {
  const leading = before ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  return `${leading}${block}`;
}

function markdownBlock({ summary, sourcePath, date, contentHash: hash }) {
  return `<!-- dotaios-promotion: content_hash=${hash} -->\n## Promoted evidence: ${date}\n\n${summary}\n\nSource: \`${sourcePath}\`\n`;
}

function parsePromotionBlocks(content) {
  const starts = [];
  const pattern = /(?:^|\n)(?:<!-- dotaios-promotion:[^\n]+ -->\n)?## Promoted evidence:[^\n]*/g;
  for (const match of content.matchAll(pattern)) {
    starts.push(match.index + (content[match.index] === "\n" ? 1 : 0));
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? content.length;
    const raw = content.slice(start, end);
    const hash = raw.match(/content_hash=([a-f0-9]{16,64})/)?.[1] || null;
    const summaryMatch = raw.match(/## Promoted evidence:[^\n]*\n\n([\s\S]*?)(?:\n\nSource:|\nSource:)/);
    const summary = summaryMatch?.[1]?.trim() || "";
    const sourcePath = raw.match(/Source: `([^`]+)`/)?.[1] || null;
    return {
      start,
      end,
      raw,
      contentHash: hash || contentHash(summary),
      summary,
      sourcePath,
      superseded: raw.includes("dotaios-promotion-status: superseded-by=")
    };
  });
}

function parseSignalEntries(content) {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error("Cannot modify a signal promotion because its JSONL destination is invalid.");
      }
    });
}

function findMatchingPromotion(entries, { match, sourcePath }) {
  if (match) {
    return entries.find((entry) => (
      promotionContentHash(entry) === match
      || String(entry.summary || "").trim() === match
      || String(entry.content_hash || "") === match
    )) || null;
  }
  const sourceMatches = entries.filter((entry) => entry.source === sourcePath || entry.sourcePath === sourcePath);
  return sourceMatches.length === 1 ? sourceMatches[0] : null;
}

function promotionContentHash(entry) {
  return entry.contentHash || entry.content_hash || contentHash(String(entry.summary || "").trim());
}

function renderPromotionDiff({ destinationPath, destinationType, destinationExists, before, after, addition, operation, noop }) {
  if (noop) return "No changes. Identical promoted content already exists at this destination.";
  if (destinationType === "session-only") {
    return "No knowledge file will be written. The source remains captured session evidence.";
  }
  if (operation === "add" && destinationType !== "session-only") {
    return renderDiff(destinationPath, addition, destinationType, destinationExists);
  }
  // Show what actually changes. This used to print the last N lines of `before`
  // as removals and the last N of `after` as additions — two unaligned tail
  // windows, not a diff. A block deleted from the top of a long file showed no
  // deletion at all, while untouched tail lines showed as both removed and
  // added. A preview the user is asked to approve has to be true.
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];

  let head = 0;
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) tail += 1;

  const removedLines = beforeLines.slice(head, beforeLines.length - tail).filter((line) => line.trim());
  const addedLines = afterLines.slice(head, afterLines.length - tail).filter((line) => line.trim());

  const clip = (lines, prefix) => {
    const shown = lines.slice(0, PROMOTION_PREVIEW_LINE_LIMIT).map((line) => `${prefix}${line}`);
    const hidden = lines.length - shown.length;
    return hidden > 0 ? [...shown, `${prefix}… ${hidden} more line(s)`] : shown;
  };

  return [
    `Operation: ${operation}`,
    `--- ${destinationPath}`,
    `+++ ${destinationPath}`,
    `@@ ${operation} @@`,
    ...clip(removedLines, "-"),
    ...clip(addedLines, "+")
  ].join("\n");
}

function renderDiff(destinationPath, addition, destinationType, destinationExists) {
  if (destinationType === "session-only") {
    return "No knowledge file will be written. The source remains captured session evidence.";
  }
  const addedLines = addition.replace(/^\n+/, "").replace(/\n$/, "").split("\n");
  return [
    `--- ${destinationExists ? destinationPath : "/dev/null"}`,
    `+++ ${destinationPath}`,
    "@@ add @@",
    ...addedLines.map((line) => `+${line}`)
  ].join("\n");
}

function resolveConfiguredVaultRoot(aiosPath, config) {
  const configured = expandHome(resolveVaultPath(config, aiosPath));
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(aiosPath, configured);
}

function normalizeDestinationType(value) {
  const destinationType = String(value || "").trim().toLowerCase();
  if (!PROMOTION_DESTINATIONS.includes(destinationType)) {
    throw new Error(`Choose --to ${PROMOTION_DESTINATIONS.join("|")}.`);
  }
  return destinationType;
}

function normalizeOperation(value) {
  const operation = String(value || "add").trim().toLowerCase();
  if (!PROMOTION_OPERATIONS.includes(operation)) {
    throw new Error(`Choose --operation ${PROMOTION_OPERATIONS.join("|")}.`);
  }
  return operation;
}

function normalizeMatch(value) {
  const match = String(value || "").trim();
  return match || null;
}

function promotionPlanId(input) {
  return contentHash(JSON.stringify(input)).slice(0, PROMOTION_PLAN_ID_LENGTH);
}

function normalizeProject(value) {
  if (value == null || String(value).trim() === "") return null;
  const project = String(value).trim();
  if (project === "." || project === ".." || project.includes("/") || project.includes("\\")) {
    throw new Error("--project must be one project folder name, without slashes.");
  }
  return project;
}

function normalizeRelativePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function stripShelfPrefix(value, prefix) {
  if (value === prefix) return "";
  return value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : value;
}

function isLexicallyWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function assertPromotionPlan(plan) {
  if (!plan || plan.version !== PROMOTION_PLAN_VERSION || !plan.aiosPath || !plan.source) {
    throw new Error("Invalid promotion plan. Preview the promotion again.");
  }
}
