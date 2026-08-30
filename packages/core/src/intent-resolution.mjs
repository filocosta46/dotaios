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

  let selected;
  try {
    selected = await selectVerifiedProject({
      ...projectOptions,
      projectSelector: options.projectSelector ?? options.project,
      cwd: options.cwd || process.cwd()
    });
  } catch (error) {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: selectionReason(error),
      recovery: selectionRecovery(error)
    });
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
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "local_authority_unreadable",
      recovery: "Run dotaios doctor, then retry."
    });
  }
  const portableMatches = catalog.filter((project) => project.id === selected.id && project.slug === selected.slug);
  if (portableMatches.length !== 1) {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "project_catalog_changed",
      recovery: "Run dotaios project doctor, then retry."
    });
  }
  const portable = portableMatches[0];
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

  const tool = resolveConnectionTool({
    configuredConnections: configured.labels,
    configurationIssues: configured.issues,
    request: options.tool ?? null
  });

  const project = {
    id: selected.id,
    slug: selected.slug,
    name: portable.name,
    purpose: portable.description || null,
    identity: "verified"
  };
  const status = skill.status === "matched" && (tool.status === "matched" || tool.reason === "not_requested")
    ? "matched"
    : "partial";
  const omissions = [];
  if (skill.status === "no_match") omissions.push("governing_skill_no_match");
  if (tool.status === "no_match" && tool.reason !== "not_requested") omissions.push("configured_tool_no_match");
  if (tool.status === "refused") omissions.push("configured_tool_refused");
  omissions.push("supplemental_project_sources_not_requested");

  const fixed = {
    schema: SCHEMA,
    status,
    project,
    memory: {
      receipt: MEMORY_RECEIPT,
      scope: selected.slug,
      generated_at: null,
      context: "",
      truncated: false
    },
    skill,
    tool,
    omissions,
    recovery: { required: false, action: null },
    next_action: nextAction(skill, tool),
    budget: { limit: visibleCharacterBudget, used: 0, truncated: false },
    location: selected.projectPath
  };
  if (renderWithStableUsed(fixed).length > visibleCharacterBudget) {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "fixed_envelope_exceeds_budget",
      recovery: "Retry with a larger --budget value."
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
        recovery: "Run dotaios doctor, then retry."
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
      recovery: "Retry with a larger --budget value."
    });
  }

  // Re-check U1's machine-local directory identity immediately before the sole
  // location disclosure. A changed/moved root returns a path-free refusal.
  try {
    const verified = await resolveProjectRecord({ ...projectOptions, project: selected.id });
    if (
      verified.id !== selected.id
      || verified.slug !== selected.slug
      || verified.projectPath !== selected.projectPath
      || !projectLocationSafe(verified)
    ) {
      throw new Error("project mapping changed");
    }
  } catch {
    return budgetedRefusal({
      limit: visibleCharacterBudget,
      reason: "project_identity_unverified",
      recovery: `To re-register it, preview dotaios project add <repo-path> --slug ${selected.slug}, then apply it with the displayed operation id and plan fingerprint.`
    });
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
}

/** Canonical, human-readable JSON used by the CLI and budget accounting. */
export function renderIntentResolution(value) {
  return JSON.stringify(value, null, 2);
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

function budgetedRefusal({ limit, reason, recovery }) {
  const envelope = {
    schema: SCHEMA,
    status: "refused",
    project: null,
    memory: { receipt: MEMORY_RECEIPT, scope: null, generated_at: null, context: "", truncated: false },
    skill: { status: "not_evaluated", name: null, resource: null, confidence: 0, reason: "project_not_verified" },
    tool: { status: "not_evaluated", capability: null, connection: null, configured: false, authenticated: "unknown" },
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
  }
  stabilizeBudgetUsed(envelope);
  return envelope;
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
