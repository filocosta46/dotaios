import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isPathWithin } from "./paths.mjs";
import {
  listProjects,
  readProjectCatalog,
  resolveProjectRecord,
  validateProjectSelector
} from "./projects.mjs";
import { collectSkills } from "./skills.mjs";
import { rankSkillMatches } from "./skill-resolver.mjs";
import { renderWorkingContext, selectWorkingContext } from "./working-context.mjs";
import {
  inspectConfiguredConnections,
  resolveConnectionTool
} from "./connection-tool-resolver.mjs";
import { resolveProjectRoute } from "./project-native-routing.mjs";
import { resolveMemoryPolicy } from "./memory-policy.mjs";

export const DEFAULT_INTENT_RESOLUTION_BUDGET = 8000;
export const MIN_INTENT_RESOLUTION_BUDGET = 1024;
export const MAX_INTENT_RESOLUTION_BUDGET = 32000;
const SCHEMA = "dotaios.intent-resolution/v1";

/** Compose existing project, context, skill, and connection authorities locally. */
export async function resolveIntentResolution(options = {}, dependencies = {}) {
  const visibleCharacterBudget = normalizeBudget(options.visibleCharacterBudget ?? options.budget);
  const intent = normalizeIntent(options.intent);
  const memoryPolicy = options.memoryPolicy || resolveMemoryPolicy({
    mode: options.memory || "project",
    project: options.projectSelector ?? options.project,
    allowDeferredProject: true
  });
  if (memoryPolicy.mode === "off") {
    return budgetedMemoryOff({
      limit: visibleCharacterBudget,
      memoryPolicy,
      includeTool: options.tool !== undefined && options.tool !== null
    });
  }
  const filesystem = options.fs || dependencies.filesystem || dependencies.fs || fs;
  const homePath = path.resolve(options.homePath || os.homedir());
  const aiosPath = path.resolve(options.aiosPath || path.join(homePath, "aios"));
  const projectOptions = {
    aiosPath,
    homePath,
    statePath: options.statePath,
    fs: filesystem
  };
  const toolRequested = options.tool !== undefined && options.tool !== null;
  const cwd = options.cwd || process.cwd();
  const routeResolver = dependencies.resolveProjectRoute || resolveProjectRoute;
  const routeRequest = {
    aiosPath,
    homePath,
    statePath: options.statePath,
    filesystem,
    intent,
    supportedConventionKinds: options.supportedConventionKinds || [],
    approvalBinding: options.approvalBinding ?? null
  };
  let projectRoute = null;
  if (!toolRequested) {
    projectRoute = await safelyResolveProjectRoute(routeResolver, {
      ...routeRequest,
      projectSelector: options.projectSelector ?? options.project ?? null
    });
  }
  if (!toolRequested && projectRoute.status !== "ready") {
    return budgetedProjectRoute({ limit: visibleCharacterBudget, intent, projectRoute, memoryPolicy });
  }
  const refuse = (reason, recovery, refusedRoute = projectRoute) => budgetedRefusal({
    limit: visibleCharacterBudget,
    reason,
    recovery,
    projectRoute: refusedRoute,
    includeTool: toolRequested,
    includeProjectRoute: !toolRequested,
    memoryPolicy
  });
  let authority;
  try {
    authority = toolRequested
      ? await prepareToolAuthority({
          aiosPath,
          filesystem,
          projectOptions,
          projectSelector: options.projectSelector ?? options.project,
          cwd
        })
      : await prepareNativeAuthority({
          aiosPath,
          projectRoute
        });
  } catch (error) {
    return refuse(error?.reason || "local_authority_unreadable", error?.recovery || "Run dotaios doctor, then retry.");
  }

  const { selected, portable, skills, configured } = authority;
  const rankedSkills = rankSkillMatches(intent, skills, { skillsDir: "skills" });
  const matchedSkill = rankedSkills[0] || null;
  const skill = matchedSkill?.ambiguous
    ? {
        status: "ambiguous",
        name: null,
        resource: null,
        confidence: matchedSkill.confidence,
        reason: "low_separation",
        candidates: rankedSkills.slice(0, 2)
          .map((candidate) => ({
            name: candidate.name,
            resource: path.posix.join("skills", candidate.dir, "SKILL.md"),
            score: candidate.score
          }))
      }
    : matchedSkill
      ? {
        status: "matched",
        name: matchedSkill.name,
        resource: path.posix.join("skills", matchedSkill.dir, "SKILL.md"),
        confidence: matchedSkill.confidence,
        reason: matchedSkill.reason
      }
    : { status: "no_match", name: null, resource: null, confidence: 0, reason: "no_governing_skill" };

  const tool = toolRequested
    ? resolveConnectionTool({
        configuredConnections: configured.labels,
        configurationIssues: configured.issues,
        request: options.tool
      })
    : null;

  const project = {
    id: selected.id,
    slug: selected.slug,
    name: portable.name,
    purpose: portable.description || null,
    identity: "verified"
  };
  const status = skill.status === "matched" && (
    !tool || tool.status === "matched" || tool.reason === "not_requested"
  )
    ? "matched"
    : "partial";
  const omissions = [];
  if (skill.status === "no_match") omissions.push("governing_skill_no_match");
  if (skill.status === "ambiguous") omissions.push("governing_skill_ambiguous");
  if (tool?.status === "no_match" && tool.reason !== "not_requested") omissions.push("configured_tool_no_match");
  if (tool?.status === "refused") omissions.push("configured_tool_refused");
  omissions.push("supplemental_project_sources_not_requested");
  if (!toolRequested) omissions.push("project_native_execution_not_started");

  const fixed = {
    schema: SCHEMA,
    status,
    project,
    ...(!toolRequested ? { project_route: projectRoute } : {}),
    memory: {
      receipt: memoryPolicy.receipt,
      scope: memoryPolicy.mode === "project" ? selected.slug : null,
      generated_at: null,
      context: "",
      truncated: false
    },
    skill,
    ...(toolRequested ? { tool } : {}),
    omissions,
    recovery: { required: false, action: null },
    next_action: nextAction(skill, tool),
    budget: { limit: visibleCharacterBudget, used: 0, truncated: false },
    location: selected.projectPath
  };
  if (renderWithStableUsed(fixed).length > visibleCharacterBudget) {
    return refuse("fixed_envelope_exceeds_budget", "Retry with a larger --budget value.");
  }

  let contextBudget = Math.max(0, visibleCharacterBudget - renderWithStableUsed(fixed).length);
  let envelope = fixed;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let context;
    try {
      context = await selectWorkingContext(aiosPath, {
        memory: memoryPolicy.mode,
        ...(memoryPolicy.mode === "project" ? { project: selected.slug } : {}),
        visibleCharacterBudget: contextBudget
      }, {
        filesystem,
        clock: dependencies.clock
      });
    } catch {
      return refuse("project_context_unreadable", "Run dotaios doctor, then retry.");
    }
    envelope = {
      ...fixed,
      memory: {
        ...fixed.memory,
        generated_at: context.generatedAt,
        context: renderWorkingContext(context),
        truncated: context.budget.truncated
      },
      omissions: context.budget.truncated
        ? [...fixed.omissions, "project_context_truncated"]
        : fixed.omissions,
      budget: {
        ...fixed.budget,
        truncated: context.budget.truncated
      }
    };
    const rendered = renderWithStableUsed(envelope);
    if (rendered.length <= visibleCharacterBudget) break;
    contextBudget = Math.max(0, contextBudget - (rendered.length - visibleCharacterBudget) - 8);
  }
  if (renderWithStableUsed(envelope).length > visibleCharacterBudget) {
    return refuse("fixed_envelope_exceeds_budget", "Retry with a larger --budget value.");
  }

  // Explicit tools retain main's final primary-directory check. An exact
  // native route is already the router's one fresh, bound observation; do not
  // run that router again after it succeeds.
  try {
    if (toolRequested) await authority.revalidate();
  } catch {
    return refuse(
      "project_identity_unverified",
      `To re-register it, preview dotaios project add <repo-path> --slug ${selected.slug}, then apply it with the displayed operation id and plan fingerprint.`,
      {
        ...projectRoute,
        status: "refused",
        route: null,
        reason: "project_identity_unverified"
      }
    );
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
}

async function prepareToolAuthority({
  aiosPath,
  filesystem,
  projectOptions,
  projectSelector,
  cwd
}) {
  let selected;
  try {
    selected = await selectVerifiedProject({ ...projectOptions, projectSelector, cwd });
  } catch (error) {
    throw resolutionAuthorityError(selectionReason(error), selectionRecovery(error));
  }
  let catalog;
  let skills;
  let configured;
  try {
    [catalog, skills, configured] = await Promise.all([
      readProjectCatalog({ aiosPath, fs: filesystem }),
      collectSkills(aiosPath),
      inspectConfiguredConnections({ aiosPath, filesystem })
    ]);
  } catch {
    throw resolutionAuthorityError("local_authority_unreadable", "Run dotaios doctor, then retry.");
  }
  const matches = catalog.filter((project) => (
    project.id === selected.id && project.slug === selected.slug
  ));
  if (matches.length !== 1) {
    throw resolutionAuthorityError("project_catalog_changed", "Run dotaios project doctor, then retry.");
  }
  return {
    selected,
    portable: matches[0],
    skills,
    configured,
    revalidate: () => revalidateSelectedProject(projectOptions, selected)
  };
}

async function prepareNativeAuthority({ aiosPath, projectRoute }) {
  let skills;
  try {
    skills = await collectSkills(aiosPath);
  } catch {
    throw resolutionAuthorityError("local_authority_unreadable", "Run dotaios doctor, then retry.");
  }
  const selected = {
    id: projectRoute.project.id,
    slug: projectRoute.project.slug,
    projectPath: projectRoute.route.location,
    mappingStatus: "verified",
    pathAvailable: true,
    placement: projectRoute.project.placement
  };
  return {
    selected,
    portable: {
      id: projectRoute.project.id,
      slug: projectRoute.project.slug,
      name: projectRoute.project.name,
      description: projectRoute.project.purpose
    },
    skills,
    configured: null
  };
}

async function safelyResolveProjectRoute(routeResolver, request) {
  try {
    return await routeResolver(request);
  } catch {
    return {
      status: "refused",
      project: null,
      match: null,
      routability: null,
      route: null,
      reason: "project_identity_unverified"
    };
  }
}

async function revalidateSelectedProject(projectOptions, selected) {
  const verified = await resolveProjectRecord({ ...projectOptions, project: selected.id });
  if (
    verified.id !== selected.id
    || verified.slug !== selected.slug
    || verified.projectPath !== selected.projectPath
    || !projectLocationSafe(verified)
  ) throw new Error("project mapping changed");
  return null;
}

function resolutionAuthorityError(reason, recovery) {
  const error = new Error(reason);
  error.reason = reason;
  error.recovery = recovery;
  return error;
}

/** Canonical, human-readable JSON used by the CLI and budget accounting. */
export function renderIntentResolution(value) {
  const readable = JSON.stringify(value, null, 2);
  if (
    Object.hasOwn(value || {}, "project_route")
    && value?.status === "refused"
    && value.next_action?.summary === "fixed_envelope_exceeds_budget"
    && Number.isInteger(value.budget?.limit)
    && readable.length > value.budget.limit
  ) {
    return JSON.stringify(value);
  }
  return readable;
}

async function selectVerifiedProject(options) {
  const projects = await listProjects(options);
  const rawSelector = options.projectSelector;
  let matches;
  if (rawSelector !== undefined && rawSelector !== null) {
    const selector = validateProjectSelector(rawSelector);
    matches = projects.filter((project) => (
      project.id === selector || project.slug === selector || project.project === selector
    ));
    if (matches.length === 0) throw selectionError("unknown_project");
    if (matches.length > 1) throw selectionError("ambiguous_project");
  } else {
    const cwd = path.resolve(options.cwd);
    matches = (await Promise.all(projects.map(async (project) => {
      if (!projectLocationSafe(project)) return null;
      return await isPathWithin(project.projectPath, cwd, { fileSystem: options.fs }) ? project : null;
    }))).filter(Boolean);
    if (matches.length === 0) throw selectionError("detached_directory");
    if (matches.length > 1) throw selectionError("ambiguous_directory");
  }
  const selected = matches[0];
  if (!projectLocationSafe(selected)) {
    throw selectionError("project_identity_unverified", selected.slug);
  }
  return selected;
}

function projectLocationSafe(project) {
  return project.mappingStatus === "verified"
    && Boolean(project.projectPath)
    && project.pathAvailable === true
    && (project.placement === "external" || project.placement === "managed");
}

function nextAction(skill, tool) {
  if (skill.status === "ambiguous") {
    return {
      state: "clarification_required",
      approval: "not_applicable",
      summary: "More than one governing skill matched; narrow the intent before choosing an action."
    };
  }
  if (!tool) {
    return nativeRouteNextAction();
  }
  if (tool.status === "refused") {
    return {
      state: "clarification_required",
      approval: "not_applicable",
      summary: "The optional tool request was refused; revise it before any action."
    };
  }
  if (skill.status === "no_match" && tool.status !== "matched") {
    return {
      state: "clarification_required",
      approval: "not_applicable",
      summary: "Clarify the intent before choosing an action."
    };
  }
  return {
    state: "approval_required",
    approval: "direct_user_required",
    summary: "Review this recommendation and ask the user to approve before acting."
  };
}

function budgetedMemoryOff({ limit, memoryPolicy, includeTool }) {
  const envelope = {
    schema: SCHEMA,
    status: "partial",
    project: null,
    memory: {
      receipt: memoryPolicy.receipt,
      notice: memoryPolicy.notice,
      scope: null,
      generated_at: null,
      context: "",
      truncated: false
    },
    skill: {
      status: "not_evaluated",
      name: null,
      resource: null,
      confidence: 0,
      reason: "memory_off"
    },
    ...(includeTool ? {
      tool: {
        status: "not_evaluated",
        capability: null,
        connection: null,
        configured: false,
        authenticated: "unknown"
      }
    } : {}),
    omissions: ["project_route", "project_context", "governing_skill", "configured_tool", "primary_location"],
    recovery: { required: false, action: null },
    next_action: {
      state: "memory_off",
      approval: "not_applicable",
      summary: "DotAIOS memory is off; no route or context was evaluated."
    },
    budget: { limit, used: 0, truncated: false },
    location: null
  };
  stabilizeBudgetUsed(envelope);
  if (renderIntentResolution(envelope).length > limit) {
    throw new TypeError("budget is too small for the Memory Off resolution envelope");
  }
  return envelope;
}

function budgetedRefusal({
  limit,
  reason,
  recovery,
  projectRoute = null,
  includeTool = true,
  includeProjectRoute = true,
  memoryPolicy
}) {
  const safeProjectRoute = refusedProjectRoute(projectRoute, reason);
  const envelope = {
    schema: SCHEMA,
    status: "refused",
    project: null,
    ...(includeProjectRoute ? { project_route: safeProjectRoute } : {}),
    memory: { receipt: memoryPolicy.receipt, scope: null, generated_at: null, context: "", truncated: false },
    skill: { status: "not_evaluated", name: null, resource: null, confidence: 0, reason: "project_not_verified" },
    ...(includeTool ? {
      tool: { status: "not_evaluated", capability: null, connection: null, configured: false, authenticated: "unknown" }
    } : {}),
    omissions: ["project_context", "governing_skill", "configured_tool", "primary_location"],
    recovery: { required: true, action: recovery },
    next_action: { state: "recovery_required", approval: "not_applicable", summary: reason },
    budget: { limit, used: 0, truncated: false },
    location: null
  };
  if (renderWithStableUsed(envelope).length > limit) {
    if (includeProjectRoute) {
      compactRefusalEnvelope(envelope);
    } else {
      envelope.recovery.action = null;
      envelope.next_action.summary = "fixed_envelope_exceeds_budget";
      envelope.omissions = ["all_variable_content"];
    }
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
}

function refusedProjectRoute(projectRoute, reason) {
  if (projectRoute?.status !== "ready" && !projectRoute?.route?.location) {
    return projectRoute;
  }
  return {
    ...projectRoute,
    status: "refused",
    route: null,
    reason
  };
}

function compactProjectRoute(projectRoute) {
  if (
    projectRoute?.project === null
    && projectRoute.match === null
    && projectRoute.routability === null
    && projectRoute.route === null
  ) {
    return projectRoute;
  }
  return {
    status: projectRoute?.status || "refused",
    reason: projectRoute?.reason || "project_route_unavailable",
    project: null,
    match: null,
    routability: null,
    route: null
  };
}

function compactRefusalEnvelope(envelope) {
  envelope.status = "refused";
  envelope.project = null;
  envelope.project_route = compactProjectRoute(envelope.project_route);
  envelope.omissions = ["all_variable_content"];
  envelope.recovery = { required: true, action: null };
  envelope.next_action = {
    state: "recovery_required",
    approval: "not_applicable",
    summary: "fixed_envelope_exceeds_budget"
  };
  envelope.location = null;
}

function budgetedProjectRoute({ limit, intent, projectRoute, memoryPolicy }) {
  const failed = projectRoute.status === "refused" || projectRoute.status === "unsupported_by_host";
  const envelope = {
    schema: SCHEMA,
    status: failed ? "refused" : "partial",
    project: null,
    project_route: projectRoute,
    memory: { receipt: memoryPolicy.receipt, scope: null, generated_at: null, context: "", truncated: false },
    skill: {
      status: "not_evaluated",
      name: null,
      resource: null,
      confidence: 0,
      reason: "project_route_not_ready"
    },
    omissions: ["project_context", "governing_skill", "configured_tool", "primary_location"],
    recovery: projectRouteRecovery(projectRoute),
    next_action: projectRouteNextAction(intent, projectRoute),
    budget: { limit, used: 0, truncated: false },
    location: null
  };
  if (renderWithStableUsed(envelope).length > limit) {
    compactRefusalEnvelope(envelope);
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
}

function projectRouteRecovery(projectRoute) {
  if (projectRoute.status === "unsupported_by_host") {
    const handle = projectRoute.project?.id || projectRoute.project?.slug || "<slug-or-id>";
    return {
      required: true,
      action: `Open this registered project manually in a fresh context with a host that supports an observed convention; run dotaios project resolve ${handle} to verify its folder.`
    };
  }
  if (projectRoute.status === "no_match") {
    return {
      required: true,
      action: "Keep the repository where it is and connect it once: preview dotaios project add <folder> --purpose <purpose>, then apply the displayed operation id and plan fingerprint. After connection, rerun implicit discovery with the same concrete action."
    };
  }
  if (projectRoute.status === "refused") {
    if (
      projectRoute.reason === "approval_binding_required"
      || projectRoute.reason === "approval_binding_mismatch"
    ) {
      return {
        required: true,
        action: "Rerun path-free implicit discovery for the unchanged concrete action, obtain a fresh candidate binding, and ask for fresh approval before exact resolution."
      };
    }
    return {
      required: true,
      action: "Run dotaios project doctor and repair or reconnect the registration, then rerun implicit discovery for the concrete action."
    };
  }
  return { required: false, action: null };
}

function projectRouteNextAction(intent, projectRoute) {
  if (projectRoute.status === "candidate") {
    return {
      state: "approval_required",
      approval: "direct_user_required",
      summary: `Explain that ${projectRoute.project.slug} matched only from the customer's registration metadata, not an AIOS endorsement. Ask for direct approval of one action: “${intent}” After approval, immediately request exact resolution for ${projectRoute.project.id} and start a fresh context rooted at the project location revalidated by that exact resolution; changing directory in this run is insufficient.`
    };
  }
  if (projectRoute.status === "ambiguous") {
    return {
      state: "clarification_required",
      approval: "not_applicable",
      summary: "Ask the customer to narrow the concrete action, then rerun implicit discovery; do not make an exact request without a fresh candidate binding."
    };
  }
  if (projectRoute.status === "unsupported_by_host") {
    return {
      state: "manual_open_required",
      approval: "not_applicable",
      summary: "This host declared no native support for the observed conventions; use the manual-open recovery and a fresh rooted context."
    };
  }
  if (projectRoute.status === "no_match") {
    return {
      state: "clarification_required",
      approval: "not_applicable",
      summary: "Connect the existing folder once with its purpose, or make the action more concrete, then rerun implicit discovery."
    };
  }
  if (
    projectRoute.reason === "approval_binding_required"
    || projectRoute.reason === "approval_binding_mismatch"
  ) {
    return {
      state: "approval_restart_required",
      approval: "not_applicable",
      summary: "Rerun implicit discovery for a fresh candidate binding, explain the unchanged proposal, and obtain fresh approval before exact resolution."
    };
  }
  return {
    state: "recovery_required",
    approval: "not_applicable",
    summary: projectRoute.reason
  };
}

function nativeRouteNextAction() {
  return {
    state: "fresh_context_required",
    approval: "not_applicable",
    summary: "Start a fresh context rooted at the project location revalidated by exact resolution for the approved action; changing directory in this run is insufficient."
  };
}

function normalizeBudget(value) {
  const budget = value === undefined ? DEFAULT_INTENT_RESOLUTION_BUDGET : Number(value);
  if (!Number.isInteger(budget) || budget < MIN_INTENT_RESOLUTION_BUDGET || budget > MAX_INTENT_RESOLUTION_BUDGET) {
    throw new TypeError(`budget must be an integer from ${MIN_INTENT_RESOLUTION_BUDGET} to ${MAX_INTENT_RESOLUTION_BUDGET}`);
  }
  return budget;
}

function normalizeIntent(value) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || Array.from(value).length > 1000
    || /\p{Cc}/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new TypeError("intent must contain 1-1000 safe Unicode code points");
  }
  return value;
}

function renderWithStableUsed(envelope) {
  stabilizeBudgetUsed(envelope);
  return renderIntentResolution(envelope);
}

function stabilizeBudgetUsed(envelope) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const used = renderIntentResolution(envelope).length;
    if (envelope.budget.used === used) return;
    envelope.budget.used = used;
  }
}

function selectionError(reason, slug = null) {
  const error = new Error(reason);
  error.reason = reason;
  error.slug = slug;
  return error;
}

function selectionReason(error) {
  if (error?.code === "DOTAIOS_PROJECT_SELECTOR_INVALID") return "invalid_project_selector";
  return error?.reason || "project_selection_refused";
}

function selectionRecovery(error) {
  if (error?.reason === "project_identity_unverified" && error.slug) {
    return `To re-register it, preview dotaios project add <repo-path> --slug ${error.slug}, then apply it with the displayed operation id and plan fingerprint.`;
  }
  if (error?.reason === "detached_directory") {
    return "Run this command inside one registered primary folder or pass --project <slug-or-id>.";
  }
  return "Run dotaios project list and retry with one exact slug or stable id.";
}
