import fs from "node:fs/promises";
import path from "node:path";
import { isoDate, readSignals } from "./memory.mjs";
import { readSection, readSubsection } from "./sections.mjs";
import { readSessionIndex } from "./sessions.mjs";

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

  const focus = readSection(todayNote, "Focus");
  const plan = readSection(todayNote, "Plan");
  const carryOver = extractCarryOver(todayNote, yesterdayNote);

  const sessions = allSessions
    .filter((s) => !project || s.project === project)
    .sort((a, b) => scoreSession(b) - scoreSession(a))
    .slice(0, limit);

  const activeProject = project || inferActiveProject(allSessions);
  const recentSignals = [...signals].reverse().slice(0, 8);

  const digest = renderDigest({ today, focus, plan, carryOver, signals: recentSignals, sessions, activeProject });
  const sessionIds = sessions.map((s) => s.session_id).filter(Boolean);
  return { digest, sessionIds };
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
  const latest = {};
  const counts = {};
  for (const s of sessions) {
    if (!s.project) continue;
    counts[s.project] = (counts[s.project] || 0) + 1;
    const ts = s.captured_at || "";
    if (!latest[s.project] || ts > latest[s.project]) latest[s.project] = ts;
  }
  return Object.keys(latest).sort((a, b) =>
    latest[b].localeCompare(latest[a]) || counts[b] - counts[a]
  )[0] || null;
}

function extractCarryOver(todayNote, yesterdayNote) {
  const todayPlan = readSection(todayNote, "Plan");
  const carriedLines = todayPlan
    .split("\n")
    .filter((l) => l.includes("Carried over from"))
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);

  const closeSection = readSection(yesterdayNote, "Close");
  const yesterdayCarry = readSubsection(closeSection, "Carry-over");

  return dedupe([...carriedLines, ...compactLines(yesterdayCarry)]).slice(0, 5);
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
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}
