import fs from "node:fs/promises";
import path from "node:path";

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

class ProjectRemoteError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "ProjectRemoteError";
    this.reason = reason;
  }
}

/** Parse a remote accepted for managed cloning and return its credential-free identity. */
export function parseProjectRemote(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw remoteError("missing", "Project remote is missing.");
  }

  const remote = value.trim();
  if (CONTROL_RE.test(remote) || /\s/.test(remote)) {
    throw remoteError("invalid", "Project remote contains invalid whitespace or control characters.");
  }
  if (remote.startsWith("-")) {
    throw remoteError("option-like", "Project remote cannot begin with an option marker.");
  }
  if (isLocalPath(remote)) {
    throw remoteError("local-path", "Project remote must not be a local path.");
  }
  if (remote.includes("::")) {
    throw remoteError("helper-transport", "Project remote helper transports are not supported.");
  }

  if (remote.includes("://")) return parseRemoteUrl(remote);
  if (/^[a-z][a-z0-9+.-]*:/i.test(remote) && !looksLikeScpRemote(remote)) {
    throw remoteError("unsupported-transport", "Project remote uses an unsupported transport.");
  }
  return parseScpRemote(remote);
}

/** Classify legacy metadata without throwing or returning unsafe remote material. */
export function classifyProjectRemote(value) {
  try {
    return { safe: true, ...parseProjectRemote(value), reason: null };
  } catch (error) {
    if (!(error instanceof ProjectRemoteError)) throw error;
    return {
      safe: false,
      transport: null,
      canonicalUrl: null,
      identity: null,
      reason: error.reason
    };
  }
}

/** Compare only remotes which independently pass the strict parser. */
export function projectRemotesMatch(left, right) {
  const expected = classifyProjectRemote(left);
  const actual = classifyProjectRemote(right);
  return expected.safe && actual.safe && expected.identity === actual.identity;
}

/** Return the reserved root for managed project checkouts. */
export function managedWorkspaceRoot(aiosPath) {
  if (typeof aiosPath !== "string" || !aiosPath.trim()) {
    throw new Error("AIOS path is required for managed workspaces.");
  }
  return path.join(path.resolve(aiosPath), "workspaces");
}

/** Derive the sole in-AIOS checkout path permitted for a project slug. */
export function managedWorkspacePath(aiosPath, slug) {
  if (typeof slug !== "string" || !SAFE_SLUG_RE.test(slug)) {
    throw new Error("Managed workspace slug must contain lowercase letters, numbers, and single hyphens.");
  }
  return path.join(managedWorkspaceRoot(aiosPath), slug);
}

/** Classify a mapped path without treating symlink aliases as managed workspaces. */
export async function classifyProjectPlacement(options = {}) {
  const fileSystem = options.fileSystem || options.fs || fs;
  const aiosPath = path.resolve(options.aiosPath || "");
  const destination = managedWorkspacePath(aiosPath, options.slug);
  const projectPath = typeof options.projectPath === "string" && options.projectPath.trim()
    ? path.resolve(options.projectPath)
    : null;
  if (!projectPath) {
    return { placement: "missing", managed: false, pathAvailable: false, destination };
  }

  const exactManagedPath = projectPath === destination;
  const lexicallyInsideAios = isLexicallyWithin(aiosPath, projectPath);
  const stats = await lstatIfPresent(fileSystem, projectPath);
  const canonicalAios = await fileSystem.realpath(aiosPath);
  const managedRootSafe = await isManagedRootSafe(fileSystem, aiosPath, canonicalAios);

  if (!stats) {
    if (exactManagedPath && managedRootSafe) {
      return { placement: "missing", managed: true, pathAvailable: false, destination };
    }
    return {
      placement: lexicallyInsideAios ? "unsafe" : "missing",
      managed: false,
      pathAvailable: false,
      destination
    };
  }

  const targetStats = stats.isSymbolicLink()
    ? await statIfPresent(fileSystem, projectPath)
    : stats;
  if (!targetStats?.isDirectory()) {
    return {
      placement: lexicallyInsideAios ? "unsafe" : "external",
      managed: false,
      pathAvailable: false,
      destination
    };
  }

  const canonicalProject = await fileSystem.realpath(projectPath);
  const canonicalDestination = path.join(canonicalAios, "workspaces", options.slug);
  if (exactManagedPath && managedRootSafe && canonicalProject === canonicalDestination) {
    return { placement: "managed", managed: true, pathAvailable: true, destination };
  }
  if (lexicallyInsideAios || isLexicallyWithin(canonicalAios, canonicalProject)) {
    return { placement: "unsafe", managed: false, pathAvailable: true, destination };
  }
  return {
    placement: "external",
    managed: false,
    pathAvailable: true,
    destination,
    canonicalPath: canonicalProject
  };
}

/** Inspect a managed destination without changing it or invoking Git itself. */
export async function classifyRestoreDestination(options = {}) {
  const fileSystem = options.fileSystem || options.fs || fs;
  const destination = path.resolve(requiredString(options.destination, "Restore destination"));
  const expected = parseProjectRemote(options.expectedRemote);
  if (typeof options.readRepositoryRemote !== "function") {
    throw new Error("readRepositoryRemote is required to classify a restore destination.");
  }

  const stats = await lstatIfPresent(fileSystem, destination);
  if (!stats) return { state: "missing", destination, expectedRemote: expected };
  if (stats.isSymbolicLink()) return { state: "symlink", destination, expectedRemote: expected };
  if (!stats.isDirectory()) return { state: "non-repository", destination, expectedRemote: expected };

  const entries = await fileSystem.readdir(destination);
  if (entries.length === 0) return { state: "empty-directory", destination, expectedRemote: expected };
  const gitMarker = await lstatIfPresent(fileSystem, path.join(destination, ".git"));
  if (!gitMarker) return { state: "non-repository", destination, expectedRemote: expected };

  let actualValue;
  try {
    actualValue = await options.readRepositoryRemote(destination);
  } catch {
    return { state: "partial-clone", destination, expectedRemote: expected };
  }
  const actual = classifyProjectRemote(actualValue);
  if (!actual.safe) {
    return {
      state: actual.reason === "missing" ? "git-no-remote" : "unsafe-remote",
      destination,
      expectedRemote: expected,
      actualRemote: actual
    };
  }
  if (actual.identity !== expected.identity) {
    return { state: "remote-mismatch", destination, expectedRemote: expected, actualRemote: actual };
  }
  if (typeof options.readRepositoryHead !== "function") {
    return { state: "partial-clone", destination, expectedRemote: expected, actualRemote: actual };
  }
  let head;
  try {
    head = await options.readRepositoryHead(destination);
  } catch {
    return { state: "partial-clone", destination, expectedRemote: expected, actualRemote: actual };
  }
  if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/i.test(head.trim())) {
    return { state: "partial-clone", destination, expectedRemote: expected, actualRemote: actual };
  }
  return {
    state: "existing-match",
    destination,
    expectedRemote: expected,
    actualRemote: actual,
    head: head.trim().toLowerCase()
  };
}

/**
 * Restore missing catalog projects into managed workspaces. All side effects
 * are injected so this core module remains offline and deterministic in tests.
 */
export async function restoreManagedProjects(options = {}) {
  const fileSystem = options.fileSystem || options.fs || fs;
  const aiosPath = path.resolve(requiredString(options.aiosPath, "AIOS path"));
  const projects = Array.isArray(options.projects) ? options.projects : [];
  const dryRun = options.dryRun === true;
  const selected = selectRestoreProjects(projects, options.reference);
  const results = [];

  for (const project of selected) {
    try {
      results.push(await restoreManagedProject({
        aiosPath,
        cloneRepository: options.cloneRepository,
        dryRun,
        fileSystem,
        project,
        readRepositoryHead: options.readRepositoryHead,
        readRepositoryRemote: options.readRepositoryRemote,
        updateMapping: options.updateMapping
      }));
    } catch (error) {
      let destination = null;
      try {
        destination = managedWorkspacePath(aiosPath, project?.slug || project?.project);
      } catch {
        // The project result below still records an invalid-project failure.
      }
      results.push(restoreFailure(
        project,
        destination,
        "unexpected-error",
        safeOperationMessage("Restore failed", error)
      ));
    }
  }

  return {
    version: 1,
    type: "project-restore",
    dry_run: dryRun,
    ok: results.every((result) => result.ok),
    selected: selected.length,
    results
  };
}

async function restoreManagedProject(options) {
  const { aiosPath, dryRun, fileSystem, project } = options;
  const slug = typeof project?.slug === "string" ? project.slug : project?.project;
  let destination = null;
  try {
    destination = managedWorkspacePath(aiosPath, slug);
  } catch {
    return restoreFailure(project, null, "invalid-project", "Project has no safe managed workspace slug.");
  }
  if (typeof project?.id !== "string" || !project.id.trim()) {
    return restoreFailure(project, destination, "missing-id", "Project has no stable id.");
  }
  const remote = classifyProjectRemote(project.repoUrl);
  if (!remote.safe) {
    return restoreFailure(project, destination, "unsafe-remote", "Project has no safe restorable remote.", {
      remote_reason: remote.reason
    });
  }
  if (typeof options.readRepositoryRemote !== "function") {
    return restoreFailure(project, destination, "missing-reader", "Repository remote reader is unavailable.");
  }

  if (project.projectPath && project.pathAvailable === true) {
    const placement = await classifyProjectPlacement({
      aiosPath,
      projectPath: project.projectPath,
      slug,
      fileSystem
    });
    if (placement.placement === "external" && placement.pathAvailable) {
      const externalPath = path.resolve(project.projectPath);
      // A user may deliberately map a symlink alias to a real repository that
      // lives outside AIOS. Validate the canonical external target already
      // proven by placement classification; managed destinations never get
      // this exception and remain strictly no-symlink.
      const externalRepositoryPath = placement.canonicalPath || externalPath;
      const external = await classifyRestoreDestination({
        destination: externalRepositoryPath,
        expectedRemote: remote.canonicalUrl,
        fileSystem,
        readRepositoryHead: options.readRepositoryHead,
        readRepositoryRemote: options.readRepositoryRemote
      });
      if (external.state === "existing-match") {
        return restoreSuccess(
          project,
          externalPath,
          remote,
          "existing-external",
          "already-available",
          false
        );
      }
      return restoreFailure(
        project,
        externalPath,
        external.state,
        `External project mapping is not a complete matching repository (${external.state}).`,
        { state: external.state }
      );
    }
    if (placement.placement === "unsafe") {
      return restoreFailure(project, destination, "unsafe-placement", "Existing project mapping is unsafe.");
    }
  }

  const classification = await classifyRestoreDestination({
    destination,
    expectedRemote: remote.canonicalUrl,
    fileSystem,
    readRepositoryHead: options.readRepositoryHead,
    readRepositoryRemote: options.readRepositoryRemote
  });

  if (classification.state === "existing-match") {
    if (dryRun) {
      return restoreSuccess(project, destination, remote, classification.state, "would-repair-mapping", false);
    }
    if (typeof options.updateMapping !== "function") {
      return restoreFailure(project, destination, "missing-mapping-writer", "Project mapping writer is unavailable.");
    }
    try {
      await options.updateMapping(mappingRequest(project, destination, classification));
    } catch (error) {
      return restoreFailure(project, destination, "mapping-failed", safeOperationMessage("Mapping update failed", error), {
        state: classification.state
      });
    }
    return restoreSuccess(project, destination, remote, classification.state, "mapping-repaired", true);
  }

  if (classification.state !== "missing") {
    return restoreFailure(
      project,
      destination,
      classification.state,
      `Managed destination is not safe to restore (${classification.state}).`,
      { state: classification.state }
    );
  }
  if (dryRun) {
    return restoreSuccess(project, destination, remote, classification.state, "would-clone", false);
  }
  if (typeof options.cloneRepository !== "function") {
    return restoreFailure(project, destination, "missing-cloner", "Repository clone function is unavailable.");
  }
  if (typeof options.updateMapping !== "function") {
    return restoreFailure(project, destination, "missing-mapping-writer", "Project mapping writer is unavailable.");
  }

  try {
    await ensureManagedWorkspaceRoot(fileSystem, aiosPath);
    await fileSystem.mkdir(destination, { recursive: false, mode: 0o700 });
  } catch (error) {
    const reason = error.code === "EEXIST" ? "destination-raced" : "claim-failed";
    return restoreFailure(project, destination, reason, safeOperationMessage("Destination claim failed", error));
  }

  try {
    await options.cloneRepository({ url: remote.canonicalUrl, destination });
  } catch (error) {
    return restoreFailure(project, destination, "clone-failed", safeOperationMessage("Clone failed", error), {
      state: "claimed"
    });
  }

  let verified;
  try {
    verified = await classifyRestoreDestination({
      destination,
      expectedRemote: remote.canonicalUrl,
      fileSystem,
      readRepositoryHead: options.readRepositoryHead,
      readRepositoryRemote: options.readRepositoryRemote
    });
  } catch (error) {
    return restoreFailure(project, destination, "verification-failed", safeOperationMessage("Verification failed", error), {
      state: "claimed"
    });
  }
  if (verified.state !== "existing-match") {
    return restoreFailure(project, destination, "verification-failed", `Cloned repository did not verify (${verified.state}).`, {
      state: verified.state
    });
  }

  try {
    await options.updateMapping(mappingRequest(project, destination, verified));
  } catch (error) {
    return restoreFailure(project, destination, "mapping-failed", safeOperationMessage("Mapping update failed", error), {
      state: "existing-match"
    });
  }
  return restoreSuccess(project, destination, remote, "missing", "cloned", true);
}

function selectRestoreProjects(projects, reference) {
  if (reference !== undefined && reference !== null && String(reference).trim()) {
    const needle = String(reference).trim();
    const matches = projects.filter((project) =>
      project?.id === needle || project?.slug === needle || project?.project === needle
    );
    if (matches.length === 0) throw new Error(`Project "${needle}" is not registered.`);
    if (matches.length > 1) throw new Error(`Project reference "${needle}" is ambiguous.`);
    return matches;
  }
  return projects.filter((project) => project?.pathAvailable !== true);
}

function mappingRequest(project, destination, verification) {
  return {
    id: project.id.trim(),
    slug: project.slug || project.project,
    projectPath: destination,
    previousPath: typeof project.projectPath === "string" ? project.projectPath : null,
    expectedRemote: verification.expectedRemote.canonicalUrl,
    expectedHead: verification.head
  };
}

function restoreSuccess(project, destination, remote, state, action, applied) {
  return {
    project_id: project.id,
    project: project.slug || project.project,
    destination,
    remote_url: remote.canonicalUrl,
    state,
    action,
    applied,
    ok: true
  };
}

function restoreFailure(project, destination, reason, message, additional = {}) {
  return {
    project_id: typeof project?.id === "string" ? project.id : null,
    project: project?.slug || project?.project || null,
    destination,
    remote_url: null,
    state: additional.state || reason,
    action: "refused",
    applied: false,
    ok: false,
    reason,
    message,
    ...additional
  };
}

async function ensureManagedWorkspaceRoot(fileSystem, aiosPath) {
  const canonicalAios = await fileSystem.realpath(aiosPath);
  const root = managedWorkspaceRoot(aiosPath);
  await fileSystem.mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await fileSystem.lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Managed workspace root is not a real directory.");
  }
  if (await fileSystem.realpath(root) !== path.join(canonicalAios, "workspaces")) {
    throw new Error("Managed workspace root resolves outside AIOS.");
  }
}

function safeOperationMessage(prefix, error) {
  const detail = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "unknown error";
  return `${prefix}: ${detail}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function parseRemoteUrl(remote) {
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    throw remoteError("invalid", "Project remote is not a valid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw remoteError("unsupported-transport", "Project remote uses an unsupported transport.");
  }
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    throw remoteError("credentials", "Project remote must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw remoteError("invalid", "Project remote must not contain a query or fragment.");
  }
  if (!parsed.hostname) {
    throw remoteError("invalid", "Project remote must include a host.");
  }
  if (parsed.protocol === "ssh:" && parsed.username && !/^[A-Za-z0-9._-]+$/.test(parsed.username)) {
    throw remoteError("invalid", "Project SSH remote has an invalid user.");
  }

  const repoPath = normalizeRepositoryPath(parsed.pathname, { leadingSlash: true });
  const host = parsed.hostname.toLowerCase();
  const hostAndPort = parsed.port ? `${formatHost(host)}:${parsed.port}` : formatHost(host);
  const identityHost = parsed.port ? `${host}:${parsed.port}` : host;
  if (parsed.protocol === "https:") {
    return {
      transport: "https",
      canonicalUrl: `${parsed.protocol}//${hostAndPort}/${repoPath}.git`,
      identity: `${identityHost}/${repoPath}`
    };
  }
  const user = parsed.username ? `${parsed.username}@` : "";
  return {
    transport: "ssh",
    canonicalUrl: `ssh://${user}${hostAndPort}/${repoPath}.git`,
    identity: `${identityHost}/${repoPath}`
  };
}

function parseScpRemote(remote) {
  const match = /^(?:([A-Za-z0-9._-]+)@)?([^\s:]+):(.+)$/.exec(remote);
  if (!match) {
    throw remoteError("unsupported-transport", "Project remote must use HTTPS, SSH, or scp syntax.");
  }
  const [, user, rawHost, rawPath] = match;
  if (!isSafeScpHost(rawHost)) {
    throw remoteError("invalid", "Project scp remote has an invalid host.");
  }
  const host = rawHost.toLowerCase();
  const repoPath = normalizeRepositoryPath(rawPath, { leadingSlash: false });
  return {
    transport: "scp",
    canonicalUrl: `${user ? `${user}@` : ""}${host}:${repoPath}.git`,
    identity: `${host}/${repoPath}`
  };
}

function normalizeRepositoryPath(rawPath, options) {
  let pathValue = rawPath;
  if (options.leadingSlash) {
    if (!pathValue.startsWith("/")) {
      throw remoteError("invalid", "Project remote must include a repository path.");
    }
    pathValue = pathValue.slice(1);
  } else if (pathValue.startsWith("/") || pathValue.startsWith("~") || pathValue.startsWith("-")) {
    throw remoteError("local-path", "Project remote must use a relative repository path.");
  }

  pathValue = pathValue.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!pathValue) {
    throw remoteError("invalid", "Project remote must include a repository path.");
  }
  const segments = pathValue.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw remoteError("invalid", "Project remote contains an unsafe repository path.");
  }
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw remoteError("invalid", "Project remote contains invalid path encoding.");
    }
    if (!decoded || decoded === "." || decoded === ".." || /[\\/]/.test(decoded) || CONTROL_RE.test(decoded)) {
      throw remoteError("invalid", "Project remote contains an unsafe repository path.");
    }
  }
  return pathValue;
}

function isLocalPath(remote) {
  return remote.startsWith("/")
    || remote.startsWith("./")
    || remote.startsWith("../")
    || remote.startsWith("~/")
    || remote.startsWith("\\\\")
    || /^[A-Za-z]:/.test(remote);
}

function isSafeScpHost(host) {
  if (!host || host.startsWith("-") || /[\\/@]/.test(host)) return false;
  return host.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

function looksLikeScpRemote(remote) {
  return /^(?:[A-Za-z0-9._-]+@)?[^\s:]+:.+$/.test(remote);
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

async function isManagedRootSafe(fileSystem, aiosPath, canonicalAios) {
  const root = managedWorkspaceRoot(aiosPath);
  const stats = await lstatIfPresent(fileSystem, root);
  if (!stats) return true;
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  return await fileSystem.realpath(root) === path.join(canonicalAios, "workspaces");
}

async function lstatIfPresent(fileSystem, target) {
  try {
    return await fileSystem.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function statIfPresent(fileSystem, target) {
  try {
    return await fileSystem.stat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isLexicallyWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    !path.isAbsolute(relative)
    && !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
  );
}

function remoteError(reason, message) {
  return new ProjectRemoteError(reason, message);
}
