import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import { isPathWithin } from "./paths.mjs";
import { schemaVersion } from "./schema.mjs";
import { processBirthToken, processRecordIsAlive } from "./process-identity.mjs";
import {
  hasExactManagedWorkspaceIgnoreRule,
  isManagedWorkspaceEffectivelyIgnored
} from "./workspace-ignore.mjs";
import {
  classifyProjectPlacement,
  classifyProjectRemote,
  classifyRestoreDestination,
  managedWorkspacePath,
  projectRemotesMatch,
  restoreManagedProjects
} from "./project-workspaces.mjs";

const execFileAsync = promisify(execFile);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PROJECT_PLAN_VERSION = 1;
const PROJECT_STATE_VERSION = 1;
const PROJECT_STATE_LOCK_FORMAT = "dotaios-project-state-lock/v1";
const PROJECT_STATE_LOCK_STALE_MS = 5 * 60 * 1000;
const PROJECT_DOMAINS = new Set(["build", "make", "sell"]);
const UNSELECTABLE_PROJECT_IDENTITY_CONTENT_ERRORS = new Set([
  "DOTAIOS_EVIDENCE_FILE_TOO_LARGE",
  "DOTAIOS_EVIDENCE_FRONTMATTER_INVALID",
  "DOTAIOS_EVIDENCE_INVALID_UTF8",
]);

/**
 * Preview registration of an external project repository without moving or
 * copying it. Synced metadata and machine-local path state are written only
 * when apply or yes is explicitly true.
 */
export async function registerProject(options = {}) {
  const plan = await planProjectRegistration(options);
  if (options.apply !== true && options.yes !== true) return plan;
  assertExactProjectApply(options, plan);
  return applyProjectRegistration(plan, { fs: options.fs });
}

/** Build a read-only project registration plan and durable README diff. */
export async function planProjectRegistration(options = {}) {
  if (!options.projectPath) {
    throw new Error("projectPath is required");
  }

  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  const canonicalAiosPath = await context.fs.realpath(context.aiosPath);
  const aiosRootIdentity = await inspectDirectoryIdentity(
    canonicalAiosPath,
    context.fs,
    "AIOS folder"
  );

  const requestedProjectPath = resolveUserPath(options.projectPath, context.homePath);
  await assertDirectory(context.fs, requestedProjectPath, "Project path");
  await assertProjectRootPath(requestedProjectPath, context.fs);
  const realProjectPath = await context.fs.realpath(requestedProjectPath);
  const rootIdentity = await inspectProjectRootIdentity(realProjectPath, context.fs);

  const [records, state] = await Promise.all([
    readProjectRecords(context),
    readProjectState(context)
  ]);
  assertUniqueProjectIds(records);

  const mappedId = await findIdForPath(context, state.paths, realProjectPath);
  const mappedRecord = mappedId ? records.find((record) => record.id === mappedId) : null;
  const requestedSlug = options.slug ? validateSlug(options.slug) : null;
  if (mappedRecord && requestedSlug && requestedSlug !== mappedRecord.directorySlug) {
    throw new Error([
      `This path is already registered as "${mappedRecord.directorySlug}".`,
      `Use --slug ${mappedRecord.directorySlug}, or omit --slug.`
    ].join(" "));
  }

  const slug = requestedSlug
    || mappedRecord?.directorySlug
    || slugify(path.basename(requestedProjectPath));
  const placement = await classifyProjectPlacement({
    aiosPath: context.aiosPath,
    projectPath: requestedProjectPath,
    slug,
    fileSystem: context.fs
  });
  if (placement.placement === "unsafe") {
    throw new Error([
      `Cannot register ${requestedProjectPath} because it is inside the AIOS folder.`,
      "Keep the actual project repository outside AIOS so it retains its own Git history,",
      `or use the exact managed workspace at ${placement.destination}.`
    ].join(" "));
  }
  const existing = records.find((record) => record.directorySlug === slug) || null;
  if (mappedId && existing?.id && mappedId !== existing.id) {
    throw new Error([
      `Project "${slug}" has id ${existing.id}, but this machine maps the path to ${mappedId}.`,
      `Fix the conflicting local state at ${context.statePath} before retrying.`
    ].join(" "));
  }

  const stableProjectId = mappedId || existing?.id || null;
  const operationId = validateProjectOperationId(
    options.operationId || (stableProjectId ? context.createOperationId() : context.createId())
  );
  const id = stableProjectId || operationId;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Project id generation returned an empty value");
  }
  const duplicate = records.find((record) => record.id === id && record.directorySlug !== slug);
  if (duplicate) {
    throw new Error(`Project id ${id} is already used by "${duplicate.directorySlug}".`);
  }

  const name = readRequiredString(options.name ?? existing?.metadata.name ?? path.basename(requestedProjectPath), "name");
  const description = options.purpose !== undefined
    ? validateProjectPurpose(options.purpose)
    : readOptionalString(existing?.metadata.description);
  const status = readRequiredString(options.status ?? existing?.metadata.status ?? "active", "status");
  const domain = normalizeDomains(options.domain ?? existing?.metadata.domain ?? ["build"]);
  const explicitRepoUrlSupplied = options.repoUrl !== undefined && options.repoUrl !== null;
  const explicitRepoUrl = readOptionalString(options.repoUrl);
  if (explicitRepoUrlSupplied) {
    const explicitRemote = classifyProjectRemote(explicitRepoUrl);
    if (!explicitRemote.safe) {
      throw unsafeExplicitProjectRemoteError(explicitRemote.reason);
    }
  }
  const discoveredRepoUrl = await context.readRepoUrl(requestedProjectPath);
  const remoteCandidate = explicitRepoUrl
    ?? readOptionalString(discoveredRepoUrl)
    ?? readOptionalString(existing?.metadata.repo_url)
    ?? readOptionalString(existing?.metadata.repo)
    ?? null;
  const remote = classifyProjectRemote(remoteCandidate);
  const repoUrl = remote.safe ? remote.canonicalUrl : null;

  const readmePath = path.join(context.aiosPath, "projects", slug, "README.md");
  await assertProjectReadmePath(context, readmePath);
  const source = existing
    ? existing.source
    : await readMarkdownSource(context.fs, readmePath);
  const content = renderProjectReadme(source, {
    id: id.trim(),
    project: slug,
    name,
    ...(description ? { description } : {}),
    status,
    domain,
    repo_url: repoUrl
  });

  const nextPaths = { ...state.paths };
  for (const [otherId, localPath] of Object.entries(nextPaths)) {
    if (otherId !== id && await pathsReferToSameDirectory(context, localPath, realProjectPath)) {
      delete nextPaths[otherId];
    }
  }
  nextPaths[id] = {
    path: requestedProjectPath,
    root_identity: rootIdentity
  };
  const nextState = { ...state, paths: nextPaths };
  const relativeReadmePath = path.relative(context.aiosPath, readmePath);
  const operation = source ? "replace" : "add";
  const beforeHash = source ? contentHash(source.content) : null;
  const afterHash = contentHash(content);
  const fingerprintSource = {
    version: PROJECT_PLAN_VERSION,
    operation,
    operationId,
    id: id.trim(),
    slug,
    name,
    description,
    status,
    domain,
    repoUrl,
    aiosPath: context.aiosPath,
    canonicalAiosPath,
    aiosRootIdentity,
    readmePath,
    readme: content,
    readmeBefore: source?.content || "",
    readmeExists: source !== null,
    statePath: context.statePath,
    projectPath: requestedProjectPath,
    canonicalProjectPath: realProjectPath,
    rootIdentity,
    stateBefore: state,
    stateAfter: nextState
  };
  const planFingerprint = projectRegistrationFingerprint(fingerprintSource);
  const receipt = {
    version: 1,
    type: "project-registration",
    operation,
    project_id: id.trim(),
    project: slug,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    durable: {
      path: relativeReadmePath,
      before_hash: beforeHash,
      after_hash: afterHash
    },
    machine_local: {
      state_path: context.statePath,
      project_path: requestedProjectPath,
      root_identity: rootIdentity
    },
    applied: false
  };

  return {
    ...fingerprintSource,
    applied: false,
    planFingerprint,
    project: slug,
    pathAvailable: true,
    homePath: context.homePath,
    preview: renderProjectDiff(relativeReadmePath, source?.content || "", content, source !== null),
    receipt
  };
}

/** Apply a previously previewed registration plan. */
export async function applyProjectRegistration(plan, options = {}) {
  const approvedPlan = structuredClone(plan);
  assertProjectPlanIntegrity(approvedPlan);
  const context = createContext({
    aiosPath: approvedPlan.aiosPath,
    homePath: approvedPlan.homePath,
    statePath: approvedPlan.statePath,
    fs: options.fs
  });
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  await assertAiosRootUnchanged(context, approvedPlan);
  await assertProjectReadmePath(context, approvedPlan.readmePath);

  await withProjectStateLock(context, async () => {
    await assertProjectRootUnchanged(context, approvedPlan);
    const currentSource = await readMarkdownSource(context.fs, approvedPlan.readmePath);
    const currentReadmeExists = currentSource !== null;
    const currentReadme = currentSource?.content || "";
    if (
      currentReadmeExists !== approvedPlan.readmeExists
      || currentReadme !== approvedPlan.readmeBefore
    ) {
      throw new Error("The project README changed after the preview. Preview project add again.");
    }
    const currentState = await readProjectState(context);
    if (JSON.stringify(currentState) !== JSON.stringify(approvedPlan.stateBefore)) {
      throw new Error("The machine-local project path state changed after the preview. Preview project add again.");
    }

    await context.fs.mkdir(path.dirname(approvedPlan.readmePath), { recursive: true });

    // Keep README validation, its write, and the state CAS under one owner-safe
    // lock. A concurrent loser therefore fails before it can touch the winner's
    // durable record.
    await context.fs.writeFile(approvedPlan.readmePath, approvedPlan.readme, {
      encoding: "utf8",
      flag: approvedPlan.readmeExists ? "w" : "wx"
    });
    try {
      await writeProjectState(context, approvedPlan.stateAfter, {
        expectedState: approvedPlan.stateBefore,
        lockHeld: true
      });
    } catch (error) {
      const rollbackErrors = [];
      try {
        await rollbackProjectReadmeWrite(context, approvedPlan);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Project registration failed and its rollback could not be completed."
        );
      }
      throw new Error(`Project registration rolled back because local state could not be saved: ${error.message}`);
    }
  });

  return {
    ...approvedPlan,
    applied: true,
    receipt: { ...approvedPlan.receipt, applied: true }
  };
}

/** List synced project metadata enriched with this machine's local path. */
export async function listProjects(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  return listProjectRecords(context);
}

/** Restore catalog projects through injected Git operations and local state only. */
export async function restoreProjects(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  await assertManagedRestoreBoundary(context);
  const projects = await listProjectRecords(context);
  const reference = readOptionalString(
    options.reference ?? options.project ?? options.slug ?? options.id
  );
  return restoreManagedProjects({
    aiosPath: context.aiosPath,
    projects,
    reference,
    dryRun: options.dryRun,
    fileSystem: context.fs,
    cloneRepository: options.cloneRepository,
    readRepositoryRemote: context.readRepoUrl,
    readRepositoryHead: context.readRepoHead,
    updateMapping: (request) => updateProjectPathMapping({
      aiosPath: context.aiosPath,
      homePath: context.homePath,
      statePath: context.statePath,
      fs: context.fs,
      id: request.id,
      slug: request.slug,
      projectPath: request.projectPath,
      expectedPath: request.previousPath,
      expectedRemote: request.expectedRemote,
      expectedHead: request.expectedHead,
      readRepoUrl: context.readRepoUrl,
      readRepoHead: context.readRepoHead
    })
  });
}

async function assertManagedRestoreBoundary(context) {
  const configPath = path.join(context.aiosPath, "aios.json");
  let config;
  try {
    config = JSON.parse(await context.fs.readFile(configPath, "utf8"));
  } catch (error) {
    const detail = error.code === "ENOENT" ? "is missing" : "is unreadable or invalid";
    throw new Error(`Managed project restore is blocked because ${configPath} ${detail}.`);
  }
  if (config?.schema_version !== schemaVersion) {
    throw new Error([
      `Managed project restore requires folder schema ${schemaVersion}; this folder reports ${config?.schema_version || "unknown"}.`,
      `Preview the versioned upgrade first: dotaios migrate --path ${JSON.stringify(context.aiosPath)}`
    ].join(" "));
  }

  const ignorePath = path.join(context.aiosPath, ".gitignore");
  let stats;
  let content;
  try {
    stats = await context.fs.lstat(ignorePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("unsafe-type");
    content = await context.fs.readFile(ignorePath, "utf8");
  } catch {
    throw new Error([
      "Managed project restore is blocked because the /workspaces/ privacy boundary is missing or unsafe.",
      `Check the versioned folder upgrade: dotaios migrate --path ${JSON.stringify(context.aiosPath)}`
    ].join(" "));
  }
  if (!hasExactManagedWorkspaceIgnoreRule(content)) {
    throw new Error([
      "Managed project restore is blocked because the exact /workspaces/ ignore rule is not installed.",
      `Check the versioned folder upgrade: dotaios migrate --path ${JSON.stringify(context.aiosPath)}`
    ].join(" "));
  }
  if (!await isManagedWorkspaceEffectivelyIgnored(content, { filesystem: context.fs })) {
    throw new Error([
      "Managed project restore is blocked because a later ignore rule cancels the /workspaces/ privacy boundary.",
      `Check the versioned folder upgrade: dotaios migrate --path ${JSON.stringify(context.aiosPath)}`
    ].join(" "));
  }
}

/** Atomically update one verified managed checkout mapping, preserving all others. */
export async function updateProjectPathMapping(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  const id = readRequiredString(options.id ?? options.projectId, "project id");
  const slug = validateSlug(options.slug);
  const projectPath = resolveUserPath(
    readRequiredString(options.projectPath, "projectPath"),
    context.homePath
  );
  const placement = await classifyProjectPlacement({
    aiosPath: context.aiosPath,
    projectPath,
    slug,
    fileSystem: context.fs
  });
  if (placement.placement !== "managed" || placement.destination !== projectPath) {
    throw new Error(`Project mapping must use the exact verified managed workspace: ${placement.destination}`);
  }
  const expectedRemote = classifyProjectRemote(
    readRequiredString(options.expectedRemote, "expectedRemote")
  );
  if (!expectedRemote.safe) {
    throw new Error(`Project mapping requires a safe expected remote (${expectedRemote.reason}).`);
  }
  const expectedHead = readRequiredString(options.expectedHead, "expectedHead").toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(expectedHead)) {
    throw new Error("Project mapping requires a verified Git commit id.");
  }
  const hasExpectedPath = Object.prototype.hasOwnProperty.call(options, "expectedPath");
  const expectedPath = typeof options.expectedPath === "string" && options.expectedPath.trim()
    ? resolveUserPath(options.expectedPath, context.homePath)
    : null;

  return withProjectStateLock(context, async () => {
    const repositoryBefore = await managedRepositoryReceipt(context, projectPath);
    const verified = await classifyRestoreDestination({
      destination: projectPath,
      expectedRemote: expectedRemote.canonicalUrl,
      fileSystem: context.fs,
      readRepositoryHead: context.readRepoHead,
      readRepositoryRemote: context.readRepoUrl
    });
    if (verified.state !== "existing-match" || verified.head !== expectedHead) {
      throw new Error(
        `Project mapping target changed after verification (${verified.state}); restore again before saving the mapping.`
      );
    }
    const repositoryAfter = await managedRepositoryReceipt(context, projectPath);
    if (repositoryBefore !== repositoryAfter) {
      throw new Error("Project mapping target changed during verification; restore again before saving the mapping.");
    }
    const canonicalProjectPath = await context.fs.realpath(projectPath);
    const rootIdentity = await inspectProjectRootIdentity(canonicalProjectPath, context.fs);

    const state = await readProjectState(context);
    const mapping = await verifyProjectPathMapping(context, state.paths[id]);
    const currentPath = readMappedPath(state.paths[id]);
    if (currentPath !== projectPath) {
      if (hasExpectedPath && currentPath !== expectedPath) {
        throw new Error(`Project mapping changed concurrently for id ${id}.`);
      }
      if (!hasExpectedPath && currentPath !== null) {
        throw new Error(`Project mapping conflict for id ${id}.`);
      }
    }
    for (const [otherId, value] of Object.entries(state.paths)) {
      if (otherId !== id && readMappedPath(value) === projectPath) {
        throw new Error(`Project mapping conflict: ${projectPath} is already mapped to ${otherId}.`);
      }
    }
    if (currentPath === projectPath && mapping.status === "verified") {
      return { changed: false, id, projectPath, statePath: context.statePath };
    }
    const nextState = {
      ...state,
      paths: {
        ...state.paths,
        [id]: { path: projectPath, root_identity: rootIdentity }
      }
    };
    await writeProjectStateFile(context, nextState);
    return { changed: true, id, projectPath, statePath: context.statePath };
  });
}

async function managedRepositoryReceipt(context, projectPath) {
  const stats = await context.fs.lstat(projectPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Managed project mapping target must remain a real directory: ${projectPath}`);
  }
  const canonicalPath = await context.fs.realpath(projectPath);
  return `${canonicalPath}\u0000${stats.dev}\u0000${stats.ino}`;
}

/** Read the portable project catalog without consulting machine-local paths. */
export async function readProjectCatalog(options = {}) {
  const context = createContext(options);
  const records = await readProjectRecords(context);
  return records.map(toProjectCatalogRecord);
}

/** Validate the canonical selector shared by project-scoped CLI and MCP reads. */
export function validateProjectSelector(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw projectSelectorError("DOTAIOS_PROJECT_SELECTOR_INVALID", "project selector must be a non-empty string");
  }
  const codePoints = Array.from(value);
  if (codePoints.length > 200) {
    throw projectSelectorError("DOTAIOS_PROJECT_SELECTOR_INVALID", "project selector must contain at most 200 code points");
  }
  if (
    value.trim() !== value
    || /[\p{Cc}\/\\]/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
    || value === "."
    || value === ".."
    || path.isAbsolute(value)
    || !/^[\p{L}\p{N}](?:[\p{L}\p{N}:._-]*[\p{L}\p{N}])?$/u.test(value)
  ) {
    throw projectSelectorError(
      "DOTAIOS_PROJECT_SELECTOR_INVALID",
      "project selector must be a safe project slug or stable id"
    );
  }
  return value;
}

/**
 * Resolve one portable project identity from bounded README frontmatter only.
 * The caller supplies the request-scoped evidence capability so catalog work
 * and the later corpus share one observation budget.
 */
export async function resolvePortableProjectIdentity({
  aiosPath,
  projectSelector,
  evidenceReader
} = {}) {
  const selector = validateProjectSelector(projectSelector);
  if (!evidenceReader) {
    throw new TypeError("resolvePortableProjectIdentity requires an evidence reader");
  }
  const resolvedAiosPath = path.resolve(aiosPath);
  const projectsPath = path.join(resolvedAiosPath, "projects");
  const directIdentity = isProjectSlug(selector)
    ? await readPortableProjectIdentity(
      resolvedAiosPath,
      path.join(projectsPath, selector),
      evidenceReader,
      { strict: true }
    )
    : null;
  const projectDirectories = await evidenceReader.listDirectories(resolvedAiosPath, projectsPath, {
    skipLinkedEntries: true
  });
  let matches = directIdentity ? [directIdentity] : [];
  for (const projectDirectory of projectDirectories) {
    if (directIdentity?.slug === path.basename(projectDirectory)) continue;
    const identity = await readPortableProjectIdentity(
      resolvedAiosPath,
      projectDirectory,
      evidenceReader,
      { strict: false }
    );
    if (identity && (selector === identity.slug || selector === identity.id)) {
      matches = [...matches, identity];
    }
  }

  if (matches.length === 0) {
    throw projectSelectorError("DOTAIOS_PROJECT_SELECTOR_UNKNOWN", "project selector is unknown");
  }
  if (matches.length > 1) {
    throw projectSelectorError("DOTAIOS_PROJECT_SELECTOR_AMBIGUOUS", "project selector is ambiguous; use its stable id");
  }
  return matches[0];
}

function isProjectSlug(value) {
  try {
    validateSlug(value);
    return true;
  } catch {
    return false;
  }
}

async function readPortableProjectIdentity(aiosPath, projectDirectory, evidenceReader, { strict } = {}) {
  const slug = path.basename(projectDirectory);
  try {
    validateSlug(slug);
    validateProjectSelector(slug);
  } catch {
    if (!strict) return null;
    throw projectSelectorError("DOTAIOS_PROJECT_CATALOG_INVALID", "project catalog contains an invalid slug");
  }
  const readmePath = path.join(projectDirectory, "README.md");
  const expectedEntry = strict ? null : await evidenceReader.inspectEntry(aiosPath, readmePath);
  if (!strict && expectedEntry?.type !== "regular-file") {
    await evidenceReader.inspectEntry(aiosPath, readmePath, { expectedEntry });
    return null;
  }
  let frontmatter;
  try {
    frontmatter = await evidenceReader.readFrontmatter(
      aiosPath,
      readmePath,
      {
        maxBytes: 16 * 1024,
        maxFileBytes: 1024 * 1024,
        allowMissing: !strict,
        stopOnMissingFrontmatter: true,
        expectedEntry
      }
    );
  } catch (error) {
    if (!strict && UNSELECTABLE_PROJECT_IDENTITY_CONTENT_ERRORS.has(error?.code)) return null;
    if (strict && error?.code === "DOTAIOS_EVIDENCE_FRONTMATTER_INVALID") {
      throw projectSelectorError("DOTAIOS_PROJECT_CATALOG_INVALID", "project identity frontmatter is invalid");
    }
    throw error;
  }
  if (frontmatter === null) return null;
  const match = FRONTMATTER_RE.exec(frontmatter);
  if (!match) {
    if (!strict) return null;
    throw projectSelectorError("DOTAIOS_PROJECT_CATALOG_INVALID", "project identity frontmatter is invalid");
  }
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    if (!strict) return null;
    throw projectSelectorError("DOTAIOS_PROJECT_CATALOG_INVALID", "project identity frontmatter is invalid");
  }
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    if (!strict) return null;
    throw projectSelectorError(
      "DOTAIOS_PROJECT_CATALOG_INVALID",
      "project identity frontmatter must be a metadata mapping",
    );
  }
  const hasPrimaryId = Object.hasOwn(metadata, "id");
  const hasLegacyId = Object.hasOwn(metadata, "project_id");
  const primaryId = hasPrimaryId ? metadata.id : null;
  const legacyId = hasLegacyId ? metadata.project_id : null;
  if (
    (hasPrimaryId && (typeof primaryId !== "string" || primaryId.length === 0))
    || (hasLegacyId && (typeof legacyId !== "string" || legacyId.length === 0))
  ) {
    if (!strict) return null;
    throw projectSelectorError(
      "DOTAIOS_PROJECT_CATALOG_INVALID",
      "project identity requires valid stable id fields",
    );
  }
  if (primaryId && legacyId && primaryId !== legacyId) {
    if (!strict) return null;
    throw projectSelectorError(
      "DOTAIOS_PROJECT_CATALOG_INVALID",
      "project identity contains conflicting stable ids",
    );
  }
  const id = primaryId || legacyId;
  if (!id) {
    if (!strict) return null;
    throw projectSelectorError("DOTAIOS_PROJECT_CATALOG_INVALID", "project identity requires a stable id");
  }
  try {
    validateProjectSelector(id);
  } catch {
    if (!strict) return null;
    throw projectSelectorError(
      "DOTAIOS_PROJECT_CATALOG_INVALID",
      "project identity requires a valid stable id",
    );
  }
  return Object.freeze({ id, slug });
}

/** Resolve a project id or slug to an existing path on this machine. */
export async function resolveProject(referenceOrOptions, additionalOptions = {}) {
  const project = await resolveProjectRecord(referenceOrOptions, additionalOptions);
  return project.projectPath;
}

/**
 * Match a project reference to its catalog record without requiring a
 * machine-local checkout path. Use this for emitters and readers that only
 * need catalog identity; use resolveProjectRecord when a local path is required.
 */
export async function matchProjectRecord(referenceOrOptions, additionalOptions = {}) {
  const options = typeof referenceOrOptions === "string"
    ? { ...additionalOptions, project: referenceOrOptions }
    : { ...(referenceOrOptions || {}) };
  const reference = readOptionalString(options.project ?? options.slug ?? options.id);
  if (!reference) {
    throw new Error("project id or slug is required");
  }

  const projects = await listProjects(options);
  const matches = projects.filter((project) =>
    project.id === reference || project.slug === reference || project.project === reference
  );
  if (matches.length === 0) {
    throw new Error(`Project "${reference}" is not registered. Run \`dotaios project list\`.`);
  }
  if (matches.length > 1) {
    throw new Error(`Project reference "${reference}" is ambiguous. Use its stable id.`);
  }
  return matches[0];
}

/** Resolve a project reference to its catalog record, requiring a local path. */
export async function resolveProjectRecord(referenceOrOptions, additionalOptions = {}) {
  const project = await matchProjectRecord(referenceOrOptions, additionalOptions);
  if (project.mappingStatus !== "verified" && project.mappingStatus !== "unmapped") {
    const recovery = project.restoreEligible
      ? restoreRecoveryInstruction(project)
      : `To re-register it, preview \`dotaios project add <repo-path> --slug ${project.slug}\`, then apply it with the displayed operation id and plan fingerprint.`;
    throw new Error([
      `Project "${project.slug}" local folder registration cannot be verified.`,
      recovery
    ].join(" "));
  }
  if (!project.projectPath) {
    const recovery = project.restoreEligible
      ? restoreRecoveryInstruction(project)
      : `Run \`dotaios project add <repo-path> --slug ${project.slug}\` to register it.`;
    throw new Error([
      `Project "${project.slug}" has no path on this machine.`,
      recovery
    ].join(" "));
  }
  if (!project.pathAvailable) {
    const recovery = project.restoreEligible
      ? restoreRecoveryInstruction(project)
      : `Run \`dotaios project add <repo-path> --slug ${project.slug}\` to update it.`;
    throw new Error([
      `Project "${project.slug}" is registered at ${project.projectPath}, but that path is missing.`,
      recovery
    ].join(" "));
  }
  return project;
}

function restoreRecoveryInstruction(project) {
  const reference = project.id || project.slug;
  return `Run \`dotaios project restore ${reference} --dry-run\`, then repeat without \`--dry-run\` to restore it.`;
}

/** Resolve a writer or bridge project reference through the project catalog. */
export async function resolveProjectContext(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  const projects = await listProjectRecords(context);
  const reference = readOptionalString(options.project ?? options.slug ?? options.id);

  if (reference) {
    const matches = projects.filter((project) =>
      project.id === reference || project.slug === reference || project.project === reference
    );
    if (matches.length > 1) {
      throw new Error(`Project reference "${reference}" is ambiguous. Resolve it by its stable id.`);
    }
    if (matches.length === 0) {
      throw new Error(`Project "${reference}" is not registered. Run \`dotaios project list\` to see available projects.`);
    }
    return toProjectContext(matches[0]);
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const matches = (await Promise.all(projects.map(async (project) => {
    if (!project.projectPath || !project.pathAvailable) return null;
    return await isPathWithin(project.projectPath, cwd, { fileSystem: context.fs })
      ? project
      : null;
  }))).filter(Boolean);
  matches.sort((left, right) => right.projectPath.length - left.projectPath.length);
  return matches[0] ? toProjectContext(matches[0]) : null;
}

function toProjectContext(project) {
  return {
    id: project.id,
    slug: project.slug,
    project: project.project || project.slug,
    projectPath: project.projectPath,
    registered: true
  };
}

/** Check local paths and Git remotes without changing metadata or local state. */
export async function doctorProjects(options = {}) {
  const context = createContext(options);
  await assertDirectory(context.fs, context.aiosPath, "AIOS folder");
  await assertStateOutsideAios(context);
  const [projects, state] = await Promise.all([
    listProjectRecords(context),
    readProjectState(context)
  ]);
  const durableIds = new Set(projects.map((project) => project.id).filter(Boolean));
  const orphanProjects = Object.entries(state.paths)
    .filter(([id]) => !durableIds.has(id))
    .map(([id, localPath]) => ({
      id,
      slug: `orphan-${id}`,
      project: null,
      name: "orphaned local project mapping",
      status: null,
      domain: [],
      repoUrl: null,
      projectPath: readMappedPath(localPath),
      pathAvailable: false,
      readmePath: null,
      readme: ""
    }));
  const checkedProjects = [...projects, ...orphanProjects];
  const issues = [];

  for (const project of checkedProjects) {
    if (orphanProjects.includes(project)) {
      issues.push({
        type: "orphan_state",
        reason: "missing_readme",
        project,
        actual: project.projectPath,
        message: `Orphaned local project state for id ${project.id} has no durable project README.`
      });
      continue;
    }
    if (!project.remoteSafe && project.remoteReason !== "missing") {
      issues.push({
        type: "unsafe_remote",
        reason: project.remoteReason,
        project,
        message: `Project "${project.slug}" has an unsafe catalog remote (${project.remoteReason}). It is local-only and cannot be restored.`
      });
    }
    if (project.placement === "unsafe") {
      issues.push({
        type: "unsafe_placement",
        reason: "inside_aios",
        project,
        actual: project.projectPath,
        message: `Project "${project.slug}" uses an unsafe path inside AIOS: ${project.projectPath}`
      });
    }

    let managedDestination = null;
    let managedState = null;
    if (project.remoteSafe) {
      managedDestination = managedWorkspacePath(context.aiosPath, project.slug);
      managedState = await classifyRestoreDestination({
        destination: managedDestination,
        expectedRemote: project.repoUrl,
        fileSystem: context.fs,
        readRepositoryHead: context.readRepoHead,
        readRepositoryRemote: context.readRepoUrl
      });
      if (managedState.state === "remote-mismatch") {
        issues.push({
          type: "remote_mismatch",
          reason: "managed_workspace",
          project,
          expected: project.repoUrl,
          actual: managedState.actualRemote?.canonicalUrl || null,
          message: `Managed workspace "${project.slug}" has a Git origin that does not match its catalog remote.`
        });
      } else if (managedState.state === "unsafe-remote") {
        issues.push({
          type: "unsafe_remote",
          reason: managedState.actualRemote?.reason || "invalid",
          project,
          actual: managedDestination,
          message: `Managed workspace "${project.slug}" has an unsafe Git origin.`
        });
      } else if (!["missing", "existing-match"].includes(managedState.state)) {
        issues.push({
          type: "incomplete_checkout",
          reason: managedState.state,
          project,
          actual: managedDestination,
          message: `Managed workspace "${project.slug}" is incomplete or unsafe (${managedState.state}): ${managedDestination}`
        });
      }
    }
    if (!project.projectPath) {
      issues.push({
        type: "missing_path",
        reason: "unmapped",
        project,
        message: `Project "${project.slug}" has no path registered on this machine.`
      });
      continue;
    }
    if (!project.pathAvailable) {
      issues.push({
        type: "missing_path",
        reason: "not_found",
        project,
        actual: project.projectPath,
        message: `Project "${project.slug}" path is missing: ${project.projectPath}`
      });
      continue;
    }
    if (project.placement === "unsafe") continue;
    if (!project.repoUrl) continue;

    if (managedDestination && path.resolve(project.projectPath) === managedDestination) {
      continue;
    }

    let actualRepoUrl = null;
    try {
      actualRepoUrl = readOptionalString(await context.readRepoUrl(project.projectPath));
    } catch {
      // A broken or unreadable checkout is a doctor finding, not a reason for
      // the whole report to abort.
    }
    const actualRemote = classifyProjectRemote(actualRepoUrl);
    if (!actualRemote.safe && actualRemote.reason !== "missing") {
      issues.push({
        type: "unsafe_remote",
        reason: actualRemote.reason,
        project,
        actual: project.projectPath,
        message: `Project "${project.slug}" checkout has an unsafe Git origin (${actualRemote.reason}).`
      });
    } else if (!projectRemotesMatch(project.repoUrl, actualRepoUrl)) {
      issues.push({
        type: "remote_mismatch",
        project,
        expected: project.repoUrl,
        actual: actualRepoUrl,
        message: actualRepoUrl
          ? `Project "${project.slug}" remote is ${actualRepoUrl}; metadata expects ${project.repoUrl}.`
          : `Project "${project.slug}" has no Git origin; metadata expects ${project.repoUrl}.`
      });
    }
  }

  let workspace = { checked: false, outer_git: null };
  if (typeof options.inspectWorkspaceBoundary === "function") {
    try {
      const result = await options.inspectWorkspaceBoundary();
      workspace = {
        checked: true,
        outer_git: result?.outerGit === true
      };
      if (result?.ok === false) {
        issues.push({
          type: "workspace_boundary",
          reason: result.reason || "invalid",
          project: null,
          message: result.message || "The managed workspace boundary is not safe."
        });
      }
    } catch (error) {
      issues.push({
        type: "workspace_boundary",
        reason: "inspection_failed",
        project: null,
        message: `Workspace boundary inspection failed: ${error.message}`
      });
      workspace = { checked: true, outer_git: null };
    }
  }

  return {
    ok: issues.length === 0,
    checked: checkedProjects.length,
    projects: checkedProjects,
    issues,
    workspace
  };
}

function createContext(options) {
  const homePath = path.resolve(options.homePath || os.homedir());
  const aiosPath = resolveUserPath(options.aiosPath || path.join(homePath, "aios"), homePath);
  const defaultStatePath = path.join(homePath, ".dotaios", "projects.json");
  const statePath = resolveUserPath(
    options.statePath || defaultStatePath,
    homePath
  );
  return {
    aiosPath,
    createId: options.createId || randomUUID,
    createOperationId: options.createOperationId || randomUUID,
    fs: options.fs || fs,
    homePath,
    ownsStateDirectory: statePath === defaultStatePath,
    readRepoHead: options.readRepoHead || readGitHead,
    readRepoUrl: options.readRepoUrl || readGitRemoteUrl,
    statePath
  };
}

async function listProjectRecords(context) {
  const [records, state] = await Promise.all([
    readProjectRecords(context),
    readProjectState(context)
  ]);
  return Promise.all(records.map(async (record) => {
    const mapping = record.id
      ? await verifyProjectPathMapping(context, state.paths[record.id])
      : { status: "unmapped", projectPath: null };
    const projectPath = mapping.projectPath;
    const placement = await classifyProjectPlacement({
      aiosPath: context.aiosPath,
      projectPath,
      slug: record.slug,
      fileSystem: context.fs
    });
    const restoreEligible = Boolean(record.id && record.remote.safe && placement.placement === "missing");
    return {
      id: record.id,
      slug: record.slug,
      project: record.project,
      name: record.name,
      status: record.status,
      domain: record.domain,
      repoUrl: record.repoUrl,
      projectPath,
      mappingStatus: mapping.status,
      pathAvailable: placement.pathAvailable,
      placement: placement.placement,
      remoteSafe: record.remote.safe,
      remoteReason: record.remote.reason,
      restoreEligible,
      restoreStatus: restoreStatus(record.remote, placement),
      readmePath: record.readmePath,
      readme: record.source.content
    };
  }));
}

async function readProjectRecords(context) {
  const projectsPath = path.join(context.aiosPath, "projects");
  if (!await isPathWithin(context.aiosPath, projectsPath, { fileSystem: context.fs })) {
    throw new Error(`Project shelf resolves outside the AIOS folder: ${projectsPath}`);
  }
  let entries;
  try {
    entries = await context.fs.readdir(projectsPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        "Project README path is outside the AIOS project shelf because its project directory is a symbolic link."
      );
    }
    if (!entry.isDirectory()) continue;
    try {
      validateSlug(entry.name);
    } catch {
      throw new Error(
        `Invalid project directory slug "${entry.name}". Use lowercase letters, numbers, and single hyphens.`
      );
    }
    const readmePath = path.join(projectsPath, entry.name, "README.md");
    const projectDirectoryPath = path.dirname(readmePath);
    const projectDirectoryBefore = await context.fs.lstat(projectDirectoryPath);
    if (
      !projectDirectoryBefore.isDirectory()
      || projectDirectoryBefore.isSymbolicLink()
      || !await isPathWithin(context.aiosPath, projectDirectoryPath, { fileSystem: context.fs })
    ) {
      throw new Error("Project catalog changed while it was being read.");
    }
    const source = await readMarkdownSource(context.fs, readmePath);
    if (source === null) {
      try {
        await context.fs.lstat(readmePath);
        const error = new Error("Project README changed while the working-context catalog was being read.");
        error.code = "DOTAIOS_CONTEXT_SOURCE_CHANGED";
        throw error;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
      let projectDirectoryAfter;
      try {
        projectDirectoryAfter = await context.fs.lstat(projectDirectoryPath);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          const changed = new Error("Project catalog changed while it was being read.");
          changed.code = "DOTAIOS_CONTEXT_SOURCE_CHANGED";
          throw changed;
        }
        throw error;
      }
      if (
        !sameProjectDirectory(projectDirectoryBefore, projectDirectoryAfter)
        || projectDirectoryAfter.isSymbolicLink()
        || !await isPathWithin(context.aiosPath, projectDirectoryPath, { fileSystem: context.fs })
      ) {
        const changed = new Error("Project catalog changed while it was being read.");
        changed.code = "DOTAIOS_CONTEXT_SOURCE_CHANGED";
        throw changed;
      }
      continue;
    }
    records.push(projectRecord(entry.name, readmePath, source));
  }
  assertUniqueProjectIds(records);
  return records;
}

function sameProjectDirectory(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function projectRecord(directorySlug, readmePath, source) {
  const metadata = source.metadata;
  const id = readProjectId(metadata, readmePath);
  const project = readOptionalString(metadata.project)
    || readOptionalString(metadata.slug)
    || directorySlug;
  const bodyName = firstHeading(source.body);
  const remote = classifyProjectRemote(
    readOptionalString(metadata.repo_url) || readOptionalString(metadata.repo) || null
  );
  return {
    directorySlug,
    id,
    metadata,
    name: readOptionalString(metadata.name) || bodyName || project,
    project,
    status: readOptionalString(metadata.status) || "unknown",
    domain: normalizeStoredDomains(metadata.domain),
    remote,
    repoUrl: remote.safe ? remote.canonicalUrl : null,
    readmePath,
    slug: directorySlug,
    source
  };
}

function toProjectCatalogRecord(record) {
  const body = record.source.body;
  return {
    id: record.id,
    slug: record.slug,
    project: record.project,
    name: record.name,
    status: record.status,
    domains: record.domain,
    repoUrl: record.repoUrl,
    remoteSafe: record.remote.safe,
    remoteReason: record.remote.reason,
    description: readOptionalString(record.metadata.description) || firstDescription(body),
    contextExcerpt: projectExcerpt(body),
    readme: record.source.content,
  };
}

function readProjectId(metadata, source) {
  const id = readOptionalString(metadata.id);
  const legacyId = readOptionalString(metadata.project_id);
  if (id && legacyId && id !== legacyId) {
    throw new Error(`Conflicting id and project_id in ${source}`);
  }
  return id || legacyId || null;
}

async function readMarkdownSource(fileSystem, readmePath) {
  let stats;
  try {
    stats = await fileSystem.lstat(readmePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Project README must be a regular file, not a symlink or special file: ${readmePath}`);
  }
  let content;
  try {
    content = await fileSystem.readFile(readmePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Project README changed while it was being read: ${readmePath}`);
    }
    throw error;
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { body: content, content, document: parseDocument("\n"), metadata: {} };
  }
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML frontmatter in ${readmePath}: ${document.errors[0].message}`);
  }
  const metadata = document.toJS();
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Invalid YAML frontmatter in ${readmePath}: expected a mapping`);
  }
  return {
    body: content.slice(match[0].length),
    content,
    document,
    metadata
  };
}

function renderProjectReadme(source, metadata) {
  const document = source?.document || parseDocument("\n");
  for (const [key, value] of Object.entries(metadata)) {
    document.set(key, value);
  }
  const frontmatter = String(document).trimEnd();
  const body = source?.body || `# ${metadata.name}\n`;
  return `---\n${frontmatter}\n---\n${body}`;
}

async function readProjectState(context) {
  let content;
  try {
    content = await context.fs.readFile(context.statePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: PROJECT_STATE_VERSION, paths: {} };
    throw error;
  }

  let state;
  try {
    state = JSON.parse(content);
  } catch {
    throw new Error(`Project path state is not valid JSON: ${context.statePath}`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`Project path state must be an object: ${context.statePath}`);
  }
  if (state.paths !== undefined && (!state.paths || typeof state.paths !== "object" || Array.isArray(state.paths))) {
    throw new Error(`Project path state has an invalid paths map: ${context.statePath}`);
  }
  return { ...state, paths: { ...(state.paths || {}) } };
}

async function writeProjectState(context, state, options = {}) {
  const write = async () => {
    if (options.expectedState) {
      const currentState = await readProjectState(context);
      if (JSON.stringify(currentState) !== JSON.stringify(options.expectedState)) {
        throw new Error("The machine-local project path state changed after the preview. Preview project add again.");
      }
    }
    await writeProjectStateFile(context, state);
  };
  return options.lockHeld === true ? write() : withProjectStateLock(context, write);
}

async function rollbackProjectReadmeWrite(context, plan) {
  const currentExists = await pathExists(context.fs, plan.readmePath);
  const currentReadme = currentExists
    ? await context.fs.readFile(plan.readmePath, "utf8")
    : null;
  if (!currentExists || currentReadme !== plan.readme) {
    throw new Error("The project README changed after this registration wrote it; refusing to overwrite or remove the newer content.");
  }
  if (plan.readmeExists) {
    await context.fs.writeFile(plan.readmePath, plan.readmeBefore, "utf8");
  } else {
    await context.fs.rm(plan.readmePath, { force: true });
  }
}

async function writeProjectStateFile(context, state) {
  const paths = Object.fromEntries(
    Object.entries(state.paths).sort(([left], [right]) => left.localeCompare(right))
  );
  const temporaryPath = `${context.statePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify({ ...state, version: PROJECT_STATE_VERSION, paths }, null, 2)}\n`;
  const currentStats = await lstatIfPresent(context.fs, context.statePath);
  if (currentStats?.isSymbolicLink()) {
    throw new Error(`Project path state must not be a symlink: ${context.statePath}`);
  }
  try {
    await context.fs.writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await context.fs.chmod(temporaryPath, 0o600);
    await context.fs.rename(temporaryPath, context.statePath);
  } catch (error) {
    await context.fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function withProjectStateLock(context, operation) {
  const stateDirectory = path.dirname(context.statePath);
  const lockPath = `${context.statePath}.lock`;
  const createdDirectory = await context.fs.mkdir(stateDirectory, {
    recursive: true,
    ...(context.ownsStateDirectory ? { mode: 0o700 } : {})
  });
  if (context.ownsStateDirectory && createdDirectory && process.platform !== "win32") {
    await context.fs.chmod(stateDirectory, 0o700);
  }
  const lock = await acquireProjectStateLock(lockPath, context.fs);
  if (!lock) throw new Error(`Project path state is already being updated: ${context.statePath}`);
  try {
    return await operation();
  } finally {
    await releaseProjectStateLock(lock, context.fs);
  }
}

async function acquireProjectStateLock(lockPath, fileSystem, recoveryDepth = 0) {
  if (recoveryDepth > 16) return null;
  const processStartedAt = processBirthToken(process.pid);
  const record = {
    format: PROJECT_STATE_LOCK_FORMAT,
    pid: process.pid,
    owner: randomUUID(),
    created_at: Date.now(),
    ...(processStartedAt && { process_started_at: processStartedAt })
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fileSystem.writeFile(lockPath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      return { lockPath, owner: record.owner };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const held = await readProjectStateLock(lockPath, fileSystem);
    if (!held) continue;
    if (projectStateLockIsLive(held)) return null;
    if (!projectStateLockIsAbandoned(held)) return null;
    await recoverProjectStateLock(lockPath, fileSystem, recoveryDepth);
  }
  return null;
}

async function recoverProjectStateLock(lockPath, fileSystem, recoveryDepth) {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryLock = await acquireProjectStateLock(recoveryPath, fileSystem, recoveryDepth + 1);
  if (!recoveryLock) return false;
  try {
    const held = await readProjectStateLock(lockPath, fileSystem);
    if (!held || projectStateLockIsLive(held) || !projectStateLockIsAbandoned(held)) return false;
    const moved = `${lockPath}.stale.${randomUUID()}`;
    try {
      await fileSystem.rename(lockPath, moved);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    await fileSystem.rm(moved, { force: true });
    return true;
  } finally {
    await releaseProjectStateLock(recoveryLock, fileSystem);
  }
}

async function releaseProjectStateLock(lock, fileSystem) {
  const held = await readProjectStateLock(lock.lockPath, fileSystem);
  if (held?.record?.format !== PROJECT_STATE_LOCK_FORMAT || held.record.owner !== lock.owner) {
    throw new Error(`Project path state lock ownership changed before release: ${lock.lockPath}`);
  }
  try {
    await fileSystem.unlink(lock.lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function readProjectStateLock(lockPath, fileSystem) {
  try {
    const [raw, stats] = await Promise.all([
      fileSystem.readFile(lockPath, "utf8"),
      fileSystem.stat(lockPath)
    ]);
    let record = null;
    try {
      record = JSON.parse(raw);
    } catch {
      // A malformed lock is recoverable only after the stale window below.
    }
    return { record, stats };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function projectStateLockIsAbandoned(held) {
  const valid = held.record?.format === PROJECT_STATE_LOCK_FORMAT
    && typeof held.record.owner === "string"
    && Number.isSafeInteger(held.record.pid)
    && held.record.pid > 0;
  const createdAt = Number.isFinite(held.record?.created_at)
    ? held.record.created_at
    : held.stats?.mtimeMs;
  if (valid) return !processRecordIsAlive(held.record);
  return Number.isFinite(createdAt) && Date.now() - createdAt > PROJECT_STATE_LOCK_STALE_MS;
}

function projectStateLockIsLive(held) {
  return held?.record?.format === PROJECT_STATE_LOCK_FORMAT
    && typeof held.record.owner === "string"
    && Number.isSafeInteger(held.record.pid)
    && held.record.pid > 0
    && processRecordIsAlive(held.record);
}

export function projectStateProcessIsAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

const processIsAlive = projectStateProcessIsAlive;

async function pathExists(fileSystem, filePath) {
  try {
    await fileSystem.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findIdForPath(context, paths, projectPath) {
  for (const [id, localPath] of Object.entries(paths)) {
    if (await pathsReferToSameDirectory(context, localPath, projectPath)) return id;
  }
  return null;
}

async function pathsReferToSameDirectory(context, storedPath, projectPath) {
  const localPath = readMappedPath(storedPath);
  if (!localPath) return false;
  const resolved = resolveUserPath(localPath, context.homePath);
  if (resolved === projectPath) return true;
  try {
    return await context.fs.realpath(resolved) === projectPath;
  } catch {
    return false;
  }
}

async function verifyProjectPathMapping(context, value) {
  if (value === undefined || value === null) {
    return { status: "unmapped", projectPath: null };
  }
  if (typeof value === "string") {
    return { status: "legacy", projectPath: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid", projectPath: null };
  }
  const projectPath = readMappedPath(value);
  if (!projectPath || typeof value.path !== "string" || !path.isAbsolute(value.path)) {
    return { status: "invalid", projectPath: null };
  }
  const identity = value.root_identity;
  if (
    identity?.type !== "directory"
    || typeof identity.dev !== "string"
    || !/^\d+$/.test(identity.dev)
    || typeof identity.ino !== "string"
    || !/^\d+$/.test(identity.ino)
  ) {
    return { status: "invalid", projectPath: null };
  }
  try {
    await assertProjectRootPath(projectPath, context.fs);
    const canonicalPath = await context.fs.realpath(projectPath);
    const observed = await inspectProjectRootIdentity(canonicalPath, context.fs);
    if (!sameProjectRootIdentity(observed, identity)) {
      return { status: "changed", projectPath: null };
    }
    return { status: "verified", projectPath };
  } catch {
    return { status: "unavailable", projectPath: null };
  }
}

async function inspectProjectRootIdentity(projectPath, fileSystem) {
  return inspectDirectoryIdentity(projectPath, fileSystem, "Project folder");
}

async function inspectDirectoryIdentity(directoryPath, fileSystem, label) {
  let stats;
  try {
    stats = await fileSystem.lstat(directoryPath, { bigint: true });
  } catch {
    throw new Error(`${label} is unavailable.`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a real directory.`);
  }
  return {
    type: "directory",
    dev: stats.dev.toString(),
    ino: stats.ino.toString()
  };
}

async function assertProjectRootPath(projectPath, fileSystem) {
  let stats;
  try {
    stats = await fileSystem.lstat(projectPath);
  } catch {
    throw new Error("Project folder is unavailable.");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Project folder must not be a symbolic link.");
  }
}

async function assertProjectRootUnchanged(context, plan) {
  let canonicalPath;
  let identity;
  try {
    await assertProjectRootPath(plan.projectPath, context.fs);
    canonicalPath = await context.fs.realpath(plan.projectPath);
    identity = await inspectProjectRootIdentity(canonicalPath, context.fs);
  } catch {
    throw new Error("The project folder changed after the preview. Preview project add again.");
  }
  if (
    canonicalPath !== plan.canonicalProjectPath
    || !sameProjectRootIdentity(identity, plan.rootIdentity)
  ) {
    throw new Error("The project folder changed after the preview. Preview project add again.");
  }
}

async function assertAiosRootUnchanged(context, plan) {
  let canonicalPath;
  let identity;
  try {
    canonicalPath = await context.fs.realpath(context.aiosPath);
    identity = await inspectDirectoryIdentity(canonicalPath, context.fs, "AIOS folder");
  } catch {
    throw new Error("The AIOS folder changed after the preview. Preview project add again.");
  }
  if (
    canonicalPath !== plan.canonicalAiosPath
    || !sameProjectRootIdentity(identity, plan.aiosRootIdentity)
  ) {
    throw new Error("The AIOS folder changed after the preview. Preview project add again.");
  }
}

function sameProjectRootIdentity(left, right) {
  return left?.type === right?.type
    && left?.dev === right?.dev
    && left?.ino === right?.ino;
}

function readMappedPath(value) {
  if (typeof value === "string" && value.trim()) return path.resolve(value);
  if (value && typeof value.path === "string" && value.path.trim()) return path.resolve(value.path);
  return null;
}

async function assertStateOutsideAios(context) {
  const containmentOptions = { fileSystem: context.fs };
  if (!await isPathWithin(path.parse(context.statePath).root, context.statePath, containmentOptions)) {
    throw new Error(`Project path state cannot safely resolve through a dangling symlink: ${context.statePath}`);
  }
  if (
    isLexicallyWithin(context.aiosPath, context.statePath) ||
    await isPathWithin(context.aiosPath, context.statePath, containmentOptions)
  ) {
    throw new Error([
      `Project path state must live outside the synced AIOS folder: ${context.statePath}.`,
      "Pass a statePath under the user's local state directory instead."
    ].join(" "));
  }
}

async function assertProjectReadmePath(context, readmePath) {
  const projectsPath = path.join(context.aiosPath, "projects");
  const options = { fileSystem: context.fs };
  if (
    !await isPathWithin(context.aiosPath, projectsPath, options) ||
    !await isPathWithin(projectsPath, readmePath, options)
  ) {
    throw new Error(`Project README path resolves outside the AIOS project shelf: ${readmePath}`);
  }
}

function assertUniqueProjectIds(records) {
  const seen = new Map();
  for (const record of records) {
    if (!record.id) continue;
    const previous = seen.get(record.id);
    if (previous) {
      throw new Error(`Project id ${record.id} is used by both "${previous}" and "${record.directorySlug}".`);
    }
    seen.set(record.id, record.directorySlug);
  }
}

function normalizeDomains(value) {
  const domains = normalizeStoredDomains(value);
  if (domains.length === 0) {
    throw new Error("domain requires at least one value");
  }
  for (const domain of domains) {
    if (!PROJECT_DOMAINS.has(domain)) {
      throw new Error(`Unknown project domain "${domain}". Use build, make, or sell.`);
    }
  }
  return [...new Set(domains)];
}

function normalizeStoredDomains(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
}

function validateSlug(value) {
  const slug = readRequiredString(value, "slug");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("slug must use lowercase letters, numbers, and single hyphens");
  }
  return slug;
}

function projectSelectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(`Could not create a project slug from "${value}". Pass --slug explicitly.`);
  }
  return slug;
}

function readRequiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateProjectPurpose(value) {
  const purpose = typeof value === "string" ? value.trim() : "";
  if (
    !purpose
    || Array.from(purpose).length > 500
    || /\p{Cc}/u.test(purpose)
    || /[\uD800-\uDFFF]/u.test(purpose)
  ) {
    throw new Error("purpose must contain 1-500 safe Unicode code points");
  }
  return purpose;
}

function unsafeExplicitProjectRemoteError(reason) {
  const error = new Error(
    `Explicit project remote is unsafe (${reason || "invalid"}); refusing registration before writing metadata.`
  );
  error.code = "ERR_DOTAIOS_UNSAFE_PROJECT_REMOTE";
  return error;
}

function firstHeading(body) {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

function firstDescription(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("<!--") && !/^[-*]\s/.test(line)) || "";
}

function projectExcerpt(body, limit = 1200) {
  const excerpt = String(body || "")
    .replace(/^#\s+.+(?:\r?\n|$)/, "")
    .trim();
  if (excerpt.length <= limit) return excerpt;
  return `${excerpt.slice(0, limit - 1).trimEnd()}…`;
}

function resolveUserPath(value, homePath) {
  if (value === "~") return homePath;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homePath, value.slice(2));
  }
  return path.resolve(value);
}

function isLexicallyWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function renderProjectDiff(relativePath, before, after, existed) {
  const lines = [
    `--- ${existed ? relativePath : "/dev/null"}`,
    `+++ ${relativePath}`,
    `@@ ${existed ? "replace" : "add"} README @@`
  ];
  if (existed) {
    lines.push(...before.replace(/\n$/, "").split("\n").map((line) => `-${line}`));
  }
  lines.push(...after.replace(/\n$/, "").split("\n").map((line) => `+${line}`));
  return lines.join("\n");
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function projectRegistrationFingerprint(plan) {
  const relativeReadmePath = path.relative(plan.aiosPath, plan.readmePath);
  return contentHash(stableJson({
    version: plan.version,
    operation: plan.operation,
    operation_id: plan.operationId,
    project: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      description: plan.description || null,
      status: plan.status,
      domain: plan.domain,
      repo_url: plan.repoUrl
    },
    durable: {
      root_path: plan.canonicalAiosPath,
      root_identity: plan.aiosRootIdentity,
      path: relativeReadmePath,
      before_hash: plan.readmeExists ? contentHash(plan.readmeBefore) : null,
      after_hash: contentHash(plan.readme)
    },
    machine_local: {
      state_path: plan.statePath,
      project_path: plan.projectPath,
      canonical_project_path: plan.canonicalProjectPath,
      root_identity: plan.rootIdentity,
      state_before: plan.stateBefore,
      state_after: plan.stateAfter
    }
  }));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateProjectOperationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Project registration operation id is invalid.");
  }
  return value;
}

function assertExactProjectApply(options, plan) {
  if (!options.operationId || !options.planFingerprint) {
    throw new Error("Project registration apply requires the displayed operation id and plan fingerprint.");
  }
  if (
    typeof options.planFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(options.planFingerprint)
    || options.planFingerprint !== plan.planFingerprint
  ) {
    throw new Error("Project registration plan is stale. Preview project add again.");
  }
}

function assertProjectPlan(plan) {
  if (
    !plan
    || plan.version !== PROJECT_PLAN_VERSION
    || !plan.aiosPath
    || !plan.canonicalAiosPath
    || !plan.aiosRootIdentity
    || !plan.readmePath
  ) {
    throw new Error("Invalid project registration plan. Preview project add again.");
  }
}

function assertProjectPlanIntegrity(plan) {
  assertProjectPlan(plan);
  const relativeReadmePath = path.relative(plan.aiosPath, plan.readmePath);
  const expectedReadmePath = path.join(plan.aiosPath, "projects", plan.slug, "README.md");
  const beforeHash = plan.readmeExists ? contentHash(plan.readmeBefore) : null;
  const afterHash = contentHash(plan.readme);
  const receipt = plan.receipt;
  const stateMapping = plan.stateAfter?.paths?.[plan.id];
  const expectedPreview = renderProjectDiff(
    relativeReadmePath,
    plan.readmeBefore,
    plan.readme,
    plan.readmeExists
  );
  if (
    path.resolve(plan.readmePath) !== path.resolve(expectedReadmePath)
    || plan.operation !== (plan.readmeExists ? "replace" : "add")
    || typeof plan.planFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(plan.planFingerprint)
    || projectRegistrationFingerprint(plan) !== plan.planFingerprint
    || plan.preview !== expectedPreview
    || !receipt
    || receipt.applied !== false
    || receipt.operation !== plan.operation
    || receipt.project_id !== plan.id
    || receipt.project !== plan.slug
    || receipt.operation_id !== plan.operationId
    || receipt.plan_fingerprint !== plan.planFingerprint
    || receipt.durable?.path !== relativeReadmePath
    || receipt.durable?.before_hash !== beforeHash
    || receipt.durable?.after_hash !== afterHash
    || receipt.machine_local?.state_path !== plan.statePath
    || receipt.machine_local?.project_path !== plan.projectPath
    || !sameProjectRootIdentity(receipt.machine_local?.root_identity, plan.rootIdentity)
    || stateMapping?.path !== plan.projectPath
    || !sameProjectRootIdentity(stateMapping?.root_identity, plan.rootIdentity)
  ) {
    throw new Error("Invalid project registration plan. Preview project add again.");
  }
}

async function assertDirectory(fileSystem, target, label) {
  let stats;
  try {
    stats = await fileSystem.stat(target);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${target}`);
    throw error;
  }
  if (!stats.isDirectory()) throw new Error(`${label} is not a directory: ${target}`);
}

async function isDirectory(fileSystem, target) {
  try {
    return (await fileSystem.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readGitRemoteUrl(projectPath) {
  const originUrl = await gitOutput(projectPath, ["config", "--get", "remote.origin.url"]);
  if (originUrl) return originUrl;

  const remotes = await gitOutput(projectPath, ["remote"]);
  const firstRemote = remotes?.split(/\r?\n/).map((remote) => remote.trim()).find(Boolean);
  if (!firstRemote) return null;
  return gitOutput(projectPath, ["config", "--get", `remote.${firstRemote}.url`]);
}

async function readGitHead(projectPath) {
  return gitOutput(projectPath, ["rev-parse", "--verify", "HEAD"]);
}

async function gitOutput(projectPath, args) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, ...args],
      { encoding: "utf8", env: sanitizedReadOnlyGitEnvironment() }
    );
    return readOptionalString(stdout);
  } catch {
    return null;
  }
}

function sanitizedReadOnlyGitEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("GIT_"))
  );
}

async function lstatIfPresent(fileSystem, target) {
  try {
    return await fileSystem.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function restoreStatus(remote, placement) {
  if (!remote.safe) return "local-only";
  if (placement.placement === "missing") return "restorable";
  if (placement.placement === "unsafe") return "unsafe-placement";
  return `available-${placement.placement}`;
}
