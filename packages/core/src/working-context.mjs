import localFilesystem from "node:fs/promises";
import path from "node:path";

import { isoDate, readSignals as readMemorySignals } from "./memory.mjs";
import {
  ContainedReadError,
  createContainedReadBudget,
  createContainedReadFilesystem,
  inspectContainedFile,
  readContainedFile,
  sameContainedFileSnapshot
} from "./contained-read.mjs";
import { resolveMemoryPolicy } from "./memory-policy.mjs";
import { readProjectCatalog } from "./projects.mjs";
import { readSection, readSubsection } from "./sections.mjs";

export const DEFAULT_VISIBLE_CHARACTER_BUDGET = 6000;

const DEFAULT_SESSION_LIMIT = 3;
const MAX_DECISION_ITEMS = 3;
const MAX_PLAN_ITEMS = 4;
const MAX_CARRY_OVER_ITEMS = 5;
const MAX_SIGNAL_ITEMS = 8;
const MAX_EVENT_ITEMS = 8;
const MAX_HEADER_CHARS = 800;
const MAX_PROJECT_FILTER_CHARS = 200;
const MEBIBYTE = 1024 * 1024;
const MAX_PROJECTION_SOURCE_BYTES = 16 * MEBIBYTE;
const MAX_PROJECTION_SOURCE_FILES = 512;
const MAX_PROJECTION_DIRECTORY_ENTRIES = 10_000;
const MAX_MARKDOWN_SOURCE_BYTES = 1 * MEBIBYTE;
const MAX_DECISIONS_SOURCE_BYTES = 4 * MEBIBYTE;
const MAX_TIMELINE_SOURCE_BYTES = 8 * MEBIBYTE;
const MAX_SIGNAL_SOURCE_BYTES = 1 * MEBIBYTE;
const MAX_SIGNAL_DIRECTORY_ENTRIES = 8_192;
const MAX_SIGNAL_FILES = 64;
const MAX_PROJECT_DIRECTORY_ENTRIES = 256;
const MAX_PROJECT_README_BYTES = 1 * MEBIBYTE;

const localClock = () => new Date();

/**
 * Capture I/O dependencies once for consumers that build working context more
 * than once. Tests and embedders can supply an isolated filesystem and clock;
 * the filesystem must implement handle-bound open, incremental opendir, lstat,
 * readdir, and realpath with Node's fs/promises-compatible behavior.
 */
export function createWorkingContextProjection({
  filesystem = localFilesystem,
  clock = localClock,
} = {}) {
  const dependencies = { filesystem, clock };
  return Object.freeze({
    select: (aiosPath, options = {}) => selectWorkingContext(aiosPath, options, dependencies),
    render: (context) => renderWorkingContext(context),
    build: (aiosPath, options = {}) => buildWorkingContext(aiosPath, options, dependencies),
  });
}

/**
 * Build both the structured projection and its canonical text representation.
 */
export async function buildWorkingContext(aiosPath, options = {}, dependencies = {}) {
  const context = await selectWorkingContext(aiosPath, options, dependencies);
  return { context, rendered: renderWorkingContext(context) };
}

/**
 * Select one bounded, deterministic working-context projection from local AIOS
 * state. The project filter is applied identically to every timeline source.
 */
export async function selectWorkingContext(aiosPath, options = {}, dependencies = {}) {
  const memoryPolicy = resolveMemoryPolicy({
    mode: options.memory,
    project: options.project,
    firstUserMessage: options.firstUserMessage,
  });
  if (memoryPolicy.mode === "off") return selectOffWorkingContext(memoryPolicy);
  const { filesystem, clock } = resolveDependencies(dependencies);
  const now = readClock(clock);
  const today = isoDate(now);
  const yesterday = isoDate(previousLocalDay(now));
  const requestedProject = normalizeProject(memoryPolicy.projectSelector);
  const includesSharedSurfaces = memoryPolicy.mode === "shared";
  const sessionLimit = normalizeLimit(options.limit, DEFAULT_SESSION_LIMIT);
  const visibleCharacterBudget = normalizeBudget(options);
  const readBudget = createContainedReadBudget({
    maxBytes: MAX_PROJECTION_SOURCE_BYTES,
    maxFiles: MAX_PROJECTION_SOURCE_FILES,
    maxEntries: MAX_PROJECTION_DIRECTORY_ENTRIES
  });

  const dailyDir = path.join(aiosPath, "memory", "daily");
  const projectFilesystem = createContainedReadFilesystem(aiosPath, filesystem, {
    budget: readBudget,
    maxEntries: MAX_PROJECT_DIRECTORY_ENTRIES,
    maxFileBytes: MAX_PROJECT_README_BYTES,
    fileTooLargeCode: "DOTAIOS_CONTEXT_SOURCE_TOO_LARGE",
    tooManyCode: "DOTAIOS_PROJECT_DIRECTORY_LIMIT_EXCEEDED"
  });
  let sources;
  try {
    const authorityPath = path.join(aiosPath, "aios.json");
    const authorityBefore = await inspectContainedFile(aiosPath, authorityPath, { filesystem });
    if (authorityBefore === null) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
    sources = await Promise.all([
      includesSharedSurfaces
        ? readText(filesystem, path.join(aiosPath, "context", "identity.md"), aiosPath, readBudget, MAX_MARKDOWN_SOURCE_BYTES)
        : "",
      includesSharedSurfaces
        ? readText(filesystem, path.join(aiosPath, "context", "priorities.md"), aiosPath, readBudget, MAX_MARKDOWN_SOURCE_BYTES)
        : "",
      includesSharedSurfaces
        ? readText(filesystem, path.join(aiosPath, "decisions", "log.md"), aiosPath, readBudget, MAX_DECISIONS_SOURCE_BYTES)
        : "",
      includesSharedSurfaces
        ? readText(filesystem, path.join(dailyDir, `${today}.md`), aiosPath, readBudget, MAX_MARKDOWN_SOURCE_BYTES)
        : "",
      includesSharedSurfaces
        ? readText(filesystem, path.join(dailyDir, `${yesterday}.md`), aiosPath, readBudget, MAX_MARKDOWN_SOURCE_BYTES)
        : "",
      readJsonl(
        filesystem,
        path.join(aiosPath, "memory", "sessions", "index.jsonl"),
        aiosPath,
        readBudget,
        MAX_TIMELINE_SOURCE_BYTES
      ),
      readMemorySignals(
        path.join(aiosPath, "memory", "signals"),
        yesterday,
        today,
        {
          boundaryRoot: aiosPath,
          budget: readBudget,
          filesystem,
          maxDirectoryEntries: MAX_SIGNAL_DIRECTORY_ENTRIES,
          maxFileBytes: MAX_SIGNAL_SOURCE_BYTES,
          maxFiles: MAX_SIGNAL_FILES,
          quarantine: false,
          transform: (entry, { file, date, sourceLine }) => normalizeTimelineEntry(entry, {
            fallbackDate: date,
            sourcePath: path.posix.join("memory", "signals", file),
            sourceLine,
          }),
        },
      ),
      readTimelineJsonl(filesystem, path.join(aiosPath, "memory", "events.jsonl"), {
        boundaryRoot: aiosPath,
        budget: readBudget,
        maxBytes: MAX_TIMELINE_SOURCE_BYTES,
        sourcePath: "memory/events.jsonl",
      }),
      readProjectCatalog({ aiosPath, fs: projectFilesystem }),
    ]);
    const authorityAfter = await inspectContainedFile(aiosPath, authorityPath, { filesystem });
    if (!sameContainedFileSnapshot(authorityBefore, authorityAfter)) {
      throw new ContainedReadError("DOTAIOS_CONTEXT_SOURCE_CHANGED");
    }
  } catch (cause) {
    const error = new Error("DotAIOS could not read working context safely.", { cause });
    error.code = "DOTAIOS_WORKING_CONTEXT_READ_FAILED";
    throw error;
  }
  const [identity, priorities, decisionsLog, todayNote, yesterdayNote, sessionEntries, signalEntries, eventEntries, projects] = sources;

  const projectScope = resolveProjectScope(requestedProject, projects);
  const projectFilter = projectScope?.filter || null;
  const sessions = stableSessionOrder(sessionEntries)
    .filter((session) => matchesProject(session, projectScope, memoryPolicy.mode))
    .map((session) => markUnscoped(session, projectScope));
  const signals = stableTimelineOrder(signalEntries)
    .filter((signal) => isOperationalDate(signal.date, today, yesterday))
    .filter((signal) => matchesProject(signal, projectScope, memoryPolicy.mode))
    .filter(hasTimelineSummary)
    .map((signal) => markUnscoped(signal, projectScope));
  const events = stableTimelineOrder(eventEntries)
    .filter((event) => isOperationalDate(event.date, today, yesterday))
    .filter((event) => matchesProject(event, projectScope, memoryPolicy.mode))
    .filter(hasTimelineSummary)
    .map((event) => markUnscoped(event, projectScope));
  const deduped = dedupeUpdateChannels(signals, events);

  const candidates = {
    identity: compactHeader(stripMarkdownFrontmatter(identity)),
    priorities: compactHeader(stripMarkdownFrontmatter(priorities)),
    decisions: recentDecisions(decisionsLog, MAX_DECISION_ITEMS),
    today: {
      focus: firstLine(readSection(todayNote, "Focus")),
      plan: compactLines(readSection(todayNote, "Plan")).slice(0, MAX_PLAN_ITEMS),
    },
    carryOver: extractCarryOver(todayNote, yesterdayNote),
    activeProject: selectActiveProject(projectFilter, sessions, projects),
    sessions: sessions.slice(0, sessionLimit),
    signals: deduped.signals.slice(0, MAX_SIGNAL_ITEMS),
    events: deduped.events.slice(0, MAX_EVENT_ITEMS),
  };

  return applyVisibleCharacterBudget(
    {
      generatedAt: now.toISOString(),
      today,
      yesterday,
      memoryMode: memoryPolicy.mode,
      memoryReceipt: memoryPolicy.receipt,
      projectFilter,
    },
    candidates,
    visibleCharacterBudget,
  );
}

/**
 * Canonical renderer for a selected projection. Consumers should use this
 * instead of recreating section ordering or display rules.
 */
export function renderWorkingContext(context) {
  const rendered = renderUnbounded(context);
  const limit = context?.budget?.limit;
  if (!Number.isInteger(limit)) return rendered;
  if (context?.budget?.truncated) {
    return appendBudgetMarker(rendered, limit);
  }
  if (rendered.length <= limit) return rendered;
  return truncateVisible(rendered, limit);
}

function applyVisibleCharacterBudget(base, candidates, limit) {
  let selected = {
    ...base,
    identity: "",
    priorities: "",
    decisions: [],
    todayContext: { focus: "", plan: [] },
    carryOver: [],
    activeProject: null,
    sessions: [],
    signals: [],
    events: [],
  };
  let omittedForBudget = false;

  const consider = (candidate) => {
    if (renderUnbounded(candidate).length > limit) {
      omittedForBudget = true;
      return false;
    }
    selected = candidate;
    return true;
  };

  if (candidates.identity) consider({ ...selected, identity: candidates.identity });
  if (candidates.priorities) consider({ ...selected, priorities: candidates.priorities });
  if (candidates.decisions.length > 0) consider({ ...selected, decisions: candidates.decisions });

  if (base.projectFilter && candidates.activeProject) {
    consider({ ...selected, activeProject: candidates.activeProject });
  }

  if (candidates.today.focus) {
    consider({
      ...selected,
      todayContext: { ...selected.todayContext, focus: candidates.today.focus },
    });
  }

  for (const planItem of candidates.today.plan) {
    const accepted = consider({
      ...selected,
      todayContext: {
        ...selected.todayContext,
        plan: [...selected.todayContext.plan, planItem],
      },
    });
    if (!accepted) break;
  }

  for (const item of candidates.carryOver) {
    if (!consider({ ...selected, carryOver: [...selected.carryOver, item] })) break;
  }

  if (!base.projectFilter && candidates.activeProject) {
    consider({ ...selected, activeProject: candidates.activeProject });
  }

  for (const session of candidates.sessions) {
    if (!consider({ ...selected, sessions: [...selected.sessions, session] })) break;
  }

  for (const signal of candidates.signals) {
    if (!consider({ ...selected, signals: [...selected.signals, signal] })) break;
  }

  for (const event of candidates.events) {
    if (!consider({ ...selected, events: [...selected.events, event] })) break;
  }

  const unboundedLength = renderUnbounded(selected).length;
  const truncated = omittedForBudget || unboundedLength > limit;
  const provisional = {
    ...selected,
    budget: {
      limit,
      used: 0,
      remaining: limit,
      truncated,
    },
  };
  const used = renderWorkingContext(provisional).length;
  return {
    ...provisional,
    budget: {
      ...provisional.budget,
      used,
      remaining: Math.max(0, limit - used),
    },
  };
}

// decisions/log.md is append-only ("## <date> <title>" blocks), so the last
// blocks are the newest. Titles only — the projection is a pointer, not the log.
function recentDecisions(text, limit) {
  if (!text) return [];
  const blocks = String(text).split(/^## +/m).slice(1);
  return blocks
    .slice(-limit)
    .reverse()
    .map((block) => block.split("\n")[0].trim())
    .filter(Boolean);
}

function renderUnbounded(context) {
  if (context?.memoryMode === "off") {
    const receipt = typeof context.memoryReceipt === "string" ? context.memoryReceipt : "";
    const notice = typeof context.memoryNotice === "string" ? context.memoryNotice : "";
    return receipt && notice ? `${receipt}\n\n${notice}` : receipt || notice;
  }
  const today = context?.today || "";
  const todayContext = context?.todayContext || { focus: "", plan: [] };
  const carryOver = context?.carryOver || [];
  const sessions = context?.sessions || [];
  const signals = context?.signals || [];
  const events = context?.events || [];
  const fallbackReceipt = context?.memoryMode === "project"
    ? "Memory: This project"
    : context?.memoryMode === "shared"
      ? "Memory: Shared"
      : "";
  const receipt = typeof context?.memoryReceipt === "string"
    ? context.memoryReceipt
    : fallbackReceipt;
  const lines = [receipt, "", `## Active Context · ${today}`, ""];

  if (context?.identity) lines.push("### Identity", context.identity, "");
  if (context?.priorities) lines.push("### Priorities", context.priorities, "");
  if (context?.decisions?.length > 0) {
    lines.push("### Decisions", ...context.decisions.map((decision) => `- ${decision}`), "");
  }

  const todayLines = [];
  if (todayContext.focus) todayLines.push(`**Focus:** ${todayContext.focus}`);
  for (const item of todayContext.plan || []) todayLines.push(`- ${item}`);
  if (todayLines.length > 0) lines.push("### Today", ...todayLines, "");

  if (carryOver.length > 0) {
    lines.push("### Carry-overs", ...carryOver.map((item) => `- ${item}`), "");
  }

  if (context?.activeProject) {
    lines.push("### Active Project", ...renderProject(context.activeProject), "");
  }

  if (sessions.length > 0) {
    lines.push("### Recent Sessions");
    for (const session of sessions) {
      const date = String(session.captured_at || "").slice(0, 10);
      const agent = session.agent || "unknown";
      const project = session.project ? ` · ${session.project}` : "";
      const scope = session.unscoped ? " (unscoped)" : "";
      const title = session.title || "(untitled)";
      const turns = Number.isInteger(session.turns) ? session.turns : 0;
      lines.push(`- ${date} · ${agent}${project}${scope} · "${title}" (${turns} turns)`);
    }
    lines.push("");
  }

  if (signals.length > 0) {
    lines.push("### Recent Signals");
    for (const signal of signals) {
      lines.push(`- [${signal.date || today}]${signal.unscoped ? " (unscoped)" : ""} ${timelineSummary(signal)}`);
    }
    lines.push("");
  }

  if (events.length > 0) {
    lines.push("### Recent Events");
    for (const event of events) {
      lines.push(`- [${event.date || today}]${event.unscoped ? " (unscoped)" : ""} ${timelineSummary(event)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function selectOffWorkingContext(memoryPolicy) {
  const context = {
    generatedAt: null,
    today: "",
    yesterday: "",
    memoryMode: memoryPolicy.mode,
    memoryReceipt: memoryPolicy.receipt,
    memoryNotice: memoryPolicy.notice,
    projectFilter: null,
    identity: "",
    priorities: "",
    decisions: [],
    todayContext: { focus: "", plan: [] },
    carryOver: [],
    activeProject: null,
    sessions: [],
    signals: [],
    events: [],
  };
  const used = renderWorkingContext(context).length;
  return {
    ...context,
    budget: { limit: used, used, remaining: 0, truncated: false },
  };
}

function renderProject(project) {
  const name = project.name || project.project || project.slug;
  const details = [project.status, ...(project.domains || [])].filter(Boolean);
  const lines = [`- ${name}${details.length > 0 ? ` · ${details.join(" · ")}` : ""}`];
  if (project.description) lines.push(`  ${project.description}`);
  if (project.contextExcerpt && project.contextExcerpt !== project.description) {
    lines.push(...project.contextExcerpt.split(/\r?\n/).map((line) => line ? `> ${line}` : ">"));
  }
  return lines;
}

function timelineSummary(entry) {
  return String(entry.summary || entry.note || entry.type || "").trim();
}

function hasTimelineSummary(entry) {
  return timelineSummary(entry).length > 0;
}

function extractCarryOver(todayNote, yesterdayNote) {
  const todayPlan = readSection(todayNote, "Plan");
  const carriedLines = todayPlan
    .split(/\r?\n/)
    .filter((line) => line.includes("Carried over from"))
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  const yesterdayClose = readSection(yesterdayNote, "Close");
  const yesterdayCarry = readSubsection(yesterdayClose, "Carry-over");
  return dedupe([...carriedLines, ...compactLines(yesterdayCarry)]).slice(0, MAX_CARRY_OVER_ITEMS);
}

function compactLines(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"))
    .map((line) => line.replace(/^- \[[ x]\]\s*/i, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function compactHeader(content) {
  const visible = String(content || "").trim();
  if (!visible) return "";
  return visible.length > MAX_HEADER_CHARS
    ? `${visible.slice(0, MAX_HEADER_CHARS - 1).trimEnd()}…`
    : visible;
}

function stripMarkdownFrontmatter(content) {
  const source = String(content || "");
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return source;
  const lines = source.split(/\r?\n/);
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return closing === -1 ? source : lines.slice(closing + 1).join("\n").replace(/^\n+/, "");
}

function firstLine(content) {
  return String(content || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableSessionOrder(sessions) {
  return sessions.slice().sort((left, right) => {
    const scoreDifference = sessionScore(right) - sessionScore(left);
    if (scoreDifference !== 0) return scoreDifference;
    const capturedDifference = String(right.captured_at || "").localeCompare(String(left.captured_at || ""));
    if (capturedDifference !== 0) return capturedDifference;
    return stableKey(left).localeCompare(stableKey(right));
  });
}

function sessionScore(session) {
  const capturedAt = Date.parse(session.captured_at || "");
  return Number.isFinite(capturedAt) ? capturedAt : 0;
}

function stableTimelineOrder(entries) {
  return entries.slice().sort((left, right) => {
    const timestampDifference = String(right.timestamp || "").localeCompare(String(left.timestamp || ""));
    if (timestampDifference !== 0) return timestampDifference;
    return stableKey(left).localeCompare(stableKey(right));
  });
}

function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeTimelineEntry(entry, {
  fallbackDate = null,
  sourcePath = null,
  sourceLine = null,
} = {}) {
  const timestamp = typeof entry?.ts === "string" ? entry.ts : "";
  return {
    ...(entry && typeof entry === "object" ? entry : {}),
    date: timestamp.slice(0, 10) || fallbackDate,
    timestamp: timestamp || `${fallbackDate || ""}T00:00:00`,
    ...(sourcePath ? { sourcePath, sourceLine } : {}),
  };
}

/**
 * Project filter for operational timeline rows.
 * This project memory admits only explicitly attributed rows. Every present
 * attribution field must agree with the selected catalog identity. Unscoped,
 * malformed, conflicting, and differently attributed rows fail closed.
 */
function matchesProject(entry, projectScope, memoryMode = "shared") {
  if (!projectScope) return true;
  const project = readProjectAttribution(entry, "project");
  const projectId = readProjectAttribution(entry, "project_id");
  if (!project.present && !projectId.present) return memoryMode !== "project";
  if (!project.valid || !projectId.valid) return false;
  if (project.present && !projectScope.aliases.has(project.value)) return false;
  if (projectId.present && projectId.value !== projectScope.id) return false;
  if (project.present && !projectScope.uniqueAliases.has(project.value) && !projectId.present) return false;
  return true;
}

function markUnscoped(entry, projectScope) {
  return projectScope && isGloballyAttributed(entry) ? { ...entry, unscoped: true } : entry;
}

function readProjectAttribution(entry, key) {
  const value = entry?.[key];
  if (value === undefined || value === null) return { present: false, valid: true, value: null };
  const valid = typeof value === "string" && value.length > 0 && value.trim() === value;
  return { present: true, valid, value: valid ? value : null };
}

function isGloballyAttributed(entry) {
  return !readProjectAttribution(entry, "project").present
    && !readProjectAttribution(entry, "project_id").present;
}

function dedupeUpdateChannels(signals, events) {
  const updateKeys = new Set(
    events
      .filter((event) => event.type === "update" && event.source === "dotaios update")
      .map(timelineKey)
  );
  return {
    signals: signals.filter((signal) => !(
      signal.type === "update" &&
      signal.source === "dotaios update" &&
      updateKeys.has(timelineKey(signal))
    )),
    events
  };
}

function timelineKey(entry) {
  return [entry.type, entry.source, entry.project || "", entry.project_id || "", timelineSummary(entry)].join("\n");
}

function resolveProjectScope(reference, projects) {
  if (!reference) return null;
  const matches = projects.filter((project) =>
    project.id === reference || project.slug === reference || project.project === reference);
  if (matches.length > 1) {
    const error = new TypeError(`Project reference "${reference}" is ambiguous. Use its stable id.`);
    error.code = "DOTAIOS_AMBIGUOUS_PROJECT";
    throw error;
  }
  if (matches.length === 0) {
    const error = new TypeError("Project selector is unknown.");
    error.code = "DOTAIOS_PROJECT_SELECTOR_UNKNOWN";
    throw error;
  }
  const selected = matches[0];
  const filter = selected.slug;
  const aliases = projectAliases(selected);
  const uniqueAliases = new Set(
    [...aliases].filter((alias) => projects.filter((project) => projectAliases(project).has(alias)).length === 1)
  );
  const selectedId = typeof selected?.id === "string" && selected.id.length > 0 ? selected.id : null;
  const id = selectedId && projects.filter((project) => project.id === selectedId).length === 1
    ? selectedId
    : null;
  return {
    aliases,
    filter,
    id,
    uniqueAliases,
  };
}

function projectAliases(project) {
  return new Set(
    [project?.slug, project?.project, project?.id]
      .filter((value) => typeof value === "string" && value.length > 0)
  );
}

function isOperationalDate(date, today, yesterday) {
  return date === today || date === yesterday;
}

function selectActiveProject(projectFilter, sessions, projects) {
  if (projectFilter) {
    return projects.find((project) => project.slug === projectFilter || project.project === projectFilter)
      || syntheticProject(projectFilter);
  }

  const inferred = inferActiveProject(sessions);
  if (inferred) {
    return projects.find((project) => project.slug === inferred || project.project === inferred)
      || syntheticProject(inferred);
  }

  return projects.find((project) => project.status === "active") || null;
}

function inferActiveProject(sessions) {
  const projectStats = new Map();
  for (const session of sessions) {
    if (!session.project) continue;
    const current = projectStats.get(session.project) || { count: 0, latest: "" };
    projectStats.set(session.project, {
      count: current.count + 1,
      latest: String(session.captured_at || "") > current.latest
        ? String(session.captured_at || "")
        : current.latest,
    });
  }
  return [...projectStats.entries()]
    .sort(([leftProject, left], [rightProject, right]) =>
      right.latest.localeCompare(left.latest)
      || right.count - left.count
      || leftProject.localeCompare(rightProject))
    .map(([project]) => project)[0] || null;
}

function syntheticProject(project) {
  return {
    id: null,
    slug: project,
    project,
    name: project,
    status: null,
    domains: [],
    repoUrl: null,
    description: "",
    contextExcerpt: "",
    readme: "",
  };
}

async function readJsonl(filesystem, filePath, boundaryRoot, budget, maxBytes) {
  const content = await readText(filesystem, filePath, boundaryRoot, budget, maxBytes);
  return content.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === "object" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

async function readTimelineJsonl(filesystem, filePath, {
  boundaryRoot,
  budget,
  fallbackDate = null,
  maxBytes,
  sourcePath
} = {}) {
  const content = await readText(filesystem, filePath, boundaryRoot, budget, maxBytes);
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") return [];
      return [normalizeTimelineEntry(parsed, {
        fallbackDate,
        sourcePath,
        sourceLine: index + 1,
      })];
    } catch {
      return [];
    }
  });
}

async function readText(filesystem, filePath, boundaryRoot, budget, maxBytes) {
  const content = await readContainedFile(boundaryRoot, filePath, {
    budget,
    filesystem,
    encoding: "utf8",
    maxBytes
  });
  return content === null ? "" : content;
}

function resolveDependencies(dependencies) {
  return {
    filesystem: dependencies.filesystem || dependencies.fs || localFilesystem,
    clock: dependencies.clock || dependencies.now || localClock,
  };
}

function readClock(clock) {
  const value = typeof clock === "function" ? clock() : clock.now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Working-context clock returned an invalid date");
  return date;
}

function normalizeProject(project) {
  if (project === undefined || project === null) return null;
  if (typeof project !== "string") {
    throw new TypeError("Working-context project filter must be a string");
  }
  if (Array.from(project).length > MAX_PROJECT_FILTER_CHARS) {
    throw new TypeError(`Working-context project filter must be at most ${MAX_PROJECT_FILTER_CHARS} characters`);
  }
  if (/\p{Cc}/u.test(project)) {
    throw new TypeError("Working-context project filter must be a project slug or stable id");
  }
  const value = project.trim();
  if (!value) throw new TypeError("Working-context project filter must not be blank");
  return value;
}

function normalizeLimit(limit, fallback) {
  if (limit === undefined) return fallback;
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Working-context limit must be non-negative");
  return Math.floor(value);
}

function normalizeBudget(options) {
  const requested = options.visibleCharacterBudget ?? DEFAULT_VISIBLE_CHARACTER_BUDGET;
  const value = Number(requested);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("Working-context visible character budget must be non-negative");
  }
  return Math.floor(value);
}

function previousLocalDay(date) {
  const previous = new Date(date.getTime());
  previous.setDate(previous.getDate() - 1);
  return previous;
}

function truncateVisible(content, limit) {
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${content.slice(0, limit - 1).trimEnd()}…`;
}

function appendBudgetMarker(content, limit) {
  const marker = "\n\n[context budget reached]";
  if (limit <= marker.length) return truncateVisible(marker.trimStart(), limit);
  const available = limit - marker.length;
  return `${content.slice(0, available).trimEnd()}${marker}`;
}
