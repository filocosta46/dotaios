import fs from "node:fs/promises";
import path from "node:path";
import { stdin as input } from "node:process";
import { expandHome } from "../../../core/src/paths.mjs";
import { isHtmlComment } from "../../../core/src/render.mjs";

// The interview answers, as a value rather than a terminal session. `dotaios
// init --answers` and `dotaios setup --answers` are the only two callers, so
// the vocabulary lives beside the CLI's other argument helpers rather than in
// core. `dotaios interview` carries the same TTY wall but not the same fields:
// it asks for role, work, and priorities, never asks for a name or the AI
// tools, and adds four planning preferences this map cannot express. There is
// no shared vocabulary between them to hoist.

// Only these five are documented, in INSTALL.md and `dotaios init --help`.
const DOCUMENTED_ANSWER_KEYS = ["name", "role", "work", "priorities", "ai_tools"];

// The internal field names are accepted too, so a caller who read the rendered
// templates instead of the docs still works. They are deliberately absent from
// DOCUMENTED_ANSWER_KEYS: advertising two spellings for one field doubles what
// any future rename has to keep working.
const ANSWER_KEYS = new Map([
  ["name", "user_name"],
  ["user_name", "user_name"],
  ["role", "user_role"],
  ["user_role", "user_role"],
  ["work", "current_work"],
  ["current_work", "current_work"],
  ["priorities", "priorities"],
  ["ai_tools", "ai_tools"]
]);

// user_name and user_role render into the bullets `- Name: {{user_name}}` and
// `- Role: {{user_role}}` in templates/context/identity.md.hbs, where one line
// break moves everything after it out of the field. current_work and
// priorities render into section bodies (work.md.hbs, priorities.md.hbs), and
// `dotaios interview` asks for both of those with multiline: true — someone
// describing three work threads will use line breaks, and those are the answer
// rather than an escape from it.
const MULTILINE_FIELDS = new Set(["current_work", "priorities"]);

// Invisible in the file and invisible in the chat the answer was copied out of,
// in the files agents trust most. A bare carriage return is the sharpest case:
// on a terminal it overwrites the line already printed, so reading the file can
// show something the file does not say. Newline and tab are the two a person
// can actually type into a multi-line answer, so those are the two the
// multi-line fields keep.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CONTROL_CHARACTERS_EXCEPT_NEWLINE_AND_TAB = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/;

// A bidirectional override reorders how a line prints without changing what it
// says. That is the carriage return's harm in a stronger form, and it lands in
// context/identity.md, the first file in the agent read order.
const BIDI_OVERRIDES = /\p{Bidi_Control}/u;

// Format characters, plus the few blanks that are not formally invisible but
// render as nothing anyway: Hangul fillers, the braille blank, the Mongolian
// vowel separator. A value made only of these passes the empty-string check and
// still renders an empty field, so it belongs in the same class as "".
const INVISIBLE_ONLY = /^[\p{Cf}\p{Zs}ㅤᅟᅠ⠀᠎\s]*$/u;

// A section body is the whole field, so there is no sibling field to escape
// into — but a heading inside one is not something a person said. readSection
// stops at the first `## `, so everything written after an injected heading
// becomes invisible to interview, context, and brief, while the forged heading
// shadows the template's own section of that name. Bullets and prose are fine.
// Level two only, and the harm is two different things that both need it.
// readSection ends a section on `line.startsWith("## ")`, which is exact and
// unindented, so only a bare `## ` truncates an answer. It finds a section's
// START with `line.trim() === "## " + heading`, which is NOT indentation
// sensitive, so an indented `   ## Active Projects` inside one answer is found
// as that section and shadows the template's own — verified by running both.
//
// The first pass refused `#{1,6}`. `#`, `###`, `####`, `#####` and `######` do
// neither: they are read back as ordinary body text. Refusing them told the
// person their answer "splits that section" and "shadows the template's own
// section of that name" when it does not, and `### Side project` is an
// ordinary thing to write about your own work. The over-refusal reached the
// import door too once these rules were shared.
const MARKDOWN_HEADING = /^[^\S\r\n]*##[^\S\r\n]/m;

// A value that is present but says nothing installs a folder that looks
// finished and reports success — the exact failure --answers was added to end,
// arriving through the one door the type checks leave open. These are literal
// cases rather than a heuristic: guessing at whether someone's own words are
// "real enough" would refuse the answer they actually typed.
//
// isHtmlComment is render.mjs's own rule, and it is why the repo's
// `<!-- Your Name -->` placeholders render as an empty string instead of as
// something visibly unfinished. An ellipsis is what a documented example block
// uses for every value, and an assistant that reads a fenced block as the
// command to run pipes it in unedited.
const ELLIPSES = new Set(["...", "…"]);

const MAX_ANSWERS_BYTES = 64 * 1024;

function assertAnswersSize(bytes, origin) {
  if (bytes > MAX_ANSWERS_BYTES) {
    throw new Error(
      `${origin} is ${bytes} bytes, over the ${MAX_ANSWERS_BYTES}-byte limit. It holds a few sentences, not a transcript.`
    );
  }
}

// --answers and --yes contradict each other, and both commands have to say so
// at the same moment. init owns the rule, but setup's --dry-run is documented
// as the gate to inspect before the real run and it returns before init ever
// parses an option, so the check has to be reachable from both.
export function assertOneAnswerSource({ answers, yes }) {
  if (answers && yes) {
    throw new Error(
      "--answers and --yes contradict each other: one supplies real context, the other writes placeholders. Pass only one."
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

// setup retries init (--force, transaction recovery) and a stream only drains
// once, so setup reads this and hands the text down rather than letting init
// reach for stdin a second time.
export async function readAllStdin(stream = input) {
  if (stream.isTTY) {
    throw new Error(
      "--answers - reads the answers from stdin, and stdin is this terminal, so it would wait forever.\n" +
      "Pipe the JSON in, or pass --answers <file> instead."
    );
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    // Bail while reading rather than after buffering, so an accidental pipe
    // from a huge file cannot be pulled fully into memory first.
    assertAnswersSize(bytes, "--answers -");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

  const repeated = repeatedTopLevelKey(raw);
  if (repeated) {
    throw new Error(
      `--answers sets "${repeated}" twice. JSON keeps only the last one, so the earlier answer would disappear ` +
      "without a word. Keep one."
    );
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

    answers[field] = field === "ai_tools" ? normalizeAiTools(value, key) : normalizeText(value, key, field);
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

function answerSubject(key) {
  return `--answers key "${key}"`;
}

function normalizeText(value, key, field) {
  if (typeof value !== "string") {
    throw new Error(`--answers key "${key}" must be a string. Omit the key entirely to leave that field unanswered.`);
  }
  const text = value.trim();
  assertCarriesAnAnswer(text, key);

  if (MULTILINE_FIELDS.has(field)) {
    assertPlainText(text, answerSubject(key), CONTROL_CHARACTERS_EXCEPT_NEWLINE_AND_TAB);
    assertNoHeading(text, answerSubject(key));
    return text;
  }
  assertOneLine(text, key, BULLET_IS_ONE_LINE);
  assertPlainText(text, answerSubject(key), CONTROL_CHARACTERS);
  return text;
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
    // A blank entry here is the ordinary artefact of splitting "a,b," rather
    // than an unanswered field, so it is dropped instead of refused. A
    // placeholder is not: it names a client nobody uses.
    if (!tool) continue;
    assertCarriesAnAnswer(tool, key);
    assertOneLine(tool, key, TOOL_NAME_IS_ONE_LINE);
    assertPlainText(tool, key, CONTROL_CHARACTERS);
    tools.push(tool);
  }
  // An empty list is an answer — "none of them" — and quietly restoring the
  // three defaults would record the opposite in aios.json, where status,
  // doctor, and context all read it back and show it to the person as theirs.
  // (It does not decide bridges: activate detects installed clients.)
  if (tools.length === 0) {
    throw new Error(`--answers key "${key}" named no tools. Omit the key to keep the default, or list at least one.`);
  }
  return tools.join(",");
}

// `subject` is the caller's name for the value, not a key: `dotaios import`
// runs these same two rules over payloads that arrive from another assistant,
// and "--answers key" would be a lie in that message. The rules themselves are
// about the destination file, not about how the text got there — the reasoning
// at the top of this module argues from context/identity.md and the section
// bodies, which are the same files whichever door the text came through.
export function assertNoHeading(text, subject) {
  if (!MARKDOWN_HEADING.test(text)) return;
  throw new Error(
    `${subject} contains a markdown heading. This text becomes the body of one section, and a ` +
    "heading inside it splits that section: everything after it stops being read as part of the answer, and it " +
    "shadows the template's own section of that name. Use a list or a blank line between threads instead."
  );
}

function assertCarriesAnAnswer(text, key) {
  // Checked after the empty case below, so a plain "" keeps the message written
  // for it; this one is for the values that survive a trim and still show
  // nothing.
  if (text !== "" && INVISIBLE_ONLY.test(text)) {
    throw new Error(
      `--answers key "${key}" is only invisible characters. It renders as a blank field, so the install would ` +
      "report success over nothing. Omit the key to leave that field unanswered."
    );
  }
  if (text !== "" && !ELLIPSES.has(text) && !isHtmlComment(text)) return;
  throw new Error(
    `--answers key "${key}" carries no answer. Omit the key to leave that field unanswered, or supply what the ` +
    "person actually said.\n" +
    "An empty value, an ellipsis, and this repo's own <!-- placeholder --> text all render as nothing, so the " +
    "install would report success over a blank field."
  );
}

function assertOneLine(text, key, because) {
  if (!/[\r\n]/.test(text)) return;
  throw new Error(`--answers key "${key}" must be one line. ${because}`);
}

const BULLET_IS_ONE_LINE =
  "It renders into a bullet in context/identity.md, so a line break moves the rest of the value out of the " +
  "field and into that file's own structure, where an agent reads it as something the person never said.\n" +
  "An answer that needs more than a line belongs in work or priorities.";

const TOOL_NAME_IS_ONE_LINE = "It names one AI tool, and a tool name is a single word on a single line.";

export function assertPlainText(text, subject, pattern) {
  const found = text.match(pattern) || text.match(BIDI_OVERRIDES);
  if (!found) return;
  const code = found[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  throw new Error(
    `${subject} contains the control character U+${code}. An answer is text a person said out loud; ` +
    "an invisible character in the files agents trust most is not, and a bare carriage return can make the file " +
    "print as something it does not say."
  );
}

// The two patterns above, named so a caller outside this module does not have
// to know which one it wants. Imported markdown is a section body, so it keeps
// its line breaks and tabs for the same reason work and priorities do.
export const SECTION_BODY_CONTROL_CHARACTERS = CONTROL_CHARACTERS_EXCEPT_NEWLINE_AND_TAB;

// A JSONL record is one line by construction, so unlike a section body it
// keeps neither newlines nor tabs. `dotaios import` uses this for the signal
// and event text it appends.
export const JOURNAL_CONTROL_CHARACTERS = CONTROL_CHARACTERS;

// JSON.parse collapses {"name":"a","name":"b"} to "b" before Object.entries can
// see it, so the two-spellings guard above — written because one answer
// silently winning by key order was judged unacceptable — never fires on the
// literal same-key case, which has exactly the same semantics. There is no
// dependency budget for a streaming parser, so the raw text is scanned for the
// top-level keys. This runs only after JSON.parse has already accepted the
// text, which is what keeps it small: it never has to diagnose malformed JSON,
// only find the keys in input already proven valid.
function repeatedTopLevelKey(raw) {
  const seen = new Set();
  let depth = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    else if (character === '"') {
      // Consuming the whole literal is also what keeps a brace or a quote
      // inside a string value from moving the depth or ending the scan early.
      const start = index;
      index += 1;
      while (index < raw.length && raw[index] !== '"') index += raw[index] === "\\" ? 2 : 1;
      if (depth !== 1) continue;

      let after = index + 1;
      while (/\s/.test(raw[after] || "")) after += 1;
      // At depth 1 a string is either a key or a value; only a key is followed
      // by a colon.
      if (raw[after] !== ":") continue;

      const key = JSON.parse(raw.slice(start, index + 1));
      if (seen.has(key)) return key;
      seen.add(key);
    }
  }

  return null;
}
