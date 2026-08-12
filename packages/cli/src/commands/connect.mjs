import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendEvent } from "../../../core/src/memory.mjs";
import { expandHome } from "../../../core/src/paths.mjs";
import {
  assertSafeGeminiAiosPath,
  mergeGeminiSettings,
  writeGeminiBridge,
  writeGeminiHookScript
} from "../adapters/gemini.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { mcpLauncher } from "../lib/mcp-launcher.mjs";
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

export async function connectCommand(args) {
  if (hasHelpFlag(args)) {
    printConnectHelp();
    return;
  }

  const { service, options } = parseOptions(args);
  if (!service) {
    throw new Error("Usage: dotaios connect google [--dry-run|--status]");
  }
  if (options.status && !googleAliases.has(service)) {
    throw new Error("The --status option is supported only for `dotaios connect google`.");
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
  console.log("[ok] memory/events.jsonl");
  printReadFirstScope();
}

function printConnectHelp() {
  console.log(`Usage:
  dotaios connect <service> [options]

Services:
  google      Connect optional Google Workspace reads via gws
  gemini      Connect Gemini CLI with GEMINI.md and a SessionStart hook
  opencode    Connect OpenCode MCP

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

function googleConnectionDoc({ versionText }) {
  return `# Google Workspace

Status: Active
Connection: Optional; Google is not required for DotAIOS
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
  assertSafeGeminiAiosPath(aiosPath);
  const geminiDir = path.join(os.homedir(), ".gemini");
  const detected = await dirExists(geminiDir);

  console.log("DotAIOS → Gemini CLI");
  console.log(`AIOS path: ${aiosPath}`);
  console.log(detected ? `[ok] ~/.gemini found` : `[warn] ~/.gemini not found — Gemini CLI may not be installed`);

  if (options.dryRun) {
    console.log("\nWould write:");
    console.log("  ~/.gemini/GEMINI.md  — DotAIOS context bridge");
    console.log("  ~/.gemini/settings.json: SessionStart hook");
    console.log("  ~/.gemini/dotaios-context-hook.sh  — pinned context command");
    return;
  }

  await fs.mkdir(geminiDir, { recursive: true });

  const geminiMdPath = path.join(geminiDir, "GEMINI.md");
  const hookScriptPath = path.join(geminiDir, "dotaios-context-hook.sh");
  const settingsPath = path.join(geminiDir, "settings.json");

  // All three artifacts share this parent. Refuse an unsafe home/.gemini path
  // before touching settings, the bridge, or the hook so a symlinked client
  // directory cannot redirect a partial install outside the user's home.
  await writeGeminiBridge(geminiMdPath, aiosPath, {
    boundaryRoot: os.homedir(),
    preflightOnly: true
  });
  await writeGeminiHookScript(hookScriptPath, aiosPath, {
    boundaryRoot: os.homedir(),
    preflightOnly: true
  });
  await mergeGeminiSettings(settingsPath, hookScriptPath, aiosPath, {
    boundaryRoot: os.homedir(),
    preflightOnly: true
  });

  // Publish the inert artifacts first. settings.json is the activation point,
  // so it is written last and never points at an absent or refused hook.
  await writeGeminiHookScript(hookScriptPath, aiosPath, { boundaryRoot: os.homedir() });
  console.log("[ok] ~/.gemini/dotaios-context-hook.sh");

  await writeGeminiBridge(geminiMdPath, aiosPath);
  console.log("[ok] ~/.gemini/GEMINI.md");

  await mergeGeminiSettings(settingsPath, hookScriptPath, aiosPath, { boundaryRoot: os.homedir() });
  console.log("[ok] ~/.gemini/settings.json (SessionStart hook)");

  await appendEvent(path.join(aiosPath, "memory", "events.jsonl"), {
    type: "connection",
    summary: "Configured Gemini CLI SessionStart hook; invocation unverified",
    source: "dotaios connect gemini",
    connection: "gemini-cli"
  });

  console.log("\nGemini CLI configured; invocation is not yet verified.");
  // docs/client-support.md records that Gemini CLI could not produce an
  // invocation receipt in the bounded probe. Writing a hook file proves the
  // configuration, never that the client runs it — claiming otherwise is the
  // exact overclaim this project refuses to make about every other client.
  console.log("A SessionStart hook is installed. Whether your Gemini version runs it is client-side behaviour —");
  console.log("check the start of your next session to confirm your context arrives.");
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
    console.log("Native skills remain in ~/.agents/skills, managed by `dotaios activate`.");
    return;
  }

  await fs.mkdir(opencodeConfigDir, { recursive: true });

  // Merge opencode.json
  const opencodeJsonPath = path.join(opencodeConfigDir, "opencode.json");
  await mergeOpenCodeSettings(opencodeJsonPath, aiosPath);
  console.log("[ok] ~/.config/opencode/opencode.json (MCP server entry)");

  await appendEvent(path.join(aiosPath, "memory", "events.jsonl"), {
    type: "connection",
    summary: "Configured OpenCode MCP",
    source: "dotaios connect opencode",
    connection: "opencode"
  });

  console.log("\nOpenCode configured.");
  console.log("Read-only MCP tools available: read_working_context, search_aios, resolve_skill");
  console.log("Native skills use the shared ~/.agents/skills target from `dotaios activate`.");
}

export async function mergeOpenCodeSettings(settingsPath, aiosPath) {
  let settings = {};
  let raw = null;
  try {
    raw = await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(
        `Could not read existing ${settingsPath} (${error?.code || "read error"}). Refusing to overwrite it.`
      );
    }
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      throw new Error(`Existing ${settingsPath} is not valid JSON. Fix or remove it, then retry — refusing to overwrite it.`);
    }
  }

  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Existing ${settingsPath} must contain a JSON object. Fix it, then retry — refusing to overwrite it.`);
  }
  if (
    settings.mcp != null
    && (typeof settings.mcp !== "object" || Array.isArray(settings.mcp))
  ) {
    throw new Error(`Existing ${settingsPath} mcp field must contain a JSON object. Fix it, then retry — refusing to overwrite it.`);
  }

  if (!settings.mcp) settings.mcp = {};
  const legacyServers = settings.mcp.servers;
  if (
    legacyServers != null
    && (typeof legacyServers !== "object" || Array.isArray(legacyServers))
  ) {
    throw new Error(
      `Existing ${settingsPath} has an invalid legacy mcp.servers value. Fix or remove it, then retry; refusing to write an invalid OpenCode configuration.`
    );
  }
  const legacyEntry = legacyServers?.dotaios;
  if (legacyEntry != null) {
    const foreignNames = Object.keys(legacyServers).filter((name) => name !== "dotaios");
    if (foreignNames.length > 0) {
      throw new Error(
        `Existing ${settingsPath} uses legacy mcp.servers entries (${foreignNames.join(", ")}). Move them to current mcp.<name> entries, then retry; refusing to write an invalid OpenCode configuration.`
      );
    }
    if (!isManagedLegacyOpenCodeEntry(legacyEntry)) {
      throw new Error(
        `Existing ${settingsPath} has an unrecognized legacy mcp.servers.dotaios entry. Move or remove it, then retry; refusing to overwrite it.`
      );
    }
    delete settings.mcp.servers;
  } else if (
    legacyServers
    && typeof legacyServers === "object"
    && !Array.isArray(legacyServers)
    && Object.keys(legacyServers).length === 0
  ) {
    delete settings.mcp.servers;
  } else if (legacyServers != null) {
    throw new Error(
      `Existing ${settingsPath} uses legacy mcp.servers entries (${Object.keys(legacyServers).join(", ")}). Move them to current mcp.<name> entries, then retry; refusing to write an invalid OpenCode configuration.`
    );
  }

  if (
    settings.mcp.dotaios != null
    && !isManagedCurrentOpenCodeEntry(settings.mcp.dotaios)
  ) {
    throw new Error(
      `Existing ${settingsPath} has an unrecognized mcp.dotaios entry. Move or remove it, then retry; refusing to overwrite it.`
    );
  }
  const launcher = mcpLauncher(aiosPath);
  settings.mcp.dotaios = {
    type: "local",
    command: [launcher.command, ...launcher.args],
    enabled: true
  };

  await writePrivateJsonAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function isManagedLegacyOpenCodeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!hasOnlyKeys(entry, new Set(["type", "command", "args", "enabled"]))) return false;
  if (entry.type !== "local" || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
    return false;
  }
  return (
    (
      isNodeExecutable(entry.command)
      && entry.args.length === 3
      && typeof entry.args[0] === "string"
      && /packages[\\/]mcp[\\/]src[\\/]server\.mjs$/.test(entry.args[0])
      && entry.args[1] === "--path"
      && typeof entry.args[2] === "string"
    )
    || isPinnedDotaiosLauncher([entry.command, ...entry.args])
  );
}

function isManagedCurrentOpenCodeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!hasOnlyKeys(entry, new Set(["type", "command", "enabled"]))) return false;
  if (entry.type !== "local" || !Array.isArray(entry.command)) return false;
  if (isPinnedDotaiosLauncher(entry.command)) return true;
  return (
    entry.command.length === 4
    && isNodeExecutable(entry.command[0])
    && typeof entry.command[1] === "string"
    && /packages[\\/]mcp[\\/]src[\\/]server\.mjs$/.test(entry.command[1])
    && entry.command[2] === "--path"
    && typeof entry.command[3] === "string"
  );
}

function isPinnedDotaiosLauncher(command) {
  if (!Array.isArray(command) || command.length !== 7) return false;
  return (
    command[0] === "npx"
    && command[1] === "--yes"
    && command[2] === "--package"
    && /^dotaios@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(command[3] || "")
    && command[4] === "dotaios-mcp"
    && command[5] === "--path"
    && typeof command[6] === "string"
  );
}

function isNodeExecutable(command) {
  return typeof command === "string" && /^node(?:\.exe)?$/i.test(path.basename(command));
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

async function writePrivateJsonAtomic(settingsPath, content) {
  let mode = 0o600;
  try {
    const stat = await fs.lstat(settingsPath);
    if (!stat.isFile()) {
      throw new Error(`Existing ${settingsPath} is not a regular file. Refusing to overwrite it.`);
    }
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(settingsPath),
    `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle = null;
  try {
    handle = await fs.open(tempPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, settingsPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function dirExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
