import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, expandHome, requiredAiosFiles, resolveVaultPath } from "../../../core/src/paths.mjs";

export async function statusCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  dotaios status [options]

Options:
  --path <dir>  Check an AIOS folder other than ~/.aios
`);
    return;
  }

  const target = path.resolve(expandHome(parsePath(args) || defaultAiosPath()));

  console.log(`DotAIOS status for ${target}`);
  console.log("\nRequired files");
  let missingCount = 0;
  for (const file of requiredAiosFiles) {
    const exists = await pathExists(path.join(target, file));
    if (!exists) missingCount += 1;
    console.log(`${exists ? "[ok]" : "[missing]"} ${file}`);
  }

  const config = await readConfig(target);
  console.log("\nConfiguration");
  if (!config) {
    console.log("[missing] aios.json could not be read");
  } else {
    console.log(`[ok] schema_version: ${config.schema_version || "unknown"}`);
    console.log(`[ok] ai_tools: ${(config.ai_tools || []).join(", ") || "none"}`);
  }

  const vaultPath = resolveVaultPath(config || {}, target);
  console.log("\nVault");
  console.log(`${await pathExists(vaultPath) ? "[ok]" : "[missing]"} ${vaultPath}`);

  console.log("\nMemory");
  console.log(`[info] events: ${await countLines(path.join(target, "memory", "events.jsonl"))}`);
  console.log(`[info] errors: ${await countLines(path.join(target, "memory", "errors.jsonl"))}`);

  console.log("\nSkills");
  const skillsPath = path.join(target, "skills");
  const skillCount = await countSkillDirectories(skillsPath);
  console.log(`${skillCount > 0 ? "[ok]" : "[missing]"} ${skillCount} installed skill(s)`);

  if (missingCount > 0 || !config) {
    process.exitCode = 1;
  }
}

function parsePath(args = []) {
  const index = args.indexOf("--path");
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--path requires a value");
  }
  return value;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readConfig(target) {
  try {
    return JSON.parse(await fs.readFile(path.join(target, "aios.json"), "utf8"));
  } catch {
    return null;
  }
}

async function countLines(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function countSkillDirectories(skillsPath) {
  try {
    const entries = await fs.readdir(skillsPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}
