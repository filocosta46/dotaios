import fs from "node:fs/promises";
import path from "node:path";
import { inspectContainedFile } from "./contained-read.mjs";

const GOOGLE_CONNECTION = "google-workspace";
const SAFE_TEXT_MAX = 500;
const DATE_WINDOWS = new Set(["today", "tomorrow", "week"]);
const WRITE_LIKE_RE = /(?:^|[._-])(send|write|create|update|delete|remove|trash|move|modify|reply|forward)(?:$|[._-])/i;

const CAPABILITIES = Object.freeze({
  "google.gmail.inbox": Object.freeze({
    allowed: [],
    argv: () => ["google", "inbox", "--json"]
  }),
  "google.gmail.search": Object.freeze({
    allowed: ["query"],
    argv: ({ query }) => ["google", "gmail", "search", "--query", safeText(query, "query"), "--json"]
  }),
  "google.gmail.read": Object.freeze({
    allowed: ["messageId"],
    argv: ({ messageId }) => ["google", "gmail", "read", "--message-id", messageIdentifier(messageId), "--json"]
  }),
  "google.calendar.agenda": Object.freeze({
    allowed: ["dateWindow"],
    argv: ({ dateWindow }) => ["google", "agenda", dateWindowFlag(dateWindow), "--json"]
  }),
  "google.calendar.prep": Object.freeze({
    allowed: ["dateWindow"],
    argv: ({ dateWindow }) => ["google", "calendar", "prep", dateWindowFlag(dateWindow), "--json"]
  }),
  "google.drive.list": Object.freeze({
    allowed: ["pageSize"],
    argv: ({ pageSize }) => ["google", "drive", "--page-size", pageSizeValue(pageSize), "--json"]
  }),
  "google.drive.find": Object.freeze({
    allowed: ["query"],
    argv: ({ query }) => ["google", "drive", "find", "--query", safeText(query, "query"), "--json"]
  })
});

/** Inspect only product-owned connection markers; their prose is never parsed. */
export async function inspectConfiguredConnections({ aiosPath, filesystem = fs } = {}) {
  const root = path.resolve(requiredString(aiosPath, "aiosPath"));
  const marker = path.join(root, "connections", "apis", "google-workspace.md");
  let snapshot;
  try {
    snapshot = await inspectContainedFile(root, marker, { filesystem });
  } catch {
    return { labels: [], issues: ["google_connection_marker_unsafe"] };
  }
  if (snapshot === null) return { labels: [], issues: [] };
  return { labels: [GOOGLE_CONNECTION], issues: [] };
}

/** Resolve a structured request through the closed, read-only capability table. */
export function resolveConnectionTool({ configuredConnections = [], configurationIssues = [], request = null } = {}) {
  if (request === null || request === undefined) {
    return {
      status: "no_match",
      capability: null,
      connection: null,
      configured: false,
      authenticated: "unknown",
      reason: "not_requested"
    };
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return refused(null, false, "invalid_request");
  }
  const capability = typeof request.capability === "string" ? request.capability : null;
  if (!capability || capability.trim() !== capability || capability.length > 100 || /\p{Cc}/u.test(capability)) {
    return refused(null, false, "invalid_capability");
  }
  if (configurationIssues.length > 0) {
    return refused(capability, false, "unsafe_configuration");
  }

  const configuredCount = configuredConnections.filter((label) => label === GOOGLE_CONNECTION).length;
  if (configuredCount > 1) return refused(capability, true, "connection_collision");
  const configured = configuredCount === 1;
  const descriptor = CAPABILITIES[capability];
  if (!descriptor) {
    return WRITE_LIKE_RE.test(capability)
      ? refused(capability, configured, "write_capability_refused")
      : noMatch(capability, configured, "unsupported_capability");
  }
  if (!configured) return noMatch(capability, false, "connection_not_configured");

  const supplied = Object.keys(request).filter((key) => key !== "capability");
  if (supplied.some((key) => !descriptor.allowed.includes(key))) {
    return refused(capability, true, "extra_parameters_refused");
  }
  if (supplied.length !== descriptor.allowed.length || descriptor.allowed.some((key) => !Object.hasOwn(request, key))) {
    return refused(capability, true, "required_parameter_missing");
  }

  try {
    return {
      status: "matched",
      capability,
      connection: GOOGLE_CONNECTION,
      configured: true,
      authenticated: "unknown",
      argv_suffix: descriptor.argv(request)
    };
  } catch (error) {
    return refused(capability, true, error?.code || "invalid_parameters");
  }
}

function noMatch(capability, configured, reason) {
  return {
    status: "no_match",
    capability,
    connection: configured ? GOOGLE_CONNECTION : null,
    configured,
    authenticated: "unknown",
    reason
  };
}

function refused(capability, configured, reason) {
  return {
    status: "refused",
    capability,
    connection: configured ? GOOGLE_CONNECTION : null,
    configured,
    authenticated: "unknown",
    reason
  };
}

function safeText(value, field) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.startsWith("--")
    || Array.from(value).length > SAFE_TEXT_MAX
    || /\p{Cc}/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw validationError(`invalid_${field}`);
  }
  return value;
}

function messageIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value) || value.startsWith("-")) {
    throw validationError("invalid_message_id");
  }
  return value;
}

function dateWindowFlag(value) {
  if (!DATE_WINDOWS.has(value)) throw validationError("invalid_date_window");
  return `--${value}`;
}

function pageSizeValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw validationError("invalid_page_size");
  }
  return String(value);
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function validationError(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}
