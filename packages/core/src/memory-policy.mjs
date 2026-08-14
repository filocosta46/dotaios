export const MEMORY_MODES = Object.freeze(["shared", "project", "off"]);

const OFF_NOTICE = "DotAIOS is off; your AI app may still keep its own conversation history. DotAIOS did not read, search, save, or capture this turn.";
const FIRST_MESSAGE_MODES = Object.freeze([
  { pattern: /^\s*private chat\b/i, mode: "off" },
  { pattern: /^\s*only this project\b/i, mode: "project" },
  { pattern: /^\s*use my memory\b/i, mode: "shared" }
]);

/**
 * Resolve the one session-wide memory choice without touching the filesystem.
 * Callers must do this before opening the configured AIOS folder so Off can be
 * proven as zero DotAIOS reads, searches, writes, and capture.
 */
export function resolveMemoryPolicy({
  mode,
  project,
  firstUserMessage
} = {}) {
  const projectSelector = normalizeProjectSelector(project);
  const firstMessageMode = detectMemoryModeFromFirstMessage(firstUserMessage);
  const explicitMode = normalizeMode(mode);
  const selectedMode = explicitMode === "off"
    ? "off"
    : firstMessageMode || explicitMode || (projectSelector ? "project" : "shared");

  if (
    !firstMessageMode
    && explicitMode === "shared"
    && projectSelector
  ) {
    throw memoryPolicyError("Cannot combine shared memory with a project selector.");
  }
  if (selectedMode === "project" && !projectSelector) {
    throw memoryPolicyError("A project selector is required for This project memory.");
  }

  if (selectedMode === "off") {
    return Object.freeze({
      mode: "off",
      projectSelector: null,
      receipt: "Memory: Off",
      notice: OFF_NOTICE,
      reads: false,
      writes: false
    });
  }

  return Object.freeze({
    mode: selectedMode,
    projectSelector: selectedMode === "project" ? projectSelector : null,
    receipt: selectedMode === "project" ? "Memory: This project" : "Memory: Shared",
    notice: null,
    reads: true,
    writes: true
  });
}

function normalizeMode(mode) {
  if (mode === undefined || mode === null) return null;
  if (typeof mode !== "string" || !MEMORY_MODES.includes(mode)) {
    throw memoryPolicyError(`Memory mode must be one of: ${MEMORY_MODES.join(", ")}.`);
  }
  return mode;
}

function normalizeProjectSelector(project) {
  if (project === undefined || project === null) return null;
  if (typeof project !== "string" || project.length === 0) {
    throw memoryPolicyError("Project must be a non-empty string.");
  }
  return project;
}

export function detectMemoryModeFromFirstMessage(firstUserMessage) {
  if (firstUserMessage === undefined || firstUserMessage === null) return null;
  if (typeof firstUserMessage !== "string") {
    throw memoryPolicyError("First user message must be a string.");
  }
  return FIRST_MESSAGE_MODES.find(({ pattern }) => pattern.test(firstUserMessage))?.mode || null;
}

function memoryPolicyError(message) {
  const error = new TypeError(message);
  error.code = "DOTAIOS_MEMORY_POLICY_INVALID";
  return error;
}
