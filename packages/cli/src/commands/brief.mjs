import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent, isoDate } from "../../../core/src/memory.mjs";
import { resolveMemoryPolicy } from "../../../core/src/memory-policy.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { resolveProjectContext } from "../../../core/src/projects.mjs";
import { readSection, replaceSection } from "../../../core/src/sections.mjs";
import { selectWorkingContext } from "../../../core/src/working-context.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { buildWorkingContextEnvelope } from "../../../core/src/working-context-envelope.mjs";
import { readGeminiHookInput, resolveGeminiHookRequest } from "../lib/gemini-memory-hook.mjs";

const HELP_TEXT = `Usage:
  dotaios brief [daily] [options]

Writes today's brief into memory/daily/YYYY-MM-DD.md as a ## Brief section.
The brief is deterministic: priorities, open loops, and carry-over. No AI or
external services required.

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --dry-run     Print the brief without writing the daily note
  --compact     Print the canonical working-context projection (no file write)
  --memory <mode>  With --compact: shared, project, or off. A project selector
                   implies project mode; project mode requires --project.
  --project <slug-or-id>  With --compact: include only continuity for this project.
                          Must be nonblank, contain no control characters, and
                          be at most 200 Unicode code points.
  --budget <n>    With --compact: projection character budget (default 6000;
                  a fixed operational notice may appear before the projection)
  --lean        Print a small high-signal surface to stdout: identity, priorities,
                north-star, today's daily note, and the first active project
                README. The rest of memory/ stays opt-in. No file write.
  --json        With --compact: wrap output as Gemini CLI hook JSON
  --first-message <text>  With --compact: select memory from a host session's
                          first user message (managed agent bridges only)
  --cwd <dir>    With --compact and --first-message: detect an attached project
`;

const OPEN_LOOP_RE = /\b(open|loop|blocker|blocked|waiting|follow[- ]?up|todo|to do|next action|deadline|due|carry[- ]?over)\b/i;

export async function briefCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parseOptions(args);
  if (options.geminiHook) {
    assertGeminiHookOptions(options);
    const request = await resolveGeminiHookRequest(await readGeminiHookInput());
    if (request.kind === "legacy-session-start") {
      process.stdout.write(`${JSON.stringify({
        systemMessage: "Memory: Closed — DotAIOS is updating its Gemini hook; memory stayed closed for this session start.",
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
        dotaiosMemory: { mode: "closed", project: null }
      })}\n`);
      return;
    }
    options.firstMessage = request.firstMessage;
    options.cwd = request.cwd;
  }
  if (!options.compact && (options.firstMessage !== null || options.cwd !== null)) {
    throw new Error("--first-message and --cwd are supported with --compact only.");
  }
  if (options.cwd !== null && (!path.isAbsolute(options.cwd) || /[\0-\x1f\x7f]/.test(options.cwd))) {
    throw new Error("--cwd must be an absolute path without control characters.");
  }

  let memoryPolicy;
  try {
    memoryPolicy = resolveMemoryPolicy({
      mode: options.memory,
      project: options.project,
      firstUserMessage: options.firstMessage
    });
  } catch (error) {
    const canResolveAttachedProject = error?.code === "DOTAIOS_MEMORY_POLICY_INVALID"
      && options.cwd !== null
      && options.memory === null
      && options.project === null;
    if (!canResolveAttachedProject) throw error;
  }
  if (memoryPolicy?.mode === "off") {
    const additionalContext = `${memoryPolicy.receipt}\n\n${memoryPolicy.notice}`;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        systemMessage: `${memoryPolicy.receipt} — ${memoryPolicy.notice}`,
        hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext },
        dotaiosMemory: { mode: memoryPolicy.mode, project: null },
        contextBudget: {
          limit: additionalContext.length,
          used: additionalContext.length,
          remaining: 0,
          truncated: false,
        },
      }) + "\n");
    } else {
      process.stdout.write(`${additionalContext}\n`);
    }
    return;
  }
  if (!options.compact && (options.memory !== null || options.project !== null)) {
    throw new Error("--memory and --project are supported with --compact only.");
  }
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  let projectSelector = options.project;
  if (options.cwd !== null && options.memory === null && projectSelector === null) {
    const attached = await resolveProjectContext({ aiosPath: target, cwd: options.cwd });
    projectSelector = attached?.id || null;
  }
  memoryPolicy = resolveMemoryPolicy({
    mode: options.memory,
    project: projectSelector,
    firstUserMessage: options.firstMessage
  });

  if (options.compact) {
    const { digest, budget, notice } = await buildWorkingContextEnvelope(target, {
      memory: memoryPolicy.mode,
      project: memoryPolicy.projectSelector,
      visibleCharacterBudget: options.budget
    });
    const additionalContext = notice ? `${notice}\n\n${digest}` : digest;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        systemMessage: memoryPolicy.receipt,
        hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext },
        dotaiosMemory: {
          mode: memoryPolicy.mode,
          project: memoryPolicy.projectSelector
        },
        contextBudget: budget
      }) + "\n");
    } else {
      process.stdout.write(additionalContext + "\n");
    }
    return;
  }

  if (options.lean) {
    const lean = await buildLeanBrief(target);
    process.stdout.write(`${lean}\n`);
    return;
  }

  const now = new Date();
  const date = isoDate(now);
  const dailyPath = path.join(target, "memory", "daily", `${date}.md`);
  const brief = await buildDailyBrief(target, date, now);

  if (options.dryRun) {
    console.log(`(dry run — would update ${dailyPath})\n`);
    console.log(brief);
    return;
  }

  const existing = await readOrEmpty(dailyPath);
  const updated = upsertBriefSection(existing, { date, brief, now });
  await fs.mkdir(path.dirname(dailyPath), { recursive: true });
  await fs.writeFile(dailyPath, updated, "utf8");

  await appendEvent(path.join(target, "memory", "events.jsonl"), {
    type: "brief",
    summary: `Daily brief written for ${date}.`,
    source: "dotaios brief"
  });

  console.log(`${memoryPolicy.receipt}\nBrief saved at ${dailyPath}`);
}

function parseOptions(args = []) {
  const options = {
    dryRun: false,
    compact: false,
    lean: false,
    json: false,
    path: null,
    project: null,
    memory: null,
    firstMessage: null,
    cwd: null,
    budget: undefined,
    geminiHook: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "daily") {
      continue;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--lean") {
      options.lean = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
    } else if (arg === "--memory") {
      options.memory = readOptionValue(args, index, "--memory");
      index += 1;
    } else if (arg === "--first-message") {
      options.firstMessage = readOptionValue(args, index, "--first-message");
      index += 1;
    } else if (arg === "--cwd") {
      options.cwd = readOptionValue(args, index, "--cwd");
      index += 1;
    } else if (arg === "--budget") {
      const value = readOptionValue(args, index, "--budget");
      if (!/^\d+$/.test(value)) throw new Error("--budget must be a non-negative whole number.");
      options.budget = Number(value);
      index += 1;
    } else if (arg === "--gemini-hook") {
      options.geminiHook = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function assertGeminiHookOptions(options) {
  if (!options.compact || !options.json || options.path === null) {
    throw new Error("--gemini-hook requires --compact, --json, and --path.");
  }
  if (options.dryRun || options.lean || options.memory !== null || options.project !== null
    || options.firstMessage !== null || options.cwd !== null || options.budget !== undefined) {
    throw new Error("--gemini-hook cannot be combined with user-facing memory or output options.");
  }
}

// A small high-signal surface for boot: identity, priorities, north-star,
// today's daily note, and the first active project README. The rest of memory/
// stays opt-in (loaded on demand or summarized explicitly). This is the lean
// default load the Matt Van Horn push-memory thesis asks for: pay for signal,
// not square footage.
export async function buildLeanBrief(aiosPath, date = isoDate(new Date())) {
  const [identity, priorities, northStar, dailyNote, projectReadme] = await Promise.all([
    readOrEmpty(path.join(aiosPath, "context", "identity.md")),
    readOrEmpty(path.join(aiosPath, "context", "priorities.md")),
    readOrEmpty(path.join(aiosPath, "context", "north-star.md")),
    readOrEmpty(path.join(aiosPath, "memory", "daily", `${date}.md`)),
    readFirstProjectReadme(aiosPath)
  ]);

  const sections = [
    "Memory: Shared",
    "",
    "# Lean brief",
    "",
    `Generated by \`dotaios brief --lean\` on ${date}.`,
    ""
  ];

  const blocks = [
    ["## Identity", identity],
    ["## Priorities", priorities],
    ["## North star", northStar],
    ["## Today's daily note", dailyNote],
    ["## Active project README", projectReadme]
  ];

  for (const [header, body] of blocks) {
    const trimmed = body.trim();
    if (!trimmed) {
      sections.push(`${header}`, "", "_Not found._", "");
      continue;
    }
    sections.push(header, "", trimmed, "");
  }

  return sections.join("\n");
}

async function readFirstProjectReadme(aiosPath) {
  const projectsDir = path.join(aiosPath, "projects");
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return "";
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of dirs) {
    const readme = path.join(projectsDir, name, "README.md");
    const body = await readOrEmpty(readme);
    if (body.trim()) return body;
  }
  return "";
}

export async function buildDailyBrief(aiosPath, date = isoDate(new Date()), now = new Date()) {
  const [priorities, workingContext] = await Promise.all([
    readPriorities(aiosPath),
    selectWorkingContext(aiosPath, {}, { clock: () => new Date(now.getTime()) })
  ]);

  const openLoops = extractOpenLoops([
    ...workingContext.signals,
    ...workingContext.events
  ]);

  return renderBrief({
    date,
    priorities,
    openLoops,
    carryOver: workingContext.carryOver
  });
}

async function readPriorities(aiosPath) {
  const content = await readOrEmpty(path.join(aiosPath, "context", "priorities.md"));
  const currentBets = readSection(content, "Current Bets");
  return compactLines(currentBets || stripFrontmatter(content)).slice(0, 5);
}

function extractOpenLoops(entries) {
  const candidates = [];
  for (const entry of entries) {
    const summary = String(entry.summary || entry.note || "").trim();
    if (!summary || !OPEN_LOOP_RE.test(summary)) continue;
    candidates.push(summary);
  }
  return dedupe(candidates).slice(0, 5);
}


function renderBrief({ date, priorities, openLoops, carryOver }) {
  return [
    "Memory: Shared",
    "",
    `Generated by \`dotaios brief\` on ${date}.`,
    "",
    "### Priorities",
    renderList(priorities, "No priorities found. Run `dotaios interview` when your week changes."),
    "",
    "### Open Loops",
    renderList(openLoops, "No obvious open loops found in recent memory."),
    "",
    "### Carry-over",
    renderList(carryOver, "No carry-over found from yesterday or today's plan.")
  ].join("\n");
}

function renderList(items, emptyText) {
  if (items.length === 0) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
}

export function upsertBriefSection(content, { date, brief, now = new Date() }) {
  if (!content.trim()) {
    return newDailyNote({ date, brief, now });
  }

  if (/^## Brief\s*$/m.test(content)) {
    return ensureTrailingNewline(replaceSection(content, "Brief", brief));
  }

  const lines = content.split("\n");
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line));
  const section = ["", "## Brief", "", brief, ""];

  if (h1Index !== -1) {
    lines.splice(h1Index + 1, 0, ...section);
    return ensureTrailingNewline(lines.join("\n"));
  }

  return ensureTrailingNewline(`${content.replace(/\s*$/, "")}\n\n## Brief\n\n${brief}\n`);
}

function newDailyNote({ date, brief, now }) {
  return `---
date: ${date}
created_at: ${now.toISOString()}
source: dotaios brief
---

# ${date}

## Brief

${brief}

## Focus


## Plan


## Close
<!-- Run /closeday to fill this section at the end of the day -->

### Done

### Carry-over

### Reflection
`;
}

function compactLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"))
    .map((line) => line.replace(/^- \[[ x]\]\s*/i, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function stripFrontmatter(content) {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  return content.slice(end + 4);
}

async function readOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function ensureTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`;
}
