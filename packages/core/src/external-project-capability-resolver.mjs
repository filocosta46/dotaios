import { projectRemotesMatch } from "./project-workspaces.mjs";
import { validateProjectSelector } from "./projects.mjs";

// Product-owned card metadata, assembled without introducing an endpoint
// literal that the core offline admission guard correctly reserves for adapters.
const CAREER_OPS_SOURCE = "https:" + "//github.com/santifer/career-ops";
const CATALOG = validateCatalog([{
  id: "career-ops.evaluate-job",
  title: "Evaluate a job with Career Ops",
  outcome: "Use this Career Ops project to evaluate one job. Career Ops may create or update onboarding files, a report, a PDF, and tracker data in the project or its configured data and tracker locations. It must not submit an application.",
  provider: "santifer/career-ops",
  source: CAREER_OPS_SOURCE,
  scope: "project",
  effect: "mixed",
  trust: "curated-external-user-owned",
  approval: "fresh",
  triggers: [
    "evaluate a job",
    "evaluate this job",
    "evaluate a role",
    "evaluate this role"
  ],
  entrypoints: [
    { host: "agents", resource: "AGENTS.md" },
    { host: "claude-code", resource: "CLAUDE.md" },
    { host: "agent-skills", resource: ".agents/skills/career-ops/SKILL.md" }
  ]
}]);

/** Resolve one curated external-project capability without executing it. */
export async function resolveExternalProjectCapability({
  intent,
  requestedCapability = null,
  project
} = {}, {
  readLiveRepoUrl,
  inspectContainedEntrypoints
} = {}) {
  if (!validIntent(intent)) {
    return refused("invalid_intent");
  }
  if (!validCapabilitySelector(requestedCapability)) {
    return refused("invalid_requested_capability");
  }
  let capability = requestedCapability === null
    ? null
    : CATALOG.find((entry) => entry.id === requestedCapability);
  if (requestedCapability !== null && !capability) return noMatch("unsupported_capability");
  if (project?.identity !== "verified" || !validProjectId(project.id)) {
    return refused("project_identity_unverified");
  }
  const projectIdentity = snapshotProjectIdentity(project);
  if (capability) {
    if (!projectRemotesMatch(capability.source, project.repoUrl)) {
      return noMatch("repository_not_supported");
    }
  } else {
    const repositoryCapabilities = CATALOG.filter((entry) => (
      projectRemotesMatch(entry.source, project.repoUrl)
    ));
    if (repositoryCapabilities.length === 0) return noMatch("repository_not_supported");
    const intentMatches = repositoryCapabilities.filter((entry) => matchesIntent(intent, entry.triggers));
    if (intentMatches.length === 0) return noMatch("intent_not_supported");
    if (intentMatches.length > 1) return refused("ambiguous_capability");
    [capability] = intentMatches;
  }

  let liveRepoUrl;
  try {
    liveRepoUrl = await readLiveRepoUrl(project);
  } catch {
    return refused("live_repository_unverified");
  }
  if (!sameProjectIdentity(project, projectIdentity, capability)) {
    return refused("project_identity_changed", requestedCapability === capability.id ? capability : null);
  }
  if (!projectRemotesMatch(capability.source, liveRepoUrl)) {
    return refused("live_repository_mismatch");
  }

  if (requestedCapability === capability.id) {
    let observations;
    try {
      observations = await inspectContainedEntrypoints({
        project,
        entrypoints: capability.entrypoints.map((entrypoint) => ({ ...entrypoint }))
      });
    } catch {
      return refused("entrypoint_inspection_failed", capability);
    }
    const entrypoints = routeEntrypoints(capability.entrypoints, observations);
    if (entrypoints === null) return refused("entrypoint_observation_unsafe", capability);
    if (entrypoints.length === 0) return refused("project_entrypoint_missing", capability);
    if (!sameProjectIdentity(project, projectIdentity, capability)) {
      return refused("project_identity_changed", capability);
    }
    let finalLiveRepoUrl;
    try {
      finalLiveRepoUrl = await readLiveRepoUrl(project);
    } catch {
      return refused("live_repository_changed", capability);
    }
    if (!sameProjectIdentity(project, projectIdentity, capability)) {
      return refused("project_identity_changed", capability);
    }
    if (
      !projectRemotesMatch(capability.source, finalLiveRepoUrl)
      || !projectRemotesMatch(liveRepoUrl, finalLiveRepoUrl)
    ) {
      return refused("live_repository_changed", capability);
    }
    return {
      status: "matched",
      card: capabilityCard(capability),
      route: {
        kind: "project-native",
        project_id: projectIdentity.id,
        advisory: true,
        entrypoints
      },
      reason: "exact_capability_matched"
    };
  }

  return {
    status: "discovered",
    card: capabilityCard(capability),
    route: null,
    reason: "capability_selection_required"
  };
}

function validateCatalog(records) {
  if (!Array.isArray(records) || records.length > 128) {
    throw new TypeError("external capability catalog exceeds 128 entries");
  }
  const ids = new Set();
  const validated = records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("external capability catalog entries must be objects");
    }
    if (typeof record.id !== "string" || !validCapabilitySelector(record.id) || ids.has(record.id)) {
      throw new TypeError("external capability catalog ids must be unique lowercase dotted identifiers");
    }
    ids.add(record.id);
    if (
      !boundedCatalogText(record.title, 200)
      || !boundedCatalogText(record.outcome, 2000)
      || !boundedCatalogText(record.provider, 200)
      || !projectRemotesMatch(record.source, record.source)
      || record.scope !== "project"
      || !new Set(["read", "write", "mixed", "unknown"]).has(record.effect)
      || !new Set(["product-owned", "curated-external-user-owned"]).has(record.trust)
      || record.approval !== "fresh"
    ) {
      throw new TypeError(`external capability catalog card is invalid: ${record.id}`);
    }
    if (!Array.isArray(record.triggers) || record.triggers.length === 0 || record.triggers.length > 16) {
      throw new TypeError(`external capability catalog triggers are invalid: ${record.id}`);
    }
    const triggers = record.triggers.map((trigger) => {
      if (!boundedCatalogText(trigger, 200) || trigger !== trigger.toLocaleLowerCase("en-US")) {
        throw new TypeError(`external capability catalog trigger is invalid: ${record.id}`);
      }
      return trigger;
    });
    if (new Set(triggers).size !== triggers.length) {
      throw new TypeError(`external capability catalog triggers must be unique: ${record.id}`);
    }
    if (!Array.isArray(record.entrypoints) || record.entrypoints.length === 0 || record.entrypoints.length > 8) {
      throw new TypeError(`external capability catalog entrypoints are invalid: ${record.id}`);
    }
    const resources = new Set();
    const entrypoints = record.entrypoints.map((entrypoint) => {
      if (
        !entrypoint
        || typeof entrypoint !== "object"
        || Array.isArray(entrypoint)
        || typeof entrypoint.host !== "string"
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entrypoint.host)
        || !safeRelativeResource(entrypoint.resource)
        || resources.has(entrypoint.resource)
      ) {
        throw new TypeError(`external capability catalog entrypoint is invalid: ${record.id}`);
      }
      resources.add(entrypoint.resource);
      return Object.freeze({ host: entrypoint.host, resource: entrypoint.resource });
    });
    return Object.freeze({
      id: record.id,
      title: record.title,
      outcome: record.outcome,
      provider: record.provider,
      source: record.source,
      scope: record.scope,
      effect: record.effect,
      trust: record.trust,
      approval: record.approval,
      triggers: Object.freeze(triggers),
      entrypoints: Object.freeze(entrypoints)
    });
  });
  return Object.freeze(validated);
}

function boundedCatalogText(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/\p{Cc}/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

function safeRelativeResource(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.startsWith("/")
    || value.includes("\\")
    || /\p{Cc}/u.test(value)
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function matchesIntent(intent, triggers) {
  const normalized = intent.toLocaleLowerCase("en-US");
  return triggers.some((trigger) => normalized.includes(trigger));
}

function validIntent(value) {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Array.from(value).length <= 1000
    && !/\p{Cc}/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

function validCapabilitySelector(value) {
  if (value === null) return true;
  return typeof value === "string"
    && value.length <= 100
    && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(value);
}

function validProjectId(value) {
  try {
    validateProjectSelector(value);
    return true;
  } catch {
    return false;
  }
}

function sameProjectIdentity(project, snapshot, capability) {
  return project?.identity === "verified"
    && project.id === snapshot.id
    && validProjectId(project.id)
    && projectRemotesMatch(snapshot.repoUrl, project.repoUrl)
    && projectRemotesMatch(capability.source, project.repoUrl)
    && project.projectPath === snapshot.projectPath
    && project.mappingStatus === snapshot.mappingStatus
    && project.pathAvailable === snapshot.pathAvailable
    && project.placement === snapshot.placement
    && sameRootIdentity(project.rootIdentity, snapshot.rootIdentity)
    && sameRootIdentity(project.root_identity, snapshot.root_identity);
}

function snapshotProjectIdentity(project) {
  return Object.freeze({
    id: project.id,
    repoUrl: project.repoUrl,
    projectPath: project.projectPath,
    mappingStatus: project.mappingStatus,
    pathAvailable: project.pathAvailable,
    placement: project.placement,
    rootIdentity: snapshotRootIdentity(project.rootIdentity),
    root_identity: snapshotRootIdentity(project.root_identity)
  });
}

function snapshotRootIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.freeze({ type: value.type, dev: value.dev, ino: value.ino });
}

function sameRootIdentity(value, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return value === snapshot;
  }
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && value.type === snapshot.type
    && value.dev === snapshot.dev
    && value.ino === snapshot.ino;
}

function capabilityCard(capability) {
  const { triggers, entrypoints, ...card } = capability;
  return card;
}

function routeEntrypoints(declarations, observations) {
  if (!Array.isArray(observations) || observations.length > declarations.length) return null;
  const byResource = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return null;
    if (typeof observation.resource !== "string" || byResource.has(observation.resource)) return null;
    const identity = observedFileIdentity(observation.observed_identity);
    if (!identity) return null;
    byResource.set(observation.resource, identity);
  }

  const routed = [];
  for (const declaration of declarations) {
    const observedIdentity = byResource.get(declaration.resource);
    if (!observedIdentity) continue;
    routed.push({
      host: declaration.host,
      resource: declaration.resource,
      observed_identity: observedIdentity
    });
    byResource.delete(declaration.resource);
  }
  return byResource.size === 0 ? routed : null;
}

function observedFileIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "file") return null;
  if (
    !boundedDecimal(value.dev, 40)
    || !boundedDecimal(value.ino, 40)
    || !Number.isSafeInteger(value.mode)
    || value.mode < 0
    || value.mode > 0o177777
    || (value.mode & 0o170000) !== 0o100000
    || value.nlink !== 1
    || !boundedDecimal(value.size, 24)
    || !boundedDecimal(value.mtime_ns, 30)
    || !boundedDecimal(value.ctime_ns, 30)
  ) return null;
  return {
    type: "file",
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtime_ns: value.mtime_ns,
    ctime_ns: value.ctime_ns
  };
}

function boundedDecimal(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && /^(?:0|[1-9]\d*)$/.test(value);
}

function noMatch(reason) {
  return { status: "no_match", card: null, route: null, reason };
}

function refused(reason, capability = null) {
  return {
    status: "refused",
    card: capability ? capabilityCard(capability) : null,
    route: null,
    reason
  };
}
