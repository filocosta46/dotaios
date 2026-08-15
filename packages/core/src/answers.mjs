import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "./paths.mjs";

// The interview answers, as a value rather than a terminal session. `dotaios
// init --answers` uses this today; `dotaios interview` carries the same TTY
// wall and the same five fields, so the vocabulary lives here rather than
// inside one command.

// Only these five are documented, in INSTALL.md and `dotaios init --help`.
export const DOCUMENTED_ANSWER_KEYS = ["name", "role", "work", "priorities", "ai_tools"];

// The internal field names are accepted too, so a caller who read the rendered
// templates instead of the docs still works. They are deliberately absent from
// DOCUMENTED_ANSWER_KEYS: advertising two spellings for one field doubles what
// any future rename has to keep working.
export const ANSWER_KEYS = new Map([
  ["name", "user_name"],
  ["user_name", "user_name"],
  ["role", "user_role"],
  ["user_role", "user_role"],
  ["work", "current_work"],
  ["current_work", "current_work"],
  ["priorities", "priorities"],
  ["ai_tools", "ai_tools"]
]);

export const MAX_ANSWERS_BYTES = 64 * 1024;

export function assertAnswersSize(bytes, origin) {
  if (bytes > MAX_ANSWERS_BYTES) {
    throw new Error(
      `${origin} is ${bytes} bytes, over the ${MAX_ANSWERS_BYTES}-byte limit. It holds a few sentences, not a transcript.`
    );
  }
}

export async function readAnswersFile(source) {
  const resolved = path.resolve(expandHome(source));
  let stats;
  try {
    stats = await fs.stat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`--answers file not found: ${resolved}`);
    throw error;
  }
  if (!stats.isFile()) throw new Error(`--answers is not a file: ${resolved}`);
  // Checked before the read, so an oversized file is refused rather than
  // buffered and then complained about.
  assertAnswersSize(stats.size, "--answers");
  return fs.readFile(resolved, "utf8");
}

// Every rejection here exists for the same reason: a silently accepted answers
// file installs placeholder or wrong context and reports success, which is the
// exact failure --answers was added to end. Loud beats plausible.
export function parseAnswers(raw, defaults) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--answers is not valid JSON (${error.message}). Expected an object like {"name": "...", "role": "..."}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('--answers must be a JSON object, for example {"name": "Ada", "role": "Founder"}.');
  }

  const answers = { ...defaults };
  const claimedBy = new Map();
  const provided = [];

  for (const [key, value] of Object.entries(parsed)) {
    const field = ANSWER_KEYS.get(key);
    if (!field) {
      throw new Error(
        `--answers has an unknown key "${key}". Accepted keys: ${DOCUMENTED_ANSWER_KEYS.join(", ")}.\n` +
        "A misspelled key would quietly install placeholder context, so this stops instead."
      );
    }
    const earlier = claimedBy.get(field);
    if (earlier) {
      throw new Error(
        `--answers sets "${earlier}" and "${key}", which are two names for the same field. Keep one.`
      );
    }
    claimedBy.set(field, key);

    const text = field === "ai_tools" ? normalizeAiTools(value, key) : normalizeText(value, key);
    if (!text) continue;
    answers[field] = text;
    if (field !== "ai_tools") provided.push(field);
  }

  // --yes already exists for people who genuinely want placeholders. Arriving
  // here with nothing in it means the answers were meant to be real and got
  // lost on the way.
  if (provided.length === 0) {
    throw new Error(
      "--answers supplied no context. Fill in at least one of name, role, work, or priorities, " +
      "or pass --yes if you deliberately want placeholder context."
    );
  }

  return answers;
}

function normalizeText(value, key) {
  if (typeof value !== "string") {
    throw new Error(`--answers key "${key}" must be a string. Omit the key entirely to leave that field unanswered.`);
  }
  return value.trim();
}

function normalizeAiTools(value, key) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (list === null) {
    throw new Error(`--answers key "${key}" must be a string or an array of strings.`);
  }
  const tools = [];
  for (const entry of list) {
    if (typeof entry !== "string") throw new Error(`--answers key "${key}" must contain only strings.`);
    const tool = entry.trim();
    if (tool) tools.push(tool);
  }
  // Silently falling back to the three defaults here would hand someone bridge
  // files and skill links for clients they explicitly did not name.
  if (tools.length === 0) {
    throw new Error(`--answers key "${key}" named no tools. Omit the key to keep the default, or list at least one.`);
  }
  return tools.join(",");
}
