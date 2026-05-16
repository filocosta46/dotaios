import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ADAPTER_LEVELS, getLevelLabel } from "../../../core/src/adapter-contract.mjs";

const HOME = os.homedir();

export async function detectAdapters() {
  const [claudeCode, gemini, cursor, codex] = await Promise.all([
    detectClaudeCode(),
    detectGemini(),
    detectCursor(),
    detectCodex(),
  ]);

  return { "claude-code": claudeCode, gemini, cursor, codex };
}

export async function enableAdapter(adapterName, aiosPath) {
  if (!adapterName) {
    return enableInteractive(aiosPath);
  }

  if (adapterName === "claude-code") {
    const { enable } = await import("./claude-code.mjs");
    await enable(aiosPath);
    return;
  }

  const detected = await detectAdapters();
  const info = detected[adapterName];
  if (!info || info.level === ADAPTER_LEVELS.UNSUPPORTED) {
    console.log(`${adapterName} is not available on this machine.`);
    return;
  }
  if (info.level === ADAPTER_LEVELS.BACKFILL_ONLY) {
    console.log(`${adapterName}: auto-save is not yet supported.`);
    console.log(`Run: dotaios capture import ${adapterName}`);
    return;
  }
  if (info.level === ADAPTER_LEVELS.MANUAL_ASSIST) {
    console.log(`${adapterName}: paste/import only — auto-save is planned for a future release.`);
    console.log(`To save a conversation: dotaios capture import paste`);
    return;
  }

  console.log(`${adapterName}: not supported yet.`);
}

export async function disableAdapter(adapterName, aiosPath) {
  if (!adapterName || adapterName === "claude-code") {
    const { disable } = await import("./claude-code.mjs");
    await disable(aiosPath);
    return;
  }
  console.log(`${adapterName} auto-save was not enabled (or not supported yet).`);
}

async function enableInteractive(aiosPath) {
  const detected = await detectAdapters();
  const capable = Object.entries(detected).filter(
    ([, info]) => info.detected && info.level !== ADAPTER_LEVELS.UNSUPPORTED
  );

  if (capable.length === 0) {
    console.log("No supported AI tools detected on this machine.");
    console.log("You can still save any conversation manually: dotaios capture import paste");
    return;
  }

  const autoCapable = capable.filter(([, info]) => info.level === ADAPTER_LEVELS.FULL_AUTO);
  const importOnly = capable.filter(([, info]) => info.level === ADAPTER_LEVELS.BACKFILL_ONLY);
  const manualOnly = capable.filter(([, info]) => info.level === ADAPTER_LEVELS.MANUAL_ASSIST);

  console.log("Found on this machine:");
  for (const [name, info] of autoCapable) {
    console.log(`  ${name}: ${getLevelLabel(info.level)}`);
  }
  for (const [name, info] of importOnly) {
    console.log(`  ${name}: ${getLevelLabel(info.level)}`);
  }
  for (const [name, info] of manualOnly) {
    console.log(`  ${name}: ${getLevelLabel(info.level)}`);
  }

  if (autoCapable.length > 0) {
    console.log("");
    for (const [name] of autoCapable) {
      await enableAdapter(name, aiosPath);
    }
  }

  if (importOnly.length > 0 || manualOnly.length > 0) {
    console.log("\nTo import past conversations:");
    for (const [name] of importOnly) {
      console.log(`  dotaios capture import ${name}`);
    }
    if (manualOnly.length > 0) {
      console.log("  dotaios capture import paste  (for any tool)");
    }
  }
}

// ---------- per-agent detection ----------

async function detectClaudeCode() {
  const settingsPath = path.join(HOME, ".claude", "settings.json");
  const projectsPath = path.join(HOME, ".claude", "projects");

  const [hasSettings, hasProjects] = await Promise.all([
    pathExists(settingsPath),
    pathExists(projectsPath),
  ]);

  if (!hasSettings && !hasProjects) {
    return { detected: false, level: ADAPTER_LEVELS.UNSUPPORTED, enabled: false };
  }

  const { isEnabled } = await import("./claude-code.mjs");
  const enabled = await isEnabled();

  // Verify Stop hook payload carries transcript_path:
  // Claude Code passes transcript_path in UserPromptSubmit hooks (confirmed by existing hooks
  // on this machine). Stop hooks use the same payload structure.
  // We also require that at least one .jsonl transcript is accessible before claiming full-auto.
  const hasTranscripts = await hasJsonlFiles(projectsPath);
  const level = hasTranscripts ? ADAPTER_LEVELS.FULL_AUTO : ADAPTER_LEVELS.BACKFILL_ONLY;

  return {
    detected: true,
    level,
    enabled: enabled && level === ADAPTER_LEVELS.FULL_AUTO,
    hookVerified: hasTranscripts,
    importCommand: "dotaios capture import claude-code",
  };
}

async function detectGemini() {
  const geminiDir = path.join(HOME, ".gemini");
  const hasBinary = binaryExists("gemini");
  const hasDir = await pathExists(geminiDir);

  if (!hasBinary && !hasDir) {
    return { detected: false, level: ADAPTER_LEVELS.UNSUPPORTED, enabled: false };
  }

  // Check for parseable history (jsonl files)
  const historyDir = path.join(geminiDir, "history");
  const hasTranscripts = await hasJsonlFiles(historyDir);

  return {
    detected: true,
    level: hasTranscripts ? ADAPTER_LEVELS.BACKFILL_ONLY : ADAPTER_LEVELS.MANUAL_ASSIST,
    enabled: false,
    importCommand: hasTranscripts ? "dotaios capture import gemini" : null,
  };
}

async function detectCursor() {
  const cursorDir = path.join(HOME, ".cursor");
  const hasDir = await pathExists(cursorDir);

  if (!hasDir) {
    return { detected: false, level: ADAPTER_LEVELS.UNSUPPORTED, enabled: false };
  }

  return {
    detected: true,
    level: ADAPTER_LEVELS.MANUAL_ASSIST,
    enabled: false,
    importCommand: null,
  };
}

async function detectCodex() {
  const hasBinary = binaryExists("codex");

  if (!hasBinary) {
    return { detected: false, level: ADAPTER_LEVELS.UNSUPPORTED, enabled: false };
  }

  return {
    detected: true,
    level: ADAPTER_LEVELS.MANUAL_ASSIST,
    enabled: false,
  };
}

// ---------- helpers ----------

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function binaryExists(name) {
  const result = spawnSync("which", [name], { stdio: "pipe" });
  return result.status === 0;
}

async function hasJsonlFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: false });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return true;
      if (entry.isDirectory()) {
        const sub = await fs.readdir(path.join(dir, entry.name));
        if (sub.some((f) => f.endsWith(".jsonl"))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
