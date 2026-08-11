export const SESSIONS_RELATIVE = "memory/sessions";

const DATE_DIRECTORY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_FILE_RE = /^[^/\\\0]+\.md$/;
const CANONICAL_SESSION_FILE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})_[a-z0-9-]+_[a-z0-9_-]{1,6}\.md$/;

export function isSessionDateDirectory(value) {
  return typeof value === "string" && DATE_DIRECTORY_RE.test(value) && isRealCalendarDate(value);
}

export function isSessionMarkdownFilename(value) {
  return typeof value === "string" && SESSION_FILE_RE.test(value);
}

export function parseSessionRelativePath(value, { requireCanonicalFilename = false } = {}) {
  if (
    typeof value !== "string"
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
  ) return null;
  const parts = value.split("/");
  if (
    parts.length !== 4
    || parts[0] !== "memory"
    || parts[1] !== "sessions"
    || !isSessionDateDirectory(parts[2])
    || !isSessionMarkdownFilename(parts[3])
    || parts.some((part) => part === "." || part === ".." || part === "")
  ) return null;
  if (requireCanonicalFilename) {
    const match = parts[3].match(CANONICAL_SESSION_FILE_RE);
    if (
      !match
      || match[1] !== parts[2]
      || Number(match[2]) > 23
      || Number(match[3]) > 59
      || Number(match[4]) > 59
    ) return null;
  }
  return Object.freeze({
    date: parts[2],
    filename: parts[3],
    relativePath: value,
  });
}

function isRealCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}
