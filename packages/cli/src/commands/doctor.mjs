import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { pathExists, readJson } from "../../../core/src/files.mjs";
import { previewMigration } from "../../../core/src/migrations.mjs";
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
  console.log("Using another local AI tool that can read files? Paste this line into it:");
  console.log(`  Read ${path.join(target, "AGENTS.md")} first and follow it.`);
  console.log("  Browser chats need an attached file or a pasted, reviewed brief.");
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
  let migration;
  try {
    migration = await previewMigration({ aiosPath: target });
  } catch (error) {
    return {
      name: "aios.json schema compatibility",
      status: "fail",
      detail: error.message,
      fix: "Install a DotAIOS release that supports this folder schema. This build will not write it."
    };
  }
  if (migration.status === "recovery_required") {
    return {
      name: "aios.json migration transaction",
      status: "fail",
      detail: `Interrupted plan: ${migration.transaction_ids.join(", ")}`,
      fix: `Run \`npx dotaios migrate --recover${pathOptionFor(target)}\`.`
    };
  }
  if (migration.status === "ready") {
    return {
      name: "aios.json schema update",
      status: "warn",
      detail: `schema ${migration.plan.from_schema_version} → ${migration.plan.to_schema_version}, plan ${migration.plan.plan_id}`,
      fix: `Run \`npx dotaios migrate${pathOptionFor(target)}\` to preview it.`
    };
  }
  return {
    name: "aios.json present",
    status: "ok",
    detail: `schema ${config.schema_version || "?"}, ai_tools: ${tools}`
  };
}

async function checkAgentBridges(target, homePath) {
  const results = [];
  let foundBridge = false;
  let foundNativeRuntime = false;
  let anyInstalled = false;

  const registry = await loadAgentRegistry(target);
  for (const agent of registry) {
    const filePath = bridgePath(homePath, agent) || path.join(homePath, agent.detect);

    if (!await isAgentInstalled(homePath, agent)) {
      results.push({
        name: `${agent.name} (not installed)`,
        status: "ok",
        detail: "Not detected on this machine — nothing to connect."
      });
      continue;
    }
    anyInstalled = true;

    if (!agent.bridge) {
      foundNativeRuntime = true;
      results.push({
        name: `${agent.name} native skills`,
        status: "ok",
        detail: "Runtime has no DotAIOS bridge file; native skill configuration is checked separately."
      });
      continue;
    }

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
      if (content.includes("read_session_digest")) {
        results.push({
          name: `${agent.name} bridge`,
          status: "warn",
          detail: "Managed bridge predates v1.23 and still calls the retired read_session_digest surface.",
          fix: `Run \`npx dotaios activate --path ${target} --overwrite\` to refresh it.`
        });
      } else {
        results.push({ name: `${agent.name} bridge`, status: "ok" });
      }
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
  } else if (!foundBridge && !foundNativeRuntime) {
    results.push({
      name: "At least one AI tool connected",
      status: "warn",
      detail: "An AI tool is installed but no managed bridge points at this AIOS folder yet.",
      fix: "Run `npx dotaios activate`."
    });
  }

  return results;
}

function pathOptionFor(target) {
  const defaultPath = path.resolve(expandHome(defaultAiosPath()));
  return target === defaultPath ? "" : ` --path ${shellQuote(target)}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
