import fs from "node:fs/promises";
import path from "node:path";
import { readSignals } from "./memory.mjs";
import { readSessionIndex } from "./sessions.mjs";

/**
 * Build a compact context digest for cross-agent handoff.
 * Returns a Markdown string any agent can read to get up to speed instantly.
 */
export async function buildSessionDigest(aiosPath, { project, limit = 3 } = {}) {
  const now = new Date();
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getTime() - 86400000));
  const threeDaysAgo = isoDate(new Date(now.getTime() - 3 * 86400000));

  const dailyDir = path.join(aiosPath, "memory", "daily");

  const [todayNote, yesterdayNote, signals, allSessions] = await Promise.all([
    readOrEmpty(path.join(dailyDir, `${today}.md`)),
    readOrEmpty(path.join(dailyDir, `${yesterday}.md`)),
    readSignals(path.join(aiosPath, "memory", "signals"), threeDaysAgo, today),
    readSessionIndex(aiosPath),
  ]);

  const focus = readDailySection(todayNote, "Focus");
  const plan = readDailySection(todayNote, "Plan");
  const carryOver = extractCarryOver(todayNote, yesterdayNote);

  const sessions = allSessions
    .filter((s) => !project || s.project === project)
    .sort((a, b) => scoreSession(b) - scoreSession(a))
    .slice(0, limit);

  const activeProject = project || inferActiveProject(allSessions);
  const recentSignals = signals.slice().reverse().slice(0, 8);

  return renderDigest({ today, focus, plan, carryOver, signals: recentSignals, sessions, activeProject });
}

function scoreSession(session) {
  const recency = session.captured_at ? new Date(session.captured_at).getTime() : 0;
  // Each stored access counts as +1 hour of recency boost for ranking
  const accessBoost = (session.access_count || 0) * 3_600_000;
  return recency + accessBoost;
}

function renderDigest({ today, focus, plan, carryOver, signals, sessions, activeProject }) {
  const lines = [`## Active Context · ${today}`, ""];

  const todayLines = [];
  if (focus) todayLines.push(`**Focus:** ${firstLine(focus)}`);
  if (plan) {
    for (const item of compactLines(plan).slice(0, 4)) {
      todayLines.push(`- ${item}`);
    }
  }
  if (todayLines.length > 0) {
    lines.push("### Today", ...todayLines, "");
  }

  if (carryOver.length > 0) {
    lines.push("### Carry-overs");
    for (const item of carryOver) lines.push(`- ${item}`);
    lines.push("");
  }

  if (signals.length > 0) {
    lines.push("### Recent Signals");
    for (const signal of signals) {
      const date = signal.ts?.slice(0, 10) || today;
      const summary = signal.summary || signal.note || "";
      if (summary) lines.push(`- [${date}] ${summary}`);
    }
    lines.push("");
  }

  if (sessions.length > 0) {
    lines.push("### Recent Sessions");
    for (const session of sessions) {
      const date = session.captured_at?.slice(0, 10) || "";
      const agent = session.agent || "unknown";
      const title = session.title || "(untitled)";
      const turns = session.turns || 0;
      const proj = session.project ? ` · ${session.project}` : "";
      lines.push(`- ${date} · ${agent}${proj} · "${title}" (${turns} turns)`);
    }
    lines.push("");
  }

  if (activeProject) {
    lines.push("### Active Project", `- ${activeProject}`, "");
  }

  return lines.join("\n").trimEnd();
}

function inferActiveProject(sessions) {
  const recent = sessions
    .slice()
    .sort((a, b) => (b.captured_at || "").localeCompare(a.captured_at || ""))
    .slice(0, 10);

  const counts = {};
  for (const s of recent) {
    if (s.project) counts[s.project] = (counts[s.project] || 0) + 1;
  }

  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function extractCarryOver(todayNote, yesterdayNote) {
  const todayPlan = readDailySection(todayNote, "Plan");
  const carriedLines = todayPlan
    .split("\n")
    .filter((l) => l.includes("Carried over from"))
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);

  const closeSection = readDailySection(yesterdayNote, "Close");
  const yesterdayCarry = readSubsection(closeSection, "Carry-over");

  return dedupe([...carriedLines, ...compactLines(yesterdayCarry)]).slice(0, 5);
}

function readDailySection(content, heading) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line.trim())) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

function readSubsection(content, heading) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (start === -1) return "";
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3} /.test(line.trim())) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

function compactLines(content) {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("<!--"))
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
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

function firstLine(content) {
  return content.split("\n").map((l) => l.trim()).find(Boolean) || "";
}

async function readOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
