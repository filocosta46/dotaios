import fs from "node:fs/promises";
import path from "node:path";
import { MANAGED_END, MANAGED_START, bridgeManagedBlock, findManagedBlock } from "../../../core/src/bridges.mjs";
import {
  replaceFileIfUnchanged,
  validateManagedFilePath,
  writeFileSafe
} from "../../../core/src/files.mjs";
import { DOTAIOS_PACKAGE_VERSION } from "../lib/mcp-launcher.mjs";

const GEMINI_HOOK_MARKER = "# dotaios-managed: gemini-context-hook/v2";
const GEMINI_HOOK_DESCRIPTION = "# DotAIOS context selection for Gemini CLI BeforeAgent";
const GEMINI_HOOK_DETAIL = "# Selects session memory from the first user prompt before loading context.";
const GEMINI_LEGACY_HOOK_MARKER = "# dotaios-managed: gemini-context-hook/v1";
const GEMINI_LEGACY_HOOK_DESCRIPTION = "# DotAIOS context injection for Gemini CLI SessionStart";
const GEMINI_LEGACY_HOOK_DETAIL = "# Injects working memory digest as the first context turn.";
const GEMINI_HOOK_PATH_PREFIX = "# dotaios-aios-path-base64: ";
const GEMINI_HOOK_MODULE_PREFIX = "# dotaios-hook-module-base64: ";
const GEMINI_HOOK_MODULE_URL = new URL("../lib/gemini-memory-hook.mjs", import.meta.url).href;

export function assertSafeGeminiAiosPath(aiosPath) {
  if (/[\0-\x1f\x7f]/.test(aiosPath)) {
    throw new Error("Gemini connection does not support AIOS paths containing control characters or line breaks.");
  }
}


// A Gemini user may already have instructions in GEMINI.md. DotAIOS owns only
// one complete managed block and preserves every byte around it.
export async function writeGeminiBridge(
  filePath,
  aiosPath,
  {
    boundaryRoot = path.dirname(path.dirname(filePath)),
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null,
    beforeRename = null,
    preflightOnly = false
  } = {}
) {
  const stats = await validateManagedFilePath(filePath, boundaryRoot);
  // The same block `activate` writes, from its one owner. A second body here
  // meant whichever of the two commands ran last silently replaced the other's,
  // and connect's older body reinstated the always-on shape this release removed.
  const block = await bridgeManagedBlock(aiosPath);
  if (!stats) {
    if (preflightOnly) return { action: "would-create" };
    const created = await writeFileSafe(filePath, `# DotAIOS Context\n\n${block}\n`, "preserve", {
      boundaryRoot
    });
    if (created.action !== "created") {
      throw new Error(`Could not create ${filePath}: it changed during connect. Existing file kept.`);
    }
    return { action: "created" };
  }

  let existingBytes;
  try {
    existingBytes = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(
      `Could not read existing ${filePath} (${error?.code || "read error"}). Refusing to overwrite it.`
    );
  }
  const existing = existingBytes.toString("utf8");
  if (!Buffer.from(existing, "utf8").equals(existingBytes)) {
    throw new Error(`Could not update ${filePath}: existing file is not valid UTF-8. Existing bytes kept.`);
  }

  const managed = findManagedBlock(existing);
  let updated;
  let action;
  if (managed) {
    updated = existing.slice(0, managed.start) + block + existing.slice(managed.end);
    if (updated === existing) return { action: "unchanged" };
    action = "updated";
  } else if (existing.includes(MANAGED_START) || existing.includes(MANAGED_END)) {
    throw new Error(`Could not update ${filePath}: managed markers are malformed. Existing file kept.`);
  } else {
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    updated = `${existing}${separator}${block}\n`;
    action = "appended";
  }

  if (preflightOnly) return { action: `would-${action}` };

  const result = await replaceFileIfUnchanged(filePath, existing, updated, {
    boundaryRoot,
    beforeReplace,
    beforePublish,
    beforeCommit,
    beforeRename,
    expectedBytes: existingBytes,
    expectedStats: stats,
    mode: stats.mode & 0o777
  });
  if (!result.replaced) {
    throw new Error(`Could not update ${filePath}: it changed during connect. Concurrent edit kept.`);
  }
  return { action, ...(result.preservedPath ? { preservedPath: result.preservedPath } : {}) };
}

// Wrap a value in single quotes for safe use as a POSIX shell word. Embedded
// single quotes are closed, escaped, and reopened.
export function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildGeminiHookScript(aiosPath) {
  return buildGeminiHookScriptVersion(aiosPath, {
    moduleUrl: GEMINI_HOOK_MODULE_URL,
    packageVersion: DOTAIOS_PACKAGE_VERSION
  });
}

function buildGeminiHookScriptVersion(aiosPath, { moduleUrl, packageVersion }) {
  assertSafeGeminiAiosPath(aiosPath);
  const encodedPath = Buffer.from(aiosPath, "utf8").toString("base64");
  const encodedModule = Buffer.from(moduleUrl, "utf8").toString("base64");
  const fallback = JSON.stringify({
    systemMessage: "Memory: Closed — DotAIOS could not verify the session mode, so it left memory closed.",
    hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "" },
    dotaiosMemory: { mode: "closed", project: null }
  });
  const privateClassifier = `let readGeminiHookInput;
let resolveGeminiPrivateHookOutput;
try {
  ({ readGeminiHookInput, resolveGeminiPrivateHookOutput } = await import(${JSON.stringify(moduleUrl)}));
} catch {
  process.exit(3);
}
try {
  const input = await readGeminiHookInput();
  const output = await resolveGeminiPrivateHookOutput(input);
  if (!output) process.exit(3);
  process.stdout.write(JSON.stringify(output) + "\\n");
} catch {
  process.exit(2);
}`;
  const validator = `import fs from "node:fs";
const raw = fs.readFileSync(0, "utf8");
const value = JSON.parse(raw);
if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid hook envelope");
if (typeof value.systemMessage !== "string" || !value.systemMessage.startsWith("Memory: ")) throw new Error("missing visible receipt");
const hook = value.hookSpecificOutput;
if (!hook || typeof hook !== "object" || Array.isArray(hook) || typeof hook.additionalContext !== "string") throw new Error("invalid hook output");
if (!["BeforeAgent", "SessionStart"].includes(hook.hookEventName)) throw new Error("invalid hook event");
if (hook.hookEventName === "BeforeAgent") {
  const memory = value.dotaiosMemory;
  if (!memory || !["shared", "project", "off"].includes(memory.mode)) throw new Error("invalid memory receipt");
  const receipt = memory.mode === "shared" ? "Memory: Shared" : memory.mode === "project" ? "Memory: This project" : "Memory: Off";
  if (!value.systemMessage.startsWith(receipt) || !hook.additionalContext.startsWith(receipt)) throw new Error("inconsistent memory receipt");
  if ((memory.mode === "project") !== (typeof memory.project === "string" && memory.project.length > 0)) throw new Error("invalid project receipt");
}
process.stdout.write(JSON.stringify(value) + "\\n");`;
  return `#!/usr/bin/env bash
${GEMINI_HOOK_MARKER}
${GEMINI_HOOK_DESCRIPTION}
${GEMINI_HOOK_DETAIL}
${GEMINI_HOOK_PATH_PREFIX}${encodedPath}
${GEMINI_HOOK_MODULE_PREFIX}${encodedModule}
input="$(cat)"
private_output="$(printf '%s' "$input" | node --input-type=module -e ${shSingleQuote(privateClassifier)})"
private_status=$?
if [ "$private_status" -eq 0 ]; then
  printf '%s\\n' "$private_output"
  exit 0
fi
if [ "$private_status" -ne 3 ]; then
  printf '%s\\n' ${shSingleQuote(fallback)}
  exit 0
fi
output="$(printf '%s' "$input" | (cd / && npx -y --loglevel=error --package ${shSingleQuote(`dotaios@${packageVersion}`)} dotaios brief --compact --json --path ${shSingleQuote(aiosPath)} --gemini-hook))"
status=$?
if [ "$status" -eq 0 ] && printf '%s' "$output" | node --input-type=module -e ${shSingleQuote(validator)}; then
  exit 0
fi
printf '%s\\n' ${shSingleQuote(fallback)}
`;
}

export async function writeGeminiHookScript(
  scriptPath,
  aiosPath,
  {
    boundaryRoot = path.dirname(scriptPath),
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null,
    beforeRename = null,
    preflightOnly = false
  } = {}
) {
  const stats = await validateManagedFilePath(scriptPath, boundaryRoot);
  const updated = buildGeminiHookScript(aiosPath);
  if (!stats) {
    if (preflightOnly) return { action: "would-create" };
    const created = await writeFileSafe(scriptPath, updated, "preserve", {
      boundaryRoot,
      mode: 0o700
    });
    if (created.action !== "created") {
      throw new Error(`Could not create ${scriptPath}: it changed during connect. Existing file kept.`);
    }
    return { action: "created" };
  }

  let existingBytes;
  try {
    existingBytes = await fs.readFile(scriptPath);
  } catch (error) {
    throw new Error(
      `Could not read existing ${scriptPath} (${error?.code || "read error"}). Refusing to overwrite it.`
    );
  }
  const existing = existingBytes.toString("utf8");
  if (!Buffer.from(existing, "utf8").equals(existingBytes)) {
    throw new Error(`Existing ${scriptPath} is not valid UTF-8. Refusing to overwrite it.`);
  }
  const lines = existing.split("\n");
  const managedCurrent = isCurrentGeminiHookScript(existing);
  const managedPrevious = lines.length === 6
    && lines[0] === "#!/usr/bin/env bash"
    && lines[1] === GEMINI_LEGACY_HOOK_MARKER
    && lines[2] === GEMINI_LEGACY_HOOK_DESCRIPTION
    && lines[3] === GEMINI_LEGACY_HOOK_DETAIL
    && /^cd \/ && npx -y --loglevel=error dotaios@[0-9A-Za-z.+-]+ brief --compact --json --path [^\r\n]+$/.test(lines[4])
    && lines[5] === "";
  const managedLegacy = lines.length === 5
    && lines[0] === "#!/usr/bin/env bash"
    && lines[1] === GEMINI_LEGACY_HOOK_DESCRIPTION
    && lines[2] === GEMINI_LEGACY_HOOK_DETAIL
    && /^npx dotaios brief --compact --json --path [^\r\n]+ 2>\/dev\/null \|\| echo '\{\}'$/.test(lines[3])
    && lines[4] === "";
  if (!managedCurrent && !managedPrevious && !managedLegacy) {
    throw new Error(`Existing ${scriptPath} is not a DotAIOS-managed hook. Existing foreign script kept.`);
  }

  const targetMode = (stats.mode & 0o777) | 0o100;
  if (preflightOnly) return { action: existing === updated ? "unchanged" : "would-update" };
  if (existing === updated && (stats.mode & 0o100)) return { action: "unchanged" };

  const result = await replaceFileIfUnchanged(scriptPath, existing, updated, {
    boundaryRoot,
    beforeReplace,
    beforePublish,
    beforeCommit,
    beforeRename,
    expectedBytes: existingBytes,
    expectedStats: stats,
    backupMode: stats.mode & 0o777,
    mode: targetMode
  });
  if (!result.replaced) {
    throw new Error(`Could not update ${scriptPath}: it changed during connect. Concurrent edit kept.`);
  }
  return { action: "updated", ...(result.preservedPath ? { preservedPath: result.preservedPath } : {}) };
}

function isCurrentGeminiHookScript(content) {
  const encoded = content.split("\n").find((line) => line.startsWith(GEMINI_HOOK_PATH_PREFIX))
    ?.slice(GEMINI_HOOK_PATH_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const encodedModule = content.split("\n").find((line) => line.startsWith(GEMINI_HOOK_MODULE_PREFIX))
    ?.slice(GEMINI_HOOK_MODULE_PREFIX.length);
  if (!encodedModule || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedModule)) return false;
  let embeddedPath;
  let embeddedModule;
  try {
    embeddedPath = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.from(embeddedPath, "utf8").toString("base64") !== encoded) return false;
    embeddedModule = Buffer.from(encodedModule, "base64").toString("utf8");
    if (Buffer.from(embeddedModule, "utf8").toString("base64") !== encodedModule) return false;
  } catch {
    return false;
  }
  const versionMatch = /npx -y --loglevel=error --package 'dotaios@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)' dotaios brief --compact --json --path /.exec(content);
  if (!versionMatch) return false;
  return content === buildGeminiHookScriptVersion(embeddedPath, {
    moduleUrl: embeddedModule,
    packageVersion: versionMatch[1]
  });
}

export async function mergeGeminiSettings(
  settingsPath,
  hookScriptPath,
  aiosPath,
  {
    boundaryRoot = path.dirname(settingsPath),
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null,
    beforeRename = null,
    preflightOnly = false
  } = {}
) {
  const stats = await validateManagedFilePath(settingsPath, boundaryRoot);
  let settings = {};
  let rawBytes = null;
  let raw = null;
  if (stats) {
    try {
      rawBytes = await fs.readFile(settingsPath);
    } catch (error) {
      throw new Error(
        `Could not read existing ${settingsPath} (${error?.code || "read error"}). Refusing to overwrite it.`
      );
    }
    raw = rawBytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(rawBytes)) {
      throw new Error(`Existing ${settingsPath} is not valid UTF-8. Refusing to overwrite it.`);
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

  if (settings.hooks == null) {
    settings.hooks = {};
  } else if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error(`Existing ${settingsPath} hooks field must contain a JSON object. Fix it, then retry — refusing to overwrite it.`);
  }
  validateGeminiHooksConfig(settings.hooksConfig, settingsPath);
  validateGeminiHookGroups(settings.hooks.SessionStart, "SessionStart", settingsPath);
  validateGeminiHookGroups(settings.hooks.BeforeAgent, "BeforeAgent", settingsPath);

  const hookEntry = {
    matcher: "*",
    hooks: [{ type: "command", command: shSingleQuote(hookScriptPath), name: "dotaios-context", timeout: 10000 }]
  };
  const ownedHooks = [];
  for (const eventName of ["SessionStart", "BeforeAgent"]) {
    for (let groupIndex = 0; groupIndex < (settings.hooks[eventName] || []).length; groupIndex += 1) {
      const group = settings.hooks[eventName][groupIndex];
      for (let hookIndex = 0; hookIndex < group.hooks.length; hookIndex += 1) {
        if (group.hooks[hookIndex]?.name === "dotaios-context") {
          ownedHooks.push({ eventName, group, groupIndex, hookIndex });
        }
      }
    }
  }
  if (ownedHooks.filter(({ eventName }) => eventName === "SessionStart").length > 1
    || ownedHooks.filter(({ eventName }) => eventName === "BeforeAgent").length > 1) {
    throw new Error(`Existing ${settingsPath} contains multiple dotaios-context hooks. Remove the duplicate, then retry — refusing an ambiguous update.`);
  }
  for (const owned of ownedHooks) {
    if (!isRecognizedGeminiHookEntry(owned.group.hooks[owned.hookIndex], hookScriptPath)) {
      throw new Error(`Existing ${settingsPath} contains an unrecognized dotaios-context hook. Rename or remove it, then retry — refusing to assume ownership.`);
    }
  }

  const previous = ownedHooks.find(({ eventName }) => eventName === "SessionStart") || null;
  const current = ownedHooks.find(({ eventName }) => eventName === "BeforeAgent") || null;
  const migratedFields = previous ? previous.group.hooks[previous.hookIndex] : null;
  if (previous) {
    previous.group.hooks.splice(previous.hookIndex, 1);
    const groups = settings.hooks.SessionStart;
    if (previous.group.hooks.length === 0 && isManagedGeminiHookGroup(previous.group)) {
      groups.splice(previous.groupIndex, 1);
    }
    if (groups.length === 0) delete settings.hooks.SessionStart;
  }

  if (current) {
    current.group.hooks[current.hookIndex] = {
      ...current.group.hooks[current.hookIndex],
      ...hookEntry.hooks[0]
    };
  } else {
    settings.hooks.BeforeAgent ||= [];
    settings.hooks.BeforeAgent.push({
      ...hookEntry,
      hooks: [{ ...(migratedFields || {}), ...hookEntry.hooks[0] }]
    });
  }

  removeLegacyGeminiMcpEntry(settings, settingsPath);

  const updated = `${JSON.stringify(settings, null, 2)}\n`;
  if (updated === raw) return { action: "unchanged" };
  if (preflightOnly) return { action: stats ? "would-update" : "would-create" };
  if (!stats) {
    const created = await writeFileSafe(settingsPath, updated, "preserve", { boundaryRoot });
    if (created.action !== "created") {
      throw new Error(`Could not create ${settingsPath}: it changed during connect. Existing file kept.`);
    }
    return { action: "created" };
  }

  const result = await replaceFileIfUnchanged(settingsPath, raw, updated, {
    boundaryRoot,
    beforeReplace,
    beforePublish,
    beforeCommit,
    beforeRename,
    expectedBytes: rawBytes,
    expectedStats: stats,
    mode: stats.mode & 0o777
  });
  if (!result.replaced) {
    throw new Error(`Could not update ${settingsPath}: it changed during connect. Concurrent edit kept.`);
  }
  return { action: "updated", ...(result.preservedPath ? { preservedPath: result.preservedPath } : {}) };
}

function isManagedGeminiHookGroup(group) {
  return Object.keys(group).every((key) => ["hooks", "matcher", "sequential"].includes(key));
}

function validateGeminiHookGroups(groups, eventName, settingsPath) {
  if (groups == null) return;
  if (!Array.isArray(groups)) {
    throw new Error(`Existing ${settingsPath} ${eventName} field must contain an array. Fix it, then retry — refusing to overwrite it.`);
  }
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new Error(`Existing ${settingsPath} contains a malformed ${eventName} entry. Fix it, then retry — refusing to overwrite it.`);
    }
    if (!Array.isArray(group.hooks)) {
      throw new Error(`Existing ${settingsPath} ${eventName} hooks field must contain an array. Fix it, then retry — refusing to overwrite it.`);
    }
    if (group.hooks.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error(`Existing ${settingsPath} contains a malformed ${eventName} hook entry. Fix it, then retry — refusing to overwrite it.`);
    }
  }
}

function validateGeminiHooksConfig(config, settingsPath) {
  if (config == null) return;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Existing ${settingsPath} hooksConfig field must contain a JSON object. Fix it, then retry — refusing to overwrite it.`);
  }
  if (config.enabled != null && typeof config.enabled !== "boolean") {
    throw new Error(`Existing ${settingsPath} hooksConfig.enabled field must be true or false. Fix it, then retry — refusing to overwrite it.`);
  }
  if (config.disabled != null && (!Array.isArray(config.disabled) || config.disabled.some((name) => typeof name !== "string"))) {
    throw new Error(`Existing ${settingsPath} hooksConfig.disabled field must contain hook names. Fix it, then retry — refusing to overwrite it.`);
  }
  if (config.enabled === false) {
    throw new Error(`Existing ${settingsPath} has Gemini hooks disabled. Enable hooks, then retry.`);
  }
  if (config.disabled?.includes("dotaios-context")) {
    throw new Error(`Existing ${settingsPath} explicitly disables dotaios-context. Enable or remove that hook name, then retry.`);
  }
}

function isRecognizedGeminiHookEntry(entry, hookScriptPath) {
  return entry.type === "command"
    && entry.name === "dotaios-context"
    && entry.timeout === 10000
    && (entry.command === hookScriptPath || entry.command === shSingleQuote(hookScriptPath));
}

function removeLegacyGeminiMcpEntry(settings, settingsPath) {
  if (settings.mcp == null) return;
  if (typeof settings.mcp !== "object" || Array.isArray(settings.mcp)) {
    throw new Error(`Existing ${settingsPath} mcp field must contain a JSON object. Fix it, then retry — refusing to overwrite it.`);
  }
  if (settings.mcp.servers == null) return;
  if (typeof settings.mcp.servers !== "object" || Array.isArray(settings.mcp.servers)) {
    throw new Error(`Existing ${settingsPath} mcp.servers field must contain a JSON object. Fix it, then retry — refusing to overwrite it.`);
  }

  const entry = settings.mcp.servers.dotaios;
  if (entry == null) return;
  const exactManagedShape = entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && Object.keys(entry).sort().join(",") === "args,command"
    && entry.command === "npx"
    && Array.isArray(entry.args)
    && entry.args.length === 3
    && entry.args[0] === "dotaios-mcp"
    && entry.args[1] === "--path"
    && typeof entry.args[2] === "string"
    && entry.args[2].length > 0;
  if (!exactManagedShape) {
    throw new Error(`Existing ${settingsPath} has an unrecognized legacy mcp.servers.dotaios entry. Move or remove it, then retry — refusing to overwrite it.`);
  }
  delete settings.mcp.servers.dotaios;
  if (Object.keys(settings.mcp.servers).length === 0) delete settings.mcp.servers;
  if (Object.keys(settings.mcp).length === 0) delete settings.mcp;
}
