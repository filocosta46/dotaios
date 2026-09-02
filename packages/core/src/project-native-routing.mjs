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
import { stableJson } from "./json.mjs";
import { inspectAuthoritativeProjectRemote } from "./project-git-remote.mjs";
import {
  classifyProjectRemote,
  projectRemotesMatch
} from "./project-workspaces.mjs";
import {
  readBoundedProjectRegistrations,
  validateProjectSelector
} from "./projects.mjs";
import {
  hasConcreteAction,
  matchedStableProjectHandles,
  matchReason,
  remoteBasename,
  stableHandleMatchReason
} from "./project-route-intent.mjs";
import { rankSkills } from "./skill-resolver.mjs";

const MAX_LIVE_GIT_CONCURRENCY = 8;
const MAX_SKILL_CONVENTION_CONCURRENCY = 4;
const MAX_SKILL_CONVENTION_OBSERVATIONS = 64;
const PROJECT_ROUTE_APPROVAL_DOMAIN = "dotaios-project-route-approval/v1";
const SAFE_LOCAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
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
  if (
    projectSelector !== null
    && approvalBinding !== null
    && !validApprovalBinding(approvalBinding)
  ) {
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
  if (projects.length === 0) return noMatch("no_registered_projects");
  const stableHandleMatches = matchedStableProjectHandles(intent, projects);
  if (stableHandleMatches.length > 1) {
    return ambiguous(stableHandleMatches, {
      kind: "exact_handle_collision",
      confidence: 0.5,
      fields: [...new Set(stableHandleMatches.map(({ field }) => field))].sort()
    });
  }
  const stableHandleMatch = stableHandleMatches[0] || null;
  if (stableHandleMatch && !hasConcreteAction(intent, stableHandleMatch.project)) {
    return noMatch("concrete_action_required");
  }
  const stableHandleRefusal = stableHandleMatch
    ? projectInspectionRefusalReason(stableHandleMatch.project)
    : null;
  if (stableHandleRefusal) {
    return refused(stableHandleRefusal);
  }
  const inspectionTargets = stableHandleMatch
    ? [stableHandleMatch.project]
    : projects.filter(projectEligibleForInspection);
  const observation = await observeRoutableProjects(
    inspectionTargets,
    runtime
  );
  if (observation.error) return refused(observation.error);
  if (stableHandleMatch) {
    const unavailable = observation.unroutable.find(({ project }) => (
      project.id === stableHandleMatch.project.id
    ));
    if (unavailable) return refused(unavailable.reason);
    const selected = observation.routable.find(({ project }) => (
      project.id === stableHandleMatch.project.id
    ));
    if (!selected) return refused("project_identity_unverified");
    return resolveStableHandleProject({
      intent,
      supportedConventionKinds,
      selected,
      handleField: stableHandleMatch.field,
      routable: observation.routable
    });
  }
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
    (project) => settleInspection(async () => {
      const observed = await dependencies.inspectLiveRemote(project);
      return observed === null ? null : canonicalLiveRemote(observed);
    })
  );
  if (liveRemoteResults.some(({ error }) => isDiscoveryBoundError(error))) {
    return { error: "discovery_bound_exceeded", routable: [] };
  }
  const remoteVerified = [];
  const unroutable = [];
  for (const [index, project] of projects.entries()) {
    const result = liveRemoteResults[index];
    if (!result.ok) {
      unroutable.push({ project, reason: "project_remote_unverified" });
      continue;
    }
    const liveRemote = result.value;
    const matches = project.repository === null
      ? liveRemote === null
      : projectRemotesMatch(project.repository, liveRemote);
    if (!matches) {
      unroutable.push({ project, reason: "project_remote_mismatch" });
      continue;
    }
    remoteVerified.push({ project, liveRemote });
  }
  const inventoryResults = await mapWithConcurrency(
    remoteVerified,
    MAX_LIVE_GIT_CONCURRENCY,
    ({ project }) => settleInspection(async () => validateConventionInventory(
      await dependencies.inspectConventionInventory(project)
    ))
  );
  if (inventoryResults.some(({ error }) => isDiscoveryBoundError(error))) {
    return { error: "discovery_bound_exceeded", routable: [] };
  }
  const routable = [];
  for (const [index, { project, liveRemote }] of remoteVerified.entries()) {
    const result = inventoryResults[index];
    if (!result.ok) {
      unroutable.push({ project, reason: "project_conventions_unverified" });
      continue;
    }
    routable.push({ project, liveRemote, conventions: result.value });
  }
  return { error: null, routable, unroutable };
}

function resolveStableHandleProject({
  intent,
  supportedConventionKinds,
  selected,
  handleField,
  routable
}) {
  const winner = rankedProjectMatches(intent, routable)
    .find((entry) => entry.dir === selected.project.slug);
  const match = winner
    ? matchReason(selected.project, winner)
    : stableHandleMatchReason(handleField);
  const supported = supportedConventions(selected.conventions, supportedConventionKinds);
  if (selected.conventions.length > 0 && supported.length === 0) {
    return unsupported(selected.project, selected.conventions, match);
  }
  return candidate(selected, match, { intent, supportedConventionKinds });
}

function resolveImplicitProject({
  intent,
  supportedConventionKinds,
  routable,
  minimumConfidence = 0.67
}) {
  const ranked = rankedProjectMatches(intent, routable);
  const winner = ranked[0];
  if (winner && winner.confidence >= minimumConfidence) {
    const selected = routable.find(({ project }) => project.slug === winner.dir);
    if (!hasConcreteAction(intent, selected.project)) {
      return noMatch("concrete_action_required");
    }
    const match = matchReason(selected.project, winner);
    const supported = supportedConventions(selected.conventions, supportedConventionKinds);
    if (selected.conventions.length > 0 && supported.length === 0) {
      return unsupported(selected.project, selected.conventions, match);
    }
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
  return noMatch();
}

function rankedProjectMatches(intent, routable) {
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
  return ranked;
}

function noMatch(reason = "no_registered_project_match") {
  return {
    status: "no_match",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason
  };
}

function projectInspectionRefusalReason(project) {
  if (project?.status !== "active") return "project_inactive";
  if (["unavailable", "unmapped"].includes(project.mappingStatus)) {
    return "project_path_unavailable";
  }
  if (project.mappingStatus !== "verified") return "project_mapping_unverified";
  if (project.pathAvailable !== true) return "project_path_unavailable";
  if (project.placement !== "external" && project.placement !== "managed") {
    return "project_placement_unsafe";
  }
  if (project.repository !== null && typeof project.repository !== "string") {
    return "project_identity_unverified";
  }
  return null;
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
  if (matches.length !== 1) {
    return refused(approvalBinding === null
      ? "project_identity_unverified"
      : "approval_binding_mismatch");
  }
  const selected = matches[0];
  const eligibilityRefusal = projectInspectionRefusalReason(selected);
  if (eligibilityRefusal) return refused(eligibilityRefusal);
  const observation = await observeRoutableProjects([selected], dependencies);
  if (observation.error) return refused(observation.error);
  if (observation.routable.length !== 1) {
    return refused(observation.unroutable[0]?.reason || "project_identity_unverified");
  }
  const observed = observation.routable[0];
  const explicitProposal = proposeExplicitProject({
    intent,
    supportedConventionKinds,
    observed
  });
  if (approvalBinding === null) return explicitProposal;
  const stableHandle = matchedStableProjectHandles(intent, [selected])[0] || null;
  const stableHandleProposal = stableHandle
    ? resolveStableHandleProject({
        intent,
        supportedConventionKinds,
        selected: observed,
        handleField: stableHandle.field,
        routable: [observed]
      })
    : null;
  const implicitProposal = resolveImplicitProject({
    intent,
    supportedConventionKinds,
    routable: [observed],
    minimumConfidence: 0
  });
  const proposal = [explicitProposal, stableHandleProposal, implicitProposal].find((entry) => (
    entry?.status === "candidate"
    && entry.project.id === selected.id
    && entry.approval_binding === approvalBinding
  ));
  if (
    !proposal
  ) {
    return refused("approval_binding_mismatch");
  }
  const finalSupported = supportedConventions(
    observed.conventions,
    supportedConventionKinds
  );
  let finalRootIdentity;
  try {
    finalRootIdentity = await dependencies.revalidateProjectRoot(selected);
  } catch {
    return refused("project_identity_unverified");
  }
  if (
    !validProjectRootIdentity(finalRootIdentity)
    || !sameRootIdentity(selected.rootIdentity, finalRootIdentity)
  ) {
    return refused("project_identity_unverified");
  }
  return ready(
    selected,
    observed.conventions,
    finalSupported,
    projectSelector === selected.id ? "stable_id" : "slug",
    finalRootIdentity
  );
}

function proposeExplicitProject({
  intent,
  supportedConventionKinds,
  observed
}) {
  if (!hasConcreteAction(intent, observed.project, { requireHandle: false })) return noMatch();
  const match = {
    kind: "exact_handle",
    confidence: 1,
    fields: ["stable_id"]
  };
  const supported = supportedConventions(observed.conventions, supportedConventionKinds);
  if (observed.conventions.length > 0 && supported.length === 0) {
    return unsupported(observed.project, observed.conventions, match);
  }
  return candidate(observed, match, {
    intent,
    supportedConventionKinds,
    reason: "explicit_registered_project_candidate"
  });
}

function projectEligibleForInspection(project) {
  return projectInspectionRefusalReason(project) === null;
}

function candidate({ project, liveRemote, conventions }, match, {
  intent,
  supportedConventionKinds,
  reason = "unique_registered_project_match"
}) {
  return {
    status: "candidate",
    project: publicProject(project),
    match,
    routability: publicRoutability(conventions),
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

function ready(project, conventions, supported, handleField, rootIdentity) {
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
      root_identity: {
        type: "directory",
        dev: rootIdentity.dev,
        ino: rootIdentity.ino
      },
      advisory: true,
      revalidated_at_exact_resolution: true,
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

function unsupported(project, conventions, match) {
  return {
    status: "unsupported_by_host",
    project: publicProject(project),
    match,
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
    inspectConventionInventory: (project) => inspectConventionInventory(project, { filesystem }),
    revalidateProjectRoot: (project) => revalidateProjectRouteRoot({
      location: project.projectPath,
      root_identity: project.rootIdentity
    }, filesystem)
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

function validProjectRootIdentity(value) {
  return value?.type === "directory"
    && boundedDecimal(value.dev, 40)
    && boundedDecimal(value.ino, 40);
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
  const remote = await inspectAuthoritativeProjectRemote(project.projectPath, {
    execFileAsync: runGit
  });
  const after = await observeProjectRoot(project, filesystem);
  if (!sameRootIdentity(before, after)) throw new Error("The registered project root changed.");
  return remote;
}

async function inspectConventionInventory(project, { filesystem }) {
  const before = await observeProjectRoot(project, filesystem);
  const observations = [];
  const agentsConvention = await observeConventionFile(
    project.projectPath,
    "AGENTS.md",
    "agents-md",
    filesystem
  );
  const claudeConvention = await observeConventionFile(
    project.projectPath,
    "CLAUDE.md",
    "claude-md",
    filesystem
  );
  if (agentsConvention) observations.push(agentsConvention);
  if (claudeConvention) observations.push(claudeConvention);

  const skillsPath = path.join(project.projectPath, ".agents", "skills");
  const skillEntries = await readContainedDirectory(project.projectPath, skillsPath, {
    filesystem,
    maxEntries: MAX_SKILL_CONVENTION_OBSERVATIONS,
    readdirOptions: { withFileTypes: true },
    tooManyCode: "DOTAIOS_PROJECT_ROUTE_CONVENTION_BOUND_EXCEEDED"
  });
  const eligibleSkills = (skillEntries || [])
    .filter((entry) => (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && SAFE_LOCAL_NAME_RE.test(entry.name)
    ))
    .sort((left, right) => left.name.localeCompare(right.name));
  const skillConventions = await mapWithConcurrency(
    eligibleSkills,
    MAX_SKILL_CONVENTION_CONCURRENCY,
    (entry) => observeConventionFile(
      project.projectPath,
      `.agents/skills/${entry.name}/SKILL.md`,
      "repository-skill",
      filesystem
    )
  );
  observations.push(...skillConventions.filter(Boolean));
  const after = await observeProjectRoot(project, filesystem);
  if (!sameRootIdentity(before, after)) throw new Error("The registered project root changed.");
  return observations.sort(compareConventions);
}

async function observeConventionFile(root, resource, kind, filesystem) {
  const filePath = path.join(root, ...resource.split("/"));
  const snapshot = await inspectContainedPathEntry(root, filePath, { filesystem });
  if (snapshot?.type !== "regular-file" || Number(snapshot.stats.nlink) !== 1) return null;
  return {
    kind,
    resource,
    observed_identity: conventionIdentity(snapshot.stats)
  };
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
  if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) {
    throw new Error("The registered project canonical root is unavailable.");
  }
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

/** Revalidate the emitted native route against the same bounded directory identity contract. */
export async function revalidateProjectRouteRoot(route, filesystem = fs) {
  const location = route?.location;
  const rootIdentity = route?.root_identity;
  if (
    typeof location !== "string"
    || !path.isAbsolute(location)
    || !validProjectRootIdentity(rootIdentity)
  ) throw new Error("The project route root identity is invalid.");
  const observed = await observeProjectRoot({ projectPath: location, rootIdentity }, filesystem);
  const finalStats = await filesystem.lstat(location, { bigint: true });
  if (
    !finalStats.isDirectory()
    || finalStats.isSymbolicLink()
    || finalStats.dev.toString() !== observed.dev
    || finalStats.ino.toString() !== observed.ino
  ) throw new Error("The project route root changed during revalidation.");
  const finalCanonical = await filesystem.realpath(location);
  const finalCanonicalStats = await filesystem.lstat(finalCanonical, { bigint: true });
  if (
    !finalCanonicalStats.isDirectory()
    || finalCanonicalStats.isSymbolicLink()
    || finalCanonicalStats.dev.toString() !== observed.dev
    || finalCanonicalStats.ino.toString() !== observed.ino
  ) throw new Error("The project route canonical root changed during revalidation.");
  const finalPathStats = await filesystem.lstat(location, { bigint: true });
  if (
    !finalPathStats.isDirectory()
    || finalPathStats.isSymbolicLink()
    || finalPathStats.dev.toString() !== observed.dev
    || finalPathStats.ino.toString() !== observed.ino
  ) throw new Error("The project route path changed during revalidation.");
  return observed;
}

function sameRootIdentity(left, right) {
  return left?.type === "directory"
    && right?.type === "directory"
    && left.dev === right.dev
    && left.ino === right.ino;
}
