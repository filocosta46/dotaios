import fs from "node:fs/promises";
import path from "node:path";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { collectSkills } from "../../../core/src/skills.mjs";
import { rankSkills, resolveIntent, renderBootContext } from "../../../core/src/skill-resolver.mjs";

const HELP_TEXT = `Usage:
  dotaios skills [name]
  dotaios skills resolve "<intent>" [options]

List installed skills, show detail for one skill, or resolve a free-text intent
to the skill that handles it.

Examples:
  dotaios skills             List all installed skills
  dotaios skills plan-today  Show full instructions for the plan-today skill
  dotaios skills resolve "plan my day"
  dotaios skills resolve "plan my day" --full
  dotaios skills resolve "plan my day" --json
  dotaios skills resolve --boot-context
  BOOT_CONTEXT="$(dotaios skills resolve --boot-context)"

Resolve options:
  --json          Print ranked matches as JSON (for fleet/MCP callers)
  --full          Also print the top match's SKILL.md body
  --all           Print the full ranked list, not just the top match
  --limit <n>     Cap the number of matches (default 1, ignored with --all)
  --boot-context  Print Markdown context to capture and append to an agent prompt
  --path <dir>    Use a non-default AIOS folder

Boot context is Markdown, not shell code. Capture it in a quoted variable as
shown above, then interpolate that text into the agent prompt.

Exit codes (resolve): 0 on a match, 2 when nothing clears the bar.
`;

export async function skillsCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  if (args[0] === "resolve") {
    await resolveSkillCommand(args.slice(1));
    return;
  }

  const aiosPath = path.resolve(expandHome(extractPath(args) || defaultAiosPath()));
  const skills = await collectSkills(aiosPath);

  const name = extractName(args);

  if (name) {
    await showSkill(aiosPath, skills, name);
  } else {
    listSkills(skills);
  }
}

async function resolveSkillCommand(args) {
  const options = parseResolveOptions(args);
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const skillsDir = path.join(aiosPath, "skills");
  const skills = await collectSkills(aiosPath);

  if (options.bootContext) {
    process.stdout.write(`${renderBootContext(skills, { skillsDir })}\n`);
    return;
  }

  if (!options.intent) {
    console.error(`Pass an intent to resolve, e.g. dotaios skills resolve "plan my day".`);
    console.error(`Or print a boot block: dotaios skills resolve --boot-context.`);
    process.exitCode = 2;
    return;
  }

  const ranked = rankSkills(options.intent, skills, { skillsDir });

  if (ranked.length === 0) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ intent: options.intent, matches: [] }, null, 2)}\n`);
    } else {
      console.error(`No skill matched: ${options.intent}`);
      console.error(`Run "dotaios skills" to list installed skills.`);
    }
    process.exitCode = 2;
    return;
  }

  const limit = options.all ? ranked.length : Math.max(1, options.limit);
  const matches = ranked.slice(0, limit);

  if (options.json) {
    const payload = {
      intent: options.intent,
      matches: matches.map((entry) => ({
        name: entry.name,
        dir: entry.dir,
        description: entry.description,
        triggers: entry.triggers,
        score: round(entry.score),
        reason: entry.reason,
        skillPath: entry.skillPath
      }))
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (options.all) {
    for (const entry of matches) {
      printMatchHeader(entry);
    }
    return;
  }

  const top = matches[0];
  printMatchHeader(top);
  if (options.full) {
    let body;
    try {
      body = await fs.readFile(top.skillPath, "utf8");
    } catch {
      console.error(`Could not read skill file: ${top.skillPath}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n${body}`);
  }
}

function printMatchHeader(entry) {
  const confidence = entry.score >= 100 ? 1 : Math.min(1, entry.score);
  console.log(`${entry.name} — ${entry.description || "(no description)"}`);
  console.log(`  dir:       ${entry.dir}`);
  console.log(`  confidence: ${confidence.toFixed(2)} (${entry.reason})`);
  if (entry.triggers.length) {
    console.log(`  triggers:  ${entry.triggers.join(" · ")}`);
  }
  console.log(`  run:       ${entry.skillPath}`);
}

function parseResolveOptions(args) {
  const options = { intent: null, json: false, full: false, all: false, bootContext: false, limit: 1, path: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--full") {
      options.full = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--boot-context") {
      options.bootContext = true;
    } else if (arg === "--limit") {
      options.limit = parseLimit(readOptionValue(args, index, "--limit"));
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  options.intent = positional.join(" ").trim() || null;
  return options;
}

function parseLimit(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid --limit "${value}". Use a positive whole number.`);
  }
  return Number(value);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function listSkills(skills) {
  if (skills.length === 0) {
    console.log("No skills installed.");
    console.log("Add one: dotaios skill add <url-or-path>");
    return;
  }

  console.log(`${skills.length} skill${skills.length === 1 ? "" : "s"} installed:\n`);
  for (const skill of skills) {
    if (skill.description) {
      console.log(`  ${skill.name} — ${skill.description}`);
    } else {
      console.log(`  ${skill.name}`);
    }
  }
  console.log('\nAsk your agent: "use the <skill-name> skill"');
}

async function showSkill(aiosPath, skills, query) {
  const match = skills.find(
    (skill) =>
      skill.name.toLowerCase() === query.toLowerCase() ||
      skill.dir.toLowerCase() === query.toLowerCase()
  );

  if (!match) {
    console.error(`No skill found: ${query}`);
    console.error(`Run "dotaios skills" to list installed skills.`);
    process.exitCode = 1;
    return;
  }

  const skillFile = path.join(aiosPath, "skills", match.dir, "SKILL.md");
  let content;
  try {
    content = await fs.readFile(skillFile, "utf8");
  } catch {
    console.error(`Could not read skill file: ${skillFile}`);
    process.exitCode = 1;
    return;
  }

  console.log(content);
}

function extractPath(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

function extractName(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path") {
      i++;
    } else if (!args[i].startsWith("--")) {
      result.push(args[i]);
    }
  }
  return result.join(" ").trim();
}
