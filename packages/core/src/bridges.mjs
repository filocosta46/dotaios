import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./files.mjs";

export const MANAGED_START = "<!-- dotaios-managed:start -->";
export const MANAGED_END = "<!-- dotaios-managed:end -->";

// The canonical entrypoint every bridge points at. One front door for every agent.
export const AGENT_ENTRYPOINT = "AGENTS.md";

const defaultRegistryPath = fileURLToPath(new URL("./agents.json", import.meta.url));

// Each agent record:
//   name    human label
//   detect  path under the user's home that exists when the tool is installed
//   bridge  path under the user's home where DotAIOS writes the bridge file
//   include "@" if the agent auto-includes a file referenced as @path, "" otherwise
function normalizeAgent(raw) {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (typeof raw.bridge !== "string" || !raw.bridge.trim()) return null;
  return {
    name: raw.name.trim(),
    detect: typeof raw.detect === "string" && raw.detect.trim() ? raw.detect.trim() : raw.bridge,
    bridge: raw.bridge.trim(),
    include: raw.include === "@" ? "@" : ""
  };
}

function normalizeRegistry(data) {
  const list = Array.isArray(data?.agents) ? data.agents : [];
  return list.map(normalizeAgent).filter(Boolean);
}

// Load the shipped agent registry, then merge any user-defined registry at
// <aiosPath>/agents.json. User entries with the same name override the
// defaults; new names are appended. This is how a user (or Filippo) adds a
// new AI tool without a code release.
export async function loadAgentRegistry(aiosPath) {
  const defaults = normalizeRegistry(await readJson(defaultRegistryPath, { agents: [] }));

  if (!aiosPath) return defaults;
  const userRegistry = normalizeRegistry(await readJson(path.join(aiosPath, "agents.json"), { agents: [] }));
  if (userRegistry.length === 0) return defaults;

  const byName = new Map();
  for (const agent of defaults) byName.set(agent.name.toLowerCase(), agent);
  for (const agent of userRegistry) byName.set(agent.name.toLowerCase(), agent);
  return [...byName.values()];
}

export function bridgePath(homePath, agent) {
  return path.join(homePath, agent.bridge);
}

export function detectPath(homePath, agent) {
  return path.join(homePath, agent.detect);
}

// Is this agent actually installed on the machine? True when its detect path exists.
export async function isAgentInstalled(homePath, agent) {
  try {
    await fs.access(detectPath(homePath, agent));
    return true;
  } catch {
    return false;
  }
}

// The managed bridge-file body for one agent. Always points at the single
// canonical AGENTS.md front door inside the AIOS folder.
export function bridgeContent(agent, aiosPath) {
  const entrypoint = path.join(aiosPath, AGENT_ENTRYPOINT);
  const skillsIndex = path.join(aiosPath, "skills", "INDEX.md");
  const pointerLine = agent.include === "@"
    ? `@${entrypoint}`
    : `DotAIOS entrypoint (read this file first): ${entrypoint}`;

  return [
    `# DotAIOS ${agent.name} Bridge`,
    "",
    MANAGED_START,
    "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
    "",
    pointerLine,
    "",
    "AGENTS.md is the single source of truth for this folder: who the user is, how it is organized, the rules, and the installed skills.",
    "",
    `Skills: read ${skillsIndex} to see all available skills and how to run them.`,
    "Working memory: call the `read_session_digest` MCP tool, or run `dotaios brief --compact` to get today's focus, carry-overs, and recent sessions.",
    MANAGED_END,
    ""
  ].join("\n");
}
