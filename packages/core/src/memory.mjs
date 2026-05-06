export const RECENT_EVENT_LIMIT = 50;

export function parseJsonlLine(line) {
  if (!line.trim()) return null;
  return JSON.parse(line);
}

export function formatJsonlEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}
