import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { resolveProjectContext } from "../../../core/src/projects.mjs";

const HELP_TEXT = `Usage:
  dotaios plan "<title>" [options]

Write a lightweight plan.md artifact an agent can pick up across sessions.
Compound Engineering style: a goal, a few checkbox steps, a status, and open
questions. Plain markdown, no AI, no services. Saved under memory/plans/ and
logged as an event so it surfaces in the session digest.

Options:
  --path <dir>     Use an AIOS folder other than ~/aios
  --steps <list>   Comma-separated steps (each becomes a checkbox)
  --project <slug> Tag the plan with a project slug
  --print          Print the plan to stdout instead of writing a file
  --dry-run        Print the plan and the target path without writing
`;

export async function planCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parseOptions(args);
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(aiosPath);
  const project = await resolveProjectContext({
    aiosPath,
    project: options.project,
    cwd: process.cwd()
  });

  if (!options.title) {
    console.error(`Pass a plan title, e.g. dotaios plan "ship the resolver" --steps "write tests,implement,ship".`);
    process.exitCode = 2;
    return;
  }

  const now = new Date();
  const date = localDate(now);
  const slug = slugify(options.title);
  const fileName = `${date}-${slug}.md`;
  const plansDir = path.join(aiosPath, "memory", "plans");
  const filePath = path.join(plansDir, fileName);
  const body = renderPlan({
    title: options.title,
    steps: options.steps,
    project,
    date,
    now
  });

  if (options.print || options.dryRun) {
    if (options.dryRun) console.log(`(dry run — would write ${filePath})\n`);
    process.stdout.write(`${body}\n`);
    return;
  }

  await fs.mkdir(plansDir, { recursive: true });
  await fs.writeFile(filePath, body, "utf8");

  await appendEvent(path.join(aiosPath, "memory", "events.jsonl"), {
    type: "plan",
    summary: `Plan written: ${options.title}`,
    ...(project?.slug ? { project: project.slug } : {}),
    ...(project?.id ? { project_id: project.id } : {}),
    source: "dotaios plan"
  });

  console.log(`Plan saved at ${filePath}`);
}

function parseOptions(args = []) {
  const options = { title: null, steps: [], project: null, print: false, dryRun: false, path: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--steps") {
      const value = readOptionValue(args, index, "--steps");
      options.steps = value.split(",").map((step) => step.trim()).filter(Boolean);
      index += 1;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--print") {
      options.print = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  options.title = positional.join(" ").trim() || null;
  return options;
}

function renderPlan({ title, steps, project, date, now }) {
  const lines = [
    "---",
    `date: ${date}`,
    `created_at: ${now.toISOString()}`,
    `source: dotaios plan`,
    project?.slug ? `project: ${project.slug}` : "project: ",
    ...(project?.id ? [`project_id: ${project.id}`] : []),
    "---",
    "",
    `# ${title}`,
    "",
    "## Goal",
    "",
    "",
    "## Steps",
    ""
  ];

  if (steps.length === 0) {
    lines.push("- [ ] ", "");
  } else {
    for (const step of steps) lines.push(`- [ ] ${step}`);
    lines.push("");
  }

  lines.push("## Status", "", "in-progress", "", "## Open questions", "", "");

  return lines.join("\n");
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "plan";
}

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
