import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent } from "../../../core/src/memory.mjs";
import { expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import {
  GWS_READ_ONLY_SCOPES,
  GWS_READ_ONLY_SERVICES,
  assertAiosFolder,
  assessGwsAuth,
  firstLine,
  gwsReadOnlyLoginCommand,
  printCaptured,
  resolveAiosTarget,
  resolveGwsBinary,
  runGws,
  safeGwsVersion
} from "../lib/gws.mjs";

const googleAliases = new Set(["google", "gmail", "gws"]);
const geminiAliases = new Set(["gemini", "gemini-cli"]);
const opencodeAliases = new Set(["opencode"]);
const mcpServerPath = fileURLToPath(new URL("../../../mcp/src/server.mjs", import.meta.url));

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
    throw new Error(`Google Workspace auth is not ready. Run \`${gwsReadOnlyLoginCommand()}\`, then retry \`dotaios connect google --status\`.`);
  }

  console.log("[ok] gws auth status");
  console.log(`      ${authState.summary}`);

  if (options.status) {
    console.log("\nGoogle Workspace looks ready for DotAIOS.");
    printReadFirstScope();
    return;
  }

  const versionText = safeGwsVersion(firstLine(version.stdout));
  await writeGoogleConnection(target, { versionText });
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
  google      Connect optional Google Workspace reads via gws
  gemini      Connect Gemini CLI with GEMINI.md and a SessionStart hook
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

async function writeGoogleConnection(target, { versionText }) {
  const connectionDir = path.join(target, "connections", "apis");
  await fs.mkdir(connectionDir, { recursive: true });
  await fs.writeFile(
    path.join(connectionDir, "google-workspace.md"),
    googleConnectionDoc({ versionText })
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

function googleConnectionDoc({ versionText }) {
  return `# Google Workspace

Status: Active
Connection: Optional; no paid DotAIOS package required
Tool: gws
Version: ${versionText || "unknown"}
Auth: managed by \`gws\`, outside DotAIOS
Services: ${GWS_READ_ONLY_SERVICES.join(", ")}
Requested OAuth scopes: ${GWS_READ_ONLY_SCOPES.join(", ")}

DotAIOS does not store Google OAuth credentials or record the resolved \`gws\` binary path. Google and \`gws\` process Workspace data; DotAIOS only invokes the local CLI for the explicit read commands below. The setup requests read-only scopes, but \`gws auth status\` does not prove the scopes of an existing grant. Re-authenticate with the fixed command if a broader grant must be removed. Keep secrets out of chat, context, memory, and vault files.

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

- Reading Gmail, Calendar, and Drive through the listed wrappers is allowed when the user asks.
- Sending email, changing mail, creating events, or writing Drive content is outside this connection's scope.
- Do not paste OAuth client secrets, refresh tokens, or credential files into agent chat.
`;
}

function googleWorkspaceSkill() {
  return `---
name: google-workspace
description: "Use the local gws CLI for optional, read-first Gmail, Calendar, and Drive workflows."
---

# Google Workspace

Use \`gws\` for Google Workspace access. DotAIOS does not store Google credentials; auth is managed by \`gws\`. This optional connection exposes only DotAIOS read-first Gmail, Calendar, and Drive workflows. The requested OAuth scopes are read-only, but an existing grant's scope is not verified by \`gws auth status\`.

## Before Use

\`\`\`bash
gws auth status
\`\`\`

If auth is not ready, ask the user to run:

\`\`\`bash
${gwsReadOnlyLoginCommand()}
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

Use \`--json\` on safe read commands when an agent or local automation needs structured output.

## Source Attribution

When using Google output in an answer, name the source service and command, such as:

- Source: Gmail via \`dotaios google gmail search\`
- Source: Calendar via \`dotaios google calendar prep\`
- Source: Drive via \`dotaios google drive find\`

## Approval Rules

- Ask before sending, replying, forwarding, labeling, archiving, or deleting email.
- Ask before creating, editing, moving, or deleting calendar events.
- Do not use raw \`gws\` write commands through this DotAIOS connection. DotAIOS does not expose them, and an existing \`gws\` grant may have broader scopes than the requested setup.
- Ask before saving Google-derived facts into \`context/\`, \`vault/wiki/\`, \`vault/org/\`, or CRM notes.
- Never request or expose OAuth client secrets, refresh tokens, or credential files in chat.
`;
}

function printReadFirstScope() {
  console.log("\nRead-first beta scope");
  console.log("- Fixed services: Gmail, Calendar, Drive");
  console.log("- OAuth request: read-only (existing grant scopes are not verified by gws status)");
  console.log("- No send, edit, delete, or custom-scope commands");
}

function printGwsGuidance() {
  console.log("\nInstall or expose the Google Workspace CLI (`gws`) first.");
  console.log("Reference: https://github.com/googleworkspace/cli");
  console.log(`Then authenticate with \`${gwsReadOnlyLoginCommand()}\` and verify with \`gws auth status\`.`);
}

function printAuthGuidance() {
  console.log("\nNext steps:");
  console.log(`1. Run \`${gwsReadOnlyLoginCommand()}\`.`);
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
    console.log("  ~/.gemini/settings.json: SessionStart hook");
    return;
  }

  await fs.mkdir(geminiDir, { recursive: true });

  const geminiMdPath = path.join(geminiDir, "GEMINI.md");
  const hookScriptPath = path.join(geminiDir, "dotaios-context-hook.sh");
  const settingsPath = path.join(geminiDir, "settings.json");

  // Merge settings first: it validates an existing settings.json and aborts on a
  // malformed file before we write any other artifacts (no partial install).
  await mergeGeminiSettings(settingsPath, hookScriptPath, aiosPath);
  console.log("[ok] ~/.gemini/settings.json (SessionStart hook)");

  await writeGeminiBridge(geminiMdPath, aiosPath);
  console.log("[ok] ~/.gemini/GEMINI.md");

  await writeGeminiHookScript(hookScriptPath, aiosPath);
  await fs.chmod(hookScriptPath, 0o755);
  console.log("[ok] ~/.gemini/dotaios-context-hook.sh");

  await appendEvent(path.join(aiosPath, "memory", "events.jsonl"), {
    type: "connection",
    summary: "Connected Gemini CLI via SessionStart hook",
    source: "dotaios connect gemini",
    connection: "gemini-cli"
  });

  console.log("\nGemini CLI connected.");
  console.log("Every session start will inject your DotAIOS working context automatically.");
}

async function writeGeminiBridge(filePath, aiosPath) {
  const content = `# DotAIOS Context

Your personal AI operating system is at \`${aiosPath}\`.

- Full context guide: \`${aiosPath}/AGENTS.md\`
- Skills index: \`${aiosPath}/skills/INDEX.md\`
- Working memory: run \`dotaios brief --compact\`
`;
  await fs.writeFile(filePath, content, "utf8");
}

// Wrap a value in single quotes for safe use as a POSIX shell word. Any embedded
// single quote is closed, escaped, and reopened ('\''), so no metacharacter in
// the value (spaces, ", $, ;, backticks) can break out of the quoting. Used for
// the AIOS path that gets baked into the generated Gemini hook script.
export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildGeminiHookScript(aiosPath) {
  return `#!/usr/bin/env bash
# DotAIOS context injection for Gemini CLI SessionStart
# Injects working memory digest as the first context turn.
npx dotaios brief --compact --json --path ${shSingleQuote(aiosPath)} 2>/dev/null || echo '{}'
`;
}

async function writeGeminiHookScript(scriptPath, aiosPath) {
  await fs.writeFile(scriptPath, buildGeminiHookScript(aiosPath), "utf8");
}

export async function mergeGeminiSettings(settingsPath, hookScriptPath, aiosPath) {
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

  removeLegacyGeminiMcpEntry(settings);

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function removeLegacyGeminiMcpEntry(settings) {
  const entry = settings.mcp?.servers?.dotaios;
  if (entry?.command !== "npx" || !Array.isArray(entry.args) || entry.args[0] !== "dotaios-mcp") return;
  delete settings.mcp.servers.dotaios;
  if (Object.keys(settings.mcp.servers).length === 0) delete settings.mcp.servers;
  if (Object.keys(settings.mcp).length === 0) delete settings.mcp;
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
  console.log("Read-only MCP tools available: read_working_context, search_aios, resolve_skill");
  console.log("Skills accessible via /skill <name> in OpenCode.");
}

export async function mergeOpenCodeSettings(settingsPath, aiosPath) {
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
    command: process.execPath,
    args: [mcpServerPath, "--path", aiosPath]
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
