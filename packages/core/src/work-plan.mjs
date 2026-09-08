import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createContainedReadBudget, readContainedFile } from "./contained-read.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import { syncOwnedDirectory } from "./owned-state.mjs";

const START = "<!-- dotaios-work-plan:start -->";
const END = "<!-- dotaios-work-plan:end -->";
const FORMAT = "dotaios-work-plan/v1";
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** One research workflow, owned by the work folder's existing plan artifact. */
export async function startWorkPlan(workdir, input, { filesystem = fs } = {}) {
  assertKeys(input, ["goal", "limits", "nextAction"]);
  const plan = {
    format: FORMAT, goal: input.goal, limits: input.limits, status: "in-progress",
    completed: [], sources: [], outputs: [], unresolved: [], nextAction: input.nextAction
  };
  validatePlan(plan);
  return mutateWorkPlan(workdir, filesystem, async (root) => {
    const current = await readPlan(root.path, filesystem);
    if (current.plan) throw workPlanError("ALREADY_EXISTS", "A current work plan already exists. Inspect it before continuing.");
    await publishPlan(root, current, plan, filesystem);
    return inspectWorkPlan(root.path, { filesystem });
  });
}

/** Bounded discovery: no checkpoint name, directory scan or AIOS memory read. */
export async function inspectWorkPlan(workdir, { filesystem = fs } = {}) {
  const current = await readPlan(workdir, filesystem);
  if (!current.plan) return { status: "not-found", revision: current.revision, plan: null };
  const verification = await verifyPlan(workdir, current.plan, filesystem);
  return {
    status: verification.state === "current" && current.plan.status !== "blocked" ? "ready" : "needs-attention",
    revision: current.revision, plan: current.plan, verification
  };
}

export async function checkpointWorkPlan(workdir, input, { expectedRevision, filesystem = fs } = {}) {
  assertKeys(input, ["completed", "sources", "outputs", "unresolved", "nextAction", "status"]);
  return mutateWorkPlan(workdir, filesystem, async (root) => {
    return checkpoint(root, input, expectedRevision, filesystem);
  });
}

async function checkpoint(root, input, expectedRevision, filesystem) {
  const workdir = root.path;
  const current = await readPlan(workdir, filesystem);
  if (!current.plan) throw workPlanError("NOT_FOUND", "No current work plan exists in this folder.");
  assertRevision(current, expectedRevision);
  const plan = structuredClone(current.plan);
  const registrationBudget = evidenceBudget();
  if (input.completed !== undefined) {
    assertTextList(input.completed, 64);
    plan.completed = [...new Set([...plan.completed, ...input.completed])];
  }
  if (input.sources !== undefined) {
    assertList(input.sources, 32);
    for (const source of input.sources) {
      assertKeys(source, ["path", "origin"]);
      assertText(source.origin);
      const sha256 = await readEvidence(workdir, source.path, "source", filesystem, registrationBudget);
      upsert(plan.sources, { path: source.path, origin: source.origin, sha256 });
    }
  }
  if (input.outputs !== undefined) {
    assertList(input.outputs, 32);
    for (const output of input.outputs) {
      assertKeys(output, ["path", "sources"]);
      assertList(output.sources, 32, 1);
      const sha256 = await readEvidence(workdir, output.path, "output", filesystem, registrationBudget);
      const sources = output.sources.map((sourcePath) => {
        const source = plan.sources.find((item) => item.path === sourcePath);
        if (!source) throw workPlanError("SOURCE_REQUIRED", "Record the source before its dependent output.");
        return { path: source.path, sha256: source.sha256 };
      });
      upsert(plan.outputs, { path: output.path, sha256, sources });
    }
  }
  for (const field of ["unresolved", "nextAction", "status"]) {
    if (Object.hasOwn(input, field)) plan[field] = input[field];
  }
  if (hasUnfinishedCompletion(plan)) throw completionError();
  validatePlan(plan);
  const verification = await verifyPlan(workdir, plan, filesystem);
  if (plan.status === "complete" && verification.state !== "current") throw completionError();
  await publishPlan(root, current, plan, filesystem, verification);
  return inspectWorkPlan(workdir, { filesystem });
}

async function mutateWorkPlan(workdir, filesystem, callback) {
  const rootPath = path.resolve(workdir);
  const stats = await filesystem.lstat(rootPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw workPlanError("INVALID_PATH", "The work folder must be a real directory.");
  const root = { path: rootPath, stats, canonical: await filesystem.realpath(rootPath) };
  await assertRoot(root, filesystem);
  const result = await withOperationLock(path.join(rootPath, ".dotaios-work-plan.lock"), async () => {
    await assertRoot(root, filesystem);
    return callback(root);
  }, { filesystem, format: "dotaios-work-plan-lock/v1", ownsParent: false, strictOwnedState: true });
  if (!result.acquired) throw workPlanError("BUSY", "Another checkpoint is in progress. Inspect the plan before retrying.");
  return result.value;
}

async function assertRoot(root, filesystem) {
  const current = await filesystem.lstat(root.path);
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== root.stats.dev || current.ino !== root.stats.ino
    || current.uid !== root.stats.uid || current.mode !== root.stats.mode
    || await filesystem.realpath(root.path) !== root.canonical) {
    throw workPlanError("CHANGED", "The work folder changed. Inspect it before retrying.");
  }
}

async function publishPlan(root, current, plan, filesystem, verification = null) {
  const temporary = path.join(root.path, `.dotaios-work-plan.${randomUUID()}.tmp`);
  let handle = null;
  let published = false;
  try {
    await assertRoot(root, filesystem);
    handle = await filesystem.open(temporary, "wx", 0o600);
    await assertRoot(root, filesystem);
    await handle.writeFile(replacePlan(current, plan), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await assertRoot(root, filesystem);
    assertRevision(await readPlan(root.path, filesystem), current.revision);
    if (verification && JSON.stringify(await verifyPlan(root.path, plan, filesystem)) !== JSON.stringify(verification)) {
      throw workPlanError("CHANGED", "The evidence changed during the checkpoint. Inspect it before retrying.");
    }
    await assertRoot(root, filesystem);
    await filesystem.rename(temporary, path.join(root.path, "plan.md"));
    published = true;
    await syncOwnedDirectory(root.path, { filesystem });
  } catch (error) {
    if (published) throw workPlanError("PUBLICATION_UNCERTAIN", "Checkpoint publication may have completed. Inspect the current plan before retrying; do not repeat external actions.");
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    // Never clean a replacement folder after a root swap. Interrupted staging
    // files are ignored: only the atomically published plan.md is current.
    if (!published) {
      try {
        await assertRoot(root, filesystem);
        await filesystem.rm(temporary, { force: true });
      } catch { /* Preserve uncertain state for inspection. */ }
    }
  }
}

async function readPlan(workdir, filesystem) {
  const read = await readContainedFile(workdir, path.join(workdir, "plan.md"), {
    filesystem, encoding: "utf8", maxBytes: MAX_PLAN_BYTES, returnSnapshot: true
  });
  const body = read?.content || "";
  if (read && read.stats.nlink !== 1) throw workPlanError("INVALID", "The work plan path is invalid.");
  const revision = digest(body);
  if (!body.includes(START) && !body.includes(END)) return { body, revision, plan: null };
  const start = body.indexOf(START);
  const end = body.indexOf(END) + END.length;
  if (start < 0 || end < start || body.split(START).length !== 2 || body.split(END).length !== 2) throw invalidPlan();
  const block = body.slice(start + START.length, end - END.length).trim();
  if (!block.startsWith("```json\n") || !block.endsWith("\n```")) throw invalidPlan();
  let plan;
  try {
    plan = JSON.parse(block.slice("```json\n".length, -"\n```".length));
    validatePlan(plan);
  } catch {
    throw invalidPlan();
  }
  return { body, revision, start, end, plan };
}

function replacePlan(current, plan) {
  // Escape '<' inside JSON strings so source text cannot impersonate ownership markers.
  const record = `${START}\n\`\`\`json\n${JSON.stringify(plan, null, 2).replaceAll("<", "\\u003c")}\n\`\`\`\n${END}`;
  const body = current.plan
    ? current.body.slice(0, current.start) + record + current.body.slice(current.end)
    : `${current.body}\n${record}\n`;
  if (Buffer.byteLength(body) > MAX_PLAN_BYTES) throw invalidPlan();
  return body;
}

async function verifyPlan(workdir, plan, filesystem) {
  const findings = [];
  const changedSources = new Set();
  const budget = evidenceBudget();
  for (const [kind, items] of [["source", plan.sources], ["output", plan.outputs]]) {
    for (const item of items) {
      let code = null;
      try {
        if (await readEvidence(workdir, item.path, kind, filesystem, budget) !== item.sha256) code = `${kind}-changed`;
      } catch (error) {
        code = error.code === "ENOENT" ? `${kind}-missing` : `${kind}-unavailable`;
      }
      if (code) {
        findings.push({ path: item.path, code });
        if (kind === "source") changedSources.add(item.path);
      }
      if (kind === "output" && item.sources.some((dependency) => changedSources.has(dependency.path)
        || !plan.sources.some((source) => source.path === dependency.path && source.sha256 === dependency.sha256))) {
        findings.push({ path: item.path, code: "dependency-changed" });
      }
    }
  }
  return { state: findings.length ? "drifted" : "current", findings };
}

async function readEvidence(workdir, relativePath, kind, filesystem, budget) {
  assertEvidencePath(relativePath, kind);
  const bytes = await readContainedFile(workdir, path.join(workdir, relativePath), {
    filesystem, maxBytes: 16 * 1024 * 1024, budget
  });
  if (bytes === null) {
    const error = new Error("The evidence file is missing.");
    error.code = "ENOENT";
    throw error;
  }
  return digest(bytes);
}

function evidenceBudget() {
  return createContainedReadBudget({ maxBytes: 64 * 1024 * 1024, maxFiles: 64, maxEntries: 0 });
}

function validatePlan(plan) {
  assertKeys(plan, ["format", "goal", "limits", "status", "completed", "sources", "outputs", "unresolved", "nextAction"]);
  if (plan.format !== FORMAT || !["in-progress", "blocked", "complete"].includes(plan.status)) throw invalidPlan();
  assertText(plan.goal);
  assertTextList(plan.limits, 32);
  assertTextList(plan.completed, 64);
  assertTextList(plan.unresolved, 32);
  if (plan.status !== "complete" || plan.nextAction !== null) assertText(plan.nextAction);
  if (plan.status === "blocked" && plan.unresolved.length === 0) throw invalidPlan();
  assertList(plan.sources, 32);
  assertList(plan.outputs, 32);
  if (hasUnfinishedCompletion(plan)) throw invalidPlan();
  for (const source of plan.sources) {
    assertKeys(source, ["path", "origin", "sha256"]);
    assertEvidencePath(source.path, "source");
    assertText(source.origin);
    assertHash(source.sha256);
  }
  for (const output of plan.outputs) {
    assertKeys(output, ["path", "sha256", "sources"]);
    assertEvidencePath(output.path, "output");
    assertHash(output.sha256);
    assertList(output.sources, 32, 1);
    for (const source of output.sources) {
      assertKeys(source, ["path", "sha256"]);
      assertEvidencePath(source.path, "source");
      assertHash(source.sha256);
    }
    assertUniquePaths(output.sources);
  }
  assertUniquePaths(plan.sources);
  assertUniquePaths(plan.outputs);
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_RECORD_BYTES) throw invalidPlan();
}

function hasUnfinishedCompletion(plan) {
  return plan.status === "complete" && Array.isArray(plan.outputs) && Array.isArray(plan.unresolved)
    && (plan.outputs.length === 0 || plan.unresolved.length > 0);
}

function completionError() {
  return workPlanError("EVIDENCE_NOT_CURRENT", "Completion requires a result with current evidence and no unresolved questions.");
}

function assertEvidencePath(relativePath, kind) {
  const directory = kind === "source" ? "sources" : "results";
  if (typeof relativePath !== "string" || relativePath.length > 512
    || !relativePath.startsWith(`research/${directory}/`)
    || /[\\\x00-\x1f\x7f]/.test(relativePath)
    || relativePath.split("/").some((segment) => !segment || segment.startsWith("."))) {
    throw workPlanError("INVALID_PATH", "Evidence paths must be relative files in research/sources or research/results.");
  }
}

function assertKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) throw invalidPlan();
}

function assertText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw invalidPlan();
}

function assertList(value, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw invalidPlan();
}

function assertTextList(value, max) {
  assertList(value, max);
  value.forEach(assertText);
}

function assertHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalidPlan();
}

function assertUniquePaths(items) {
  if (new Set(items.map((item) => item.path)).size !== items.length) throw invalidPlan();
}

function assertRevision(current, expectedRevision) {
  if (!expectedRevision || current.revision !== expectedRevision) {
    throw workPlanError("CHANGED", "The work plan changed. Inspect it before retrying.");
  }
}

function upsert(items, next) {
  const index = items.findIndex((item) => item.path === next.path);
  if (index < 0) items.push(next);
  else items[index] = next;
}

function invalidPlan() {
  return workPlanError("INVALID", "The work plan or input is invalid; preserve it and inspect the supplied fields.");
}

function workPlanError(code, message) {
  const error = new Error(message);
  error.code = `DOTAIOS_WORK_PLAN_${code}`;
  return error;
}
