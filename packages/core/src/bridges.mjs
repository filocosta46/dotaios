import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { isSafeRegistryPathText, parseExternalSkillsKey } from "./skill-config-key.mjs";

const MAX_AGENT_REGISTRY_BYTES = 1024 * 1024;
const MAX_AGENT_REGISTRY_ENTRIES = 256;
const MAX_AGENT_FIELD_BYTES = 1024;
const MAX_AGENT_SKILL_TARGETS = 128;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const require = createRequire(import.meta.url);
const bundledAgentRegistry = require("./agents.json");

export const MANAGED_START = "<!-- dotaios-managed:start -->";
export const MANAGED_END = "<!-- dotaios-managed:end -->";

// Locate one complete managed block. Malformed or reversed markers are not
// ownership proof, so callers must preserve the file instead of editing it.
export function findManagedBlock(text) {
  const start = text.indexOf(MANAGED_START);
  const endStart = text.indexOf(MANAGED_END);
  if (
    start < 0
    || endStart < 0
    || start !== text.lastIndexOf(MANAGED_START)
    || endStart !== text.lastIndexOf(MANAGED_END)
    || start >= endStart
  ) return null;
  const end = endStart + MANAGED_END.length;
  return { start, end, text: text.slice(start, end) };
}

// The canonical entrypoint every bridge points at. One front door for every agent.
export const AGENT_ENTRYPOINT = "AGENTS.md";

// Each agent record:
//   name    human label
//   detect  path under the user's home that exists when the tool is installed
//   bridge  path under the user's home where DotAIOS writes the bridge file
//   include "@" if the agent auto-includes a file referenced as @path, "" otherwise
function normalizeAgent(raw) {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) return null;
  const bridge = raw.bridge == null
    ? null
    : (typeof raw.bridge === "string" && raw.bridge.trim() ? raw.bridge.trim() : null);
  if (raw.bridge != null && bridge == null) return null;
  const skills = normalizeSkills(raw.skills);
  return {
    name: raw.name.trim(),
    detect: typeof raw.detect === "string" && raw.detect.trim() ? raw.detect.trim() : raw.bridge,
    ...(typeof raw.command === "string" && raw.command.trim() ? { command: raw.command.trim() } : {}),
    bridge,
    include: raw.include === "@" ? "@" : "",
    ...(skills ? { skills } : {})
  };
}

function normalizeSkills(raw) {
  if (!raw || typeof raw !== "object") return null;
  const config = normalizeSkillTarget(raw, { relativeOnly: true });
  if (!config) return null;

  const project = normalizeSkillTarget(raw.project, { relativeOnly: true });
  return project ? { ...config, project } : config;
}

function normalizeSkillTarget(raw, { relativeOnly = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
  if (mode !== "symlink" && mode !== "config-external-dir") return null;

  const config = { mode };
  if (isSafeRegistryPathText(raw.dir)) {
    const dir = raw.dir.trim();
    if (!relativeOnly || isSafeRelativePath(dir)) config.dir = dir;
  }
  if (isSafeRegistryPathText(raw.configFile)) {
    const configFile = raw.configFile.trim();
    if (!relativeOnly || isSafeRelativePath(configFile)) config.configFile = configFile;
  }
  if (parseExternalSkillsKey(raw.key)) config.key = raw.key;

  if (mode === "symlink" && !config.dir) return null;
  if (mode === "config-external-dir" && (!config.configFile || !config.key)) return null;
  return config;
}

function isSafeRelativePath(value) {
  return !path.isAbsolute(value)
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.split(/[\\/]+/).includes("..");
}

export function normalizeAgentRegistry(data) {
  const list = Array.isArray(data?.agents) ? data.agents : [];
  return list.map(normalizeAgent).filter(Boolean);
}

// Load the shipped agent registry, then merge any user-defined registry at
// <aiosPath>/agents.json. User entries with the same name override the
// defaults; new names are appended. This is how a user (or Filippo) adds a
// new AI tool without a code release.
export async function loadAgentRegistry(aiosPath) {
  const defaultValue = bundledAgentRegistry;
  assertAgentRegistryBounds(defaultValue);
  const defaults = normalizeAgentRegistry(defaultValue);

  if (!aiosPath) return defaults;
  const userValue = await readStrictRegistryJson(path.join(aiosPath, "agents.json"), { allowMissing: true });
  if (userValue) assertAgentRegistryBounds(userValue);
  const userRegistry = normalizeAgentRegistry(userValue || { agents: [] });
  if (userRegistry.length === 0) return defaults;

  const byName = new Map();
  for (const agent of defaults) byName.set(agent.name.toLowerCase(), agent);
  for (const agent of userRegistry) byName.set(agent.name.toLowerCase(), agent);
  const merged = [...byName.values()];
  const targets = new Set(
    merged
      .filter((agent) => agent.skills?.mode === "symlink")
      .map((agent) => agent.skills.dir)
  );
  if (targets.size > MAX_AGENT_SKILL_TARGETS) {
    throw new Error(`Agent registry exceeds the ${MAX_AGENT_SKILL_TARGETS}-target bound.`);
  }
  return merged;
}

function assertAgentRegistryBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.agents)) {
    throw new Error("Agent registry must contain an agents array.");
  }
  if (value.agents.length > MAX_AGENT_REGISTRY_ENTRIES) {
    throw new Error(`Agent registry exceeds the ${MAX_AGENT_REGISTRY_ENTRIES}-entry bound.`);
  }
  for (const raw of value.agents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const values = [raw.name, raw.detect, raw.command, raw.bridge, raw.include];
    for (const target of [raw.skills, raw.skills?.project]) {
      if (!target || typeof target !== "object" || Array.isArray(target)) continue;
      values.push(target.mode, target.dir, target.configFile, target.key);
    }
    if (values.some((field) => (
      typeof field === "string" && Buffer.byteLength(field, "utf8") > MAX_AGENT_FIELD_BYTES
    ))) throw new Error(`Agent registry field exceeds the ${MAX_AGENT_FIELD_BYTES}-byte bound.`);
  }
}

async function readStrictRegistryJson(filePath, { allowMissing = false } = {}) {
  let before;
  try {
    before = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("Agent registry must be a single-link regular file.");
  }
  if (before.size > BigInt(MAX_AGENT_REGISTRY_BYTES)) {
    throw new Error(`Agent registry exceeds the ${MAX_AGENT_REGISTRY_BYTES}-byte bound.`);
  }
  const handle = await fs.open(filePath, "r");
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) throw new Error("Agent registry changed while opening.");
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== bytes.length
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
    ) throw new Error("Agent registry changed while reading.");
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw new Error("Agent registry is not valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Agent registry is not valid JSON.");
  }
}

export function bridgePath(homePath, agent) {
  return agent.bridge ? path.join(homePath, agent.bridge) : null;
}

function detectPath(homePath, agent) {
  return path.join(homePath, agent.detect);
}

// A declared command is the strongest signal on a fresh host, before the
// client creates its configuration directory.
export async function isAgentInstalled(
  homePath,
  agent,
  { env = process.env, platform = process.platform } = {}
) {
  if (agent.command && await isCommandAvailable(agent.command, { env, platform })) return true;
  try {
    await fs.access(detectPath(homePath, agent));
    return true;
  } catch {
    return false;
  }
}

export async function isCommandAvailable(
  command,
  { env = process.env, platform = process.platform } = {}
) {
  const pathValue = env.PATH || env.Path || env.path || "";
  const explicitPath = path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const directories = explicitPath ? [""] : pathValue.split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32" && !path.extname(command)
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = explicitPath
        ? `${command}${extension}`
        : path.join(directory, `${command}${extension}`);
      try {
        await fs.access(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if ((await fs.stat(candidate)).isFile()) return true;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return false;
}

// The managed bridge-file body for one agent. Always points at the single
// canonical AGENTS.md front door inside the AIOS folder. When `skillsFirst` is
// true, the skill catalog (INDEX.md + RESOLVER.md) is INLINED into the managed
// block instead of just pointed at, so agents that do not auto-follow file
// references (headless fleet workers, MCP-only clients, browser-paste users)
// still see the catalog at boot. Default stays pointer-mode to keep bridge
// files small.
export async function bridgeContent(agent, aiosPath, { skillsFirst = false, skillsCatalog } = {}) {
  const entrypoint = path.join(aiosPath, AGENT_ENTRYPOINT);
  const skillsIndex = path.join(aiosPath, "skills", "INDEX.md");
  const resolver = path.join(aiosPath, "skills", "RESOLVER.md");
  const pointerLine = agent.include === "@"
    ? `@${entrypoint}`
    : `DotAIOS entrypoint (read this file first): ${entrypoint}`;

  const lines = [
    `# DotAIOS ${agent.name} Bridge`,
    "",
    MANAGED_START,
    "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
    "",
    pointerLine,
    "",
    "AGENTS.md is the single source of truth for this folder: who the user is, how it is organized, the rules, and the installed skills.",
    ""
  ];

  if (skillsFirst) {
    const [indexText, resolverText] = await Promise.all([
      skillsCatalog?.indexText ?? readCatalogFile(skillsIndex),
      skillsCatalog?.resolverText ?? readCatalogFile(resolver)
    ]);
    lines.push("## Skills first (inlined by `dotaios activate --skills-first`)");
    lines.push("");
    lines.push("Match the user's intent to a skill below, then open that skill's SKILL.md before acting. If nothing fits, hand-roll the work and offer to skillify a repeat.");
    lines.push("");
    if (indexText) {
      lines.push("### Skills index", "", indexText.trim(), "");
    }
    if (resolverText) {
      lines.push("### Skill resolver", "", resolverText.trim(), "");
    }
  } else {
    lines.push(`Skills: read ${skillsIndex} to see all available skills and how to run them.`);
    lines.push(`Routing: to choose a skill for a request, match the user's intent against ${resolver} (trigger phrases -> skill), then open that SKILL.md before acting. If the user keeps repeating a workflow, offer to run the skillify skill to make it reusable (draft it, then ask before saving).`);
  }

  lines.push("Working memory: route events, signals, and saved sessions only through the canonical bounded projection. Run `dotaios brief --compact` at session start; for project work, add `--project <slug-or-id>`. Do not load those memory stores directly or invent another recency window.");
  lines.push("Optional MCP: `read_working_context` returns that same projection plus bounded operational compatibility state beside it. The adapter exposes exactly `read_working_context`, `search_aios`, and `resolve_skill`; it has no compatibility aliases.");
  lines.push(MANAGED_END, "");

  return lines.join("\n");
}

async function readCatalogFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
