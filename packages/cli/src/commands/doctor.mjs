import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { pathExists, readJson } from "../../../core/src/files.mjs";
import { MANAGED_START, bridgePath, isAgentInstalled, loadAgentRegistry } from "../../../core/src/bridges.mjs";
import { hasHelpFlag, parsePathHomeOptions } from "../lib/args.mjs";

const MIN_NODE_MAJOR = 20;

const HELP_TEXT = `Usage:
  dotaios doctor [options]

One-stop health check. Looks at Node version, terminal, the AIOS folder,
agent bridges, and prints one line per check so a non-technical user can
follow along.

Options:
  --path <dir>  Check an AIOS folder other than ~/aios
  --home <dir>  Check agent bridges somewhere other than your home
`;

export async function doctorCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parsePathHomeOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const homePath = path.resolve(expandHome(options.home || os.homedir()));

  const checks = [];

  checks.push(checkNodeVersion());
  checks.push(checkTerminal());
  checks.push(await checkAiosFolder(target));
  checks.push(await checkAiosConfig(target));
  checks.push(...await checkAgentBridges(target, homePath));

  console.log("DotAIOS doctor");
  console.log("");
  for (const check of checks) {
    console.log(`${tag(check.status)} ${check.name}`);
    if (check.detail) console.log(`        ${check.detail}`);
    if (check.fix) console.log(`        Fix: ${check.fix}`);
  }

  console.log("");
  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");

  if (failed.length === 0 && warned.length === 0) {
    console.log("Everything looks good. Ask Claude Code: \"What am I working on?\"");
    return;
  }

  if (failed.length > 0) {
    console.log(`Found ${failed.length} blocking issue(s). Fix those first, then run \`dotaios doctor\` again.`);
    process.exitCode = 1;
  } else {
    console.log(`Found ${warned.length} warning(s). DotAIOS works, but consider the fixes above.`);
  }
}

const STATUS_TAGS = { ok: "[ok]", warn: "[warn]", fail: "[fail]" };

function tag(status) {
  return STATUS_TAGS[status] || "[fail]";
}

function checkNodeVersion() {
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { name: `Node.js ${raw}`, status: "ok" };
  }
  return {
    name: `Node.js ${raw}`,
    status: "fail",
    detail: `DotAIOS needs Node.js ${MIN_NODE_MAJOR} or newer.`,
    fix: "Install Node.js from https://nodejs.org (pick the LTS download)."
  };
}

function checkTerminal() {
  if (process.stdin.isTTY) {
    return { name: "Running in a real Terminal", status: "ok" };
  }
  return {
    name: "Running in a real Terminal",
    status: "warn",
    detail: "Some commands need an interactive terminal (init, interview).",
    fix: "Open the Terminal app on Mac (cmd+space → Terminal) or 'cmd' on Windows, then re-run."
  };
}

async function checkAiosFolder(target) {
  if (await pathExists(target)) {
    return { name: `AIOS folder at ${target}`, status: "ok" };
  }
  return {
    name: `AIOS folder at ${target}`,
    status: "fail",
    detail: "No folder found at this path.",
    fix: "Run `npx dotaios setup` to create it."
  };
}

async function checkAiosConfig(target) {
  const configPath = path.join(target, "aios.json");
  const config = await readJson(configPath, null);
  if (!config) {
    return {
      name: "aios.json present",
      status: "fail",
      detail: "Config file missing or unreadable.",
      fix: "Run `npx dotaios init --force` to add missing base files."
    };
  }
  const tools = (config.ai_tools || []).join(", ") || "none";
  return {
    name: "aios.json present",
    status: "ok",
    detail: `schema ${config.schema_version || "?"}, ai_tools: ${tools}`
  };
}

async function checkAgentBridges(target, homePath) {
  const results = [];
  let foundBridge = false;
  let anyInstalled = false;

  const registry = await loadAgentRegistry(target);
  for (const agent of registry) {
    const filePath = bridgePath(homePath, agent);

    if (!await isAgentInstalled(homePath, agent)) {
      results.push({
        name: `${agent.name} (not installed)`,
        status: "ok",
        detail: "Not detected on this machine — nothing to connect."
      });
      continue;
    }
    anyInstalled = true;

    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: `${agent.name} is installed but not connected yet (no bridge at ${filePath}).`,
        fix: "Run `npx dotaios activate`."
      });
      continue;
    }

    if (content.includes(MANAGED_START) && content.includes(target)) {
      results.push({ name: `${agent.name} bridge`, status: "ok" });
      foundBridge = true;
    } else if (content.includes(MANAGED_START)) {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: "Bridge points to a different AIOS folder.",
        fix: `Run \`npx dotaios activate --path ${target} --overwrite\` to repoint.`
      });
    } else {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: "Existing unmanaged file. DotAIOS will not overwrite.",
        fix: `Inspect ${filePath}; if safe to replace, run \`npx dotaios activate --overwrite\`.`
      });
    }
  }

  if (!anyInstalled) {
    results.push({
      name: "At least one AI tool installed",
      status: "warn",
      detail: "No known AI tools detected on this machine.",
      fix: "Install Claude Code, Cursor, Codex, or Gemini, then run `npx dotaios activate`."
    });
  } else if (!foundBridge) {
    results.push({
      name: "At least one AI tool connected",
      status: "warn",
      detail: "An AI tool is installed but no managed bridge points at this AIOS folder yet.",
      fix: "Run `npx dotaios activate`."
    });
  }

  return results;
}
