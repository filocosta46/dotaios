import fs from "node:fs/promises";
import path from "node:path";
import {
  classifyProjectRemote,
  projectRemotesMatch
} from "../../../core/src/project-workspaces.mjs";

export function findGitlinks(lsFilesStdout) {
  return parseIndexEntries(lsFilesStdout)
    .filter((entry) => entry.metadata.startsWith("160000 "))
    .map((entry) => entry.path);
}

export function findSymlinkEntries(lsFilesStdout) {
  return parseIndexEntries(lsFilesStdout)
    .filter((entry) => entry.metadata.startsWith("120000 "))
    .map((entry) => entry.path);
}

export function findWorkspaceIndexEntries(lsFilesStdout) {
  const found = new Set();
  for (const { path: candidate } of parseIndexEntries(lsFilesStdout)) {
    const portablePath = candidate.toLowerCase();
    if (portablePath === "workspaces" || portablePath.startsWith("workspaces/")) {
      found.add(candidate);
    }
  }
  return [...found].sort();
}

function findWorkspaceChangedPaths(changedPaths) {
  return [...new Set(changedPaths.filter((candidate) => {
    const portablePath = String(candidate).replaceAll("\\", "/").toLowerCase();
    return portablePath === "workspaces" || portablePath.startsWith("workspaces/");
  }))].sort();
}

function parseIndexEntries(lsFilesStdout) {
  if (!lsFilesStdout) return [];
  const records = lsFilesStdout.includes("\0")
    ? lsFilesStdout.split("\0")
    : lsFilesStdout.split("\n");
  return records.flatMap((record) => {
    if (!record) return [];
    const tab = record.indexOf("\t");
    if (tab === -1 || !record.slice(tab + 1)) return [];
    return [{ metadata: record.slice(0, tab), path: record.slice(tab + 1) }];
  });
}

function isSensitiveMirrorPath(candidate) {
  const portablePath = String(candidate).replaceAll("\\", "/").toLowerCase();
  const parts = portablePath.split("/").filter(Boolean);
  const basename = parts.at(-1) || "";
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) return true;
  // Keep the fail-closed policy aligned with the scaffolded ignore contract.
  // Patterns without a slash apply to these basenames at every depth, and the
  // lower-cased portable path also blocks aliases on case-insensitive hosts.
  if (/^(?:credentials|token)\./.test(basename)) return true;
  if (/\.(?:key|pem|token|credentials)$/.test(basename)) return true;
  if (basename === ".ds_store") return true;
  if (basename === ".dotaios-setup-transaction.json") return true;
  if (/^\.dotaios-setup-.*\.tmp$/.test(basename)) return true;
  if (portablePath.startsWith(".dotaios/migrations/transactions/")) return true;
  if (
    portablePath.startsWith(".dotaios/migrations/receipts/")
    && basename.endsWith(".pending")
  ) return true;
  if (parts.some((part) => part === "cache" || part === "tmp" || part === "node_modules")) return true;
  if (/^connections\/[^/]+\/(?:credentials|token)\.json$/.test(portablePath)) return true;
  return /^license\/[^/]+\.json$/.test(portablePath);
}

export function findSensitiveMirrorPaths(paths) {
  return [...new Set(paths.filter(isSensitiveMirrorPath))].sort();
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
    "Only complete registered repositories at workspaces/<project-slug> are allowed.",
    "Move this repository outside the AIOS folder, or use its exact registered workspace path."
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
  // Git follows a symlinked .git marker. Treat it as repository control so the
  // pre-add scan refuses it; otherwise Git can stage a Gitlink before the
  // pre-commit hook gets a chance to object.
  if (stat.isSymbolicLink()) return true;
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

async function walkForNestedRepositories(
  root,
  current,
  found,
  filesystem,
  allowedRepositories = new Set()
) {
  let stat;
  try {
    stat = await filesystem.lstat(current);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  if (current !== root && await isGitControlEntry(current, filesystem)) {
    const relative = path.relative(root, current).split(path.sep).join("/");
    if (!allowedRepositories.has(relative)) {
      found.add(relative);
      return;
    }
  }
  for (const entry of await filesystem.readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkForNestedRepositories(
        root,
        path.join(current, entry.name),
        found,
        filesystem,
        allowedRepositories
      );
    }
  }
}

async function assertWorkspaceCatalogEntries(
  root,
  projectCatalog,
  inspectWorkspaceRepository,
  filesystem
) {
  const workspacesRoot = path.join(root, "workspaces");
  let rootStat;
  try {
    rootStat = await filesystem.lstat(workspacesRoot);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Cannot sync: workspaces/ must be a real local directory, not a file or symbolic link.");
  }

  const registered = new Map(projectCatalog.map((project) => [project.slug, project]));
  const allowedRepositories = new Set();
  const entries = await filesystem.readdir(workspacesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!registered.has(entry.name)) {
      throw new Error(
        `Cannot sync: workspace "${entry.name}" is unregistered in the project catalog. Nothing was committed or pushed.`
      );
    }
    const project = registered.get(entry.name);
    if (typeof project.id !== "string" || !project.id.trim()) {
      throw new Error(
        `Cannot sync: workspace "${entry.name}" has no durable stable project id in the project catalog.`
      );
    }
    const candidate = path.join(workspacesRoot, entry.name);
    const candidateStat = await filesystem.lstat(candidate);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      const kind = candidateStat.isSymbolicLink() ? "symbolic link" : "file or debris";
      throw new Error(
        `Cannot sync: workspace "${entry.name}" is a ${kind}; every workspace must be a real top-level directory.`
      );
    }
    let gitControlStat;
    try {
      gitControlStat = await filesystem.lstat(path.join(candidate, ".git"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      !gitControlStat
      || gitControlStat.isSymbolicLink()
      || (!gitControlStat.isDirectory() && !gitControlStat.isFile())
    ) {
      throw new Error(
        `Cannot sync: workspace "${entry.name}" is not a complete Git repository with a safe regular Git control entry.`
      );
    }
    const repository = await inspectWorkspaceRepository(candidate);
    let repositoryRoot = null;
    try {
      repositoryRoot = repository?.topLevelPath
        ? await filesystem.realpath(repository.topLevelPath)
        : null;
    } catch {
      repositoryRoot = null;
    }
    const candidateRoot = await filesystem.realpath(candidate);
    if (
      !repository?.head
      || !repositoryRoot
      || repositoryRoot !== candidateRoot
      || !repository?.remoteUrl
    ) {
      throw new Error(
        `Cannot sync: workspace "${entry.name}" is not a complete Git repository with its own commit and origin.`
      );
    }

    const expectedRemote = classifyProjectRemote(project.repoUrl);
    const actualRemote = classifyProjectRemote(repository.remoteUrl);
    if (!expectedRemote.safe || !actualRemote.safe) {
      throw new Error(
        `Cannot sync: workspace "${entry.name}" has a missing or unsafe project remote.`
      );
    }
    if (!projectRemotesMatch(project.repoUrl, repository.remoteUrl)) {
      throw new Error(
        `Cannot sync: workspace "${entry.name}" origin does not match its project catalog remote.`
      );
    }
    allowedRepositories.add(`workspaces/${entry.name}`);
  }
  return allowedRepositories;
}

export async function assertMirrorContentSafe({
  root,
  changedPaths = [],
  indexedEntries,
  workspacesRootIgnored = null,
  inspectWholeTree = false,
  projectCatalog = [],
  inspectWorkspaceRepository = async () => null,
  filesystem = fs
}) {
  if (workspacesRootIgnored === false) {
    throw new Error([
      "Cannot sync: the /workspaces/ root ignore is not effective. Nothing was committed or pushed.",
      "Preview the path-aware versioned folder upgrade before retrying:",
      `  dotaios migrate --path ${JSON.stringify(path.resolve(root))}`
    ].join("\n"));
  }
  const workspaceIndexEntries = findWorkspaceIndexEntries(indexedEntries);
  if (workspaceIndexEntries.length > 0) {
    throw new Error([
      "Cannot sync: the outer Git index contains entries under workspaces/.",
      "",
      ...workspaceIndexEntries.map((entry) => `  ${entry}`),
      "",
      "Nothing was committed or pushed."
    ].join("\n"));
  }
  const workspaceChangedPaths = findWorkspaceChangedPaths(changedPaths);
  if (workspaceChangedPaths.length > 0) {
    throw new Error([
      "Cannot sync: local workspace paths must stay under the exact ignored workspaces/ root.",
      "",
      ...workspaceChangedPaths.map((entry) => `  ${entry}`),
      "",
      "Nothing was staged, committed, or pushed."
    ].join("\n"));
  }
  const sensitivePaths = findSensitiveMirrorPaths([
    ...changedPaths,
    ...parseIndexEntries(indexedEntries).map((entry) => entry.path)
  ]);
  if (sensitivePaths.length > 0) {
    throw new Error([
      "Cannot sync: the candidate mirror contains private or regenerable local files.",
      "",
      ...sensitivePaths.map((entry) => `  ${entry}`),
      "",
      "Nothing was staged, committed, or pushed. Keep these paths local and ignored."
    ].join("\n"));
  }
  const symlinkEntries = findSymlinkEntries(indexedEntries);
  if (symlinkEntries.length > 0) {
    throw new Error([
      "Cannot sync: the candidate mirror contains symbolic links.",
      "",
      ...symlinkEntries.map((entry) => `  ${entry}`),
      "",
      "Nothing was committed or pushed. Keep only regular files and directories in the portable mirror."
    ].join("\n"));
  }
  const found = new Set(findGitlinks(indexedEntries));
  if (inspectWholeTree) {
    const allowedRepositories = await assertWorkspaceCatalogEntries(
      root,
      projectCatalog,
      inspectWorkspaceRepository,
      filesystem
    );
    await walkForNestedRepositories(root, root, found, filesystem, allowedRepositories);
  } else {
    for (const changedPath of changedPaths) {
      const absolute = path.resolve(root, changedPath);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      await walkForNestedRepositories(root, absolute, found, filesystem);
    }
  }
  if (found.size > 0) throw new Error(nestedRepoMessage([...found].sort()));
}
