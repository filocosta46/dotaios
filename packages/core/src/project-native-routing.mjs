import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseDocument } from "yaml";

import {
  inspectContainedPathEntry,
  readContainedDirectory,
  readContainedFile
} from "./contained-read.mjs";
import {
  classifyProjectPlacement,
  classifyProjectRemote,
  projectRemotesMatch
} from "./project-workspaces.mjs";
import { rankSkills } from "./skill-resolver.mjs";
import { isPathWithin as isContainedPath } from "./paths.mjs";

const MAX_DISCOVERY_PROJECTS = 32;
const MAX_LIVE_GIT_CONCURRENCY = 8;
const MAX_PROJECT_CATALOG_ENTRIES = 256;
const MAX_PROJECT_METADATA_BYTES = 64 * 1024;
const MAX_PROJECT_FRONTMATTER_BYTES = 16 * 1024;
const MAX_PROJECT_README_BYTES = 1024 * 1024;
const MAX_PROJECT_STATE_BYTES = 256 * 1024;
const MAX_SKILL_CONVENTION_OBSERVATIONS = 64;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const CONVENTION_KINDS = new Set(["agents-md", "claude-md", "repository-skill"]);
const execFileAsync = promisify(execFile);

/** Resolve a registered project route without executing project instructions. */
export async function resolveProjectRoute({
  intent,
  projectSelector = null,
  cwd = null,
  supportedConventionKinds = [],
  ...runtimeOptions
} = {}, dependencies = {}) {
  if (!validRouteIntent(intent)) return refused("invalid_intent");
  if (projectSelector !== null && !isSafeHandle(projectSelector)) {
    return refused("invalid_project_selector");
  }
  if (!validSupportedConventionKinds(supportedConventionKinds)) {
    return refused("invalid_host_support");
  }
  const runtime = {
    ...defaultDependencies(runtimeOptions, dependencies),
    ...dependencies
  };
  let projects;
  try {
    projects = (await runtime.loadRegisteredProjects({ projectSelector })) || [];
  } catch (error) {
    return refused(isDiscoveryBoundError(error)
      ? "discovery_bound_exceeded"
      : "project_identity_unverified");
  }
  const active = projects.filter(projectEligibleForInspection);
  if (projectSelector !== null) {
    return resolveExactProject({
      intent,
      projectSelector,
      supportedConventionKinds,
      projects,
      dependencies: runtime
    });
  }
  if (active.length > MAX_DISCOVERY_PROJECTS) {
    return refused("discovery_bound_exceeded");
  }
  const liveRemoteResults = await mapWithConcurrency(
    active,
    MAX_LIVE_GIT_CONCURRENCY,
    (project) => settleInspection(() => runtime.inspectLiveRemote(project))
  );
  if (liveRemoteResults.some(({ error }) => isDiscoveryBoundError(error))) {
    return refused("discovery_bound_exceeded");
  }
  const remoteVerified = active.filter((project, index) => (
    liveRemoteResults[index].ok
    && projectRemotesMatch(project.repository, liveRemoteResults[index].value)
  ));
  const inventoryResults = await Promise.all(remoteVerified.map((project) => (
    settleInspection(async () => validateConventionInventory(
      await runtime.inspectConventionInventory(project)
    ))
  )));
  if (inventoryResults.some(({ error }) => isDiscoveryBoundError(error))) {
    return refused("discovery_bound_exceeded");
  }
  const routable = remoteVerified
    .map((project, index) => ({
      project,
      conventions: inventoryResults[index].ok ? inventoryResults[index].value : null
    }))
    .filter(({ conventions }) => Array.isArray(conventions) && conventions.length > 0);
  if (cwd !== null) {
    const contains = runtime.isPathWithin || ((root, candidate) => (
      isContainedPath(root, candidate, { fileSystem: runtime.filesystem })
    ));
    const contained = (await Promise.all(routable.map(async (candidate) => (
      await contains(candidate.project.projectPath, cwd) ? candidate : null
    )))).filter(Boolean);
    if (contained.length === 1) {
      return candidate(contained[0], {
        kind: "current_directory",
        confidence: 1,
        fields: ["registered_root"]
      });
    }
    if (contained.length > 1) {
      return ambiguous(contained, {
        kind: "colliding_registered_root",
        confidence: 0.5,
        fields: ["registered_root"]
      });
    }
  }
  const exactDisplayNames = exactDisplayNameMatches(intent, routable);
  if (exactDisplayNames.length > 1) {
    return ambiguous(exactDisplayNames, {
      kind: "colliding_display_name",
      confidence: 0.5,
      fields: ["name"]
    });
  }
  const ranked = rankSkills(String(intent || ""), routable.map(({ project }) => ({
    name: project.slug,
    dir: project.slug,
    description: "",
    triggers: [
      project.slug,
      project.name,
      project.purpose,
      remoteBasename(project.repository)
    ].filter(Boolean)
  })));
  const winner = ranked[0];
  if (winner && winner.confidence === undefined) {
    const runnerUp = ranked[1]?.score ?? 0;
    const total = winner.score + runnerUp;
    winner.confidence = total > 0 ? winner.score / total : 1;
  }
  if (winner && winner.confidence >= 0.67) {
    const selected = routable.find(({ project }) => project.slug === winner.dir);
    return candidate(selected, matchReason(selected.project, winner));
  }
  if (winner && ranked.length > 1) {
    const candidates = ranked.slice(0, 2).map((entry) => (
      routable.find(({ project }) => project.slug === entry.dir)
    ));
    return ambiguous(candidates, {
      kind: "low_separation",
      confidence: winner.confidence,
      fields: ["metadata"]
    });
  }
  return {
    status: "no_match",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason: "no_registered_project_match"
  };
}

async function resolveExactProject({
  projectSelector,
  supportedConventionKinds,
  projects,
  dependencies
}) {
  const matches = projects.filter((project) => (
    project.id === projectSelector || project.slug === projectSelector
  ));
  if (matches.length === 0) return noMatch("exact_project_not_found");
  if (matches.length > 1) {
    return ambiguous(
      matches.map((project) => ({ project })),
      { kind: "colliding_handle", confidence: 0.5, fields: ["slug_or_stable_id"] },
      "ambiguous_project_handle"
    );
  }
  const selected = matches[0];
  if (!projectEligibleForInspection(selected)) {
    return refused("project_identity_unverified");
  }
  let initialRemote;
  try {
    initialRemote = await dependencies.inspectLiveRemote(selected);
  } catch {
    return refused("project_identity_unverified");
  }
  if (!projectRemotesMatch(selected.repository, initialRemote)) {
    return refused("project_identity_unverified");
  }
  let initialConventions;
  try {
    initialConventions = validateConventionInventory(
      await dependencies.inspectConventionInventory(selected)
    );
  } catch (error) {
    return refused(isDiscoveryBoundError(error)
      ? "discovery_bound_exceeded"
      : "project_not_routable");
  }
  if (!Array.isArray(initialConventions) || initialConventions.length === 0) {
    return refused("project_not_routable");
  }
  const supportedKinds = new Set(supportedConventionKinds);
  const supported = initialConventions.filter(({ kind }) => supportedKinds.has(kind));
  if (supported.length === 0) {
    return unsupported(selected, initialConventions);
  }

  let currentProjects;
  try {
    currentProjects = (await dependencies.loadRegisteredProjects({ projectSelector })) || [];
  } catch (error) {
    return refused(isDiscoveryBoundError(error)
      ? "discovery_bound_exceeded"
      : "project_identity_unverified");
  }
  const currentMatches = currentProjects.filter((project) => (
    projectEligibleForInspection(project)
    && (project.id === projectSelector || project.slug === projectSelector)
  ));
  if (currentMatches.length !== 1 || !sameProjectIdentity(selected, currentMatches[0])) {
    return refused("project_identity_unverified");
  }
  const current = currentMatches[0];
  let finalRemote;
  try {
    finalRemote = await dependencies.inspectLiveRemote(current);
  } catch {
    return refused("project_identity_unverified");
  }
  if (
    !projectRemotesMatch(current.repository, finalRemote)
    || !projectRemotesMatch(initialRemote, finalRemote)
  ) {
    return refused("project_identity_unverified");
  }
  let finalConventions;
  try {
    finalConventions = validateConventionInventory(
      await dependencies.inspectConventionInventory(current)
    );
  } catch {
    return refused("project_identity_unverified");
  }
  if (!sameConventionInventory(initialConventions, finalConventions)) {
    return refused("project_identity_unverified");
  }
  const finalSupported = finalConventions
    .filter(({ kind }) => supportedKinds.has(kind))
    .sort(compareConventions);
  return ready(
    current,
    finalConventions,
    finalSupported,
    projectSelector === current.id ? "stable_id" : "slug"
  );
}

function projectEligibleForInspection(project) {
  return project?.status === "active"
    && project.mappingStatus === "verified"
    && project.pathAvailable === true
    && (project.placement === "external" || project.placement === "managed")
    && typeof project.repository === "string";
}

function remoteBasename(repository) {
  const trimmed = String(repository || "").replace(/\.git$/i, "").replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/^.*:/, "");
}

function matchReason(project, winner) {
  const reason = winner.reason || "";
  const field = reason === "exact name match" || reason.includes(`\"${project.slug}\"`)
    ? "slug"
    : reason.includes(`\"${project.purpose}\"`)
      ? "purpose"
      : reason.includes(`\"${project.name}\"`)
        ? "name"
        : "repository";
  return {
    kind: field === "slug"
      ? "slug_overlap"
      : field === "purpose"
        ? "purpose_overlap"
        : field === "name"
          ? "name_overlap"
          : "remote_name_overlap",
    confidence: winner.confidence,
    fields: [field]
  };
}

function candidate({ project, conventions }, match) {
  return {
    status: "candidate",
    project: publicProject(project),
    match,
    routability: {
      trust: "registered-user-owned",
      effect: "unknown",
      approval: "direct_user_required",
      conventions: conventions
        .map(({ kind, resource }) => ({ kind, resource }))
        .sort(compareConventions)
    },
    route: null,
    reason: "unique_registered_project_match"
  };
}

function exactDisplayNameMatches(intent, routable) {
  const normalizedIntent = String(intent || "").toLocaleLowerCase("en-US");
  return routable.filter(({ project }) => {
    const name = String(project.name || "").toLocaleLowerCase("en-US");
    return name.length >= 2 && normalizedIntent.includes(name);
  });
}

function ambiguous(candidates, match, reason = "multiple_registered_project_matches") {
  return {
    status: "ambiguous",
    project: null,
    match,
    routability: null,
    route: null,
    reason,
    candidates: candidates
      .map(({ project }) => ({ id: project.id, slug: project.slug, name: project.name }))
      .sort((left, right) => left.slug.localeCompare(right.slug))
  };
}

function ready(project, conventions, supported, handleField) {
  return {
    status: "ready",
    project: publicProject(project),
    match: { kind: "exact_handle", confidence: 1, fields: [handleField] },
    routability: publicRoutability(conventions),
    route: {
      kind: "project-native",
      project_id: project.id,
      project_slug: project.slug,
      location: project.projectPath,
      advisory: true,
      revalidate_before_entry: true,
      fresh_context_required: true,
      conventions: supported
    },
    reason: "exact_project_ready"
  };
}

function publicRoutability(conventions) {
  return {
    trust: "registered-user-owned",
    effect: "unknown",
    approval: "direct_user_required",
    conventions: conventions
      .map(({ kind, resource }) => ({ kind, resource }))
      .sort(compareConventions)
  };
}

function sameProjectIdentity(left, right) {
  return left.id === right.id
    && left.slug === right.slug
    && left.name === right.name
    && left.purpose === right.purpose
    && projectRemotesMatch(left.repository, right.repository)
    && left.projectPath === right.projectPath
    && left.mappingStatus === right.mappingStatus
    && left.pathAvailable === right.pathAvailable
    && left.placement === right.placement
    && JSON.stringify(left.rootIdentity) === JSON.stringify(right.rootIdentity);
}

function sameConventionInventory(left, right) {
  if (!Array.isArray(right) || left.length !== right.length) return false;
  const leftSorted = [...left].sort(compareConventions);
  const rightSorted = [...right].sort(compareConventions);
  return JSON.stringify(leftSorted) === JSON.stringify(rightSorted);
}

function unsupported(project, conventions) {
  return {
    status: "unsupported_by_host",
    project: publicProject(project),
    match: { kind: "exact_handle", confidence: 1, fields: ["slug_or_stable_id"] },
    routability: publicRoutability(conventions),
    route: null,
    reason: "no_supported_convention"
  };
}

function noMatch(reason) {
  return { status: "no_match", project: null, match: null, routability: null, route: null, reason };
}

function refused(reason) {
  return { status: "refused", project: null, match: null, routability: null, route: null, reason };
}

function publicProject(project) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    purpose: project.purpose,
    repository: project.repository,
    placement: project.placement
  };
}

function compareConventions(left, right) {
  return left.kind.localeCompare(right.kind) || left.resource.localeCompare(right.resource);
}

async function mapWithConcurrency(values, limit, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function settleInspection(operation) {
  try {
    return { ok: true, value: await operation(), error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

function isDiscoveryBoundError(error) {
  return error?.code === "DOTAIOS_PROJECT_ROUTE_DISCOVERY_BOUND_EXCEEDED"
    || error?.code === "DOTAIOS_PROJECT_ROUTE_CONVENTION_BOUND_EXCEEDED";
}

function defaultDependencies(options, overrides) {
  const filesystem = overrides.filesystem || options.filesystem || fs;
  const homePath = path.resolve(options.homePath || os.homedir());
  const aiosPath = path.resolve(options.aiosPath || path.join(homePath, "aios"));
  const statePath = path.resolve(options.statePath || path.join(homePath, ".dotaios", "projects.json"));
  const runGit = overrides.execFileAsync || execFileAsync;
  return {
    filesystem,
    loadRegisteredProjects: ({ projectSelector }) => loadRegisteredProjects({
      aiosPath,
      statePath,
      filesystem,
      projectSelector
    }),
    inspectLiveRemote: (project) => inspectLiveRemote(project, { filesystem, runGit }),
    inspectConventionInventory: (project) => inspectConventionInventory(project, { filesystem })
  };
}

async function loadRegisteredProjects({
  aiosPath,
  statePath,
  filesystem,
  projectSelector = null
}) {
  const projectsPath = path.join(aiosPath, "projects");
  const [entries, state] = await Promise.all([
    readContainedDirectory(aiosPath, projectsPath, {
      filesystem,
      maxEntries: MAX_PROJECT_CATALOG_ENTRIES,
      readdirOptions: { withFileTypes: true },
      tooManyCode: "DOTAIOS_PROJECT_ROUTE_DISCOVERY_BOUND_EXCEEDED"
    }),
    readProjectRouteState(statePath, filesystem)
  ]);
  if (entries === null) return [];

  let metadataBytes = 0;
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_SLUG_RE.test(entry.name)) continue;
    const readmePath = path.join(projectsPath, entry.name, "README.md");
    let frontmatter;
    try {
      frontmatter = await readContainedFile(aiosPath, readmePath, {
        filesystem,
        encoding: "utf8",
        prefixBytes: MAX_PROJECT_FRONTMATTER_BYTES,
        maxSourceBytes: MAX_PROJECT_README_BYTES,
        frontmatterOnly: true,
        stopOnMissingFrontmatter: true,
        tooLargeCode: "DOTAIOS_PROJECT_ROUTE_DISCOVERY_BOUND_EXCEEDED"
      });
    } catch {
      continue;
    }
    if (frontmatter === null) continue;
    if (projectSelector === null) {
      metadataBytes += Buffer.byteLength(frontmatter);
      if (metadataBytes > MAX_PROJECT_METADATA_BYTES) {
        throw routeBoundError();
      }
    }
    const metadata = parseProjectMetadata(frontmatter, entry.name);
    if (!metadata) continue;
    const mapping = await verifyProjectMapping(state.paths?.[metadata.id], filesystem);
    const placement = await classifyProjectPlacement({
      aiosPath,
      projectPath: mapping.projectPath,
      slug: metadata.slug,
      fileSystem: filesystem
    });
    records.push({
      ...metadata,
      projectPath: mapping.projectPath,
      mappingStatus: mapping.status,
      pathAvailable: placement.pathAvailable,
      placement: placement.placement,
      rootIdentity: mapping.rootIdentity
    });
  }
  const rootOwners = new Map();
  const idOwners = new Map();
  for (const record of records) {
    if (record.status !== "active") continue;
    idOwners.set(record.id, (idOwners.get(record.id) || 0) + 1);
    if (record.mappingStatus !== "verified" || !record.rootIdentity) continue;
    const key = `${record.rootIdentity.dev}:${record.rootIdentity.ino}`;
    rootOwners.set(key, (rootOwners.get(key) || 0) + 1);
  }
  const verified = records.map((record) => {
    if (record.status !== "active") return record;
    const key = record.rootIdentity
      ? `${record.rootIdentity.dev}:${record.rootIdentity.ino}`
      : null;
    if ((!key || rootOwners.get(key) === 1) && idOwners.get(record.id) === 1) return record;
    return {
      ...record,
      projectPath: null,
      mappingStatus: "conflict",
      pathAvailable: false,
      placement: "unsafe",
      rootIdentity: null
    };
  });
  if (projectSelector === null) return verified;
  return verified.filter((record) => (
    record.id === projectSelector || record.slug === projectSelector
  ));
}

async function readProjectRouteState(statePath, filesystem) {
  try {
    const parent = path.dirname(statePath);
    const parentStats = await filesystem.lstat(parent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) return { paths: {} };
    const content = await readContainedFile(parent, statePath, {
      filesystem,
      encoding: "utf8",
      maxBytes: MAX_PROJECT_STATE_BYTES,
      tooLargeCode: "DOTAIOS_PROJECT_ROUTE_DISCOVERY_BOUND_EXCEEDED"
    });
    if (content === null) return { paths: {} };
    const state = JSON.parse(content);
    if (!state || typeof state !== "object" || Array.isArray(state)) return { paths: {} };
    if (!state.paths || typeof state.paths !== "object" || Array.isArray(state.paths)) {
      return { paths: {} };
    }
    return { paths: state.paths };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { paths: {} };
    throw error;
  }
}

function parseProjectMetadata(frontmatter, directorySlug) {
  const match = FRONTMATTER_RE.exec(frontmatter);
  if (!match) return null;
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) return null;
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const primaryId = boundedMetadataString(metadata.id, 200);
  const legacyId = boundedMetadataString(metadata.project_id, 200);
  if (primaryId && legacyId && primaryId !== legacyId) return null;
  const id = primaryId || legacyId;
  const declaredSlug = boundedMetadataString(metadata.project ?? metadata.slug, 200);
  const name = boundedMetadataString(metadata.name, 200);
  const purpose = boundedMetadataString(metadata.description, 1000);
  const status = boundedMetadataString(metadata.status, 32) || "unknown";
  const remote = classifyProjectRemote(
    boundedMetadataString(metadata.repo_url ?? metadata.repo, 2048)
  );
  if (
    !id
    || !isSafeHandle(id)
    || declaredSlug !== directorySlug
    || !name
    || !purpose
    || !remote.safe
  ) {
    return null;
  }
  return {
    id,
    slug: directorySlug,
    name,
    purpose,
    repository: remote.canonicalUrl,
    status
  };
}

function boundedMetadataString(value, maxCodePoints) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return null;
  if (Array.from(value).length > maxCodePoints || /[\p{Cc}\uD800-\uDFFF]/u.test(value)) return null;
  return value;
}

function isSafeHandle(value) {
  return typeof value === "string"
    && value.length <= 200
    && value.trim() === value
    && !path.isAbsolute(value)
    && value !== "."
    && value !== ".."
    && !/[\/\\]/.test(value)
    && /^[\p{L}\p{N}](?:[\p{L}\p{N}:._-]*[\p{L}\p{N}])?$/u.test(value);
}

function validRouteIntent(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Array.from(value).length <= 1000
    && !/[\p{Cc}\uD800-\uDFFF]/u.test(value);
}

function validSupportedConventionKinds(value) {
  return Array.isArray(value)
    && value.length <= CONVENTION_KINDS.size
    && new Set(value).size === value.length
    && value.every((kind) => CONVENTION_KINDS.has(kind));
}

function validateConventionInventory(value) {
  if (!Array.isArray(value) || value.length > 66) {
    throw routeConventionError("DOTAIOS_PROJECT_ROUTE_CONVENTION_BOUND_EXCEEDED");
  }
  const resources = new Set();
  const validated = value.map((observation) => {
    const kind = observation?.kind;
    const resource = observation?.resource;
    const identity = observation?.observed_identity;
    if (
      !CONVENTION_KINDS.has(kind)
      || !validConventionResource(kind, resource)
      || resources.has(resource)
      || !validConventionIdentity(identity)
    ) {
      throw routeConventionError("DOTAIOS_PROJECT_ROUTE_CONVENTION_INVALID");
    }
    resources.add(resource);
    return {
      kind,
      resource,
      observed_identity: {
        type: "file",
        dev: identity.dev,
        ino: identity.ino,
        mode: identity.mode,
        nlink: identity.nlink,
        size: identity.size,
        mtime_ns: identity.mtime_ns,
        ctime_ns: identity.ctime_ns
      }
    };
  });
  return validated.sort(compareConventions);
}

function validConventionResource(kind, resource) {
  if (kind === "agents-md") return resource === "AGENTS.md";
  if (kind === "claude-md") return resource === "CLAUDE.md";
  return typeof resource === "string"
    && /^\.agents\/skills\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/SKILL\.md$/.test(resource);
}

function validConventionIdentity(value) {
  return value?.type === "file"
    && boundedDecimal(value.dev, 40)
    && boundedDecimal(value.ino, 40)
    && Number.isSafeInteger(value.mode)
    && (value.mode & 0o170000) === 0o100000
    && value.nlink === 1
    && boundedDecimal(value.size, 40)
    && boundedDecimal(value.mtime_ns, 40)
    && boundedDecimal(value.ctime_ns, 40);
}

function boundedDecimal(value, maximumLength) {
  return typeof value === "string"
    && value.length <= maximumLength
    && /^(?:0|[1-9]\d*)$/.test(value);
}

function routeConventionError(code) {
  const error = new Error("Project convention inventory is invalid.");
  error.code = code;
  return error;
}

async function verifyProjectMapping(value, filesystem) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "unmapped", projectPath: null, rootIdentity: null };
  }
  const projectPath = value.path;
  const expected = value.root_identity;
  if (
    typeof projectPath !== "string"
    || !path.isAbsolute(projectPath)
    || expected?.type !== "directory"
    || !/^\d+$/.test(expected.dev || "")
    || !/^\d+$/.test(expected.ino || "")
  ) {
    return { status: "invalid", projectPath: null, rootIdentity: null };
  }
  try {
    const observed = await observeProjectRoot({ projectPath, rootIdentity: expected }, filesystem, false);
    if (!sameRootIdentity(expected, observed)) {
      return { status: "changed", projectPath: null, rootIdentity: null };
    }
    return { status: "verified", projectPath, rootIdentity: observed };
  } catch {
    return { status: "unavailable", projectPath: null, rootIdentity: null };
  }
}

async function inspectLiveRemote(project, { filesystem, runGit }) {
  const before = await observeProjectRoot(project, filesystem);
  const origin = await readLocalFetchRemote(project.projectPath, "origin", runGit);
  let remote = origin.url;
  if (!origin.present) {
    const rawFetchKeys = await gitConfig(
      project.projectPath,
      ["config", "--local", "--no-includes", "--name-only", "--get-regexp", "^remote\\..*\\.fetch$"],
      runGit
    );
    const remotes = [...new Set(String(rawFetchKeys || "")
      .split(/\r?\n/)
      .map((value) => /^remote\.(.+)\.fetch$/.exec(value.trim())?.[1] || null)
      .filter((value) => value && value !== "origin"))];
    if (remotes.length !== 1 || !SAFE_REMOTE_NAME_RE.test(remotes[0])) {
      throw new Error("A unique authoritative local Git remote is required.");
    }
    const fallback = await readLocalFetchRemote(project.projectPath, remotes[0], runGit);
    if (!fallback.present || !fallback.url) {
      throw new Error("A unique authoritative local Git remote is required.");
    }
    remote = fallback.url;
  }
  if (!remote) throw new Error("The authoritative local Git remote is incomplete.");
  const classified = classifyProjectRemote(remote);
  if (!classified.safe) throw new Error("The live local Git remote is unsafe.");
  const after = await observeProjectRoot(project, filesystem);
  if (!sameRootIdentity(before, after)) throw new Error("The registered project root changed.");
  return classified.canonicalUrl;
}

async function readLocalFetchRemote(projectPath, remoteName, runGit) {
  if (!SAFE_REMOTE_NAME_RE.test(remoteName)) return { present: false, url: null };
  const [rawUrls, rawFetches] = await Promise.all([
    gitConfig(
      projectPath,
      ["config", "--local", "--no-includes", "--get-all", `remote.${remoteName}.url`],
      runGit
    ),
    gitConfig(
      projectPath,
      ["config", "--local", "--no-includes", "--get-all", `remote.${remoteName}.fetch`],
      runGit
    )
  ]);
  const urls = configValues(rawUrls);
  const fetches = configValues(rawFetches);
  const present = urls.length > 0 || fetches.length > 0;
  if (!present) return { present: false, url: null };
  if (urls.length !== 1 || !fetches.some(safeFetchRefspec)) {
    throw new Error("The authoritative local Git remote is incomplete.");
  }
  return { present: true, url: urls[0] };
}

function configValues(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeFetchRefspec(value) {
  return value.length <= 2048
    && !/[\p{Cc}\uD800-\uDFFF]/u.test(value)
    && /^\+?refs\/[^:\s]+(?::refs\/[^\s]+)?$/.test(value);
}

async function gitConfig(projectPath, args, runGit) {
  try {
    const { stdout } = await runGit(
      "git",
      ["-C", projectPath, ...args],
      { encoding: "utf8", env: sanitizedGitEnvironment() }
    );
    const value = String(stdout || "").trim();
    return value || null;
  } catch {
    return null;
  }
}

function sanitizedGitEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
}

async function inspectConventionInventory(project, { filesystem }) {
  const before = await observeProjectRoot(project, filesystem);
  const observations = [];
  await observeConventionFile(project.projectPath, "AGENTS.md", "agents-md", observations, filesystem);
  await observeConventionFile(project.projectPath, "CLAUDE.md", "claude-md", observations, filesystem);

  const skillsPath = path.join(project.projectPath, ".agents", "skills");
  const skillEntries = await readContainedDirectory(project.projectPath, skillsPath, {
    filesystem,
    maxEntries: MAX_SKILL_CONVENTION_OBSERVATIONS,
    readdirOptions: { withFileTypes: true },
    tooManyCode: "DOTAIOS_PROJECT_ROUTE_CONVENTION_BOUND_EXCEEDED"
  });
  for (const entry of (skillEntries || []).sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || !SAFE_REMOTE_NAME_RE.test(entry.name)
    ) {
      continue;
    }
    await observeConventionFile(
      project.projectPath,
      `.agents/skills/${entry.name}/SKILL.md`,
      "repository-skill",
      observations,
      filesystem
    );
  }
  const after = await observeProjectRoot(project, filesystem);
  if (!sameRootIdentity(before, after)) throw new Error("The registered project root changed.");
  return observations.sort(compareConventions);
}

async function observeConventionFile(root, resource, kind, observations, filesystem) {
  const filePath = path.join(root, ...resource.split("/"));
  const snapshot = await inspectContainedPathEntry(root, filePath, { filesystem });
  if (snapshot?.type !== "regular-file" || Number(snapshot.stats.nlink) !== 1) return;
  observations.push({
    kind,
    resource,
    observed_identity: conventionIdentity(snapshot.stats)
  });
}

function conventionIdentity(stats) {
  return {
    type: "file",
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: Number(stats.mode),
    nlink: Number(stats.nlink),
    size: String(stats.size),
    mtime_ns: statNanoseconds(stats, "mtime"),
    ctime_ns: statNanoseconds(stats, "ctime")
  };
}

function statNanoseconds(stats, field) {
  const bigintValue = stats[`${field}Ns`];
  if (typeof bigintValue === "bigint") return bigintValue.toString();
  return String(Math.trunc(Number(stats[`${field}Ms`]) * 1_000_000));
}

async function observeProjectRoot(project, filesystem, enforceExpected = true) {
  const stats = await filesystem.lstat(project.projectPath, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("The registered project root is unavailable.");
  }
  const canonical = await filesystem.realpath(project.projectPath);
  const canonicalStats = await filesystem.lstat(canonical, { bigint: true });
  const observed = {
    type: "directory",
    dev: canonicalStats.dev.toString(),
    ino: canonicalStats.ino.toString()
  };
  if (enforceExpected && !sameRootIdentity(project.rootIdentity, observed)) {
    throw new Error("The registered project root identity changed.");
  }
  return observed;
}

function sameRootIdentity(left, right) {
  return left?.type === "directory"
    && right?.type === "directory"
    && left.dev === right.dev
    && left.ino === right.ino;
}

function routeBoundError() {
  const error = new Error("Project route discovery bound exceeded.");
  error.code = "DOTAIOS_PROJECT_ROUTE_DISCOVERY_BOUND_EXCEEDED";
  return error;
}
