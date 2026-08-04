import fs from "node:fs/promises";
import path from "node:path";

export function findGitlinks(lsFilesStdout) {
  if (!lsFilesStdout) return [];
  const paths = [];
  for (const line of lsFilesStdout.split("\n")) {
    if (!line.startsWith("160000 ")) continue;
    const tab = line.indexOf("\t");
    if (tab !== -1 && line.slice(tab + 1)) paths.push(line.slice(tab + 1));
  }
  return paths;
}

export function nestedRepoMessage(paths) {
  const list = paths.map((p) => `  ${p}`).join("\n");
  return [
    paths.length === 1
      ? "Cannot sync: a project inside your AIOS folder has its own Git repository."
      : "Cannot sync: some projects inside your AIOS folder have their own Git repository.",
    "",
    list,
    "",
    "Git would store only a pointer, not the files. Nothing was committed and",
    "DotAIOS did not rewrite your Git index.",
    "",
    "Move the project outside your AIOS folder and register it instead:",
    "  dotaios project add <path-to-project>"
  ].join("\n");
}

async function isGitControlEntry(directory, filesystem) {
  const marker = path.join(directory, ".git");
  let stat;
  try {
    stat = await filesystem.lstat(marker);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isDirectory()) return true;
  if (!stat.isFile()) return false;
  const content = await filesystem.readFile(marker, "utf8");
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return false;
  const target = path.resolve(directory, match[1]);
  try {
    return (await filesystem.lstat(target)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function walkForNestedRepositories(root, current, found, filesystem) {
  let stat;
  try {
    stat = await filesystem.lstat(current);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  if (current !== root && await isGitControlEntry(current, filesystem)) {
    found.add(path.relative(root, current).split(path.sep).join("/"));
    return;
  }
  for (const entry of await filesystem.readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkForNestedRepositories(root, path.join(current, entry.name), found, filesystem);
    }
  }
}

export async function assertMirrorContentSafe({
  root,
  changedPaths,
  indexedEntries,
  filesystem = fs
}) {
  const found = new Set(findGitlinks(indexedEntries));
  for (const changedPath of changedPaths) {
    const absolute = path.resolve(root, changedPath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await walkForNestedRepositories(root, absolute, found, filesystem);
  }
  if (found.size > 0) throw new Error(nestedRepoMessage([...found].sort()));
}
