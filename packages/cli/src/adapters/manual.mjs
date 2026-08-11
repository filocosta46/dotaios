import { ADAPTER_LEVELS } from "../../../core/src/adapter-contract.mjs";
import { inferTitle } from "../../../core/src/sessions.mjs";

export const name = "manual";
export const level = ADAPTER_LEVELS.MANUAL_ASSIST;

export function parseRawText(text, { project, projectId = null, sourceType = "import" } = {}) {
  const turns = parseTurns(text);
  const now = new Date().toISOString();
  return {
    agent: "manual",
    captured_at: now,
    source_type: sourceType,
    ...(project && { project }),
    ...(projectId && { project_id: projectId }),
    title: inferTitle(turns),
    turns,
  };
}

function parseTurns(text) {
  const cleanText = text.trim();
  if (!cleanText) return [];

  // Try our own format: **role · HH:MM**
  const ownFormat = tryOwnFormat(cleanText);
  if (ownFormat) return ownFormat;

  // Try Human/Assistant or You/Claude or similar
  const dialogFormat = tryDialogFormat(cleanText);
  if (dialogFormat) return dialogFormat;

  // Fallback: whole text as one user turn
  return [{ role: "user", content: cleanText }];
}

function tryOwnFormat(text) {
  const pattern = /^\*\*(user|assistant|human|ai)(?:\s+·\s+\d{2}:\d{2})?\*\*/im;
  if (!pattern.test(text)) return null;

  const blocks = text.split(/\n(?=\*\*(?:user|assistant|human|ai)(?:\s+·\s+\d{2}:\d{2})?\*\*)/i);
  const turns = [];

  for (const block of blocks) {
    const headerMatch = block.match(/^\*\*(user|assistant|human|ai)(?:\s+·\s+(\d{2}:\d{2}))?\*\*\s*\n?([\s\S]*)/i);
    if (!headerMatch) continue;
    const rawRole = headerMatch[1].toLowerCase();
    const role = rawRole === "human" ? "user" : rawRole === "ai" ? "assistant" : rawRole;
    const content = headerMatch[3].trim();
    if (content) turns.push({ role, content });
  }

  return turns.length > 0 ? turns : null;
}

const SPEAKER_PATTERNS = [
  /^(you|human|user)\s*:/i,
  /^(claude|assistant|ai|chatgpt|gpt|gemini|copilot)\s*:/i,
];

function tryDialogFormat(text) {
  const lines = text.split("\n");
  const firstLine = lines[0];

  if (!SPEAKER_PATTERNS.some((p) => p.test(firstLine.trim()))) return null;

  const turns = [];
  let currentRole = null;
  let currentLines = [];

  function flushTurn() {
    if (currentRole && currentLines.length > 0) {
      const content = currentLines.join("\n").trim();
      if (content) turns.push({ role: currentRole, content });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    let matched = false;

    if (SPEAKER_PATTERNS[0].test(trimmed)) {
      flushTurn();
      currentRole = "user";
      currentLines.push(trimmed.replace(/^[^:]+:\s*/, ""));
      matched = true;
    } else if (SPEAKER_PATTERNS[1].test(trimmed)) {
      flushTurn();
      currentRole = "assistant";
      currentLines.push(trimmed.replace(/^[^:]+:\s*/, ""));
      matched = true;
    }

    if (!matched) {
      currentLines.push(line);
    }
  }

  flushTurn();
  return turns.length > 0 ? turns : null;
}
