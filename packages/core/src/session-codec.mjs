import crypto from "node:crypto";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";

import { parseSessionRelativePath } from "./session-paths.mjs";

export const SESSION_CODEC_LIMITS = Object.freeze({
  documentBytes: 1024 * 1024,
  frontmatterBytes: 16 * 1024,
  bodyBytes: 1024 * 1024,
  turns: 10_000,
  turnBytes: 256 * 1024,
  agentChars: 64,
  sessionIdChars: 128,
  capturedAtChars: 64,
  sourceTypeChars: 64,
  sourcePathChars: 4096,
  projectChars: 128,
  projectIdChars: 200,
  titleChars: 512,
});

const FRONTMATTER_KEYS = new Set([
  "agent",
  "session_id",
  "captured_at",
  "source_type",
  "source_path",
  "project",
  "project_id",
  "turns",
  "body_encoding",
  "title",
  "schema",
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SESSION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHORT_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DISALLOWED_CONTROLS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const FIELD_CONTROLS_RE = /[\u0000-\u001F\u007F-\u009F]/u;
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/u;
const ESCAPED_LINES_V1 = "escaped-lines-v1";
const TURN_MARKER_RE = /^\*\*([a-z][a-z0-9_-]{0,31})(?: · ([^*\n]+))?\*\*$/;

export class SessionCodecError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionCodecError";
    this.code = code;
  }
}

function refuse(code) {
  throw new SessionCodecError(code);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertText(value, field, maxChars, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    refuse(`DOTAIOS_SESSION_${field.toUpperCase()}_INVALID`);
  }
  if (FIELD_CONTROLS_RE.test(value) || LONE_SURROGATE_RE.test(value)) {
    refuse(`DOTAIOS_SESSION_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

export function strictDecodeUtf8(input) {
  if (typeof input === "string") {
    if (LONE_SURROGATE_RE.test(input)) refuse("DOTAIOS_SESSION_UTF8_INVALID");
    return input;
  }
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    refuse("DOTAIOS_SESSION_INPUT_INVALID");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    refuse("DOTAIOS_SESSION_UTF8_INVALID");
  }
}

export function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function generateSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

export function sessionFilename(session) {
  const timestamp = (session.captured_at || new Date().toISOString())
    .slice(0, 19)
    .replace(/:/g, "-");
  const agent = (session.agent || "manual").replace(/[^a-z0-9]/g, "-").toLowerCase();
  return `${timestamp}_${agent}_${String(session.session_id || "").slice(0, 6)}.md`;
}

export function inferTitle(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const first = turns.find((turn) => turn?.role === "user");
  if (!first?.content) return null;
  const text = String(first.content).trim().replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    refuse("DOTAIOS_SESSION_TURN_INVALID");
  }
  const keys = Object.keys(turn);
  if (keys.some((key) => !["role", "content", "ts"].includes(key) || PROTOTYPE_KEYS.has(key))) {
    refuse("DOTAIOS_SESSION_TURN_INVALID");
  }
  const role = assertText(turn.role, "turn_role", 32);
  if (!ROLE_RE.test(role)) refuse("DOTAIOS_SESSION_TURN_ROLE_INVALID");
  if (typeof turn.content !== "string" || byteLength(turn.content) > SESSION_CODEC_LIMITS.turnBytes) {
    refuse("DOTAIOS_SESSION_TURN_CONTENT_INVALID");
  }
  if (DISALLOWED_CONTROLS_RE.test(turn.content) || LONE_SURROGATE_RE.test(turn.content)) {
    refuse("DOTAIOS_SESSION_TURN_CONTENT_INVALID");
  }
  let ts;
  if (turn.ts !== undefined) {
    ts = assertText(String(turn.ts), "turn_timestamp", SESSION_CODEC_LIMITS.capturedAtChars);
    if (!SHORT_TIME_RE.test(ts) && (!ISO_TIMESTAMP_RE.test(ts) || Number.isNaN(Date.parse(ts)))) {
      refuse("DOTAIOS_SESSION_TURN_TIMESTAMP_INVALID");
    }
  }
  return Object.freeze({ role, ...(ts ? { ts } : {}), content: turn.content });
}

function assertSessionEnvelope(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    refuse("DOTAIOS_SESSION_INVALID");
  }
  if (Object.keys(session).some((key) => PROTOTYPE_KEYS.has(key))) {
    refuse("DOTAIOS_SESSION_FIELD_INVALID");
  }

  const schema = session.schema ?? 1;
  if (schema !== 1) refuse("DOTAIOS_SESSION_SCHEMA_UNSUPPORTED");
}

function normalizeSessionIdentity(session) {
  const agent = assertText(session.agent ?? "manual", "agent", SESSION_CODEC_LIMITS.agentChars);
  if (!ROLE_RE.test(agent)) refuse("DOTAIOS_SESSION_AGENT_INVALID");
  const sessionId = assertText(session.session_id, "session_id", SESSION_CODEC_LIMITS.sessionIdChars);
  if (!SESSION_ID_RE.test(sessionId)) refuse("DOTAIOS_SESSION_SESSION_ID_INVALID");
  const capturedAt = assertText(session.captured_at, "captured_at", SESSION_CODEC_LIMITS.capturedAtChars);
  if (!ISO_TIMESTAMP_RE.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))) {
    refuse("DOTAIOS_SESSION_CAPTURED_AT_INVALID");
  }
  const sourceType = assertText(session.source_type ?? "manual", "source_type", SESSION_CODEC_LIMITS.sourceTypeChars);
  if (!ROLE_RE.test(sourceType)) refuse("DOTAIOS_SESSION_SOURCE_TYPE_INVALID");
  return { agent, sessionId, capturedAt, sourceType };
}

function normalizeSessionContent(session, allowBody) {
  if (session.turns !== undefined && !Array.isArray(session.turns)) {
    refuse("DOTAIOS_SESSION_TURNS_INVALID");
  }
  const suppliedTurns = session.turns ?? [];
  if (suppliedTurns.length > SESSION_CODEC_LIMITS.turns) refuse("DOTAIOS_SESSION_TURNS_INVALID");
  const turns = suppliedTurns.map(normalizeTurn);
  const body = session.body;
  if (body !== undefined) {
    if (!allowBody || turns.length !== 0 || typeof body !== "string" || byteLength(body) > SESSION_CODEC_LIMITS.bodyBytes) {
      refuse("DOTAIOS_SESSION_BODY_INVALID");
    }
    if (DISALLOWED_CONTROLS_RE.test(body) || LONE_SURROGATE_RE.test(body)) {
      refuse("DOTAIOS_SESSION_BODY_INVALID");
    }
  }
  return { turns: Object.freeze(turns), ...(body !== undefined ? { body } : {}) };
}

function normalizeSessionMetadata(session) {
  const optional = {};
  if (session.source_path !== undefined) {
    optional.source_path = assertText(session.source_path, "source_path", SESSION_CODEC_LIMITS.sourcePathChars);
  }
  if (session.project !== undefined) {
    optional.project = assertText(session.project, "project", SESSION_CODEC_LIMITS.projectChars);
    if (!SAFE_SLUG_RE.test(optional.project)) refuse("DOTAIOS_SESSION_PROJECT_INVALID");
  }
  if (session.project_id !== undefined) {
    optional.project_id = assertText(session.project_id, "project_id", SESSION_CODEC_LIMITS.projectIdChars);
  }
  let title = session.title ?? null;
  if (title !== null) title = assertText(title, "title", SESSION_CODEC_LIMITS.titleChars);
  return { optional, title };
}

export function normalizeSession(session, { allowBody = true } = {}) {
  assertSessionEnvelope(session);
  const { agent, sessionId, capturedAt, sourceType } = normalizeSessionIdentity(session);
  const content = normalizeSessionContent(session, allowBody);
  const { optional, title } = normalizeSessionMetadata(session);

  return Object.freeze({
    schema: 1,
    agent,
    session_id: sessionId,
    captured_at: capturedAt,
    source_type: sourceType,
    ...optional,
    ...content,
    title,
  });
}

function displayTurnTime(ts) {
  if (!ts) return "";
  if (SHORT_TIME_RE.test(ts)) return ` · ${ts}`;
  return ` · ${String(ts).slice(11, 16)}`;
}

export function renderSessionBody(session) {
  return renderNormalizedSessionBody(normalizeSession(session), false);
}

function renderNormalizedSessionBody(normalized, encodeContent = true) {
  if (normalized.turns.length === 0 && normalized.body !== undefined) return normalized.body;
  const lines = [];
  for (const turn of normalized.turns) {
    lines.push(`**${turn.role}${displayTurnTime(turn.ts)}**`, "");
    if (turn.content) lines.push(encodeContent ? encodeTurnContent(turn.content) : turn.content);
    lines.push("");
  }
  return lines.join("\n");
}

function encodeTurnContent(content) {
  return content.split("\n").map((line) => (
    line.startsWith("\\") || TURN_MARKER_RE.test(line) ? `\\${line}` : line
  )).join("\n");
}

function decodeTurnContent(content) {
  return content.split("\n").map((line) => {
    if (!line.startsWith("\\")) return line;
    const decoded = line.slice(1);
    if (!decoded.startsWith("\\") && !TURN_MARKER_RE.test(decoded)) {
      refuse("DOTAIOS_SESSION_BODY_INVALID");
    }
    return decoded;
  }).join("\n");
}

function yamlString(value, plainPattern = null) {
  return plainPattern?.test(value) ? value : JSON.stringify(value);
}

export function renderSessionMarkdown(session) {
  const normalized = normalizeSession(session);
  const body = renderNormalizedSessionBody(normalized);
  const lines = [
    "---",
    `agent: ${yamlString(normalized.agent, ROLE_RE)}`,
    // IDs such as "11111111" are strings, not YAML numbers. Always quote the
    // field so parser round-trips cannot change its type.
    `session_id: ${yamlString(normalized.session_id)}`,
    `captured_at: ${normalized.captured_at}`,
    `source_type: ${yamlString(normalized.source_type, ROLE_RE)}`,
  ];
  if (normalized.source_path) lines.push(`source_path: ${yamlString(normalized.source_path, /^[A-Za-z0-9_./:+~-]+$/)}`);
  if (normalized.project) lines.push(`project: ${normalized.project}`);
  if (normalized.project_id) lines.push(`project_id: ${yamlString(normalized.project_id, /^[A-Za-z0-9_.:-]+$/)}`);
  lines.push(`turns: ${normalized.turns.length}`);
  if (normalized.turns.length > 0) lines.push(`body_encoding: ${ESCAPED_LINES_V1}`);
  if (normalized.title) lines.push(`title: ${yamlString(normalized.title)}`);
  lines.push("schema: 1", "---", "", body);
  const markdown = lines.join("\n");
  if (byteLength(markdown) > SESSION_CODEC_LIMITS.documentBytes) {
    refuse("DOTAIOS_SESSION_DOCUMENT_TOO_LARGE");
  }
  return markdown;
}

function scalarFrontmatter(document) {
  if (!isMap(document.contents)) refuse("DOTAIOS_SESSION_FRONTMATTER_INVALID");
  let unsafe = false;
  visit(document, (_, node) => {
    if (isAlias(node) || node?.anchor || node?.tag) unsafe = true;
  });
  if (unsafe) refuse("DOTAIOS_SESSION_FRONTMATTER_UNSAFE");

  const result = Object.create(null);
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isScalar(pair.value)) {
      refuse("DOTAIOS_SESSION_FRONTMATTER_INVALID");
    }
    const key = pair.key.value;
    if (!FRONTMATTER_KEYS.has(key) || PROTOTYPE_KEYS.has(key) || Object.hasOwn(result, key)) {
      refuse("DOTAIOS_SESSION_FRONTMATTER_FIELD_INVALID");
    }
    result[key] = pair.value.value;
  }
  return result;
}

function parseTurns(body, expectedCount, bodyEncoding) {
  if (expectedCount === 0) return { turns: [], body };
  const marker = new RegExp(TURN_MARKER_RE.source, "gm");
  const matches = [...body.matchAll(marker)];
  if (matches.length !== expectedCount || matches[0]?.index !== 0) {
    refuse("DOTAIOS_SESSION_TURN_COUNT_MISMATCH");
  }
  const turns = matches.map((match, index) => {
    let start = match.index + match[0].length;
    if (body.startsWith("\n\n", start)) start += 2;
    else refuse("DOTAIOS_SESSION_BODY_INVALID");
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    const raw = body.slice(start, end);
    let content;
    if (index + 1 < matches.length) {
      if (raw === "\n") content = "";
      else if (raw.endsWith("\n\n")) content = raw.slice(0, -2);
      else refuse("DOTAIOS_SESSION_BODY_INVALID");
    } else if (raw === "") {
      content = "";
    } else if (raw.endsWith("\n")) {
      content = raw.slice(0, -1);
    } else {
      refuse("DOTAIOS_SESSION_BODY_INVALID");
    }
    if (bodyEncoding === ESCAPED_LINES_V1) content = decodeTurnContent(content);
    return normalizeTurn({ role: match[1], ...(match[2] ? { ts: match[2] } : {}), content });
  });
  return { turns };
}

export function parseSessionMarkdown(input, { allowMissingSessionId = false } = {}) {
  const text = strictDecodeUtf8(input);
  if (byteLength(text) > SESSION_CODEC_LIMITS.documentBytes) refuse("DOTAIOS_SESSION_DOCUMENT_TOO_LARGE");
  if (!text.startsWith("---\n")) refuse("DOTAIOS_SESSION_FRONTMATTER_MISSING");
  const close = text.indexOf("\n---\n", 4);
  if (close === -1) refuse("DOTAIOS_SESSION_FRONTMATTER_INVALID");
  const source = text.slice(4, close);
  if (byteLength(source) > SESSION_CODEC_LIMITS.frontmatterBytes) refuse("DOTAIOS_SESSION_FRONTMATTER_TOO_LARGE");
  if (DISALLOWED_CONTROLS_RE.test(source)) refuse("DOTAIOS_SESSION_FRONTMATTER_INVALID");

  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    refuse("DOTAIOS_SESSION_FRONTMATTER_INVALID");
  }
  const fields = scalarFrontmatter(document);
  const requiredFields = ["agent", "captured_at", "source_type", "turns", "schema"];
  if (!allowMissingSessionId) requiredFields.push("session_id");
  for (const required of requiredFields) {
    if (!Object.hasOwn(fields, required)) refuse("DOTAIOS_SESSION_FRONTMATTER_REQUIRED");
  }
  for (const optionalText of ["source_path", "project", "project_id", "title", "body_encoding"]) {
    if (Object.hasOwn(fields, optionalText) && typeof fields[optionalText] !== "string") {
      refuse("DOTAIOS_SESSION_FRONTMATTER_FIELD_INVALID");
    }
  }
  if (!Number.isInteger(fields.turns) || fields.turns < 0 || fields.turns > SESSION_CODEC_LIMITS.turns) {
    refuse("DOTAIOS_SESSION_TURNS_INVALID");
  }
  if (
    (fields.body_encoding !== undefined && fields.body_encoding !== ESCAPED_LINES_V1)
    || (fields.turns === 0 && fields.body_encoding !== undefined)
  ) {
    refuse("DOTAIOS_SESSION_BODY_INVALID");
  }
  const bodyStart = close + 5;
  if (!text.startsWith("\n", bodyStart)) refuse("DOTAIOS_SESSION_BODY_INVALID");
  const body = text.slice(bodyStart + 1);
  if (byteLength(body) > SESSION_CODEC_LIMITS.bodyBytes || DISALLOWED_CONTROLS_RE.test(body)) {
    refuse("DOTAIOS_SESSION_BODY_INVALID");
  }
  const parsedBody = parseTurns(body, fields.turns, fields.body_encoding);
  const sessionFields = { ...fields };
  Reflect.deleteProperty(sessionFields, "body_encoding");
  return normalizeSession({
    ...sessionFields,
    ...(allowMissingSessionId && !sessionFields.session_id ? { session_id: "capture-candidate" } : {}),
    ...parsedBody,
  });
}

export function deriveProjectionRow(session, relativePath, { conflictGroup, conflictOf } = {}) {
  const normalized = normalizeSession(session);
  if (
    typeof relativePath !== "string"
    || !parseSessionRelativePath(relativePath)
    || FIELD_CONTROLS_RE.test(relativePath)
    || LONE_SURROGATE_RE.test(relativePath)
    || relativePath.includes("\\")
    || relativePath.split("/").some((part) => part === "." || part === "..")
  ) {
    refuse("DOTAIOS_SESSION_PATH_INVALID");
  }
  const row = {
    session_id: normalized.session_id,
    agent: normalized.agent,
    captured_at: normalized.captured_at,
    source_type: normalized.source_type,
    ...(normalized.source_path ? { source_path: normalized.source_path } : {}),
    ...(normalized.project ? { project: normalized.project } : {}),
    ...(normalized.project_id ? { project_id: normalized.project_id } : {}),
    turns: normalized.turns.length,
    title: normalized.title,
    path: relativePath,
    content_hash: contentHash(renderNormalizedSessionBody(normalized)),
  };
  if (conflictGroup !== undefined) row.conflict_group = assertText(conflictGroup, "conflict_group", 128);
  if (conflictOf !== undefined) row.conflict_of = assertText(conflictOf, "conflict_of", SESSION_CODEC_LIMITS.sessionIdChars);
  return Object.freeze(row);
}

function comparableTurns(turns) {
  return turns.map(({ role, content }) => `${role}\u0000${content}`);
}

export function compareTurnSequences(existing, candidate) {
  const left = comparableTurns(normalizeSession(existing).turns);
  const right = comparableTurns(normalizeSession(candidate).turns);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return "divergent";
  }
  if (left.length === right.length) return "equal";
  return left.length < right.length ? "existing_prefix" : "candidate_prefix";
}

export function deriveConflictGroup(sourceIdentity) {
  const value = assertText(sourceIdentity, "source_identity", SESSION_CODEC_LIMITS.sourcePathChars);
  return `source-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function deriveProjectionRows(records, { maxRecords = 512 } = {}) {
  if (
    !Array.isArray(records)
    || !Number.isSafeInteger(maxRecords)
    || maxRecords < 0
    || records.length > maxRecords
  ) refuse("DOTAIOS_SESSION_INVENTORY_INVALID");
  const normalized = records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      refuse("DOTAIOS_SESSION_INVENTORY_INVALID");
    }
    const session = normalizeSession(record.session);
    const relativePath = record.relativePath ?? record.path;
    // Validation happens in deriveProjectionRow; this call also prevents an
    // unsafe path from influencing grouping or ordering.
    deriveProjectionRow(session, relativePath);
    const sourceIdentity = record.sourceIdentity ?? session.source_path;
    if (sourceIdentity !== undefined) {
      assertText(sourceIdentity, "source_identity", SESSION_CODEC_LIMITS.sourcePathChars);
    }
    return { session, relativePath, sourceIdentity };
  });
  normalized.sort((left, right) => (
    left.session.captured_at.localeCompare(right.session.captured_at)
    || left.session.session_id.localeCompare(right.session.session_id)
    || left.relativePath.localeCompare(right.relativePath)
  ));

  const groups = new Map();
  for (const record of normalized) {
    if (!record.sourceIdentity) continue;
    const group = groups.get(record.sourceIdentity) ?? [];
    group.push(record);
    groups.set(record.sourceIdentity, group);
  }

  return Object.freeze(normalized.map((record) => {
    const group = record.sourceIdentity ? groups.get(record.sourceIdentity) : null;
    if (!group || group.length < 2) return deriveProjectionRow(record.session, record.relativePath);
    const origin = group[0].session.session_id;
    return deriveProjectionRow(record.session, record.relativePath, {
      conflictGroup: deriveConflictGroup(record.sourceIdentity),
      ...(record.session.session_id === origin ? {} : { conflictOf: origin }),
    });
  }));
}
