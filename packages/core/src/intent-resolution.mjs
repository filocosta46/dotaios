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
import { resolveIntent } from "./skill-resolver.mjs";
import { renderWorkingContext, selectWorkingContext } from "./working-context.mjs";
import {
  inspectConfiguredConnections,
  resolveConnectionTool
} from "./connection-tool-resolver.mjs";
import { resolveProjectRoute } from "./project-native-routing.mjs";

export const DEFAULT_INTENT_RESOLUTION_BUDGET = 8000;
export const MIN_INTENT_RESOLUTION_BUDGET = 1024;
export const MAX_INTENT_RESOLUTION_BUDGET = 32000;
const SCHEMA = "dotaios.intent-resolution/v1";
const MEMORY_RECEIPT = "Memory: This project";

/** Compose existing project, context, skill, and connection authorities locally. */
export async function resolveIntentResolution(options = {}, dependencies = {}) {
  const visibleCharacterBudget = normalizeBudget(options.visibleCharacterBudget ?? options.budget);
  const intent = normalizeIntent(options.intent);
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
  const routeResolver = dependencies.resolveProjectRoute || resolveProjectRoute;
  let projectRoute = notEvaluatedProjectRoute();
  let selectedProjectReference = options.projectSelector ?? options.project;

  if (!toolRequested) {
    try {
      projectRoute = await routeResolver({
        aiosPath,
        homePath,
        statePath: options.statePath,
        filesystem,
        intent,
        projectSelector: selectedProjectReference ?? null,
        cwd: options.cwd || process.cwd(),
        supportedConventionKinds: options.supportedConventionKinds || []
      });
    } catch {
      projectRoute = {
        status: "refused",
        project: null,
        match: null,
        routability: null,
        route: null,
        reason: "project_identity_unverified"
      };
    }
    if (projectRoute.status !== "ready") {
      return budgetedProjectRoute({
        limit: visibleCharacterBudget,
        intent,
        projectRoute
      });
    }
    selectedProjectReference = projectRoute.project.id;
  }

  let selected;
  if (toolRequested) {
    try {
      selected = await selectVerifiedProject({
        ...projectOptions,
        projectSelector: selectedProjectReference,
        cwd: options.cwd || process.cwd()
      });
    } catch (error) {
      return budgetedRefusal({
        limit: visibleCharacterBudget,
        reason: selectionReason(error),
        recovery: selectionRecovery(error),
        projectRoute,
        includeTool: true
      });
    }
  } else {
    selected = {
      id: projectRoute.project.id,
      slug: projectRoute.project.slug,
      projectPath: projectRoute.route.location,
      mappingStatus: "verified",
      pathAvailable: true,
      placement: projectRoute.project.placement
    };
  }

  let portable;
  let skills;
  let configured;
  try {
    if (toolRequested) {
      const [catalog, collectedSkills, connections] = await Promise.all([
        readProjectCatalog({ aiosPath, fs: filesystem }),
        collectSkills(aiosPath),
        inspectConfiguredConnections({ aiosPath, filesystem })
      ]);
      const portableMatches = catalog.filter((project) => (
        project.id === selected.id && project.slug === selected.slug
      ));
      if (portableMatches.length !== 1) {
        return budgetedRefusal({
          limit: visibleCharacterBudget,
          reason: "project_catalog_changed",
          recovery: "Run dotaios project doctor, then retry.",
          projectRoute,
          includeTool: true
        });
      }
      [portable] = portableMatches;
      skills = collectedSkills;
      configured = connections;
    } else {
      skills = await collectSkills(aiosPath);
      portable = {
        id: projectRoute.project.id,
        slug: projectRoute.project.slug,
        name: projectRoute.project.name,
        description: projectRoute.project.purpose
      };
      configured = null;
    }
  } catch {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "local_authority_unreadable",
      recovery: "Run dotaios doctor, then retry.",
      projectRoute,
      includeTool: toolRequested
    });
  }
  const matchedSkill = resolveIntent(intent, skills, { skillsDir: "skills" });
  const skill = matchedSkill
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
  if (tool?.status === "no_match" && tool.reason !== "not_requested") omissions.push("configured_tool_no_match");
  if (tool?.status === "refused") omissions.push("configured_tool_refused");
  omissions.push("supplemental_project_sources_not_requested");
  if (!toolRequested) omissions.push("project_native_execution_not_started");

  const fixed = {
    schema: SCHEMA,
    status,
    project,
    project_route: projectRoute,
    memory: {
      receipt: MEMORY_RECEIPT,
      scope: selected.slug,
      generated_at: null,
      context: "",
      truncated: false
    },
    skill,
    ...(toolRequested ? { tool } : {}),
    omissions,
    recovery: { required: false, action: null },
    next_action: toolRequested
      ? nextAction(skill, tool)
      : nativeRouteNextAction(intent, projectRoute),
    budget: { limit: visibleCharacterBudget, used: 0, truncated: false },
    location: selected.projectPath
  };
  if (renderWithStableUsed(fixed).length > visibleCharacterBudget) {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "fixed_envelope_exceeds_budget",
      recovery: "Retry with a larger --budget value.",
      projectRoute,
      includeTool: toolRequested
    });
  }

  let contextBudget = Math.max(0, visibleCharacterBudget - renderWithStableUsed(fixed).length);
  let envelope = fixed;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let context;
    try {
      context = await selectWorkingContext(aiosPath, {
        memory: "project",
        project: selected.slug,
        visibleCharacterBudget: contextBudget
      }, {
        filesystem,
        clock: dependencies.clock
      });
    } catch {
      return budgetedRefusal({
        limit: visibleCharacterBudget,
        reason: "project_context_unreadable",
        recovery: "Run dotaios doctor, then retry.",
        projectRoute,
        includeTool: toolRequested
      });
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
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "fixed_envelope_exceeds_budget",
      recovery: "Retry with a larger --budget value.",
      projectRoute,
      includeTool: toolRequested
    });
  }

  // Re-check the relevant authority immediately before the sole location
  // disclosure. Native routes revalidate root, remote, and conventions again;
  // explicit tools retain the existing primary-directory check.
  try {
    if (toolRequested) {
      const verified = await resolveProjectRecord({ ...projectOptions, project: selected.id });
      if (
        verified.id !== selected.id
        || verified.slug !== selected.slug
        || verified.projectPath !== selected.projectPath
        || !projectLocationSafe(verified)
      ) {
        throw new Error("project mapping changed");
      }
    } else {
      const finalRoute = await routeResolver({
        aiosPath,
        homePath,
        statePath: options.statePath,
        filesystem,
        intent,
        projectSelector: selected.id,
        cwd: options.cwd || process.cwd(),
        supportedConventionKinds: options.supportedConventionKinds || []
      });
      if (!sameReadyProjectRoute(projectRoute, finalRoute)) {
        throw new Error("project native route changed");
      }
      projectRoute = finalRoute;
      envelope.project_route = finalRoute;
      envelope.location = finalRoute.route.location;
      if (renderWithStableUsed(envelope).length > visibleCharacterBudget) {
        return budgetedRefusal({
          limit: visibleCharacterBudget,
          reason: "fixed_envelope_exceeds_budget",
          recovery: "Retry with a larger --budget value.",
          projectRoute: finalRoute,
          includeTool: false
        });
      }
    }
  } catch {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "project_identity_unverified",
      recovery: `To re-register it, preview dotaios project add <repo-path> --slug ${selected.slug}, then apply it with the displayed operation id and plan fingerprint.`,
      projectRoute: {
        ...projectRoute,
        status: "refused",
        route: null,
        reason: "project_identity_unverified"
      },
      includeTool: toolRequested
    });
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
}

/** Canonical, human-readable JSON used by the CLI and budget accounting. */
export function renderIntentResolution(value) {
  const readable = JSON.stringify(value, null, 2);
  if (
    value?.status === "refused"
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

function sameReadyProjectRoute(left, right) {
  return left?.status === "ready"
    && right?.status === "ready"
    && left.project?.id === right.project?.id
    && left.project?.slug === right.project?.slug
    && left.project?.name === right.project?.name
    && left.project?.purpose === right.project?.purpose
    && left.project?.repository === right.project?.repository
    && left.project?.placement === right.project?.placement
    && left.route?.location === right.route?.location
    && JSON.stringify(left.route?.conventions) === JSON.stringify(right.route?.conventions);
}

function nextAction(skill, tool) {
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

function budgetedRefusal({
  limit,
  reason,
  recovery,
  projectRoute = notEvaluatedProjectRoute(),
  includeTool = true
}) {
  const safeProjectRoute = refusedProjectRoute(projectRoute, reason);
  const envelope = {
    schema: SCHEMA,
    status: "refused",
    project: null,
    project_route: safeProjectRoute,
    memory: { receipt: MEMORY_RECEIPT, scope: null, generated_at: null, context: "", truncated: false },
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
    envelope.recovery.action = null;
    envelope.next_action.summary = "fixed_envelope_exceeds_budget";
    envelope.omissions = ["all_variable_content"];
    envelope.project_route = {
      status: "refused",
      reason: "fixed_envelope_exceeds_budget",
      project: null,
      match: null,
      routability: null,
      route: null
    };
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

function budgetedProjectRoute({ limit, intent, projectRoute }) {
  const failed = projectRoute.status === "refused" || projectRoute.status === "unsupported_by_host";
  const envelope = {
    schema: SCHEMA,
    status: failed ? "refused" : "partial",
    project: null,
    project_route: projectRoute,
    memory: { receipt: MEMORY_RECEIPT, scope: null, generated_at: null, context: "", truncated: false },
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
    return budgetedRefusal({
      limit,
      reason: "fixed_envelope_exceeds_budget",
      recovery: "Retry with a larger --budget value.",
      projectRoute: {
        status: "refused",
        project: null,
        match: null,
        routability: null,
        route: null,
        reason: "fixed_envelope_exceeds_budget"
      },
      includeTool: false
    });
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
}

function notEvaluatedProjectRoute() {
  return {
    status: "not_evaluated",
    reason: "tool_selector_precedence",
    project: null,
    match: null,
    routability: null,
    route: null
  };
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
      action: "Keep the repository where it is and connect it once: preview dotaios project add <folder> --purpose <purpose>, then apply the displayed operation id and plan fingerprint; or retry with --project <slug-or-id>."
    };
  }
  if (projectRoute.status === "refused") {
    return {
      required: true,
      action: "Run dotaios project doctor, repair or reconnect the registration, then retry with one exact slug or stable id."
    };
  }
  return { required: false, action: null };
}

function projectRouteNextAction(intent, projectRoute) {
  if (projectRoute.status === "candidate") {
    return {
      state: "approval_required",
      approval: "direct_user_required",
      summary: `Explain that ${projectRoute.project.slug} matched only from the customer's registration metadata, not an AIOS endorsement. Ask for direct approval of one action: “${intent}” After approval, immediately request exact resolution for ${projectRoute.project.id} and start a fresh context rooted at the verified project; changing directory in this run is insufficient.`
    };
  }
  if (projectRoute.status === "ambiguous") {
    return {
      state: "clarification_required",
      approval: "not_applicable",
      summary: "Choose one displayed slug or stable id, state one concrete action, and retry exact resolution."
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
      summary: "Connect the existing folder once with its purpose, or retry with one exact registered slug or stable id."
    };
  }
  return {
    state: "recovery_required",
    approval: "not_applicable",
    summary: projectRoute.reason
  };
}

function nativeRouteNextAction(intent, projectRoute) {
  return {
    state: "approval_required",
    approval: "direct_user_required",
    summary: `This advisory route authorizes nothing. After direct approval of one action—“${intent}”—immediately exact-resolve ${projectRoute.project.id} again, then start a fresh context rooted at the verified project; changing directory in this run is insufficient.`
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
