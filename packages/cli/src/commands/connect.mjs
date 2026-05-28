import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { assertAiosFolder, assessGwsAuth, firstLine, printCaptured, resolveAiosTarget, resolveGwsBinary, runGws } from "../lib/gws.mjs";

const googleAliases = new Set(["google", "gmail", "gws"]);
const geminiAliases = new Set(["gemini", "gemini-cli"]);
const opencodeAliases = new Set(["opencode"]);

export async function connectCommand(args) {
  if (hasHelpFlag(args)) {
    printConnectHelp();
    return;
  }

  const { service, options } = parseOptions(args);
  if (!service) {
    throw new Error("Usage: dotaios connect google [--dry-run|--status]");
  }

  if (geminiAliases.has(service)) {
    const target = resolveAiosTarget(options.path);
    await assertAiosFolder(target);
    await connectGemini(target, options);
    return;
  }

  if (opencodeAliases.has(service)) {
    const target = resolveAiosTarget(options.path);
    await assertAiosFolder(target);
    await connectOpenCode(target, options);
    return;
  }

  if (!googleAliases.has(service)) {
    throw new Error(`Unsupported connection: ${service}. Supported: google, gemini, opencode`);
  }

  const target = resolveAiosTarget(options.path);
  await assertAiosFolder(target);

  const gwsBin = await resolveGwsBinary(options.gwsBin || process.env.DOTAIOS_GWS_BIN || null);
  const mode = options.dryRun ? "dry run" : options.status ? "status" : "connect";

  console.log(`DotAIOS Google Workspace ${mode}`);
  console.log(`AIOS path: ${target}`);

  if (!gwsBin) {
    console.log("[missing] gws CLI");
    printGwsGuidance();
    if (options.dryRun) return;
    throw new Error("Google Workspace CLI is required. Install gws, then run `dotaios connect google --status`.");
  }

  console.log(`[ok] gws: ${gwsBin}`);
  const version = runGws(gwsBin, ["--version"]);
  if (version.status === 0) {
    console.log(`[ok] ${firstLine(version.stdout) || "gws version detected"}`);
  } else {
    console.log("[check] Could not read gws version");
  }

  if (options.dryRun) {
    console.log("\nWould verify auth with `gws auth status`.");
    console.log("Would write `connections/apis/google-workspace.md`.");
    console.log("Would update `connections/registry.md`.");
    console.log("Would add `skills/google-workspace/SKILL.md`.");
    console.log("Would log a non-secret connection event in `memory/events.jsonl`.");
    printReadFirstScope();
    return;
  }

  const auth = runGws(gwsBin, ["auth", "status"]);
  const authState = assessGwsAuth(auth);
  if (!authState.ready) {
    console.log("[missing] gws auth is not ready");
    console.log(`      ${authState.summary}`);
    if (auth.status !== 0) printCaptured(auth);
    printAuthGuidance();
    throw new Error("Google Workspace auth is not ready. Run `gws auth login`, then retry `dotaios connect google --status`.");
  }

  console.log("[ok] gws auth status");
  console.log(`      ${authState.summary}`);

  if (options.status) {
    console.log("\nGoogle Workspace looks ready for DotAIOS.");
    printReadFirstScope();
    return;
  }

  const versionText = firstLine(version.stdout) || "gws";
  await writeGoogleConnection(target, { gwsBin, versionText });
  await appendEvent(path.join(target, "memory", "events.jsonl"), {
    type: "connection",
    summary: "Connected Google Workspace via gws",
    source: "dotaios connect google",
    connection: "google-workspace",
    tool: "gws"
  });

  console.log("\nConnected Google Workspace");
  console.log("[ok] connections/apis/google-workspace.md");
  console.log("[ok] connections/registry.md");
  console.log("[ok] skills/google-workspace/SKILL.md");
  console.log("[ok] memory/events.jsonl");
  printReadFirstScope();
}

function printConnectHelp() {
  console.log(`Usage:
  dotaios connect <service> [options]

Services:
  google      Connect Google Workspace (Gmail, Calendar, Drive) via gws
  gemini      Connect Gemini CLI — installs GEMINI.md bridge, SessionStart hook, and MCP
  opencode    Connect OpenCode — installs MCP and skill stubs

Options:
  --path <dir>     Use a non-default AIOS folder
  --gws-bin <bin>  Use a specific gws binary (google only)
  --dry-run        Show what would be checked and written
  --status         Verify without writing files (google only)

Examples:
  dotaios connect google
  dotaios connect gemini
  dotaios connect opencode
  dotaios connect gemini --dry-run
`);
}

function parseOptions(args = []) {
  const options = { dryRun: false, gwsBin: null, path: null, status: false };
  let service = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--status") {
      options.status = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--gws-bin") {
      options.gwsBin = expandHome(readOptionValue(args, index, "--gws-bin"));
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!service) {
      service = arg.toLowerCase();
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { service, options };
}

async function writeGoogleConnection(target, { gwsBin, versionText }) {
  const connectionDir = path.join(target, "connections", "apis");
  await fs.mkdir(connectionDir, { recursive: true });
  await fs.writeFile(
    path.join(connectionDir, "google-workspace.md"),
    googleConnectionDoc({ gwsBin, versionText })
  );

  await updateConnectionsRegistry(path.join(target, "connections", "registry.md"));

  const skillDir = path.join(target, "skills", "google-workspace");
  await fs.mkdir(skillDir, { recursive: true });
  await writeIfMissing(path.join(skillDir, "SKILL.md"), googleWorkspaceSkill());
  await updateSkillRegistry(path.join(target, "skills", "_registry.json"), "google-workspace");
}

async function updateConnectionsRegistry(registryPath) {
  const row = "| Google Workspace | Active | Auth managed by `gws`; read-first Gmail and Calendar connection verified. |";
  const header = "# Connections\n\n| Service | Status | Notes |\n|---|---|---|\n";
  let content;
  try {
    content = await fs.readFile(registryPath, "utf8");
  } catch {
    content = header;
  }

  if (!content.includes("| Service | Status | Notes |")) {
    content = header;
  }

  const lines = content.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0);
  const rowIndex = lines.findIndex((line) => line.startsWith("| Google Workspace |"));
  if (rowIndex >= 0) {
    lines[rowIndex] = row;
  } else {
    lines.push(row);
  }

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${lines.join("\n")}\n`);
}

async function updateSkillRegistry(registryPath, skillName) {
  let registry = { skills: [] };
  try {
    registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  } catch {
    registry = { skills: [] };
  }

  registry.skills = Array.from(new Set([...(registry.skills || []), skillName])).sort();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function writeIfMissing(filePath, content) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content);
  }
}

function googleConnectionDoc({ gwsBin, versionText }) {
  return `# Google Workspace

Status: Active
Tool: ${versionText}
Binary: \`${gwsBin}\`
Auth: managed by \`gws\`, outside DotAIOS

DotAIOS does not store Google OAuth credentials. Keep secrets out of chat, context, memory, and vault files.

## Verify

\`\`\`bash
gws auth status
dotaios connect google --status
dotaios google status
\`\`\`

## Read-First Commands

\`\`\`bash
dotaios google inbox
dotaios google gmail search "from:alice@example.com newer_than:7d"
dotaios google gmail read <message-id>
dotaios google agenda --today
dotaios google calendar prep --today
dotaios google agenda --week
dotaios google drive --page-size 10
dotaios google drive find "budget"
\`\`\`

## Safety

- Reading Gmail, Calendar, Drive, Docs, and Sheets is allowed when the user asks.
- Sending email, replying, forwarding, labeling, moving mail, creating events, or editing docs/sheets requires explicit approval first.
- Do not paste OAuth client secrets, refresh tokens, or credential files into agent chat.
`;
}

function googleWorkspaceSkill() {
  return `---
name: google-workspace
description: "Use the local gws CLI for read-first Gmail, Calendar, Drive, Docs, and Sheets workflows."
---

# Google Workspace

Use \`gws\` for Google Workspace access. DotAIOS does not store Google credentials; auth is managed by \`gws\`.

## Before Use

\`\`\`bash
gws auth status
\`\`\`

If auth is not ready, ask the user to run:

\`\`\`bash
gws auth login
\`\`\`

## Safe Read-First Commands

\`\`\`bash
dotaios google inbox
dotaios google gmail search "from:alice@example.com newer_than:7d"
dotaios google gmail read <message-id>
dotaios google agenda --today
dotaios google calendar prep --today
dotaios google agenda --week
dotaios google drive --page-size 10
dotaios google drive find "budget"
\`\`\`

Use \`--json\` on safe read commands when another agent or MCP client needs structured output.

## Source Attribution

When using Google output in an answer, name the source service and command, such as:

- Source: Gmail via \`dotaios google gmail search\`
- Source: Calendar via \`dotaios google calendar prep\`
- Source: Drive via \`dotaios google drive find\`

## Approval Rules

- Ask before sending, replying, forwarding, labeling, archiving, or deleting email.
- Ask before creating, editing, moving, or deleting calendar events.
- Ask before writing to Docs, Sheets, or Drive.
- Ask before saving Google-derived facts into \`context/\`, \`vault/wiki/\`, \`vault/org/\`, or CRM notes.
- Never request or expose OAuth client secrets, refresh tokens, or credential files in chat.
`;
}

function printReadFirstScope() {
  console.log("\nRead-first beta scope");
  console.log("- Gmail triage/search and message reading");
  console.log("- Calendar agenda and meeting prep");
  console.log("- Drive/Docs/Sheets lookup when needed");
  console.log("- Send/write actions require explicit approval");
}

function printGwsGuidance() {
  console.log("\nInstall or expose the Google Workspace CLI (`gws`) first.");
  console.log("Reference: https://github.com/googleworkspace/cli");
  console.log("Then authenticate with `gws auth login` and verify with `gws auth status`.");
}

function printAuthGuidance() {
  console.log("\nNext steps:");
  console.log("1. Run `gws auth login`.");
  console.log("2. Complete the browser OAuth flow.");
  console.log("3. Run `gws auth status`.");
  console.log("4. Run `dotaios connect google` again.");
}

// --- Gemini CLI ---

async function connectGemini(aiosPath, options) {
  const geminiDir = path.join(os.homedir(), ".gemini");
  const detected = await dirExists(geminiDir);

  console.log("DotAIOS → Gemini CLI");
  console.log(`AIOS path: ${aiosPath}`);
  console.log(detected ? `[ok] ~/.gemini found` : `[warn] ~/.gemini not found — Gemini CLI may not be installed`);

  if (options.dryRun) {
    console.log("\nWould write:");
    console.log("  ~/.gemini/GEMINI.md  — DotAIOS context bridge");
    console.log("  ~/.gemini/settings.json  — SessionStart hook + MCP server entry");
    return;
  }

  await fs.mkdir(geminiDir, { recursive: true });

  // Write GEMINI.md bridge
  const geminiMdPath = path.join(geminiDir, "GEMINI.md");
  await writeGeminiBridge(geminiMdPath, aiosPath);
  console.log("[ok] ~/.gemini/GEMINI.md");

  // Write hook script
  const hookScriptPath = path.join(geminiDir, "dotaios-context-hook.sh");
  await writeGeminiHookScript(hookScriptPath, aiosPath);
  await fs.chmod(hookScriptPath, 0o755);
  console.log("[ok] ~/.gemini/dotaios-context-hook.sh");

  // Merge settings.json
  const settingsPath = path.join(geminiDir, "settings.json");
  await mergeGeminiSettings(settingsPath, hookScriptPath, aiosPath);
  console.log("[ok] ~/.gemini/settings.json (SessionStart hook + MCP server)");

  await appendEvent(path.join(aiosPath, "memory", "events.jsonl"), {
    type: "connection",
    summary: "Connected Gemini CLI via SessionStart hook and MCP",
    source: "dotaios connect gemini",
    connection: "gemini-cli"
  });

  console.log("\nGemini CLI connected.");
  console.log("Every session start will inject your DotAIOS working context automatically.");
  console.log("MCP tools available: read_session_digest, read_context, list_skills, search_memory");
}

async function writeGeminiBridge(filePath, aiosPath) {
  const content = `# DotAIOS Context

Your personal AI operating system is at \`${aiosPath}\`.

- Full context guide: \`${aiosPath}/AGENTS.md\`
- Skills index: \`${aiosPath}/skills/INDEX.md\`
- Working memory: call \`read_session_digest\` MCP tool or run \`dotaios brief --compact\`

MCP tools: \`read_session_digest\` · \`read_context\` · \`list_skills\` · \`search_memory\` · \`search_vault\` · \`log_event\`
`;
  await fs.writeFile(filePath, content, "utf8");
}

async function writeGeminiHookScript(scriptPath, aiosPath) {
  const content = `#!/usr/bin/env bash
# DotAIOS context injection for Gemini CLI SessionStart
# Injects working memory digest as the first context turn.
npx dotaios brief --compact --json --path "${aiosPath}" 2>/dev/null || echo '{}'
`;
  await fs.writeFile(scriptPath, content, "utf8");
}

async function mergeGeminiSettings(settingsPath, hookScriptPath, aiosPath) {
  let settings = {};
  let raw = null;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      throw new Error(`Existing ${settingsPath} is not valid JSON. Fix or remove it, then retry — refusing to overwrite it.`);
    }
  }

  // Merge SessionStart hook (preserve any existing hooks)
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];

  const hookEntry = {
    hooks: [{ type: "command", command: hookScriptPath, name: "dotaios-context", timeout: 10000 }]
  };
  const alreadyInstalled = settings.hooks.SessionStart.some(
    (h) => Array.isArray(h.hooks) && h.hooks.some((hh) => hh.name === "dotaios-context")
  );
  if (!alreadyInstalled) {
    settings.hooks.SessionStart.push(hookEntry);
  }

  // Merge MCP server entry
  if (!settings.mcp) settings.mcp = {};
  if (!settings.mcp.servers) settings.mcp.servers = {};
  settings.mcp.servers["dotaios"] = {
    command: "npx",
    args: ["dotaios-mcp", "--path", aiosPath]
  };

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// --- OpenCode ---

async function connectOpenCode(aiosPath, options) {
  const opencodeConfigDir = path.join(os.homedir(), ".config", "opencode");
  const detected = await dirExists(opencodeConfigDir);

  console.log("DotAIOS → OpenCode");
  console.log(`AIOS path: ${aiosPath}`);
  console.log(detected ? `[ok] ~/.config/opencode found` : `[info] ~/.config/opencode not found — will create`);

  if (options.dryRun) {
    console.log("\nWould write:");
    console.log("  ~/.config/opencode/opencode.json  — MCP server entry");
    console.log("  ~/.config/opencode/skills/<name>.md  — skill stubs for each installed skill");
    return;
  }

  await fs.mkdir(opencodeConfigDir, { recursive: true });

  // Merge opencode.json
  const opencodeJsonPath = path.join(opencodeConfigDir, "opencode.json");
  await mergeOpenCodeSettings(opencodeJsonPath, aiosPath);
  console.log("[ok] ~/.config/opencode/opencode.json (MCP server entry)");

  // Write skill stubs
  const skillsDir = path.join(aiosPath, "skills");
  const stubsDir = path.join(opencodeConfigDir, "skills");
  await fs.mkdir(stubsDir, { recursive: true });
  const count = await writeOpenCodeSkillStubs(skillsDir, stubsDir, aiosPath);
  console.log(`[ok] ~/.config/opencode/skills/ (${count} skill stub(s))`);

  await appendEvent(path.join(aiosPath, "memory", "events.jsonl"), {
    type: "connection",
    summary: "Connected OpenCode via MCP and skill stubs",
    source: "dotaios connect opencode",
    connection: "opencode"
  });

  console.log("\nOpenCode connected.");
  console.log("MCP tools available: read_session_digest, read_context, list_skills, search_memory");
  console.log("Skills accessible via /skill <name> in OpenCode.");
}

async function mergeOpenCodeSettings(settingsPath, aiosPath) {
  let settings = {};
  let raw = null;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      throw new Error(`Existing ${settingsPath} is not valid JSON. Fix or remove it, then retry — refusing to overwrite it.`);
    }
  }

  if (!settings.mcp) settings.mcp = {};
  if (!settings.mcp.servers) settings.mcp.servers = {};
  settings.mcp.servers["dotaios"] = {
    type: "local",
    command: "npx",
    args: ["dotaios-mcp", "--path", aiosPath]
  };

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function writeOpenCodeSkillStubs(skillsDir, stubsDir, aiosPath) {
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
    let skillMd;
    try {
      skillMd = await fs.readFile(skillMdPath, "utf8");
    } catch {
      continue;
    }

    const nameMatch = skillMd.match(/^name:\s*(.+)$/m);
    const descMatch = skillMd.match(/^description:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : entry.name;
    const description = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : `Run the ${entry.name} skill`;

    const stub = `---
name: ${name}
description: ${description}
---

Read \`${aiosPath}/skills/${entry.name}/SKILL.md\` and follow the steps exactly.
`;
    await fs.writeFile(path.join(stubsDir, `${entry.name}.md`), stub, "utf8");
    count++;
  }
  return count;
}

async function dirExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
