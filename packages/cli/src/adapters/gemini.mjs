import fs from "node:fs/promises";
import path from "node:path";
import { MANAGED_END, MANAGED_START, findManagedBlock } from "../../../core/src/bridges.mjs";
import {
  replaceFileIfUnchanged,
  validateManagedFilePath,
  writeFileSafe
} from "../../../core/src/files.mjs";
import { DOTAIOS_PACKAGE_VERSION } from "../lib/mcp-launcher.mjs";

const GEMINI_HOOK_MARKER = "# dotaios-managed: gemini-context-hook/v1";
const GEMINI_HOOK_DESCRIPTION = "# DotAIOS context injection for Gemini CLI SessionStart";
const GEMINI_HOOK_DETAIL = "# Injects working memory digest as the first context turn.";

export function assertSafeGeminiAiosPath(aiosPath) {
  if (/[\0-\x1f\x7f]/.test(aiosPath)) {
    throw new Error("Gemini connection does not support AIOS paths containing control characters or line breaks.");
  }
}

export function geminiBridgeBlock(aiosPath) {
  return `${MANAGED_START}
Your personal AI operating system is at \`${aiosPath}\`.

- Full context guide: \`${aiosPath}/AGENTS.md\`
- Skills index: \`${aiosPath}/skills/INDEX.md\`
- Working memory: run \`dotaios brief --compact\`
${MANAGED_END}`;
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
  const block = geminiBridgeBlock(aiosPath);
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
  assertSafeGeminiAiosPath(aiosPath);
  return `#!/usr/bin/env bash
${GEMINI_HOOK_MARKER}
${GEMINI_HOOK_DESCRIPTION}
${GEMINI_HOOK_DETAIL}
cd / && npx -y --loglevel=error dotaios@${DOTAIOS_PACKAGE_VERSION} brief --compact --json --path ${shSingleQuote(aiosPath)}
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
  const managedCurrent = lines.length === 6
    && lines[0] === "#!/usr/bin/env bash"
    && lines[1] === GEMINI_HOOK_MARKER
    && lines[2] === GEMINI_HOOK_DESCRIPTION
    && lines[3] === GEMINI_HOOK_DETAIL
    && /^cd \/ && npx -y --loglevel=error dotaios@[0-9A-Za-z.+-]+ brief --compact --json --path [^\r\n]+$/.test(lines[4])
    && lines[5] === "";
  const managedLegacy = lines.length === 5
    && lines[0] === "#!/usr/bin/env bash"
    && lines[1] === GEMINI_HOOK_DESCRIPTION
    && lines[2] === GEMINI_HOOK_DETAIL
    && /^npx dotaios brief --compact --json --path [^\r\n]+ 2>\/dev\/null \|\| echo '\{\}'$/.test(lines[3])
    && lines[4] === "";
  if (!managedCurrent && !managedLegacy) {
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
  if (settings.hooks.disabled != null && !Array.isArray(settings.hooks.disabled)) {
    throw new Error(`Existing ${settingsPath} hooks.disabled field must contain an array. Fix it, then retry — refusing to overwrite it.`);
  }
  if (settings.hooks.disabled?.includes("dotaios-context")) {
    throw new Error(`Existing ${settingsPath} explicitly disables dotaios-context. Enable or remove that hook name, then retry.`);
  }
  if (settings.hooks.SessionStart == null) {
    settings.hooks.SessionStart = [];
  } else if (!Array.isArray(settings.hooks.SessionStart)) {
    throw new Error(`Existing ${settingsPath} SessionStart field must contain an array. Fix it, then retry — refusing to overwrite it.`);
  }
  for (const sessionEntry of settings.hooks.SessionStart) {
    if (!sessionEntry || typeof sessionEntry !== "object" || Array.isArray(sessionEntry)) {
      throw new Error(`Existing ${settingsPath} contains a malformed SessionStart entry. Fix it, then retry — refusing to overwrite it.`);
    }
    if (!Array.isArray(sessionEntry.hooks)) {
      throw new Error(`Existing ${settingsPath} SessionStart hooks field must contain an array. Fix it, then retry — refusing to overwrite it.`);
    }
    if (sessionEntry.hooks.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
      throw new Error(`Existing ${settingsPath} contains a malformed SessionStart hook entry. Fix it, then retry — refusing to overwrite it.`);
    }
  }

  const hookEntry = {
    hooks: [{ type: "command", command: shSingleQuote(hookScriptPath), name: "dotaios-context", timeout: 10000 }]
  };
  const ownedHooks = [];
  for (const sessionEntry of settings.hooks.SessionStart) {
    for (let index = 0; index < sessionEntry.hooks.length; index += 1) {
      if (sessionEntry.hooks[index]?.name === "dotaios-context") {
        ownedHooks.push({ sessionEntry, index });
      }
    }
  }
  if (ownedHooks.length > 1) {
    throw new Error(`Existing ${settingsPath} contains multiple dotaios-context hooks. Remove the duplicate, then retry — refusing an ambiguous update.`);
  }
  if (ownedHooks.length === 1) {
    const [{ sessionEntry, index }] = ownedHooks;
    if (!isRecognizedGeminiHookEntry(sessionEntry.hooks[index], hookScriptPath)) {
      throw new Error(`Existing ${settingsPath} contains an unrecognized dotaios-context hook. Rename or remove it, then retry — refusing to assume ownership.`);
    }
    sessionEntry.hooks[index] = { ...sessionEntry.hooks[index], ...hookEntry.hooks[0] };
  } else {
    settings.hooks.SessionStart.push(hookEntry);
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
