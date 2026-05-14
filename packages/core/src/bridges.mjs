import path from "node:path";

export const MANAGED_START = "<!-- dotaios-managed:start -->";
export const MANAGED_END = "<!-- dotaios-managed:end -->";

// The global agent memory files DotAIOS writes bridges into.
// segments is relative to the user's home directory.
export const AGENT_BRIDGES = [
  { name: "Claude Code", segments: [".claude", "CLAUDE.md"] },
  { name: "Codex", segments: [".codex", "AGENTS.md"] },
  { name: "Gemini", segments: [".gemini", "GEMINI.md"] }
];

export function bridgePath(homePath, bridge) {
  return path.join(homePath, ...bridge.segments);
}
