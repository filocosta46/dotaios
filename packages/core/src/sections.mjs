function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A bullet value is whatever follows the label on that one line. `\s` matches
// newlines, so it ran past an empty bullet and swallowed the lines after it;
// keep the separator horizontal-only. `.*` (not `.+`) so an empty bullet still
// matches and stays fillable.
const BULLET_SPACE = "[^\\S\\r\\n]*";

export function readBullet(content, label) {
  const pattern = new RegExp(`^- ${escapeRegex(label)}:${BULLET_SPACE}(.*)$`, "im");
  return content.match(pattern)?.[1]?.trim() || "";
}

export function replaceBullet(content, label, newValue) {
  const pattern = new RegExp(`^(- ${escapeRegex(label)}:)${BULLET_SPACE}.*$`, "im");
  if (!pattern.test(content)) return null;
  // A replacer function, so `$&` or `$1` in someone's own answer stays literal
  // instead of being read back as a capture reference.
  return content.replace(pattern, (_match, prefix) => `${prefix} ${newValue}`);
}

export function readSection(content, heading) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return "";

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

export function readSubsection(content, heading) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start === -1) return "";

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3} /.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

export function replaceSection(content, heading, newBody) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }

  const before = lines.slice(0, start + 1);
  const after = lines.slice(end);
  const body = newBody.trim();
  const middle = ["", body, ""];
  return [...before, ...middle, ...after].join("\n");
}
