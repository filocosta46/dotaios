import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultAiosPath, expandHome, requiredAiosFiles, resolveVaultPath } from "../../../core/src/paths.mjs";
import { detectMarker } from "../ingest/pdf.mjs";
import { readOptionValue } from "../lib/args.mjs";
import { pathExists } from "../../../core/src/files.mjs";

const managedStart = "<!-- dotaios-managed:start -->";

export async function statusCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  dotaios status [options]

Options:
  --path <dir>  Check an AIOS folder other than ~/aios
  --home <dir>  Check agent bridges somewhere other than your home
`);
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const homePath = path.resolve(expandHome(options.home || os.homedir()));

  if (!(await pathExists(target))) {
    console.error(`No AIOS folder found at ${target}. Run \`npx dotaios init\` first, or pass --path.`);
    process.exitCode = 1;
    return;
  }

  console.log(`DotAIOS status for ${target}`);
  console.log("\nRequired files");
  let missingCount = 0;
  for (const file of requiredAiosFiles) {
    const exists = await pathExists(path.join(target, file));
    if (!exists) missingCount += 1;
    console.log(`${exists ? "[ok]" : "[missing]"} ${file}`);
  }

  const config = await readConfig(target);
  const pathOption = pathOptionFor(target);
  const activateCommand = `npx dotaios activate${pathOption}`;
  const initCommand = `npx dotaios init --force${pathOption}`;
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

  console.log("\nIngest engines");
  console.log("[ok] Web scraper           : bundled (linkedom + cheerio + readability + turndown)");
  console.log("[ok] PDF (Node fallback)   : bundled (unpdf)");
  const markerPath = await detectMarker();
  if (markerPath) {
    console.log(`[ok] Marker (local)         : installed (${markerPath})`);
  } else {
    console.log("[info] Marker (local)       : not installed (PDFs use unpdf; .docx/.pptx/.epub require marker)");
  }

  console.log("\nMemory");
  console.log(`[info] events: ${await countLines(path.join(target, "memory", "events.jsonl"))}`);
  console.log(`[info] errors: ${await countLines(path.join(target, "memory", "errors.jsonl"))}`);

  console.log("\nSkills");
  const skillsPath = path.join(target, "skills");
  const skillCount = await countSkillDirectories(skillsPath);
  console.log(`${skillCount > 0 ? "[ok]" : "[missing]"} ${skillCount} installed skill(s)`);

  console.log("\nConnections");
  const connections = await readConnections(path.join(target, "connections", "registry.md"));
  if (connections.length === 0) {
    console.log("[info] no active connections");
    console.log("[hint] Run `npx dotaios connect google --dry-run` to preview Gmail/Calendar beta setup.");
  } else {
    for (const connection of connections) {
      console.log(`[${connection.status.toLowerCase()}] ${connection.service} - ${connection.notes}`);
    }
  }

  const bridgeResults = await checkAgentBridges(target, homePath);
  console.log("\nAgent bridges");
  for (const result of bridgeResults) {
    const note = result.note ? ` (${result.note})` : "";
    console.log(`${result.status} ${result.path}${note}`);
  }

  const hasMissingBridge = bridgeResults.some((result) => result.status === "[missing]");
  const hasCheckBridge = bridgeResults.some((result) => result.status === "[check]");
  console.log("\nNext step");
  if (missingCount > 0 || !config) {
    console.log(`[action] Run \`${initCommand}\` to add missing base files, or inspect the missing files above.`);
  } else if (hasMissingBridge || hasCheckBridge) {
    console.log(`[action] Run \`${activateCommand}\` so Claude Code, Codex, and Gemini can find this AIOS.`);
    if (hasCheckBridge) {
      console.log("[note] Inspect [check] bridge files first; pass `--overwrite` only if you want DotAIOS to manage them.");
    }
  } else {
    console.log("[ok] AIOS folder and global agent bridges look ready for beta testing.");
  }

  if (missingCount > 0 || !config) {
    process.exitCode = 1;
  }
}

function pathOptionFor(target) {
  const defaultPath = path.resolve(expandHome(defaultAiosPath()));
  return target === defaultPath ? "" : ` --path ${shellQuote(target)}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseOptions(args = []) {
  const options = { home: null, path: null };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    }
  }

  return options;
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

async function readConnections(registryPath) {
  let content;
  try {
    content = await fs.readFile(registryPath, "utf8");
  } catch {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("Service | Status | Notes"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3 && cells[0])
    .map(([service, status, notes]) => ({ service, status, notes }));
}

async function checkAgentBridges(target, homePath) {
  const bridges = [
    path.join(homePath, ".claude", "CLAUDE.md"),
    path.join(homePath, ".codex", "AGENTS.md"),
    path.join(homePath, ".gemini", "GEMINI.md")
  ];
  const results = [];

  for (const bridgePath of bridges) {
    let content;
    try {
      content = await fs.readFile(bridgePath, "utf8");
    } catch {
      results.push({ status: "[missing]", path: bridgePath });
      continue;
    }

    if (content.includes(managedStart) && content.includes(target)) {
      results.push({ status: "[ok]", path: bridgePath });
    } else if (content.includes(managedStart)) {
      results.push({ status: "[check]", path: bridgePath, note: "managed for another AIOS path" });
    } else {
      results.push({ status: "[check]", path: bridgePath, note: "existing unmanaged file" });
    }
  }

  return results;
}
