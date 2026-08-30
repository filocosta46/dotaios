import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  inspectContainedPathEntry,
  readContainedDirectory
} from "./contained-read.mjs";
import {
  classifyProjectRemote,
  projectRemotesMatch
} from "./project-workspaces.mjs";
import {
  readBoundedProjectRegistrations,
  validateProjectSelector
} from "./projects.mjs";
import { rankSkills } from "./skill-resolver.mjs";

const MAX_LIVE_GIT_CONCURRENCY = 8;
const MAX_SKILL_CONVENTION_OBSERVATIONS = 64;
const PROJECT_ROUTE_APPROVAL_DOMAIN = "dotaios-project-route-approval/v1";
const SAFE_REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
export const PROJECT_NATIVE_CONVENTION_KINDS = Object.freeze([
  "agents-md",
  "claude-md",
  "repository-skill"
]);
const CONVENTION_KINDS = new Set(PROJECT_NATIVE_CONVENTION_KINDS);
const execFileAsync = promisify(execFile);

/** Resolve a registered project route without executing project instructions. */
export async function resolveProjectRoute({
  intent,
  projectSelector = null,
  supportedConventionKinds = [],
  approvalBinding = null,
  ...runtimeOptions
} = {}, dependencies = {}) {
  if (!validRouteIntent(intent)) return refused("invalid_intent");
  if (projectSelector !== null) {
    try {
      validateProjectSelector(projectSelector);
    } catch {
      return refused("invalid_project_selector");
    }
  }
  if (!validSupportedConventionKinds(supportedConventionKinds)) {
    return refused("invalid_host_support");
  }
  if (projectSelector !== null && !validApprovalBinding(approvalBinding)) {
    return refused("approval_binding_required");
  }
  const runtime = {
    ...defaultDependencies(runtimeOptions, dependencies),
    ...dependencies
  };
  let projects;
  try {
    projects = (await runtime.readProjectRegistrations({ projectSelector })) || [];
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
      approvalBinding,
      projects,
      dependencies: runtime
    });
  }
  const observation = await observeRoutableProjects(active, runtime);
  if (observation.error) return refused(observation.error);
  return resolveImplicitProject({
    intent,
    supportedConventionKinds,
    routable: observation.routable
  });
}

async function observeRoutableProjects(projects, dependencies) {
  const liveRemoteResults = await mapWithConcurrency(
    projects,
    MAX_LIVE_GIT_CONCURRENCY,
    (project) => settleInspection(async () => canonicalLiveRemote(
      await dependencies.inspectLiveRemote(project)
    ))
  );
  if (liveRemoteResults.some(({ error }) => isDiscoveryBoundError(error))) {
    return { error: "discovery_bound_exceeded", routable: [] };
  }
  const remoteVerified = projects
    .map((project, index) => ({ project, liveRemote: liveRemoteResults[index].value }))
    .filter(({ project, liveRemote }, index) => (
      liveRemoteResults[index].ok
      && projectRemotesMatch(project.repository, liveRemote)
    ));
  const inventoryResults = await Promise.all(remoteVerified.map(({ project }) => (
    settleInspection(async () => validateConventionInventory(
      await dependencies.inspectConventionInventory(project)
    ))
  )));
  if (inventoryResults.some(({ error }) => isDiscoveryBoundError(error))) {
    return { error: "discovery_bound_exceeded", routable: [] };
  }
  const routable = remoteVerified
    .map(({ project, liveRemote }, index) => ({
      project,
      liveRemote,
      conventions: inventoryResults[index].ok ? inventoryResults[index].value : null
    }))
    .filter(({ conventions }) => Array.isArray(conventions) && conventions.length > 0);
  return { error: null, routable };
}

function resolveImplicitProject({ intent, supportedConventionKinds, routable }) {
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
    const runnerUp = ranked[1]?.score;
    winner.confidence = runnerUp === undefined
      ? Math.min(1, winner.score)
      : winner.score / (winner.score + runnerUp);
  }
  if (winner && winner.confidence >= 0.67) {
    const selected = routable.find(({ project }) => project.slug === winner.dir);
    const match = matchReason(selected.project, winner);
    const supported = supportedConventions(selected.conventions, supportedConventionKinds);
    if (supported.length === 0) return unsupported(selected.project, selected.conventions);
    return candidate(selected, match, { intent, supportedConventionKinds });
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
  intent,
  projectSelector,
  supportedConventionKinds,
  approvalBinding,
  projects,
  dependencies
}) {
  const matches = projects.filter((project) => (
    project.id === projectSelector || project.slug === projectSelector
  ));
  if (matches.length !== 1) return refused("approval_binding_mismatch");
  const selected = matches[0];
  if (!projectEligibleForInspection(selected)) {
    return refused("project_identity_unverified");
  }
  const observation = await observeRoutableProjects([selected], dependencies);
  if (observation.error) return refused(observation.error);
  if (observation.routable.length !== 1) return refused("project_identity_unverified");
  const observed = observation.routable[0];
  const proposal = resolveImplicitProject({
    intent,
    supportedConventionKinds,
    routable: [observed]
  });
  if (
    proposal.status !== "candidate"
    || proposal.project.id !== selected.id
    || proposal.approval_binding !== approvalBinding
  ) {
    return refused("approval_binding_mismatch");
  }
  const finalSupported = supportedConventions(
    observed.conventions,
    supportedConventionKinds
  );
  return ready(
    selected,
    observed.conventions,
    finalSupported,
    projectSelector === selected.id ? "stable_id" : "slug"
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

function candidate({ project, liveRemote, conventions }, match, {
  intent,
  supportedConventionKinds
}) {
  const reason = "unique_registered_project_match";
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
    reason,
    approval_binding: projectRouteApprovalBinding({
      intent,
      supportedConventionKinds,
      project,
      liveRemote,
      conventions,
      match,
      reason
    })
  };
}

function projectRouteApprovalBinding({
  intent,
  supportedConventionKinds,
  project,
  liveRemote,
  conventions,
  match,
  reason
}) {
  const payload = stableJson({
    version: 1,
    action: normalizeRouteAction(intent),
    host_support: normalizeSupportedConventionKinds(supportedConventionKinds),
    project_id: project.id,
    mapping_path: project.mappingPath || project.projectPath,
    root_identity: project.rootIdentity,
    live_remote: liveRemote,
    conventions: [...conventions].sort(compareConventions),
    registration: publicProject(project),
    explanation_basis: { kind: match.kind, fields: match.fields },
    emitted_match_reason: reason
  });
  return createHash("sha256")
    .update(PROJECT_ROUTE_APPROVAL_DOMAIN)
    .update("\u0000")
    .update(payload)
    .digest("hex");
}

function normalizeRouteAction(value) {
  return String(value).normalize("NFC").replace(/\s+/gu, " ").trim();
}

function normalizeSupportedConventionKinds(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

function canonicalLiveRemote(value) {
  const remote = classifyProjectRemote(value);
  if (!remote.safe) throw new Error("The live local Git remote is unsafe.");
  return remote.canonicalUrl;
}

function supportedConventions(conventions, supportedConventionKinds) {
  const supportedKinds = new Set(supportedConventionKinds);
  return conventions
    .filter(({ kind }) => supportedKinds.has(kind))
    .sort(compareConventions);
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
      location: project.mappingPath || project.projectPath,
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

function refused(reason) {
  return { status: "refused", project: null, match: null, routability: null, route: null, reason };
}

function publicProject(project) {
  return project.publicRegistration || {
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
    readProjectRegistrations: ({ projectSelector }) => readBoundedProjectRegistrations({
      aiosPath,
      statePath,
      fs: filesystem,
      projectSelector
    }),
    inspectLiveRemote: (project) => inspectLiveRemote(project, { filesystem, runGit }),
    inspectConventionInventory: (project) => inspectConventionInventory(project, { filesystem })
  };
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

function validApprovalBinding(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
