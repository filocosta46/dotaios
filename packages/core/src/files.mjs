import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeFileSafe(destination, content, writeMode = "preserve") {
  const exists = await pathExists(destination);
  if (exists && writeMode === "preserve") {
    return { action: "kept", path: destination };
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
  return { action: exists ? "updated" : "created", path: destination };
}

export async function copyFileSafe(source, destination, writeMode = "preserve") {
  const exists = await pathExists(destination);
  if (exists && writeMode === "preserve") {
    return { action: "kept", path: destination };
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return { action: exists ? "updated" : "created", path: destination };
}

export async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(resolved) : resolved;
  }));

  return files.flat();
}
