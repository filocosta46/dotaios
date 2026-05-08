import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../../core/src/memory.mjs";
import { expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { assertAiosFolder, assessGwsAuth, firstLine, printCaptured, resolveAiosTarget, resolveGwsBinary, runGws } from "../lib/gws.mjs";

const googleAliases = new Set(["google", "gmail", "gws"]);

export async function connectCommand(args) {
  if (hasHelpFlag(args)) {
    printConnectHelp();
    return;
  }

  const { service, options } = parseOptions(args);
  if (!service) {
    throw new Error("Usage: dotaios connect google [--dry-run|--status]");
  }

  if (!googleAliases.has(service)) {
    throw new Error(`Unsupported connection: ${service}. Supported connections: google`);
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
  dotaios connect google [options]

Options:
  --path <dir>     Use a non-default AIOS folder
  --gws-bin <bin>  Use a specific gws binary
  --dry-run        Show what would be checked and written
  --status         Verify gws and auth without writing files

Examples:
  dotaios connect google --dry-run
  dotaios connect google --status
  dotaios connect google
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
dotaios google agenda --today
dotaios google agenda --week
dotaios google drive --page-size 10
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
dotaios google agenda --today
dotaios google agenda --week
dotaios google drive --page-size 10
\`\`\`

## Approval Rules

- Ask before sending, replying, forwarding, labeling, archiving, or deleting email.
- Ask before creating, editing, moving, or deleting calendar events.
- Ask before writing to Docs, Sheets, or Drive.
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
