import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson } from "./files.mjs";
import { appendEvent, formatJsonlEntry, readJsonl } from "./memory.mjs";
import { expandHome, resolveVaultPath } from "./paths.mjs";

export const PROMOTION_DESTINATIONS = [
  "signal",
  "context",
  "project",
  "vault",
  "skill",
  "session-only"
];

const MARKDOWN_DESTINATIONS = new Set(["context", "project", "vault", "skill"]);
const PROMOTION_PLAN_VERSION = 1;

/**
 * Build a read-only promotion plan for captured session evidence.
 */
export async function planPromotion(aiosPath, options = {}) {
  const root = path.resolve(aiosPath);
  const destinationType = normalizeDestinationType(options.destinationType);
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
  const sourceHash = contentHash(source.content);
  const promotedContentHash = contentHash(summary);
  const receiptPath = path.join(root, "memory", "events.jsonl");
  await assertSafeShelfPath(root, path.join(root, "memory"), receiptPath, "promotion receipt");

  let before = "";
  let destinationExists = false;
  let addition = "";
  let destinationEntry = null;

  if (destinationType === "signal") {
    destinationExists = await pathExists(destination.absolutePath);
    before = await readTextIfPresent(destination.absolutePath);
    destinationEntry = {
      ts: now.toISOString(),
      type: "promoted-evidence",
      ...(project && { project }),
      summary,
      source: source.relativePath
    };
    addition = formatJsonlEntry(destinationEntry);
  } else if (MARKDOWN_DESTINATIONS.has(destinationType)) {
    destinationExists = await pathExists(destination.absolutePath);
    before = await readTextIfPresent(destination.absolutePath);
    addition = markdownAddition({
      before,
      summary,
      sourcePath: source.relativePath,
      date: now.toISOString().slice(0, 10)
    });
  }

  return {
    version: PROMOTION_PLAN_VERSION,
    aiosPath: root,
    destinationType,
    destinationPath: destination.relativePath,
    destinationAbsolutePath: destination.absolutePath,
    destinationRoot: destination.root,
    destinationRootIsExternal: destination.rootIsExternal,
    operation: destinationType === "session-only" ? "retain" : "append",
    project,
    summary,
    source: {
      sessionId: source.sessionId,
      relativePath: source.relativePath,
      absolutePath: source.absolutePath,
      hash: sourceHash
    },
    before,
    destinationExists,
    addition,
    destinationEntry,
    contentHash: promotedContentHash,
    receiptPath,
    receiptRelativePath: path.relative(root, receiptPath),
    preview: renderDiff(destination.relativePath, addition, destinationType, destinationExists)
  };
}

export const previewPromotion = planPromotion;

/**
 * Apply a previously previewed plan. The source and destination must still
 * match the preview, otherwise the caller must build and show a fresh plan.
 */
export async function applyPromotion(plan) {
  assertPromotionPlan(plan);

  await assertSafeShelfPath(
    plan.aiosPath,
    path.join(plan.aiosPath, "memory", "sessions"),
    plan.source.absolutePath,
    "captured session"
  );
  const currentSource = await fs.readFile(plan.source.absolutePath, "utf8");
  if (contentHash(currentSource) !== plan.source.hash) {
    throw new Error("The captured session changed after the preview. Preview the promotion again.");
  }

  if (plan.destinationType !== "session-only") {
    await assertSafeDestinationFromPlan(plan);
    const destinationExists = await pathExists(plan.destinationAbsolutePath);
    const currentDestination = await readTextIfPresent(plan.destinationAbsolutePath);
    if (destinationExists !== plan.destinationExists || currentDestination !== plan.before) {
      throw new Error("The destination changed after the preview. Preview the promotion again.");
    }
    await appendPlannedContent(
      plan.destinationAbsolutePath,
      plan.destinationExists,
      plan.addition
    );
  }

  await assertSafeShelfPath(
    plan.aiosPath,
    path.join(plan.aiosPath, "memory"),
    plan.receiptPath,
    "promotion receipt"
  );
  const receipt = await appendEvent(plan.receiptPath, {
    type: "memory-promotion",
    source: plan.source.relativePath,
    source_session_id: plan.source.sessionId,
    destination_type: plan.destinationType,
    destination_path: plan.destinationPath,
    operation: plan.operation,
    ...(plan.project && { project: plan.project }),
    summary: plan.summary,
    source_hash: plan.source.hash,
    content_hash: plan.contentHash,
    actor: "dotaios-cli"
  });

  return {
    applied: true,
    destinationType: plan.destinationType,
    destinationPath: plan.destinationPath,
    receiptPath: plan.receiptRelativePath,
    receipt
  };
}

export function renderPromotionPreview(plan) {
  assertPromotionPlan(plan);
  const lines = [
    "DotAIOS memory promotion preview",
    `Source: ${plan.source.relativePath}`,
    `Destination type: ${plan.destinationType}`,
    `Destination: ${plan.destinationPath || "session-only (no knowledge file)"}`,
    ...(plan.project ? [`Project: ${plan.project}`] : []),
    `Receipt: ${plan.receiptRelativePath}`,
    "",
    "Change preview:",
    plan.preview
  ];
  return lines.join("\n");
}

async function resolveSessionSource(aiosPath, sourceValue) {
  const source = String(sourceValue || "").trim();
  if (!source) throw new Error("Choose captured evidence with a session ID.");

  const sessionsRoot = path.join(aiosPath, "memory", "sessions");
  const indexPath = path.join(sessionsRoot, "index.jsonl");
  await assertSafeShelfPath(aiosPath, sessionsRoot, indexPath, "session index");
  const entries = await readJsonl(indexPath);
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
  const absolutePath = path.resolve(aiosPath, relativePath);
  if (!isWithin(sessionsRoot, absolutePath)) {
    throw new Error(`Unsafe captured session path in index: ${entry.path}`);
  }
  await assertSafeShelfPath(aiosPath, sessionsRoot, absolutePath, "captured session");

  let content;
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Captured session file is missing: ${relativePath}`);
    throw error;
  }

  return {
    sessionId: entry.session_id,
    relativePath,
    absolutePath,
    content,
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
    const absolutePath = path.join(root, `${localIsoDate(now)}.jsonl`);
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
  const rootIsExternal = destinationType === "vault" && !isWithin(aiosPath, root);
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
  if (!isWithin(root, absolutePath)) {
    throw new Error(`Unsafe ${destinationType} destination: path traversal is not allowed.`);
  }
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
  if (!isWithin(root, path.resolve(candidate))) {
    throw new Error(`Unsafe ${label}: path traversal is not allowed.`);
  }
  await assertSafePath(root, candidate, label);
}

async function assertSafePath(allowedRoot, candidate, label) {
  const lexicalRoot = path.resolve(allowedRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (!isWithin(lexicalRoot, lexicalCandidate)) {
    throw new Error(`Unsafe ${label}: path traversal is not allowed.`);
  }

  const [realRoot, realCandidate] = await Promise.all([
    canonicalPath(lexicalRoot),
    canonicalPath(lexicalCandidate)
  ]);
  if (!isWithin(realRoot, realCandidate)) {
    throw new Error(`Unsafe ${label}: a symlink points outside the allowed shelf.`);
  }
  await assertNoSymlinkComponents(lexicalRoot, lexicalCandidate, label);
}

async function assertNoSymlinkComponents(allowedRoot, candidate, label) {
  const relative = path.relative(allowedRoot, candidate);
  let current = allowedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsafe ${label}: symlinks are not allowed in promotion paths.`);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function canonicalPath(value) {
  const resolved = path.resolve(value);
  const missing = [];
  let existing = resolved;
  while (!await pathExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return path.join(existing, ...missing);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(await fs.realpath(existing), ...missing);
}

async function appendPlannedContent(destination, destinationExists, addition) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (destinationExists) {
    await fs.appendFile(destination, addition, "utf8");
    return;
  }

  try {
    await fs.writeFile(destination, addition.replace(/^\n+/, ""), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("The destination appeared after the preview. Preview the promotion again.");
    }
    throw error;
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

function markdownAddition({ before, summary, sourcePath, date }) {
  const leading = before ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  return `${leading}## Promoted evidence: ${date}\n\n${summary}\n\nSource: \`${sourcePath}\`\n`;
}

function renderDiff(destinationPath, addition, destinationType, destinationExists) {
  if (destinationType === "session-only") {
    return "No knowledge file will be written. The source remains captured session evidence.";
  }
  const addedLines = addition.replace(/^\n+/, "").replace(/\n$/, "").split("\n");
  return [
    `--- ${destinationExists ? destinationPath : "/dev/null"}`,
    `+++ ${destinationPath}`,
    "@@ append @@",
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

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function assertPromotionPlan(plan) {
  if (!plan || plan.version !== PROMOTION_PLAN_VERSION || !plan.aiosPath || !plan.source) {
    throw new Error("Invalid promotion plan. Preview the promotion again.");
  }
}
