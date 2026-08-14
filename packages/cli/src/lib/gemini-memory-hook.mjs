import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { resolveMemoryPolicy } from "../../../core/src/memory-policy.mjs";

const DEFAULT_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const HOOK_INPUT_MAX_BYTES = 1024 * 1024;
const PRIVATE_CHAT_RE = /^\s*private chat\b/i;

export async function readGeminiHookInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > HOOK_INPUT_MAX_BYTES) throw new Error("Gemini hook input is too large.");
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) throw new Error("Gemini hook input is not valid UTF-8.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini hook input is not valid JSON.");
  }
}

export async function resolveGeminiHookRequest(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Gemini hook input must be a JSON object.");
  }
  if (input.hook_event_name === "SessionStart") {
    return { kind: "legacy-session-start" };
  }
  if (input.hook_event_name !== "BeforeAgent" || typeof input.prompt !== "string") {
    throw new Error("Gemini hook input is not a BeforeAgent prompt.");
  }
  if (typeof input.cwd !== "string" || !input.cwd || !path.isAbsolute(input.cwd) || /[\0-\x1f\x7f]/.test(input.cwd)) {
    throw new Error("Gemini BeforeAgent input has no safe absolute working directory.");
  }

  const firstMessage = await readGeminiFirstUserMessage(input, options);
  return {
    kind: "before-agent",
    cwd: input.cwd,
    firstMessage: Array.from(firstMessage).slice(0, 1000).join("")
  };
}

export async function resolveGeminiPrivateHookOutput(input, options = {}) {
  const request = await resolveGeminiHookRequest(input, options);
  if (request.kind === "legacy-session-start") {
    return {
      systemMessage: "Memory: Closed — DotAIOS is updating its Gemini hook; memory stayed closed for this session start.",
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
      dotaiosMemory: { mode: "closed", project: null }
    };
  }
  if (!PRIVATE_CHAT_RE.test(request.firstMessage)) return null;
  const policy = resolveMemoryPolicy({ mode: "off" });
  const additionalContext = `${policy.receipt}\n\n${policy.notice}`;
  return {
    systemMessage: `${policy.receipt} — ${policy.notice}`,
    hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext },
    dotaiosMemory: { mode: "off", project: null },
    contextBudget: {
      limit: additionalContext.length,
      used: additionalContext.length,
      remaining: 0,
      truncated: false
    }
  };
}

export async function readGeminiFirstUserMessage(input, {
  fileSystem = fs,
  maxBytes = DEFAULT_TRANSCRIPT_MAX_BYTES,
  noFollowFlag = fsConstants.O_NOFOLLOW
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Gemini BeforeAgent input must be a JSON object.");
  }
  if (input.hook_event_name !== "BeforeAgent" || typeof input.prompt !== "string") {
    throw new Error("Gemini hook input is not a BeforeAgent prompt.");
  }
  if (typeof input.transcript_path !== "string") {
    throw new Error("Gemini BeforeAgent input has no transcript path.");
  }

  if (input.transcript_path.length === 0) {
    throw new Error("Gemini did not provide transcript evidence, so DotAIOS could not verify the first-message memory lock.");
  }
  if (!path.isAbsolute(input.transcript_path) || /[\0-\x1f\x7f]/.test(input.transcript_path)) {
    throw new Error("Gemini transcript path must be absolute and contain no control characters.");
  }

  let before;
  try {
    before = await fileSystem.lstat(input.transcript_path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Gemini transcript evidence is missing, so DotAIOS could not verify the first-message memory lock.");
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error("Gemini transcript is not a bounded private regular file.");
  }
  if (!Number.isSafeInteger(noFollowFlag) || noFollowFlag <= 0) {
    throw new Error("Gemini transcript reads require no-follow file opens.");
  }
  const handle = await fileSystem.open(input.transcript_path, fsConstants.O_RDONLY | noFollowFlag);
  let bytes;
  let opened;
  let afterHandle;
  try {
    opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes || !sameGeminiTranscriptFile(before, opened)) {
      throw new Error("Gemini transcript changed before its session mode could be selected.");
    }
    bytes = await readBoundedGeminiTranscript(handle, opened.size);
    afterHandle = await handle.stat();
  } finally {
    await handle.close();
  }
  const afterPath = await fileSystem.lstat(input.transcript_path);
  if (!sameGeminiTranscriptFile(opened, afterHandle) || !sameGeminiTranscriptFile(afterHandle, afterPath)) {
    throw new Error("Gemini transcript changed while its session mode was being selected.");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Gemini transcript is not valid UTF-8.");
  }
  return parseGeminiFirstUserMessage(text, input.session_id, input.prompt);
}

async function readBoundedGeminiTranscript(handle, expectedBytes) {
  const buffer = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedBytes) {
    throw new Error("Gemini transcript changed while its session mode was being selected.");
  }
  return buffer.subarray(0, offset);
}

function geminiTranscriptText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Gemini transcript user content is malformed.");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

function parseGeminiFirstUserMessage(text, sessionId, currentPrompt) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Gemini hook input has no session identity.");
  }

  let legacy;
  try {
    legacy = JSON.parse(text);
  } catch {
    legacy = null;
  }
  if (isPlainObject(legacy) && Array.isArray(legacy.messages)) {
    if (legacy.sessionId !== sessionId) {
      throw new Error("Gemini transcript does not belong to this session.");
    }
    const first = legacy.messages.find((message) => isGeminiUserMessage(message));
    return first ? geminiTranscriptText(first.content) : currentPrompt;
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("Gemini transcript has no session metadata.");
  }
  const records = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error("Gemini transcript contains malformed JSONL.");
    }
  });
  const metadata = records[0];
  if (!isPlainObject(metadata)
    || metadata.sessionId !== sessionId
    || typeof metadata.projectHash !== "string"
    || metadata.projectHash.length === 0) {
    throw new Error("Gemini transcript does not belong to this session or has invalid metadata.");
  }

  const messages = new Map();
  let lockedFirstUserMessage;
  for (const record of records.slice(1)) {
    if (!isPlainObject(record)) {
      throw new Error("Gemini transcript contains a malformed JSONL record.");
    }
    if (typeof record.$rewindTo === "string") {
      rewindGeminiMessages(messages, record.$rewindTo);
      continue;
    }
    if (isPlainObject(record.$set)) {
      if (Object.hasOwn(record.$set, "sessionId") && record.$set.sessionId !== sessionId) {
        throw new Error("Gemini transcript does not belong to this session.");
      }
      if (Object.hasOwn(record.$set, "messages")) {
        if (!Array.isArray(record.$set.messages)) {
          throw new Error("Gemini transcript message checkpoint is malformed.");
        }
        messages.clear();
        for (const message of record.$set.messages) {
          if (lockedFirstUserMessage === undefined && isGeminiUserMessage(message)) {
            lockedFirstUserMessage = geminiTranscriptText(message.content);
          }
          appendGeminiMessage(messages, message);
        }
      }
      continue;
    }
    if (typeof record.id === "string") {
      if (lockedFirstUserMessage === undefined && isGeminiUserMessage(record)) {
        lockedFirstUserMessage = geminiTranscriptText(record.content);
      }
      appendGeminiMessage(messages, record);
      continue;
    }
    if (Object.hasOwn(record, "sessionId")) {
      if (record.sessionId !== sessionId) {
        throw new Error("Gemini transcript does not belong to this session.");
      }
      continue;
    }
    throw new Error("Gemini transcript contains an unsupported JSONL record.");
  }

  return lockedFirstUserMessage ?? currentPrompt;
}

function appendGeminiMessage(messages, message) {
  if (!isPlainObject(message) || typeof message.id !== "string" || message.id.length === 0 || typeof message.type !== "string") {
    throw new Error("Gemini transcript contains a malformed message record.");
  }
  messages.set(message.id, message);
}

function rewindGeminiMessages(messages, rewindId) {
  const ids = Array.from(messages.keys());
  const index = ids.indexOf(rewindId);
  if (index === -1) {
    messages.clear();
    return;
  }
  for (const id of ids.slice(index)) messages.delete(id);
}

function isGeminiUserMessage(message) {
  return isPlainObject(message) && message.type === "user";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameGeminiTranscriptFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}
