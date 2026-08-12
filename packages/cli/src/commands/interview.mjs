import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathExists, writeFileSafe } from "../../../core/src/files.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { confirmWrites } from "../../../core/src/review.mjs";
import { readBullet, readSection, replaceBullet, replaceSection } from "../../../core/src/sections.mjs";
import { appendEvent } from "../../../core/src/memory.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios interview [options]

Update your context by answering a few short questions. Use this any time
your work, role, priorities, or planning preferences change. Existing answers
are shown — press Enter to keep them, or type something new to replace.

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --review      Show a diff and confirm before writing.
                Honors DOTAIOS_AUTO_APPROVE=1 for non-interactive runs.

Files updated:
  context/identity.md           (Role)
  context/work.md               (## Current Work)
  context/priorities.md         (## Current Bets)
  context/preferences.md        (Planning preferences — created on first run)
  skills/plan-today/prompt.md   (Compiled personalization — auto-generated)
`;

const PREFERENCE_FIELDS = [
  { key: "planStyle", currentKey: "currentPlanStyle", label: "Plan style", prompt: "How should AI plan your day (focused / balanced / aggressive)", default: "focused" },
  { key: "prioritiesPerDay", currentKey: "currentPrioritiesPerDay", label: "Priorities per day", prompt: "Priorities per day (a number)", default: "3" },
  { key: "timeBlocks", currentKey: "currentTimeBlocks", label: "Time blocks", prompt: "Include time blocks (yes / no)", default: "yes" },
  { key: "frogDefinition", currentKey: "currentFrogDefinition", label: "Frog definition", prompt: "What counts as a 'frog' (hard / overdue / avoided task)", default: "overdue tasks" }
];

const COMPILED_SKILLS = ["plan-today"];

export async function interviewCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  if (!input.isTTY) {
    throw new Error("dotaios interview needs an interactive terminal. Run it from a normal shell.");
  }

  const sources = await loadCurrentContext(target);

  console.log("\nDotAIOS Interview");
  console.log("Press Enter to keep what's already there, or type to change.\n");

  const rl = readline.createInterface({ input, output });
  let answers;
  try {
    answers = await askAll(rl, sources);
  } finally {
    rl.close();
  }

  const plan = buildPlan(target, sources, answers);

  if (plan.length === 0) {
    console.log("\nNothing changed. Your context is up to date.");
    return;
  }

  if (options.review) {
    const ok = await confirmWrites(plan, { autoApprove: process.env.DOTAIOS_AUTO_APPROVE === "1" });
    if (!ok) {
      console.log("Cancelled. No files written.");
      return;
    }
  }

  const results = await Promise.all(
    plan.map((item) => writeFileSafe(item.path, item.content, "overwrite"))
  );
  for (const result of results) {
    console.log(`[${result.action}] ${result.path}`);
  }

  await appendEvent(path.join(target, "memory", "events.jsonl"), {
    type: "interview",
    summary: `Updated ${plan.map((item) => path.relative(target, item.path)).join(", ")} via dotaios interview.`,
    source: "dotaios interview"
  });
  console.log("\nDone. Restart your AI tool so it picks up the new context.");

  const recap = renderInterviewRecap({
    name: sources.currentName,
    role: answers.role || sources.currentRole,
    work: answers.work || sources.currentWork,
    priorities: answers.priorities || sources.currentPriorities
  });
  if (recap) console.log(`\n${recap}`);

  if (!options.review) {
    console.log("Tip: run `dotaios interview --review` next time to see exactly what will change before saving.");
  }
}

// A short, honest reflective close for the end of an interview. Reflects only
// what the user provided and hands the "pick one thing" reasoning to the agent
// (the CLI can't reason). Returns null when there's nothing meaningful to echo.
export function renderInterviewRecap({ name, role, work, priorities } = {}) {
  const firstLine = (value) => String(value || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const cleanName = String(name || "").trim();
  const cleanRole = firstLine(role);
  const workLine = firstLine(work);
  const priorityLine = firstLine(priorities);

  if (!cleanRole && !workLine && !priorityLine) return null;

  // "Here's what I've got: {name}, {role} — working on {work}."
  const who = [cleanName, cleanRole].filter(Boolean).join(", ");
  let head = "Here's what I've got:";
  if (who) head += ` ${who}`;
  if (workLine) head += `${who ? " — " : " "}working on ${workLine}`;
  head += ".";

  const lines = [head];
  if (priorityLine) lines.push(`This week: ${priorityLine}.`);
  lines.push('Open your AI agent and ask: "Based on my context, what\'s the one thing to focus on today?"');
  return lines.join("\n");
}

function parseOptions(args = []) {
  const options = { path: null, review: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--review") {
      options.review = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function loadCurrentContext(target) {
  const identityPath = path.join(target, "context", "identity.md");
  const workPath = path.join(target, "context", "work.md");
  const prioritiesPath = path.join(target, "context", "priorities.md");
  const preferencesPath = path.join(target, "context", "preferences.md");

  const [identity, work, priorities, preferences] = await Promise.all([
    readOrEmpty(identityPath),
    readOrEmpty(workPath),
    readOrEmpty(prioritiesPath),
    readOrEmpty(preferencesPath)
  ]);

  const sources = {
    target,
    identityPath,
    workPath,
    prioritiesPath,
    preferencesPath,
    identity,
    work,
    priorities,
    preferences,
    currentName: readBullet(identity, "Name"),
    currentRole: readBullet(identity, "Role"),
    currentWork: readSection(work, "Current Work"),
    currentPriorities: readSection(priorities, "Current Bets"),
    installedSkills: new Set(),
    currentPrompts: {}
  };

  for (const field of PREFERENCE_FIELDS) {
    sources[field.currentKey] = readBullet(preferences, field.label);
  }

  await Promise.all(COMPILED_SKILLS.map(async (skill) => {
    const skillDir = path.join(target, "skills", skill);
    if (await pathExists(skillDir)) {
      sources.installedSkills.add(skill);
      sources.currentPrompts[skill] = await readOrEmpty(path.join(skillDir, "prompt.md"));
    }
  }));

  return sources;
}

async function readOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

const FIELDS = [
  { answerKey: "role", currentKey: "currentRole", sourceKey: "identity", pathKey: "identityPath", replace: replaceBullet, label: "Role", multiline: false, prompt: "Your role" },
  { answerKey: "work", currentKey: "currentWork", sourceKey: "work", pathKey: "workPath", replace: replaceSection, label: "Current Work", multiline: true, prompt: "What you're working on right now" },
  { answerKey: "priorities", currentKey: "currentPriorities", sourceKey: "priorities", pathKey: "prioritiesPath", replace: replaceSection, label: "Current Bets", multiline: true, prompt: "What matters most this week" }
];

async function askAll(rl, sources) {
  const answers = {};

  for (const field of FIELDS) {
    answers[field.answerKey] = await ask(rl, field.prompt, sources[field.currentKey], { multiline: field.multiline });
  }

  console.log("Planning preferences");
  console.log("These shape how /plan-today thinks about your day.\n");

  for (const field of PREFERENCE_FIELDS) {
    const current = sources[field.currentKey] || field.default;
    answers[field.key] = await ask(rl, field.prompt, current, { multiline: false });
  }
  return answers;
}

async function ask(rl, label, current, { multiline = false } = {}) {
  console.log(label);
  if (multiline && current) {
    console.log("  Currently:");
    for (const line of current.split("\n")) console.log(`    ${line}`);
  } else {
    console.log(`  Currently: ${current || "(empty)"}`);
  }
  const answer = (await rl.question("  Change to (Enter to keep): ")).trim();
  console.log();
  return answer || current;
}

export function buildPlan(target, sources, answers) {
  const plan = [];

  for (const field of FIELDS) {
    const answer = answers[field.answerKey];
    if (!answer || answer === sources[field.currentKey]) continue;
    const sourceContent = sources[field.sourceKey];
    if (!sourceContent) continue;
    const updated = field.replace(sourceContent, field.label, answer);
    if (updated) plan.push({ path: sources[field.pathKey], content: updated });
  }

  const preferencesItem = buildPreferencesItem(sources, answers);
  if (preferencesItem) plan.push(preferencesItem);

  for (const item of buildCompiledPromptItems(target, sources, answers)) {
    plan.push(item);
  }

  return plan;
}

function buildPreferencesItem(sources, answers) {
  if (!sources.preferences) {
    return { path: sources.preferencesPath, content: renderPreferencesFile(answers) };
  }

  let updated = sources.preferences;
  for (const field of PREFERENCE_FIELDS) {
    const answer = answers[field.key];
    if (!answer || answer === sources[field.currentKey]) continue;
    const next = replaceBullet(updated, field.label, answer);
    if (next) updated = next;
  }
  return updated === sources.preferences ? null : { path: sources.preferencesPath, content: updated };
}

function buildCompiledPromptItems(target, sources, answers) {
  const items = [];
  for (const skill of COMPILED_SKILLS) {
    if (!sources.installedSkills.has(skill)) continue;
    const content = renderCompiledPrompt(skill, sources, answers);
    if (content === sources.currentPrompts[skill]) continue;
    items.push({ path: path.join(target, "skills", skill, "prompt.md"), content });
  }
  return items;
}

function renderPreferencesFile(answers) {
  const ts = new Date().toISOString();
  return [
    "---",
    "kind: context",
    `created_at: ${ts}`,
    "source: dotaios interview",
    "---",
    "# Preferences",
    "",
    "How you want AI agents to plan your day. Edit by hand or re-run `dotaios interview`.",
    "",
    "## Planning",
    "",
    ...PREFERENCE_FIELDS.map((field) => `- ${field.label}: ${answers[field.key] || field.default}`),
    ""
  ].join("\n");
}

function renderCompiledPrompt(skill, sources, answers) {
  const name = sources.currentName || "(set your name in context/identity.md)";
  const role = answers.role || sources.currentRole || "(set your role)";
  const work = answers.work || sources.currentWork || "(describe what you're working on)";
  const priorities = answers.priorities || sources.currentPriorities || "(describe this week's priorities)";

  const prefBullets = PREFERENCE_FIELDS
    .map((field) => `- ${field.label}: ${answers[field.key] || sources[field.currentKey] || field.default}`)
    .join("\n");

  return [
    `# ${skill} personalization`,
    "",
    "This file is generated by `dotaios interview`. Re-run that command to refresh.",
    "Skills should prefer this compiled file over reading the individual context files.",
    "",
    "## Who you are",
    `${name} — ${role}`,
    "",
    "## What you're working on",
    work,
    "",
    "## What matters this week",
    priorities,
    "",
    "## Planning preferences",
    prefBullets,
    ""
  ].join("\n");
}
