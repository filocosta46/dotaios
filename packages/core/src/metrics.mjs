import fs from "node:fs/promises";
import path from "node:path";

export async function appendMetric(filePath, payload) {
  const entry = {
    ts: new Date().toISOString(),
    ...payload
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function readJsonLines(filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines.
    }
  }
  return rows;
}
