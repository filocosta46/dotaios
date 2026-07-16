import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { readJsonl, RECENT_EVENT_LIMIT, SIGNAL_RETENTION_DAYS, isoDate } from "./memory.mjs";
import { selectWorkingContext } from "./working-context.mjs";

const DEFAULT_LINE_BUDGET = 200;
const MAX_QUEUE_CANDIDATES = 25;
const localClock = () => new Date();

const HOT_MEMORY_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "context/identity.md",
  "context/work.md",
  "context/priorities.md",
  "context/north-star.md",
  "memory/profile.md",
  "skills/INDEX.md",
  "skills/RESOLVER.md"
];

const SKILL_PATCH_RE = /\b(skill[- ]?patch|patch(?:ed|ing)?\s+(?:the\s+)?[a-z0-9-]+\s+skill|into\s+(?:the\s+)?[a-z0-9-]+\s+skill|SKILL\.md)\b/i;
const LESSON_RE = /\b(lesson|learned|pitfall|failure mode|next time|should|must|requires?|avoid|prefer|use|patched|improvement)\b/i;
const CROSS_CUTTING_RE = /\b(always|never|canonical|rule|policy|decision|scar tissue|safety rail|applies across|cross[- ]cutting)\b/i;
const FINISHED_WORK_RE = /\b(shipped|completed|finished|done|closed|fixed|resolved|tests? passed|build succeeded|ingested|saved at)\b/i;
const EMPTY_QUEUE_MARKER = "_No new skill-tied memory entries found._";
const FIELD_NOTES_HEADING = "## Field Notes";
const FIELD_NOTE_ID_PREFIX = "dotaios-memory-audit:id=";

export async function auditMemory(aiosPath, {
  lineBudget = DEFAULT_LINE_BUDGET,
  maxQueueCandidates = MAX_QUEUE_CANDIDATES,
  memoryScope = "hot",
  clock = localClock
} = {}) {
  const now = readClockDate(clock);
  const [hotFiles, memoryEntries] = await Promise.all([
    auditHotFiles(aiosPath, lineBudget),
    readMemoryEntries(aiosPath, { scope: memoryScope, now })
  ]);

  const entryAudit = classifyMemoryEntries(memoryEntries, maxQueueCandidates);
  const findings = [
    ...hotFiles.findings,
    ...entryAudit.findings,
    ...await auditSignalFiles(aiosPath, now)
  ];

  return {
    lineBudget,
    hotFiles: hotFiles.files,
    summary: {
      hotFileCount: hotFiles.files.length,
      hotFileLines: hotFiles.files.reduce((sum, file) => sum + file.lines, 0),
      hotFileWords: hotFiles.files.reduce((sum, file) => sum + file.words, 0),
      hotFileApproxTokens: hotFiles.files.reduce((sum, file) => sum + file.approxTokens, 0),
      memoryEntriesScanned: memoryEntries.length,
      findings: findings.length,
      skillPatchCandidates: entryAudit.skillPatchCandidateTotal,
      skillPatchCandidatesShown: entryAudit.skillPatchCandidates.length,
      skillPatchCandidatesTruncated: entryAudit.skillPatchCandidatesTruncated,
      archiveCandidates: entryAudit.archiveCandidates.length,
      crossCuttingCandidates: entryAudit.crossCuttingCandidates.length
    },
    skillPatchCandidates: entryAudit.skillPatchCandidates,
    archiveCandidates: entryAudit.archiveCandidates,
    crossCuttingCandidates: entryAudit.crossCuttingCandidates,
    findings
  };
}

export function renderMemoryAudit(report) {
  const lines = [
    "DotAIOS memory audit",
    "",
    `Hot files: ${report.summary.hotFileCount} file(s), ${report.summary.hotFileLines} line(s), about ${report.summary.hotFileApproxTokens} token(s), ${report.lineBudget} line budget per file.`,
    `Memory entries scanned: ${report.summary.memoryEntriesScanned}`,
    `Skill patch candidates: ${report.summary.skillPatchCandidates}${report.summary.skillPatchCandidatesTruncated ? ` (${report.summary.skillPatchCandidatesShown} shown)` : ""}`,
    `Archive candidates: ${report.summary.archiveCandidates}`,
    `Cross-cutting candidates: ${report.summary.crossCuttingCandidates}`,
    ""
  ];

  if (report.findings.length === 0) {
    lines.push("No findings. Hot memory looks lean.");
  } else {
    lines.push("Findings:");
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.path || finding.source}: ${finding.message}`);
      if (finding.recommendation) lines.push(`  Fix: ${finding.recommendation}`);
    }
  }

  if (report.skillPatchCandidates.length > 0) {
    lines.push("", "Top skill patch candidates:");
    for (const candidate of report.skillPatchCandidates.slice(0, 5)) {
      lines.push(`- ${candidate.skill}: ${candidate.summary} (${candidate.source})`);
    }
  }

  return lines.join("\n");
}

export function renderSkillPatchQueue(report, { generatedAt = new Date(), previousContent = "" } = {}) {
  const existingItems = readExistingQueueItems(previousContent);
  const candidates = report.skillPatchCandidates.filter((candidate) => !isExistingQueueCandidate(existingItems, candidate));

  if (previousContent.trim()) {
    if (candidates.length === 0) return ensureTrailingNewline(previousContent);
    const baseContent = removeEmptyQueueMarker(previousContent);
    const startIndex = countExistingQueueItems(previousContent) + 1;
    return `${baseContent.trimEnd()}\n\n${renderCandidateSections(candidates, startIndex)}`;
  }

  const date = generatedAt.toISOString();
  const lines = [
    "# Skill Patch Queue",
    "",
    `Generated by \`dotaios memory audit\` on ${date}.`,
    "",
    "These are memory entries that look tied to one reusable workflow. Review each item, then patch the skill or draft a new one. Do not auto-create paid or durable skills without user approval.",
    ""
  ];

  if (candidates.length === 0) {
    lines.push(EMPTY_QUEUE_MARKER, "");
  } else {
    lines.push(renderCandidateSections(candidates, 1));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeSkillPatchQueue(aiosPath, report, { generatedAt = new Date() } = {}) {
  const queuePath = path.join(aiosPath, "memory", "skill-patches", "queue.md");
  let previousContent = "";
  try {
    previousContent = await fs.readFile(queuePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const content = renderSkillPatchQueue(report, { generatedAt, previousContent });
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, content, "utf8");
  const existingItems = readExistingQueueItems(previousContent);
  const added = report.skillPatchCandidates.filter((candidate) => !isExistingQueueCandidate(existingItems, candidate)).length;
  return {
    path: queuePath,
    count: added,
    shown: report.skillPatchCandidates.length,
    total: report.summary.skillPatchCandidates,
    truncated: report.summary.skillPatchCandidatesTruncated
  };
}

export async function applySkillPatchCandidates(aiosPath, report) {
  const results = [];

  for (const candidate of report.skillPatchCandidates) {
    if (candidate.skill === "needs-routing") {
      results.push({ candidate: candidate.id, skill: candidate.skill, status: "skipped", reason: "needs-routing" });
      continue;
    }
    if (!candidate.safeToApply) {
      results.push({ candidate: candidate.id, skill: candidate.skill, status: "skipped", reason: "review-only" });
      continue;
    }

    const skillPath = path.join(aiosPath, "skills", candidate.skill, "SKILL.md");
    let content;
    try {
      content = await fs.readFile(skillPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        results.push({ candidate: candidate.id, skill: candidate.skill, status: "skipped", reason: "missing-skill", path: skillPath });
        continue;
      }
      throw error;
    }

    const nextContent = appendFieldNote(content, candidate);
    if (nextContent === content) {
      results.push({ candidate: candidate.id, skill: candidate.skill, status: "unchanged", path: skillPath });
      continue;
    }

    await fs.writeFile(skillPath, nextContent, "utf8");
    results.push({ candidate: candidate.id, skill: candidate.skill, status: "applied", path: skillPath });
  }

  return {
    applied: results.filter((result) => result.status === "applied").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    results
  };
}

async function auditHotFiles(aiosPath, lineBudget) {
  const files = [];
  const findings = [];

  for (const relativePath of HOT_MEMORY_FILES) {
    const filePath = path.join(aiosPath, relativePath);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    const lines = countLines(content);
    const words = countWords(content);
    const bytes = Buffer.byteLength(content, "utf8");
    const approxTokens = Math.ceil(words * 1.3);
    files.push({ path: relativePath, lines, words, bytes, approxTokens });

    if (lines > lineBudget) {
      findings.push({
        severity: lines > lineBudget * 1.5 ? "fail" : "warn",
        code: "hot-file-over-budget",
        path: relativePath,
        message: `${lines} lines exceeds the ${lineBudget} line hot-memory budget.`,
        recommendation: "Move inferable detail to the repo, route long-lived knowledge to vault, and move workflow lessons into skills."
      });
    }
  }

  return { files, findings };
}

async function readMemoryEntries(aiosPath, { scope = "hot", now } = {}) {
  if (scope !== "all") {
    const context = await selectWorkingContext(aiosPath, {}, {
      clock: () => new Date(now.getTime())
    });
    return [...context.events, ...context.signals].map((entry) => ({
      source: projectedMemorySource(entry),
      entry
    }));
  }

  const entries = [];
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  const allEvents = await readJsonl(eventsPath);
  allEvents.forEach((entry, index) => entries.push({
    source: `memory/events.jsonl#${index + 1}`,
    entry
  }));

  const signalsDir = path.join(aiosPath, "memory", "signals");
  let signalFiles;
  try {
    signalFiles = (await fs.readdir(signalsDir)).filter((file) => file.endsWith(".jsonl")).sort();
  } catch {
    signalFiles = [];
  }

  for (const file of signalFiles) {
    const fileEntries = await readJsonl(path.join(signalsDir, file));
    fileEntries.forEach((entry, index) => entries.push({
      source: `memory/signals/${file}#${index + 1}`,
      entry
    }));
  }

  return entries;
}

function projectedMemorySource(entry) {
  const sourcePath = typeof entry.sourcePath === "string" && entry.sourcePath
    ? entry.sourcePath
    : "memory";
  return Number.isInteger(entry.sourceLine)
    ? `${sourcePath}#${entry.sourceLine}`
    : sourcePath;
}

function classifyMemoryEntries(memoryEntries, maxQueueCandidates) {
  const allSkillPatchCandidates = [];
  const archiveCandidates = [];
  const crossCuttingCandidates = [];
  const findings = [];

  for (const item of memoryEntries) {
    const text = entryText(item.entry);
    if (!text) continue;

    const skill = inferSkill(item.entry, text);
    const isSkillPatch = isSkillPatchEntry(item.entry, text);
    const isLessonLike = isLessonLikeEntry(item.entry, text);
    const isCrossCutting = CROSS_CUTTING_RE.test(text);
    const isFinished = FINISHED_WORK_RE.test(text) && !isCrossCutting && !isSkillPatch;

    if (isSkillPatch || isLessonLike) {
      allSkillPatchCandidates.push({
        id: stableCandidateId(item.entry, text),
        source: item.source,
        ts: item.entry.ts,
        skill: skill || "needs-routing",
        summary: summarize(text),
        safeToApply: Boolean(skill && (isExplicitSkillPatchDecision(item.entry) || isLessonLike)),
        rationale: skill
          ? `This memory names or implies the ${skill} skill and should live with that workflow.`
          : "This memory looks skill-tied but does not name a clear skill yet.",
        entry: item.entry
      });
      continue;
    }

    if (isFinished) {
      archiveCandidates.push({
        source: item.source,
        ts: item.entry.ts,
        summary: summarize(text),
        rationale: "Finished-work records belong in git, artifacts, or archives rather than active memory."
      });
      continue;
    }

    if (isCrossCutting) {
      crossCuttingCandidates.push({
        source: item.source,
        ts: item.entry.ts,
        summary: summarize(text),
        rationale: "This may be legitimate hot memory because it changes decisions across workflows."
      });
    }
  }

  if (archiveCandidates.length > RECENT_EVENT_LIMIT) {
    findings.push({
      severity: "info",
      code: "many-archive-candidates",
      source: "memory/events.jsonl",
      message: `${archiveCandidates.length} finished-work entries look archival.`,
      recommendation: "Run `dotaios cleanup` and keep finished-work detail in git history or saved artifacts."
    });
  }

  const skillPatchCandidates = allSkillPatchCandidates.slice(0, maxQueueCandidates);
  if (allSkillPatchCandidates.length > skillPatchCandidates.length) {
    findings.push({
      severity: "info",
      code: "skill-patch-candidates-truncated",
      source: "memory",
      message: `${allSkillPatchCandidates.length} skill patch candidate(s) matched; showing ${skillPatchCandidates.length}.`,
      recommendation: "Run with a higher queue limit in code, or review JSON output before writing a queue."
    });
  }

  return {
    skillPatchCandidates,
    skillPatchCandidateTotal: allSkillPatchCandidates.length,
    skillPatchCandidatesTruncated: allSkillPatchCandidates.length > skillPatchCandidates.length,
    archiveCandidates,
    crossCuttingCandidates,
    findings
  };
}

async function auditSignalFiles(aiosPath, now) {
  const signalsDir = path.join(aiosPath, "memory", "signals");
  let signalFiles;
  try {
    signalFiles = (await fs.readdir(signalsDir)).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const cutoffDate = new Date(now.getTime());
  cutoffDate.setDate(cutoffDate.getDate() - SIGNAL_RETENTION_DAYS);
  const cutoff = isoDate(cutoffDate);
  const stale = signalFiles.filter((file) => signalDate(file) < cutoff);
  if (stale.length === 0) return [];

  return [{
    severity: "info",
    code: "stale-signals",
    source: "memory/signals",
    message: `${stale.length} signal file(s) are older than ${SIGNAL_RETENTION_DAYS} days.`,
    recommendation: "Run `dotaios cleanup` to trim stale signals."
  }];
}

function isSkillPatchEntry(entry, text) {
  const decision = String(entry.memory_decision || entry.disposition || entry.kind || "").toLowerCase();
  return decision.includes("skill") || SKILL_PATCH_RE.test(text);
}

function isExplicitSkillPatchDecision(entry) {
  const fields = [entry.memory_decision, entry.disposition, entry.kind]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return fields.some((value) => /\bskill[- ]patch\b/.test(value));
}

function isLessonLikeEntry(entry, text) {
  const decision = String(entry.memory_decision || "").toLowerCase();
  if (decision === "signal-only") return false;
  if (entry.learned || entry.failed || entry.improvement) return true;
  return LESSON_RE.test(text) && Boolean(entry.type === "lesson" || entry.kind === "lesson");
}

function inferSkill(entry, text) {
  const explicit = entry.skill || entry.skill_slug || entry.skillName || entry.workflow;
  if (explicit) return slugify(explicit);

  const patterns = [
    /\bskills\/([a-z0-9-]+)\/SKILL\.md\b/i,
    /\b(?:patch|patched|patching|update|updated|updating)\s+(?:the\s+)?([a-z0-9][a-z0-9-]{1,60})\s+skill\b/i,
    /\bskill[:=]\s*([a-z0-9][a-z0-9-]{1,60})\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return slugify(match[1]);
  }

  return null;
}

function entryText(entry) {
  const parts = [
    entry.summary,
    entry.note,
    entry.learned,
    entry.failed,
    entry.improvement,
    entry.actions_taken,
    entry.details
  ];
  return parts.flatMap(flattenText).join(" ").replace(/\s+/g, " ").trim();
}

function flattenText(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (typeof value === "object") return Object.values(value).flatMap(flattenText);
  return [String(value)];
}

function summarize(text, max = 220) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function stableCandidateId(entry, text) {
  const explicitId = entry.id || entry.event_id || entry.session_id || entry.run_id || "";
  const stableParts = [
    explicitId,
    entry.ts || "",
    entry.skill || entry.skill_slug || entry.skillName || entry.workflow || "",
    text
  ];
  return crypto.createHash("sha256").update(stableParts.join("\n")).digest("hex").slice(0, 16);
}

function slugify(value) {
  return String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "needs-routing";
}

function countLines(content) {
  if (!content) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function countWords(content) {
  return content.trim() ? content.trim().split(/\s+/).length : 0;
}

function readClockDate(clock) {
  const value = typeof clock === "function"
    ? clock()
    : typeof clock?.now === "function"
      ? clock.now()
      : clock;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Memory-audit clock returned an invalid date");
  return date;
}

function signalDate(file) {
  const match = file.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return match ? match[1] : file.replace(".jsonl", "");
}

function readExistingQueueItems(content) {
  const ids = new Set();
  for (const match of content.matchAll(/^- ID: `([^`]+)`/gm)) {
    ids.add(match[1]);
  }
  for (const match of content.matchAll(/^- Source: `([^`]+)`/gm)) {
    ids.add(match[1]);
  }
  return ids;
}

function isExistingQueueCandidate(existingItems, candidate) {
  return existingItems.has(candidate.id) || existingItems.has(candidate.source);
}

function countExistingQueueItems(content) {
  return [...content.matchAll(/^## \d+\./gm)].length;
}

function renderCandidateSections(candidates, startIndex) {
  const lines = [];
  candidates.forEach((candidate, index) => {
    lines.push(`## ${startIndex + index}. ${candidate.skill}`);
    lines.push("");
    lines.push(`- ID: \`${candidate.id}\``);
    lines.push(`- Source: \`${candidate.source}\``);
    if (candidate.ts) lines.push(`- Date: ${candidate.ts}`);
    lines.push(`- Why queued: ${candidate.rationale}`);
    lines.push(`- Memory: ${candidate.summary}`);
    if (candidate.skill === "needs-routing") {
      lines.push("- Suggested patch: Route this to an existing skill, or use `skillify` to draft a new skill before saving it.");
    } else {
      lines.push(`- Suggested patch: Update \`skills/${candidate.skill}/SKILL.md\` or route this into a new skill draft if no matching skill exists.`);
    }
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function removeEmptyQueueMarker(content) {
  return content
    .replace(new RegExp(`\\n*${escapeRegExp(EMPTY_QUEUE_MARKER)}\\n*$`), "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function appendFieldNote(content, candidate) {
  if (content.includes(`${FIELD_NOTE_ID_PREFIX}${candidate.id}`)) return content;

  const note = renderFieldNote(candidate);
  if (!new RegExp(`^${escapeRegExp(FIELD_NOTES_HEADING)}\\s*$`, "m").test(content)) {
    return `${content.trimEnd()}\n\n${FIELD_NOTES_HEADING}\n\n${note}\n`;
  }

  const headingMatch = content.match(new RegExp(`^${escapeRegExp(FIELD_NOTES_HEADING)}\\s*$`, "m"));
  const searchStart = headingMatch.index + headingMatch[0].length;
  const nextHeadingIndex = content.slice(searchStart).search(/\n## /);
  if (nextHeadingIndex === -1) {
    return `${content.trimEnd()}\n${note}\n`;
  }

  const insertAt = searchStart + nextHeadingIndex;
  return `${content.slice(0, insertAt).trimEnd()}\n${note}\n${content.slice(insertAt)}`;
}

function renderFieldNote(candidate) {
  const date = candidate.ts ? candidate.ts.slice(0, 10) : "undated";
  return [
    `<!-- ${FIELD_NOTE_ID_PREFIX}${candidate.id} -->`,
    `- ${date} from \`${candidate.source}\`: ${candidate.summary}`
  ].join("\n");
}

function ensureTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
