import fs from "node:fs/promises";
import path from "node:path";
import { hasHelpFlag } from "../lib/args.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { collectSkills } from "../../../core/src/skills.mjs";

const HELP_TEXT = `Usage:
  dotaios skills [name]

List installed skills or show detail for one skill.

Examples:
  dotaios skills             List all installed skills
  dotaios skills plan-today  Show full instructions for the plan-today skill

Options:
  --path <dir>  Use a non-default AIOS folder
`;

export async function skillsCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
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
