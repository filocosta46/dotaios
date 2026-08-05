import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathWithinLexically } from "./paths.mjs";
import { processBirthToken, processRecordIsAlive } from "./process-identity.mjs";

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const RESTORE_TRANSACTION_SCHEMA = "dotaios.project-restore-transaction.v1";
const RESTORE_TRANSACTION_MARKER = "transaction.json";
const RESTORE_CHECKOUT_DIRECTORY = "checkout";
const RESTORE_DESTINATION_CLAIM_SCHEMA = "dotaios.project-restore-destination-claim.v1";
const RESTORE_DESTINATION_CLAIM_MARKER = "destination-claim.json";

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
  return expected.safe && actual.safe && parsedProjectRemotesMatch(expected, actual);
}

function parsedProjectRemotesMatch(expected, actual) {
  const expectedSsh = expected.transport === "ssh" || expected.transport === "scp";
  const actualSsh = actual.transport === "ssh" || actual.transport === "scp";
  if (expected.transport === "https" && actual.transport === "https") {
    return expected.identity === actual.identity;
  }
  if (expectedSsh && actualSsh) {
    return expected.identity === actual.identity;
  }

  // Major hosted forges deliberately present one repository through HTTPS and
  // the fixed `git` SSH principal. Keep that common transport switch portable,
  // but never accept an omitted or arbitrary SSH username: it can select a
  // different repository namespace even when host/path text is identical.
  const https = expected.transport === "https"
    ? expected
    : actual.transport === "https"
      ? actual
      : null;
  const ssh = expected.transport === "https" ? actual : expected;
  if (!https || (ssh.transport !== "ssh" && ssh.transport !== "scp")) return false;
  const fixedGitHosts = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
  const host = https.identity.split("/", 1)[0];
  return fixedGitHosts.has(host)
    && ssh.identity.startsWith(`git@${host}/`)
    && https.identity === ssh.identity.slice("git@".length);
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
  const lexicallyInsideAios = isPathWithinLexically(aiosPath, projectPath);
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
  if (lexicallyInsideAios || isPathWithinLexically(canonicalAios, canonicalProject)) {
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

  const gitMarker = await lstatIfPresent(fileSystem, path.join(destination, ".git"));
  if (!gitMarker) {
    const entries = await fileSystem.readdir(destination);
    return {
      state: entries.length === 0 ? "empty-directory" : "non-repository",
      destination,
      expectedRemote: expected
    };
  }
  if (gitMarker.isSymbolicLink() || (!gitMarker.isDirectory() && !gitMarker.isFile())) {
    return { state: "unsafe-git-marker", destination, expectedRemote: expected };
  }

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
  if (!parsedProjectRemotesMatch(expected, actual)) {
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
      // A process can exit after atomically publishing the checkout but before
      // removing its sibling transaction or saving the local mapping. Clean
      // only a dead, exact owner record; a live publisher will clean itself.
      await recoverOwnedRestoreTransaction({
        aiosPath,
        destination,
        fileSystem,
        project,
        readRepositoryHead: options.readRepositoryHead,
        readRepositoryRemote: options.readRepositoryRemote,
        remote
      });
    } catch (error) {
      const reason = error.code === "RESTORE_CLEANUP_REQUIRED" ? "cleanup-required" : "recovery-failed";
      return restoreFailure(project, destination, reason, safeOperationMessage("Published restore cleanup failed", error));
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

  if (classification.state === "empty-directory" && !dryRun
    && typeof options.updateMapping === "function") {
    try {
      await ensureManagedWorkspaceRoot(fileSystem, aiosPath);
      const recovered = await recoverOwnedRestoreTransaction({
        aiosPath,
        destination,
        fileSystem,
        project,
        readRepositoryHead: options.readRepositoryHead,
        readRepositoryRemote: options.readRepositoryRemote,
        remote
      });
      if (recovered?.busy) {
        return restoreFailure(
          project,
          destination,
          "restore-busy",
          "Another live restore transaction already owns this project staging operation.",
          { state: "staged" }
        );
      }
      if (recovered?.raced) {
        return restoreFailure(
          project,
          destination,
          "destination-raced",
          `Managed destination changed during interrupted restore recovery (${recovered.raced.state}).`,
          { state: recovered.raced.state }
        );
      }
      if (recovered?.verification) {
        try {
          await options.updateMapping(mappingRequest(project, destination, recovered.verification));
        } catch (error) {
          return restoreFailure(project, destination, "mapping-failed", safeOperationMessage("Mapping update failed", error), {
            state: "existing-match"
          });
        }
        return restoreSuccess(project, destination, remote, "missing", "cloned", true);
      }
    } catch (error) {
      const reason = error.code === "RESTORE_CLEANUP_REQUIRED" ? "cleanup-required" : "recovery-failed";
      return restoreFailure(project, destination, reason, safeOperationMessage("Restore destination-claim recovery failed", error));
    }
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
  } catch (error) {
    return restoreFailure(project, destination, "claim-failed", safeOperationMessage("Managed workspace preparation failed", error));
  }

  let recovered;
  try {
    recovered = await recoverOwnedRestoreTransaction({
      aiosPath,
      destination,
      fileSystem,
      project,
      readRepositoryHead: options.readRepositoryHead,
      readRepositoryRemote: options.readRepositoryRemote,
      remote
    });
  } catch (error) {
    const reason = error.code === "RESTORE_CLEANUP_REQUIRED" ? "cleanup-required" : "recovery-failed";
    return restoreFailure(project, destination, reason, safeOperationMessage("Restore transaction recovery failed", error));
  }
  if (recovered?.busy) {
    return restoreFailure(
      project,
      destination,
      "restore-busy",
      "Another live restore transaction already owns this project staging operation.",
      { state: "staged" }
    );
  }
  if (recovered?.raced) {
    return restoreFailure(
      project,
      destination,
      "destination-raced",
      `Managed destination changed during interrupted restore recovery (${recovered.raced.state}).`,
      { state: recovered.raced.state }
    );
  }
  if (recovered?.verification) {
    try {
      await options.updateMapping(mappingRequest(project, destination, recovered.verification));
    } catch (error) {
      return restoreFailure(project, destination, "mapping-failed", safeOperationMessage("Mapping update failed", error), {
        state: "existing-match"
      });
    }
    return restoreSuccess(project, destination, remote, "missing", "cloned", true);
  }

  const destinationAfterRecovery = await classifyRestoreDestination({
    destination,
    expectedRemote: remote.canonicalUrl,
    fileSystem,
    readRepositoryHead: options.readRepositoryHead,
    readRepositoryRemote: options.readRepositoryRemote
  });
  if (destinationAfterRecovery.state !== "missing") {
    return restoreFailure(
      project,
      destination,
      "destination-raced",
      `Managed destination changed before restore (${destinationAfterRecovery.state}).`,
      { state: destinationAfterRecovery.state }
    );
  }

  let transaction;
  try {
    transaction = await createRestoreTransaction({
      aiosPath,
      destination,
      fileSystem,
      project,
      remote
    });
  } catch (error) {
    const reason = error.code === "RESTORE_CLEANUP_REQUIRED" ? "cleanup-required" : "claim-failed";
    return restoreFailure(project, destination, reason, safeOperationMessage("Restore transaction claim failed", error));
  }
  try {
    await options.cloneRepository({ url: remote.canonicalUrl, destination: transaction.checkout });
  } catch (error) {
    try {
      await cleanupRestoreTransaction(fileSystem, transaction);
    } catch (cleanupError) {
      return restoreFailure(
        project,
        destination,
        "cleanup-required",
        safeOperationMessage("Clone failed and its owned staging transaction could not be cleaned", cleanupError),
        { state: "staged" }
      );
    }
    return restoreFailure(project, destination, "clone-failed", safeOperationMessage("Clone failed", error), {
      state: "staged"
    });
  }

  let verified;
  try {
    verified = await classifyRestoreDestination({
      destination: transaction.checkout,
      expectedRemote: remote.canonicalUrl,
      fileSystem,
      readRepositoryHead: options.readRepositoryHead,
      readRepositoryRemote: options.readRepositoryRemote
    });
  } catch (error) {
    try {
      await cleanupRestoreTransaction(fileSystem, transaction);
    } catch (cleanupError) {
      return restoreFailure(project, destination, "cleanup-required", safeOperationMessage("Unverified staging could not be cleaned", cleanupError), {
        state: "staged"
      });
    }
    return restoreFailure(project, destination, "verification-failed", safeOperationMessage("Verification failed", error), {
      state: "staged"
    });
  }
  if (verified.state !== "existing-match") {
    try {
      await cleanupRestoreTransaction(fileSystem, transaction);
    } catch (cleanupError) {
      return restoreFailure(project, destination, "cleanup-required", safeOperationMessage("Unverified staging could not be cleaned", cleanupError), {
        state: verified.state
      });
    }
    return restoreFailure(project, destination, "verification-failed", `Cloned repository did not verify (${verified.state}).`, {
      state: verified.state
    });
  }

  try {
    await publishRestoreTransaction(fileSystem, transaction);
  } catch (error) {
    if (error.code === "RESTORE_CLEANUP_REQUIRED") {
      return restoreFailure(project, destination, "cleanup-required", safeOperationMessage("Restore publication cleanup failed", error), {
        state: "staged"
      });
    }
    const winner = await classifyRestoreDestination({
      destination,
      expectedRemote: remote.canonicalUrl,
      fileSystem,
      readRepositoryHead: options.readRepositoryHead,
      readRepositoryRemote: options.readRepositoryRemote
    });
    try {
      await cleanupRestoreTransaction(fileSystem, transaction);
    } catch (cleanupError) {
      return restoreFailure(project, destination, "cleanup-required", safeOperationMessage("Losing staging transaction could not be cleaned", cleanupError), {
        state: winner.state
      });
    }
    if (winner.state !== "existing-match") {
      return restoreFailure(project, destination, "destination-raced", safeOperationMessage("Restore publication failed", error), {
        state: winner.state
      });
    }
    verified = winner;
  }

  try {
    await cleanupRestoreTransaction(fileSystem, transaction);
  } catch (cleanupError) {
    return restoreFailure(project, destination, "cleanup-required", safeOperationMessage("Published restore transaction could not be cleaned", cleanupError), {
      state: "existing-match"
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

async function createRestoreTransaction({ aiosPath, destination, fileSystem, project, remote }) {
  const root = managedWorkspaceRoot(aiosPath);
  const slug = project.slug || project.project;
  const owner = randomUUID();
  const transactionRoot = path.join(root, `.dotaios-restore-${slug}-${owner}`);
  const checkout = path.join(transactionRoot, RESTORE_CHECKOUT_DIRECTORY);
  const processStartedAt = processBirthToken(process.pid);
  const marker = {
    schema: RESTORE_TRANSACTION_SCHEMA,
    project_id: project.id.trim(),
    slug,
    remote_url: remote.canonicalUrl,
    destination,
    checkout: RESTORE_CHECKOUT_DIRECTORY,
    pid: process.pid,
    owner,
    created_at: new Date().toISOString(),
    ...(processStartedAt && { process_started_at: processStartedAt })
  };
  const markerContent = `${JSON.stringify(marker, null, 2)}\n`;
  await fileSystem.mkdir(transactionRoot, { recursive: false, mode: 0o700 });
  try {
    const rootStats = await fileSystem.lstat(transactionRoot);
    await fileSystem.writeFile(path.join(transactionRoot, RESTORE_TRANSACTION_MARKER), markerContent, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fileSystem.mkdir(checkout, { recursive: false, mode: 0o700 });
    return { root: transactionRoot, checkout, marker, markerContent, rootStats };
  } catch (error) {
    try {
      await fileSystem.rm(transactionRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      const failure = new AggregateError(
        [error, cleanupError],
        "Restore transaction setup failed and its private staging directory could not be cleaned."
      );
      failure.code = "RESTORE_CLEANUP_REQUIRED";
      throw failure;
    }
    throw error;
  }
}

async function recoverOwnedRestoreTransaction(options) {
  const { aiosPath, destination, fileSystem, project, remote } = options;
  const root = managedWorkspaceRoot(aiosPath);
  const prefix = `.dotaios-restore-${project.slug || project.project}-`;
  const entries = await fileSystem.readdir(root, { withFileTypes: true });
  const transactions = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.startsWith(prefix)) continue;
    const transaction = await readOwnedRestoreTransaction({
      destination,
      fileSystem,
      name: entry.name,
      project,
      remote,
      root
    });
    if (transaction) transactions.push(transaction);
  }
  if (transactions.some((transaction) => processRecordIsAlive(transaction.marker))) {
    return { busy: true };
  }

  for (const transaction of transactions) {
    const staged = await classifyRestoreDestination({
      destination: transaction.checkout,
      expectedRemote: remote.canonicalUrl,
      fileSystem,
      readRepositoryHead: options.readRepositoryHead,
      readRepositoryRemote: options.readRepositoryRemote
    });
    if (staged.state === "missing") {
      const published = await classifyRestoreDestination({
        destination,
        expectedRemote: remote.canonicalUrl,
        fileSystem,
        readRepositoryHead: options.readRepositoryHead,
        readRepositoryRemote: options.readRepositoryRemote
      });
      if (published.state !== "existing-match") {
        throw restoreCleanupError("Owned restore checkout disappeared without a verified published destination.");
      }
      transaction.published = true;
      await cleanupRestoreTransaction(fileSystem, transaction);
      return { verification: published };
    }
    if (staged.state !== "existing-match") {
      await cleanupRestoreTransaction(fileSystem, transaction);
      continue;
    }

    try {
      await publishRestoreTransaction(fileSystem, transaction);
    } catch (error) {
      if (error.code === "RESTORE_CLEANUP_REQUIRED") throw error;
      const winner = await classifyRestoreDestination({
        destination,
        expectedRemote: remote.canonicalUrl,
        fileSystem,
        readRepositoryHead: options.readRepositoryHead,
        readRepositoryRemote: options.readRepositoryRemote
      });
      await cleanupRestoreTransaction(fileSystem, transaction);
      if (winner.state !== "existing-match") return { raced: winner };
      return { verification: winner };
    }
    await cleanupRestoreTransaction(fileSystem, transaction);
    const published = await classifyRestoreDestination({
      destination,
      expectedRemote: remote.canonicalUrl,
      fileSystem,
      readRepositoryHead: options.readRepositoryHead,
      readRepositoryRemote: options.readRepositoryRemote
    });
    if (published.state === "existing-match") return { verification: published };
  }
  return null;
}

async function readOwnedRestoreTransaction({ destination, fileSystem, name, project, remote, root }) {
  const transactionRoot = path.join(root, name);
  const rootStats = await lstatIfPresent(fileSystem, transactionRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return null;
  const markerPath = path.join(transactionRoot, RESTORE_TRANSACTION_MARKER);
  const markerStats = await lstatIfPresent(fileSystem, markerPath);
  if (!markerStats?.isFile() || markerStats.isSymbolicLink() || markerStats.size > 4_096) return null;
  let markerContent;
  let marker;
  try {
    markerContent = await fileSystem.readFile(markerPath, "utf8");
    marker = JSON.parse(markerContent);
  } catch {
    return null;
  }
  if (!restoreMarkerMatches(marker, { destination, name, project, remote })) return null;
  const destinationClaim = await readRestoreDestinationClaim({
    fileSystem,
    marker,
    transactionRoot
  });
  if (destinationClaim === false) return null;
  return {
    root: transactionRoot,
    checkout: path.join(transactionRoot, RESTORE_CHECKOUT_DIRECTORY),
    marker,
    markerContent,
    rootStats,
    ...(destinationClaim && { destinationClaim })
  };
}

async function readRestoreDestinationClaim({ fileSystem, marker, transactionRoot }) {
  const claimPath = path.join(transactionRoot, RESTORE_DESTINATION_CLAIM_MARKER);
  const stats = await lstatIfPresent(fileSystem, claimPath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2_048) return false;
  let content;
  let record;
  try {
    content = await fileSystem.readFile(claimPath, "utf8");
    record = JSON.parse(content);
  } catch {
    return false;
  }
  const keys = ["destination", "dev", "ino", "owner", "schema"];
  if (!record || typeof record !== "object" || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)) return false;
  if (record.schema !== RESTORE_DESTINATION_CLAIM_SCHEMA
    || record.owner !== marker.owner
    || record.destination !== marker.destination
    || typeof record.dev !== "string" || !/^\d+$/.test(record.dev)
    || typeof record.ino !== "string" || !/^\d+$/.test(record.ino)) return false;
  return { path: claimPath, content, record };
}

function restoreMarkerMatches(marker, { destination, name, project, remote }) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  const requiredKeys = [
    "checkout",
    "created_at",
    "destination",
    "owner",
    "pid",
    "project_id",
    "remote_url",
    "schema",
    "slug"
  ];
  const allowedKeys = typeof marker.process_started_at === "string"
    ? [...requiredKeys, "process_started_at"]
    : requiredKeys;
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(allowedKeys.sort())) return false;
  const createdAtIsCanonical = isCanonicalIsoTimestamp(marker.created_at);
  const ownerIsCanonicalUuid = typeof marker.owner === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.owner);
  const processTokenIsBounded = marker.process_started_at === undefined
    || (marker.process_started_at.length > 0 && marker.process_started_at.length <= 256);
  return marker.schema === RESTORE_TRANSACTION_SCHEMA
    && marker.project_id === project.id.trim()
    && marker.slug === (project.slug || project.project)
    && marker.remote_url === remote.canonicalUrl
    && marker.destination === destination
    && marker.checkout === RESTORE_CHECKOUT_DIRECTORY
    && Number.isSafeInteger(marker.pid)
    && marker.pid > 0
    && ownerIsCanonicalUuid
    && createdAtIsCanonical
    && processTokenIsBounded
    && name === `.dotaios-restore-${marker.slug}-${marker.owner}`;
}

async function publishRestoreTransaction(fileSystem, transaction) {
  const destination = transaction.marker.destination;
  if (process.platform === "win32") {
    if (await lstatIfPresent(fileSystem, destination)) throw destinationExistsError();
    await fileSystem.rename(transaction.checkout, destination);
    transaction.published = true;
    return;
  }

  // POSIX rename can silently replace an unowned empty directory. Claim the
  // final name with an exclusive mkdir first, then replace only that exact,
  // still-empty inode with the verified checkout. Windows rename already
  // refuses an existing directory and therefore uses the direct path above.
  let claimStats;
  if (transaction.destinationClaim) {
    claimStats = await lstatIfPresent(fileSystem, destination);
    if (!claimStats) {
      await clearRestoreDestinationClaim(fileSystem, transaction);
    } else if (String(claimStats.dev) !== transaction.destinationClaim.record.dev
      || String(claimStats.ino) !== transaction.destinationClaim.record.ino) {
      throw destinationExistsError();
    }
  }
  if (!transaction.destinationClaim) {
    try {
      await fileSystem.mkdir(destination, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") throw destinationExistsError();
      throw error;
    }
    claimStats = await fileSystem.lstat(destination);
    if (!claimStats.isDirectory() || claimStats.isSymbolicLink()) {
      throw destinationExistsError();
    }
    try {
      transaction.destinationClaim = await writeRestoreDestinationClaim(fileSystem, transaction, claimStats);
    } catch (error) {
      try {
        await removeOwnedEmptyDestinationClaim(fileSystem, destination, claimStats);
      } catch (cleanupError) {
        throw restoreCleanupError(safeOperationMessage("Unrecorded destination claim removal failed", cleanupError));
      }
      throw error;
    }
  }
  try {
    const currentClaim = await fileSystem.lstat(destination);
    if (!currentClaim.isDirectory() || currentClaim.isSymbolicLink()
      || currentClaim.dev !== claimStats.dev || currentClaim.ino !== claimStats.ino
      || (await fileSystem.readdir(destination)).length !== 0) {
      throw destinationExistsError();
    }
    await fileSystem.rename(transaction.checkout, destination);
    transaction.published = true;
  } catch (error) {
    try {
      await removeOwnedEmptyDestinationClaim(fileSystem, destination, claimStats);
    } catch (cleanupError) {
      throw restoreCleanupError(safeOperationMessage("Owned destination claim removal failed", cleanupError));
    }
    throw error;
  }
}

async function clearRestoreDestinationClaim(fileSystem, transaction) {
  const claim = transaction.destinationClaim;
  const stats = await lstatIfPresent(fileSystem, claim.path);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > 2_048) {
    throw restoreCleanupError("Restore destination claim changed; refusing replacement.");
  }
  if (await fileSystem.readFile(claim.path, "utf8") !== claim.content) {
    throw restoreCleanupError("Restore destination claim changed; refusing replacement.");
  }
  try {
    await fileSystem.rm(claim.path);
  } catch (error) {
    throw restoreCleanupError(safeOperationMessage("Stale destination claim removal failed", error));
  }
  transaction.destinationClaim = null;
}

async function writeRestoreDestinationClaim(fileSystem, transaction, claimStats) {
  const claimPath = path.join(transaction.root, RESTORE_DESTINATION_CLAIM_MARKER);
  const record = {
    schema: RESTORE_DESTINATION_CLAIM_SCHEMA,
    owner: transaction.marker.owner,
    destination: transaction.marker.destination,
    dev: String(claimStats.dev),
    ino: String(claimStats.ino)
  };
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await fileSystem.writeFile(claimPath, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return { path: claimPath, content, record };
}

async function removeOwnedEmptyDestinationClaim(fileSystem, destination, claimStats) {
  const current = await lstatIfPresent(fileSystem, destination);
  if (!current || !current.isDirectory() || current.isSymbolicLink()
    || current.dev !== claimStats.dev || current.ino !== claimStats.ino) return;
  if ((await fileSystem.readdir(destination)).length !== 0) return;
  await fileSystem.rmdir(destination);
}

function destinationExistsError() {
  const error = new Error("Managed destination already exists.");
  error.code = "EEXIST";
  return error;
}

async function cleanupRestoreTransaction(fileSystem, transaction) {
  const rootStats = await lstatIfPresent(fileSystem, transaction.root);
  if (!rootStats) return;
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()
    || rootStats.dev !== transaction.rootStats.dev
    || rootStats.ino !== transaction.rootStats.ino) {
    throw restoreCleanupError("Restore transaction ownership changed; refusing cleanup.");
  }
  const markerPath = path.join(transaction.root, RESTORE_TRANSACTION_MARKER);
  const markerStats = await lstatIfPresent(fileSystem, markerPath);
  if (!markerStats?.isFile() || markerStats.isSymbolicLink() || markerStats.size > 4_096) {
    throw restoreCleanupError("Restore transaction marker changed; refusing cleanup.");
  }
  const currentMarker = await fileSystem.readFile(markerPath, "utf8");
  if (currentMarker !== transaction.markerContent) {
    throw restoreCleanupError("Restore transaction marker changed; refusing cleanup.");
  }
  if (transaction.destinationClaim) {
    const claimStats = await lstatIfPresent(fileSystem, transaction.destinationClaim.path);
    if (!claimStats?.isFile() || claimStats.isSymbolicLink() || claimStats.size > 2_048) {
      throw restoreCleanupError("Restore destination claim changed; refusing cleanup.");
    }
    const currentClaim = await fileSystem.readFile(transaction.destinationClaim.path, "utf8");
    if (currentClaim !== transaction.destinationClaim.content) {
      throw restoreCleanupError("Restore destination claim changed; refusing cleanup.");
    }
  }
  const checkoutStats = await lstatIfPresent(fileSystem, transaction.checkout);
  if (checkoutStats) {
    if (!checkoutStats.isDirectory() || checkoutStats.isSymbolicLink()) {
      throw restoreCleanupError("Restore transaction checkout changed type; refusing cleanup.");
    }
    const canonicalRoot = await fileSystem.realpath(transaction.root);
    if (await fileSystem.realpath(transaction.checkout) !== path.join(canonicalRoot, RESTORE_CHECKOUT_DIRECTORY)) {
      throw restoreCleanupError("Restore transaction checkout resolves outside staging; refusing cleanup.");
    }
  } else if (!transaction.published) {
    throw restoreCleanupError("Restore transaction checkout disappeared before publication; refusing cleanup.");
  }
  try {
    await fileSystem.rm(transaction.root, { recursive: true });
  } catch (error) {
    throw restoreCleanupError(safeOperationMessage("Restore transaction removal failed", error));
  }
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

function restoreCleanupError(message) {
  const error = new Error(message);
  error.code = "RESTORE_CLEANUP_REQUIRED";
  return error;
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
    identity: `${parsed.username ? `${parsed.username}@` : ""}${identityHost}/${repoPath}`
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
    identity: `${user ? `${user}@` : ""}${host}/${repoPath}`
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

function remoteError(reason, message) {
  return new ProjectRemoteError(reason, message);
}
