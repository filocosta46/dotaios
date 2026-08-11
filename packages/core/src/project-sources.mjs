import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";

import {
  createContainedReadBudget,
  inspectContainedDirectory,
  inspectContainedFileMetadata,
  readContainedDirectory,
  sameContainedDirectorySnapshot,
  sameContainedFileMetadataSnapshot
} from "./contained-read.mjs";
import { createEvidenceReader } from "./evidence-reader.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import {
  resolvePortableProjectIdentity,
  validateProjectSelector
} from "./projects.mjs";
import {
  projectSourceStatePaths,
  projectSourceOwnedDirectories,
  markBindingPortablePublished,
  publishBinding,
  publishGrant,
  publishGrantRevocation,
  readProjectSourceAuthorizationSnapshotUnderLock,
  readProjectSourceState,
  sourceStateLockPath
} from "./project-source-state.mjs";
import {
  accessReceiptFitsPublicationBound,
  appendAccessReceipt,
  assertAccessReceiptStoreAvailable,
  createAccessReceipt
} from "./receipt-ledger.mjs";
import { matchQuery } from "./search.mjs";

const TASK_MAX_CODE_POINTS = 500;
const MAX_DEPTH = 16;
const MAX_ENTRIES = 4096;
const MAX_FILES = 256;
const MAX_PATH_BYTES = 1024;
const MAX_RESULT_CHARACTERS = 32_000;
const MAX_SOURCE_DECLARATIONS = 32;
const MAX_SOURCE_DECLARATION_BYTES = 64 * 1024;
const SOURCE_VERSION = 1;
const SOURCE_LOCK_FORMAT = "dotaios-project-source-lock/v1";
const MATCH_TIERS = { partial: 1, terms: 2, phrase: 3 };

export class ProjectSourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProjectSourceError";
    this.code = code;
    this.details = details;
  }
}

export async function addProjectSource(options = {}) {
  return executeMutation(options, planProjectSourceAdd, async (current) => {
    const binding = await publishBinding({
      homePath: current.home_path,
      projectId: current.project_id,
      sourceId: current.source_id,
      operationId: current.operation_id,
      planFingerprint: current.plan_fingerprint,
      rootPath: current.machine_local.root,
      rootIdentity: current.root_identity,
      portablePublished: false,
      filesystem: options.filesystem || fs
    });
    if (!current.portable_published) {
      await publishPortableSource(current, options.filesystem || fs);
    }
    await markBindingPortablePublished({
      homePath: current.home_path,
      projectId: current.project_id,
      sourceId: current.source_id,
      operationId: current.operation_id,
      planFingerprint: current.plan_fingerprint,
      filesystem: options.filesystem || fs
    });
    return publicMutationResult(current, { applied: true, binding_generation: binding.generation });
  });
}

export async function connectProjectSource(options = {}) {
  const expiresAt = validateFutureUtc(options.expiresAt, options.now || (() => new Date()));
  let plan = await planProjectSourceConnect({ ...options, expiresAt });
  if (options.yes !== true) return publicConnectionResult(plan);

  if (plan.add_plan) {
    await addProjectSource({
      ...options,
      operationId: plan.add_plan.operation_id,
      planFingerprint: plan.add_plan.plan_fingerprint,
      apply: true
    });
    plan = await planProjectSourceConnect({ ...options, expiresAt });
  }

  if (plan.grant) {
    return publicConnectionResult(plan, { applied: true, idempotent: true, grant: plan.grant });
  }

  const grantOptions = {
    ...options,
    sourceId: plan.source_id,
    purpose: plan.purpose,
    expiresAt: plan.expires_at,
    expectedBinding: plan.binding
  };
  const grantPlan = await grantProjectSource(grantOptions);
  const grant = await grantProjectSource({
    ...grantOptions,
    operationId: grantPlan.operation_id,
    planFingerprint: grantPlan.plan_fingerprint,
    apply: true
  });
  const completed = await planProjectSourceConnect({ ...options, expiresAt });
  return publicConnectionResult(completed, {
    applied: true,
    idempotent: false,
    grant: {
      grant_id: grant.grant_id,
      approved_at: grant.approved_at
    }
  });
}

async function planProjectSourceConnect(options) {
  let addPlan = null;
  try {
    addPlan = await planProjectSourceAdd(options);
  } catch (error) {
    if (
      !(error instanceof ProjectSourceError)
      || !["source-already-exists", "source-binding-exists"].includes(error.details?.reason)
    ) {
      throw error;
    }
  }
  if (addPlan) {
    return Object.freeze({
      project_id: addPlan.project_id,
      project: addPlan.project,
      source_id: addPlan.source_id,
      label: addPlan.label,
      purpose: addPlan.purpose,
      expires_at: options.expiresAt,
      machine_local: addPlan.machine_local,
      portable_path: addPlan.portable_path,
      add_plan: addPlan,
      grant: null
    });
  }

  const sourceId = validateSourceId(options.sourceId);
  const context = await sourceContext(options);
  const label = validateBoundedText(options.label, "label", 200);
  const purpose = validateBoundedText(options.purpose, "purpose", 500);
  const root = await inspectSourceRoot(options.folder, context, options.filesystem || fs);
  const source = await readSourceDeclaration(context, sourceId);
  const state = await readProjectSourceState({
    homePath: context.homePath,
    projectId: context.project.id,
    sourceId,
    filesystem: options.filesystem || fs
  });
  if (
    source.label !== label
    || source.purpose !== purpose
    || !matchingConnectBinding(state.binding, root)
  ) {
    throw sourceError("connection-mismatch", "Existing project source state does not match this connection.");
  }
  if (state.grant && !matchingConnectGrant({
    grant: state.grant,
    source,
    binding: state.binding,
    expiresAt: options.expiresAt,
    now: options.now || (() => new Date())
  })) {
    throw sourceError("connection-mismatch", "Existing project source grant does not match this connection.");
  }
  return Object.freeze({
    project_id: context.project.id,
    project: context.project.slug,
    source_id: sourceId,
    label,
    purpose,
    expires_at: options.expiresAt,
    machine_local: Object.freeze({ root: root.path }),
    portable_path: path.posix.join("projects", context.project.slug, "sources", `${sourceId}.md`),
    add_plan: null,
    binding: state.binding,
    grant: state.grant
  });
}

function matchingConnectBinding(binding, root) {
  return Boolean(
    binding
    && binding.portable_published === true
    && binding.root_path === root.path
    && sameRootIdentity(binding.root_identity, root.identity)
  );
}

function matchingConnectGrant({ grant, source, binding, expiresAt, now }) {
  const approvedAt = Date.parse(grant.approved_at);
  const expiry = Date.parse(grant.expires_at);
  const evaluatedAt = now().getTime();
  return grant.scope === "read"
    && grant.purpose === source.purpose
    && grant.expires_at === expiresAt
    && grant.revoked_at === null
    && grant.source_revision === source.revision
    && grant.binding_generation === binding.generation
    && stableJson(grant.root_identity) === stableJson(binding.root_identity)
    && Number.isFinite(approvedAt)
    && Number.isFinite(expiry)
    && approvedAt <= evaluatedAt
    && expiry > evaluatedAt;
}

function publicConnectionResult(plan, { applied = false, idempotent = false, grant = null } = {}) {
  return Object.freeze({
    version: 1,
    operation: "connect",
    applied,
    idempotent,
    project_id: plan.project_id,
    project: plan.project,
    source_id: plan.source_id,
    label: plan.label,
    scope: "read",
    purpose: plan.purpose,
    approval_timing: "when --yes confirms this exact connection",
    approved_at: grant?.approved_at || null,
    expires_at: plan.expires_at,
    grant_id: grant?.grant_id || null,
    portable_path: plan.portable_path,
    machine_local: plan.machine_local
  });
}

async function planProjectSourceAdd(options = {}) {
  const sourceId = validateSourceId(options.sourceId);
  const context = await sourceContext(options);
  const label = validateBoundedText(options.label, "label", 200);
  const purpose = validateBoundedText(options.purpose, "purpose", 500);
  const requestedOperationId = validateOperationId(options.operationId || randomUUID());
  const root = await inspectSourceRoot(options.folder, context, options.filesystem || fs);
  const portablePath = sourceDeclarationPath(context.aiosPath, context.project.slug, sourceId);
  const filesystem = options.filesystem || fs;
  const existingSource = await lstatIfPresent(filesystem, portablePath);
  const { binding } = await readCoordinateState(context, sourceId, options.filesystem || fs);
  const declaration = renderSourceDeclaration({
    projectId: context.project.id,
    project: context.project.slug,
    sourceId,
    label,
    purpose,
    revision: 1
  });
  const existingDeclaration = existingSource
    ? await context.evidenceReader.readText(context.aiosPath, portablePath, { maxBytes: 64 * 1024 })
    : null;
  const recovery = resolveAddRecovery({
    existingSource,
    existingDeclaration,
    declaration,
    binding,
    requestedOperationId,
    explicitOperation: Boolean(options.operationId),
    root
  });
  return createAddPlan({
    context,
    sourceId,
    label,
    purpose,
    root,
    declaration,
    binding,
    ...recovery
  });
}

function createAddPlan({
  context, sourceId, label, purpose, root, declaration, binding, operationId, recovering, portablePublished
}) {
  const planFingerprint = sha256(stableJson({
    operation: "add",
    operation_id: operationId,
    project_id: context.project.id,
    project: context.project.slug,
    source_id: sourceId,
    label,
    purpose,
    source_sha256: sha256(declaration),
    source_revision: 1,
    binding_generation: recovering ? binding.generation - 1 : 0,
    root_identity: root.identity
  }));
  if (recovering && binding.plan_fingerprint !== planFingerprint) {
    throw sourceError("stale-plan", "Project source recovery plan is stale.");
  }
  return Object.freeze({
    version: 1,
    operation: "add",
    applied: false,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    project_id: context.project.id,
    project: context.project.slug,
    source_id: sourceId,
    label,
    purpose,
    type: "local-folder",
    portable_path: path.posix.join("projects", context.project.slug, "sources", `${sourceId}.md`),
    machine_local: Object.freeze({ root: root.path }),
    root_identity: root.identity,
    declaration,
    aios_path: context.aiosPath,
    home_path: context.homePath,
    recovery: recovering,
    portable_published: portablePublished
  });
}

function resolveAddRecovery({
  existingSource, existingDeclaration, declaration, binding, requestedOperationId, explicitOperation, root
}) {
  const incompleteBinding = binding?.portable_published === false;
  const operationId = incompleteBinding && !explicitOperation
    ? validateOperationId(binding.operation_id)
    : requestedOperationId;
  const operationMatches = binding?.operation_id === operationId
    && binding.root_path === root.path
    && sameRootIdentity(binding.root_identity, root.identity);
  const recovering = Boolean(
    operationMatches
    && (
      (!existingSource && incompleteBinding)
      || (
        existingSource
        && existingDeclaration === declaration
        && (explicitOperation || incompleteBinding)
      )
    )
  );
  if (existingSource && !recovering) {
    throw sourceError("source-already-exists", "Project source already exists.");
  }
  if (binding && !recovering) {
    throw sourceError("source-binding-exists", "Project source binding already exists.");
  }
  return Object.freeze({ operationId, recovering, portablePublished: Boolean(existingSource && recovering) });
}

async function executeMutation(options, planner, applyPlan) {
  const plan = await planner(options);
  if (options.apply !== true) return publicMutationResult(plan);
  assertExactApply(options, plan);
  return withSourceLock(plan, options, async () => {
    const current = await planner({ ...options, operationId: plan.operation_id });
    assertFingerprint(options.planFingerprint, current.plan_fingerprint);
    return applyPlan(current);
  });
}

export async function bindProjectSource(options = {}) {
  return executeMutation(options, planProjectSourceBind, async (current) => {
    const binding = await publishBinding({
      homePath: current.home_path,
      projectId: current.project_id,
      sourceId: current.source_id,
      operationId: current.operation_id,
      planFingerprint: current.plan_fingerprint,
      rootPath: current.machine_local.root,
      rootIdentity: current.root_identity,
      portablePublished: true,
      filesystem: options.filesystem || fs
    });
    return publicMutationResult(current, { applied: true, binding_generation: binding.generation });
  });
}

async function planProjectSourceBind(options = {}) {
  const sourceId = validateSourceId(options.sourceId);
  const context = await sourceContext(options);
  const operationId = validateOperationId(options.operationId || randomUUID());
  const source = await readSourceDeclaration(context, sourceId);
  const root = await inspectSourceRoot(options.folder, context, options.filesystem || fs);
  const state = await readProjectSourceState({
    homePath: context.homePath,
    projectId: context.project.id,
    sourceId,
    filesystem: options.filesystem || fs
  });
  const currentBinding = state.binding;
  const fingerprintInput = {
    operation: "bind",
    operation_id: operationId,
    project_id: context.project.id,
    source_id: sourceId,
    source_revision: source.revision,
    previous_binding_generation: currentBinding?.generation || 0,
    root_identity: root.identity
  };
  return Object.freeze({
    version: 1,
    operation: "bind",
    applied: false,
    operation_id: operationId,
    plan_fingerprint: sha256(stableJson(fingerprintInput)),
    project_id: context.project.id,
    project: context.project.slug,
    source_id: sourceId,
    machine_local: Object.freeze({ root: root.path }),
    root_identity: root.identity,
    aios_path: context.aiosPath,
    home_path: context.homePath
  });
}

export async function grantProjectSource(options = {}) {
  return executeMutation(options, planProjectSourceGrant, async (current) => {
    const approvedAt = current.now().toISOString();
    if (Date.parse(current.expires_at) <= Date.parse(approvedAt)) {
      throw sourceError("grant-expired", "Grant expiry must remain in the future at apply time.");
    }
    const grant = await publishGrant({
      homePath: current.home_path,
      projectId: current.project_id,
      sourceId: current.source_id,
      operationId: current.operation_id,
      planFingerprint: current.plan_fingerprint,
      grantId: current.grant_id,
      purpose: current.purpose,
      expiresAt: current.expires_at,
      approvedAt,
      binding: current.binding,
      sourceRevision: current.source_revision,
      filesystem: options.filesystem || fs
    });
    return publicMutationResult(current, {
      applied: true,
      grant_id: grant.grant_id,
      grant_revision: grant.revision,
      approved_at: grant.approved_at
    });
  });
}

export async function revokeProjectSource(options = {}) {
  return executeMutation(options, planProjectSourceRevoke, async (current) => {
    const revokedAt = current.now().toISOString();
    const grant = await publishGrantRevocation({
      homePath: current.home_path,
      projectId: current.project_id,
      sourceId: current.source_id,
      operationId: current.operation_id,
      planFingerprint: current.plan_fingerprint,
      grantId: current.grant_id,
      revokedAt,
      filesystem: options.filesystem || fs
    });
    return publicMutationResult(current, {
      applied: true,
      grant_revision: grant.revision,
      revoked_at: grant.revoked_at
    });
  });
}

async function planProjectSourceRevoke(options = {}) {
  const sourceId = validateSourceId(options.sourceId);
  const grantId = validateGrantId(options.grantId);
  const context = await sourceContext(options);
  const operationId = validateOperationId(options.operationId || randomUUID());
  const source = await readSourceDeclaration(context, sourceId);
  const state = await readProjectSourceState({
    homePath: context.homePath,
    projectId: context.project.id,
    sourceId,
    recoveryOperationId: options.operationId,
    recoveryPlanFingerprint: options.planFingerprint,
    filesystem: options.filesystem || fs
  });
  const grant = state.grant;
  if (!grant) throw sourceError("grant-missing", "Project source grant is missing.");
  if (grant.grant_id !== grantId) throw sourceError("grant-id-mismatch", "Project source grant id does not match.");
  if (grant.revoked_at) throw sourceError("grant-revoked", "Project source grant is already revoked.");
  return createRevokePlan({ context, grant, operationId, options, source, sourceId, state });
}

function createRevokePlan({ context, grant, operationId, options, source, sourceId, state }) {
  const planFingerprint = sha256(stableJson(revokeFingerprintFields({
    context, grant, operationId, source, sourceId, state
  })));
  return Object.freeze({
    version: 1,
    operation: "revoke",
    applied: false,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    grant_id: grant.grant_id,
    project_id: context.project.id,
    project: context.project.slug,
    source_id: sourceId,
    purpose: grant.purpose,
    scope: grant.scope,
    approved_at: grant.approved_at,
    expires_at: grant.expires_at,
    revoked_at: null,
    home_path: context.homePath,
    now: options.now || (() => new Date())
  });
}

function revokeFingerprintFields({ context, grant, operationId, source, sourceId, state }) {
  return {
    operation: "revoke",
    operation_id: operationId,
    project_id: context.project.id,
    source_id: sourceId,
    source_revision: source.revision,
    binding_generation: state.binding?.generation || null,
    root_identity: state.binding?.root_identity || null,
    grant_id: grant.grant_id,
    grant_revision: grant.revision,
    scope: grant.scope,
    purpose: grant.purpose,
    expires_at: grant.expires_at
  };
}

async function planProjectSourceGrant(options = {}) {
  const sourceId = validateSourceId(options.sourceId);
  const context = await sourceContext(options);
  const purpose = validateBoundedText(options.purpose, "purpose", 500);
  const expiresAt = validateFutureUtc(options.expiresAt, options.now || (() => new Date()));
  const operationId = validateOperationId(options.operationId || randomUUID());
  const source = await readSourceDeclaration(context, sourceId);
  if (source.purpose !== purpose) {
    throw sourceError("purpose-mismatch", "Grant purpose must exactly match the portable source purpose.");
  }
  const state = await readProjectSourceState({
    homePath: context.homePath,
    projectId: context.project.id,
    sourceId,
    recoveryOperationId: options.operationId,
    recoveryPlanFingerprint: options.planFingerprint,
    filesystem: options.filesystem || fs
  });
  const binding = state.binding;
  if (!binding) throw sourceError("binding-missing", "Project source binding is missing.");
  if (options.expectedBinding && !sameConnectBindingRevision(binding, options.expectedBinding)) {
    throw sourceError("connection-mismatch", "Project source binding no longer matches this connection.");
  }
  const currentGrant = state.grant;
  return createGrantPlan({
    context,
    source,
    sourceId,
    purpose,
    expiresAt,
    operationId,
    binding,
    currentGrant,
    now: options.now || (() => new Date())
  });
}

function sameConnectBindingRevision(current, expected) {
  return current.generation === expected.generation
    && current.root_path === expected.root_path
    && sameRootIdentity(current.root_identity, expected.root_identity);
}

function createGrantPlan({
  context, source, sourceId, purpose, expiresAt, operationId, binding, currentGrant, now
}) {
  const planFingerprint = sha256(stableJson({
    operation: "grant",
    operation_id: operationId,
    project_id: context.project.id,
    source_id: sourceId,
    purpose,
    source_revision: source.revision,
    binding_generation: binding.generation,
    root_identity: binding.root_identity,
    grant_revision: currentGrant?.revision || 0,
    scope: "read",
    expires_at: expiresAt
  }));
  return Object.freeze({
    version: 1,
    operation: "grant",
    applied: false,
    operation_id: operationId,
    plan_fingerprint: planFingerprint,
    grant_id: operationId,
    project_id: context.project.id,
    project: context.project.slug,
    source_id: sourceId,
    label: source.label,
    purpose,
    scope: "read",
    approved_at: null,
    expires_at: expiresAt,
    source_revision: source.revision,
    binding,
    aios_path: context.aiosPath,
    home_path: context.homePath,
    now
  });
}

export async function retrieveProjectSource(options = {}) {
  const task = validateTask(options.task);
  const homePath = path.resolve(options.homePath);
  const aiosPath = path.resolve(options.aiosPath);
  const filesystem = options.filesystem || fs;
  await assertIndependentProjectSourceState(aiosPath, homePath, filesystem);
  let known = { projectId: null, project: null, sourceId: null, grant: null };
  if (options.projectSelector !== undefined && options.projectSelector !== null) {
    validateProjectSelector(options.projectSelector);
  }
  await assertAccessReceiptStoreAvailable({ homePath, filesystem });
  try {
    if (!options.projectSelector) throw sourceError("project-required", "A project selector is required.");
    const { reader, project } = await resolveRetrievalProject({ ...options, aiosPath, filesystem });
    known = { ...known, projectId: project.id, project: project.slug };
    const source = await selectSource({ aiosPath, project, task, evidenceReader: reader });
    known = { ...known, sourceId: source.source_id };
    const stateCoordinates = { homePath, projectId: project.id, sourceId: source.source_id, filesystem };
    const state = await readAuthorizationSnapshot(stateCoordinates);
    known = {
      ...known,
      grant: state.grantIssue
        ? state.grantReceipt
        : state.grant
          ? publicGrantSnapshot(state.grant)
          : null
    };
    if (state.grantIssue) {
      throw sourceError(state.grantIssue, "Project source authorization state does not match this operation.");
    }
    const authorization = await authorizeSelectedSource({
      filesystem,
      source,
      state,
      stateCoordinates,
      now: options.now
    });
    const { binding, grant } = authorization;
    const references = await enumerateAndRecheck({
      aiosPath, filesystem, project, source, reader, ...authorization
    });
    // Keep result-bound refusals inside this catch while audit failures still rethrow.
    return await publishAllowedRetrieval({
      homePath, filesystem, project, source, grant, references, task, options
    });
  } catch (error) {
    if (error?.code === "DOTAIOS_PROJECT_SOURCE_AUDIT_FAILED") throw error;
    return publishRefusedRetrieval({ homePath, filesystem, task, known, error, options });
  }
}

async function resolveRetrievalProject({ aiosPath, filesystem, evidenceReader, projectSelector }) {
  const reader = evidenceReader || createEvidenceReader({ roots: [aiosPath], filesystem });
  const project = await resolvePortableProjectIdentity({
    aiosPath,
    projectSelector,
    evidenceReader: reader
  });
  return Object.freeze({ reader, project });
}

async function authorizeSelectedSource({ filesystem, source, state, stateCoordinates, now }) {
  const { binding, grant } = state;
  validateAuthorization({ source, binding, grant, now: now || (() => new Date()) });
  const rootBefore = await inspectRetrievalRootIdentity(binding.root_path, filesystem);
  if (!sameRootIdentity(rootBefore, binding.root_identity)) {
    throw sourceError("reconnect-required", "Project source binding changed; reconnect it.");
  }
  return Object.freeze({ binding, grant, rootBefore, stateCoordinates });
}

async function enumerateAndRecheck({
  aiosPath, filesystem, project, source, reader, binding, grant, rootBefore, stateCoordinates
}) {
  const references = await enumerateSourceMetadata({
    rootPath: binding.root_path,
    projectId: project.id,
    sourceId: source.source_id,
    filesystem
  });
  const [rootAfter, sourceAfter, stateAfter] = await Promise.all([
    inspectRetrievalRootIdentity(binding.root_path, filesystem),
    readSourceDeclaration({ aiosPath, project, evidenceReader: reader }, source.source_id),
    readAuthorizationSnapshot(stateCoordinates)
  ]);
  if (!retrievalStateUnchanged({ rootBefore, rootAfter, source, sourceAfter, binding, stateAfter })) {
    throw sourceError("source-changed", "Project source changed while it was being resolved.");
  }
  if (stableJson(stateAfter.grant) !== stableJson(grant)) {
    throw sourceError("authorization-changed", "Project source authorization changed while it was being resolved.");
  }
  return references;
}

async function inspectRetrievalRootIdentity(rootPath, filesystem) {
  try {
    return await inspectRootIdentity(rootPath, filesystem);
  } catch {
    throw sourceError("reconnect-required", "Project source binding changed; reconnect it.");
  }
}

function retrievalStateUnchanged({ rootBefore, rootAfter, source, sourceAfter, binding, stateAfter }) {
  return sameRootIdentity(rootBefore, rootAfter)
    && sourceAfter.revision === source.revision
    && sourceAfter.purpose === source.purpose
    && stableJson(stateAfter.binding) === stableJson(binding);
}

async function publishAllowedRetrieval({ homePath, filesystem, project, source, grant, references, task, options }) {
  const receipt = createAccessReceipt({
    decision: "allowed",
    task,
    projectId: project.id,
    project: project.slug,
    sourceId: source.source_id,
    grant: publicGrantSnapshot(grant),
    references,
    createId: options.createId,
    now: options.now
  });
  const result = allowedResult(receipt);
  if (JSON.stringify(result).length > MAX_RESULT_CHARACTERS) {
    throw sourceError("result-too-large", "Complete project source results exceed the output bound.");
  }
  if (!accessReceiptFitsPublicationBound(receipt)) {
    throw sourceError("result-too-large", "Complete project source results exceed the output bound.");
  }
  await appendAccessReceipt({ homePath, receipt, filesystem });
  return result;
}

async function publishRefusedRetrieval({ homePath, filesystem, task, known, error, options }) {
  const receipt = createAccessReceipt({
    decision: "refused",
    reason: stableReason(error),
    task,
    projectId: known.projectId,
    project: known.project,
    sourceId: known.sourceId,
    grant: known.grant,
    references: [],
    createId: options.createId,
    now: options.now
  });
  await appendAccessReceipt({ homePath, receipt, filesystem });
  return refusedResult(receipt);
}

export function validateSourceId(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    throw sourceError("source-id-invalid", "source id must use 1-64 lowercase letters, numbers, and single hyphens");
  }
  return value;
}

export function validateTask(value) {
  if (typeof value !== "string") throw taskSyntaxError();
  const codePoints = Array.from(value);
  if (
    codePoints.length < 1
    || codePoints.length > TASK_MAX_CODE_POINTS
    || /\p{Cc}/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw taskSyntaxError();
  }
  return value;
}

async function sourceContext(options) {
  const aiosPath = path.resolve(options.aiosPath);
  const homePath = path.resolve(options.homePath);
  const filesystem = options.filesystem || fs;
  await assertIndependentProjectSourceState(aiosPath, homePath, filesystem);
  const evidenceReader = options.evidenceReader || createEvidenceReader({ roots: [aiosPath], filesystem });
  const project = await resolvePortableProjectIdentity({
    aiosPath,
    projectSelector: options.projectSelector,
    evidenceReader
  });
  return { aiosPath, homePath, filesystem, evidenceReader, project };
}

async function assertIndependentProjectSourceState(aiosPath, homePath, filesystem) {
  const stateRoot = projectSourceStatePaths(homePath).root;
  const [canonicalAios, canonicalStateRoot] = await Promise.all([
    canonicalPathFromExistingAncestor(aiosPath, filesystem),
    canonicalPathFromExistingAncestor(stateRoot, filesystem)
  ]);
  if (pathsOverlap(canonicalAios, canonicalStateRoot)) {
    throw sourceError(
      "state-root-overlap",
      "Machine-local project source state must remain outside the portable AIOS."
    );
  }
}

async function canonicalPathFromExistingAncestor(candidate, filesystem) {
  let ancestor = path.resolve(candidate);
  const missingSegments = [];
  while (true) {
    try {
      const canonicalAncestor = await filesystem.realpath(ancestor);
      return path.join(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(candidate);
      missingSegments.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function readCoordinateState(context, sourceId, filesystem) {
  return readProjectSourceState({
    homePath: context.homePath,
    projectId: context.project.id,
    sourceId,
    filesystem
  });
}

async function inspectSourceRoot(folder, context, filesystem) {
  if (typeof folder !== "string" || !folder) throw sourceError("root-invalid", "A local source folder is required.");
  const rootPath = path.resolve(folder);
  let canonicalRoot;
  let canonicalAios;
  try {
    [canonicalRoot, canonicalAios] = await Promise.all([
      filesystem.realpath(rootPath),
      filesystem.realpath(context.aiosPath)
    ]);
  } catch {
    throw sourceError("root-invalid", "The local source folder is unavailable.");
  }
  const canonicalStateRoot = await canonicalPathFromExistingAncestor(
    projectSourceStatePaths(context.homePath).root,
    filesystem,
  );
  if (pathsOverlap(canonicalRoot, canonicalAios) || pathsOverlap(canonicalRoot, canonicalStateRoot)) {
    throw sourceError("root-overlap", "The local source folder overlaps protected DotAIOS state.");
  }
  return { path: canonicalRoot, identity: await inspectRootIdentity(canonicalRoot, filesystem) };
}

async function inspectRootIdentity(rootPath, filesystem) {
  try {
    const stats = await filesystem.lstat(rootPath, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw sourceError("root-invalid", "The local source folder is unavailable.");
    return Object.freeze({ type: "directory", dev: stats.dev.toString(), ino: stats.ino.toString() });
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw sourceError("root-access-denied", "The local source folder is unavailable.");
  }
}

async function selectSource({ aiosPath, project, task, evidenceReader }) {
  const sourcesPath = path.join(aiosPath, "projects", project.slug, "sources");
  let entries;
  try {
    entries = await evidenceReader.listDirectory(aiosPath, sourcesPath, {
      maxEntries: MAX_SOURCE_DECLARATIONS,
    });
  } catch (error) {
    if (error?.code === "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE") {
      throw sourceError(
        "source-declaration-bound-exceeded",
        "Project source declarations exceed the bounded catalog size.",
      );
    }
    throw error;
  }
  const declarationEntries = entries.filter((entry) => path.extname(entry.name) === ".md");
  if (declarationEntries.length > MAX_SOURCE_DECLARATIONS) {
    throw sourceError(
      "source-declaration-bound-exceeded",
      "Project source declarations exceed the bounded catalog size."
    );
  }
  let candidates = [];
  for (const entry of declarationEntries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw sourceError("source-declaration-invalid", "Project source declaration is invalid.");
    }
    const sourceId = validateSourceId(path.basename(entry.name, ".md"));
    const source = await readSourceDeclaration({ aiosPath, project, evidenceReader }, sourceId);
    const match = matchQuery(`${source.label}\n${source.purpose}`, task);
    if (match.matched) candidates = [...candidates, { source, match }];
  }
  if (candidates.length === 0) throw sourceError("source-no-match", "No project source matches the task.");
  candidates = candidates.toSorted((left, right) => (
    (MATCH_TIERS[right.match.kind] - MATCH_TIERS[left.match.kind])
    || (right.match.score - left.match.score)
    || Buffer.compare(Buffer.from(left.source.source_id), Buffer.from(right.source.source_id))
  ));
  if (
    candidates.length > 1
    && MATCH_TIERS[candidates[0].match.kind] === MATCH_TIERS[candidates[1].match.kind]
    && candidates[0].match.score === candidates[1].match.score
  ) {
    throw sourceError("source-ambiguous", "Multiple project sources match the task equally.");
  }
  return candidates[0].source;
}

async function readSourceDeclaration(context, sourceId) {
  const filePath = sourceDeclarationPath(context.aiosPath, context.project.slug, sourceId);
  let declaration;
  try {
    declaration = await context.evidenceReader.readText(context.aiosPath, filePath, {
      maxBytes: MAX_SOURCE_DECLARATION_BYTES
    });
  } catch (error) {
    if (String(error?.code || "").startsWith("DOTAIOS_EVIDENCE_")) {
      throw sourceError("source-declaration-invalid", "Project source declaration is invalid.");
    }
    throw error;
  }
  if (declaration === null) throw sourceError("source-missing", "Project source declaration is missing.");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?$/.exec(declaration);
  if (!match) throw sourceError("source-declaration-invalid", "Project source declaration is invalid.");
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw sourceError("source-declaration-invalid", "Project source declaration is invalid.");
  const value = document.toJS();
  if (
    !exactFields(value, [
      "version", "project_id", "project", "source_id", "label", "type", "purpose", "revision"
    ])
    ||
    value?.version !== SOURCE_VERSION
    || value?.project_id !== context.project.id
    || value?.project !== context.project.slug
    || value?.source_id !== sourceId
    || value?.type !== "local-folder"
    || !Number.isSafeInteger(value?.revision)
    || value.revision < 1
  ) {
    throw sourceError("source-declaration-invalid", "Project source declaration is invalid.");
  }
  return Object.freeze({
    version: value.version,
    project_id: value.project_id,
    project: value.project,
    source_id: validateSourceId(value.source_id),
    label: validateBoundedText(value.label, "label", 200),
    type: value.type,
    purpose: validateBoundedText(value.purpose, "purpose", 500),
    revision: value.revision
  });
}

function exactFields(value, expected) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((field) => expected.includes(field))
  );
}

function validateAuthorization({ source, binding, grant, now }) {
  if (!binding) throw sourceError("binding-missing", "Project source binding is missing.");
  if (!grant) throw sourceError("grant-missing", "Project source grant is missing.");
  if (
    grant.project_id !== source.project_id
    || grant.source_id !== source.source_id
    || grant.scope !== "read"
  ) {
    throw sourceError("grant-scope-mismatch", "Project source grant scope does not match this operation.");
  }
  if (grant.purpose !== source.purpose) {
    throw sourceError("purpose-mismatch", "Project source grant purpose no longer matches.");
  }
  if (grant.revoked_at) throw sourceError("grant-revoked", "Project source grant was revoked.");
  const expiresAt = Date.parse(grant.expires_at);
  const approvedAt = Date.parse(grant.approved_at);
  const evaluatedAt = now().getTime();
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) {
    throw sourceError("grant-invalid", "Project source grant is not valid for this operation.");
  }
  if (expiresAt <= evaluatedAt || expiresAt <= approvedAt) {
    throw sourceError("grant-expired", "Project source grant has expired.");
  }
  if (approvedAt > evaluatedAt) {
    throw sourceError("grant-invalid", "Project source grant is not valid for this operation.");
  }
  if (grant.source_revision !== source.revision) {
    throw sourceError("source-revision-mismatch", "Project source grant is for another source revision.");
  }
  if (
    grant.binding_generation !== binding.generation
    || stableJson(grant.root_identity) !== stableJson(binding.root_identity)
  ) {
    throw sourceError("binding-revision-mismatch", "Project source grant is for another binding revision.");
  }
}

async function enumerateSourceMetadata({ rootPath, projectId, sourceId, filesystem }) {
  const budget = createContainedReadBudget({ maxBytes: 0, maxFiles: 0, maxEntries: MAX_ENTRIES });
  const observation = await walkSourceDirectory({
    rootPath,
    directoryPath: rootPath,
    relativeDirectory: "",
    depth: 0,
    projectId,
    sourceId,
    filesystem,
    budget,
    observation: Object.freeze({ references: [], directories: [], files: [] })
  });
  await recheckSourceObservation(rootPath, observation, filesystem);
  return observation.references.toSorted(
    (left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
  );
}

async function recheckSourceObservation(rootPath, observation, filesystem) {
  for (const observed of observation.files) {
    const current = await inspectContainedFileMetadata(rootPath, observed.path, { filesystem });
    if (!sameContainedFileMetadataSnapshot(observed.snapshot, current)) {
      throw sourceError("source-changed", "Project source changed while it was being resolved.");
    }
  }
  for (const observed of observation.directories) {
    const current = await inspectContainedDirectory(rootPath, observed.path, {
      filesystem,
      returnSnapshot: true
    });
    if (!sameContainedDirectorySnapshot(observed.snapshot, current)) {
      throw sourceError("source-changed", "Project source changed while it was being resolved.");
    }
  }
}

async function walkSourceDirectory(context) {
  if (context.depth > MAX_DEPTH) {
    throw sourceError("source-bound-exceeded", "Project source exceeds the traversal bound.");
  }
  let observed;
  try {
    observed = await readContainedDirectory(context.rootPath, context.directoryPath, {
      filesystem: context.filesystem,
      budget: context.budget,
      maxEntries: MAX_ENTRIES,
      nameEncoding: "buffer",
      readdirOptions: { withFileTypes: true },
      returnSnapshot: true,
      tooManyCode: "DOTAIOS_PROJECT_SOURCE_BOUND_EXCEEDED"
    });
  } catch (error) {
    if (
      context.directoryPath === context.rootPath
      && (error?.code === "EACCES" || error?.code === "EPERM")
    ) {
      throw sourceError("reconnect-required", "Project source binding changed; reconnect it.");
    }
    throw error;
  }
  if (observed === null) throw sourceError("source-changed", "Project source changed while it was being resolved.");
  let observation = Object.freeze({
    ...context.observation,
    directories: [...context.observation.directories, {
      path: context.directoryPath,
      snapshot: observed.snapshot
    }]
  });
  for (const entry of observed.entries) {
    observation = await observeSourceEntry({ ...context, observation, entry });
  }
  return observation;
}

async function observeSourceEntry(context) {
  const name = decodeEntryName(context.entry.name);
  const relativePath = context.relativeDirectory ? `${context.relativeDirectory}/${name}` : name;
  if (Buffer.byteLength(relativePath) > MAX_PATH_BYTES) {
    throw sourceError("source-bound-exceeded", "Project source path exceeds the traversal bound.");
  }
  const absolutePath = path.join(context.directoryPath, name);
  if (context.entry.isSymbolicLink()) {
    throw sourceError("source-unsafe-entry", "Project source contains an unsafe entry.");
  }
  if (context.entry.isDirectory()) {
    await inspectContainedDirectory(context.rootPath, absolutePath, { filesystem: context.filesystem });
    return walkSourceDirectory({
      ...context,
      directoryPath: absolutePath,
      relativeDirectory: relativePath,
      depth: context.depth + 1
    });
  }
  if (!context.entry.isFile()) throw sourceError("source-unsafe-entry", "Project source contains an unsafe entry.");
  if (context.observation.references.length >= MAX_FILES) {
    throw sourceError("source-bound-exceeded", "Project source exceeds the file bound.");
  }
  let snapshot;
  try {
    snapshot = await inspectContainedFileMetadata(context.rootPath, absolutePath, {
      filesystem: context.filesystem
    });
  } catch (error) {
    if (error?.code === "DOTAIOS_EVIDENCE_NOT_REGULAR_FILE") {
      throw sourceError("source-unsafe-entry", "Project source contains an unsafe entry.");
    }
    throw error;
  }
  return Object.freeze({
    ...context.observation,
    files: [...context.observation.files, { path: absolutePath, snapshot }],
    references: [...context.observation.references, sourceReference(context, relativePath, snapshot)]
  });
}

function sourceReference(context, relativePath, snapshot) {
  return Object.freeze({
    project_id: context.projectId,
    source_id: context.sourceId,
    path: relativePath,
    type: "regular-file",
    size_bytes: snapshot.stats.size.toString(),
    mtime_ns: snapshot.stats.mtimeNs.toString()
  });
}

function decodeEntryName(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let name;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw sourceError("source-name-invalid", "Project source contains an unsupported name.");
  }
  if (!name || name === "." || name === ".." || /[\p{Cc}\/\\]/u.test(name)) {
    throw sourceError("source-name-invalid", "Project source contains an unsupported name.");
  }
  return name;
}

function renderSourceDeclaration({ projectId, project, sourceId, label, purpose, revision }) {
  return [
    "---",
    `version: ${SOURCE_VERSION}`,
    `project_id: ${JSON.stringify(projectId)}`,
    `project: ${JSON.stringify(project)}`,
    `source_id: ${JSON.stringify(sourceId)}`,
    `label: ${JSON.stringify(label)}`,
    "type: local-folder",
    `purpose: ${JSON.stringify(purpose)}`,
    `revision: ${revision}`,
    "---",
    ""
  ].join("\n");
}

async function publishPortableSource(plan, filesystem) {
  const destination = sourceDeclarationPath(plan.aios_path, plan.project, plan.source_id);
  const directory = path.dirname(destination);
  await assertPortableSourceDirectory(plan, directory, filesystem);
  const existing = await lstatIfPresent(filesystem, destination);
  if (existing) throw sourceError("stale-plan", "Project source apply plan is stale.");
  const temporary = path.join(directory, `.${plan.source_id}.${plan.operation_id}.tmp`);
  try {
    const handle = await filesystem.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(plan.declaration, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await filesystem.link(temporary, destination);
    const directoryHandle = await filesystem.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await filesystem.rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertPortableSourceDirectory(plan, directory, filesystem) {
  await filesystem.mkdir(directory, { recursive: true });
  try {
    const [stats, canonicalAios, canonicalDirectory] = await Promise.all([
      filesystem.lstat(directory),
      filesystem.realpath(plan.aios_path),
      filesystem.realpath(directory),
    ]);
    const expectedDirectory = path.join(canonicalAios, "projects", plan.project, "sources");
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || path.resolve(canonicalDirectory) !== path.resolve(expectedDirectory)
    ) {
      throw sourceError("stale-plan", "Project source apply plan is stale.");
    }
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw sourceError("stale-plan", "Project source apply plan is stale.");
  }
}

function publicMutationResult(plan, additions = {}) {
  return Object.freeze({
    version: plan.version,
    operation: plan.operation,
    applied: additions.applied ?? plan.applied,
    operation_id: plan.operation_id,
    plan_fingerprint: plan.plan_fingerprint,
    ...(plan.grant_id ? { grant_id: plan.grant_id } : {}),
    project_id: plan.project_id,
    project: plan.project,
    source_id: plan.source_id,
    ...(plan.label ? { label: plan.label } : {}),
    ...(plan.purpose ? { purpose: plan.purpose } : {}),
    ...(plan.scope ? { scope: plan.scope } : {}),
    ...(Object.hasOwn(plan, "approved_at") ? { approved_at: additions.approved_at ?? plan.approved_at } : {}),
    ...(Object.hasOwn(plan, "revoked_at") ? { revoked_at: additions.revoked_at ?? plan.revoked_at } : {}),
    ...(plan.expires_at ? { expires_at: plan.expires_at } : {}),
    ...(plan.recovery ? { recovery: true } : {}),
    ...(plan.portable_path ? { portable: { path: plan.portable_path } } : {}),
    machine_local: plan.machine_local,
    ...additions
  });
}

function allowedResult(receipt) {
  return Object.freeze({
    decision: receipt.decision,
    project_id: receipt.project_id,
    project: receipt.project,
    source_id: receipt.source_id,
    receipt_id: receipt.receipt_id,
    resolved_at: receipt.resolved_at,
    references: receipt.references
  });
}

function refusedResult(receipt) {
  return Object.freeze({
    decision: receipt.decision,
    reason: receipt.reason,
    receipt_id: receipt.receipt_id,
    resolved_at: receipt.resolved_at,
    ...(receipt.project_id ? { project_id: receipt.project_id } : {}),
    ...(receipt.project ? { project: receipt.project } : {}),
    ...(receipt.source_id ? { source_id: receipt.source_id } : {}),
    references: []
  });
}

function publicGrantSnapshot(grant) {
  return Object.freeze({
    grant_id: grant.grant_id,
    revision: grant.revision,
    scope: grant.scope,
    purpose: grant.purpose,
    approved_at: grant.approved_at,
    expires_at: grant.expires_at,
    source_revision: grant.source_revision,
    binding_generation: grant.binding_generation,
    root_identity: grant.root_identity,
    revoked_at: grant.revoked_at
  });
}

async function withSourceLock(plan, options, callback) {
  const filesystem = options.filesystem || fs;
  try {
    const result = await withOperationLock(
      sourceStateLockPath(plan.home_path, plan.project_id, plan.source_id),
      callback,
      {
        filesystem,
        format: SOURCE_LOCK_FORMAT,
        strictOwnedState: true,
        ownedDirectories: projectSourceOwnedDirectories(plan.home_path, "locks"),
        retainOnError: (error) => error?.retainOperationLock === true
      }
    );
    if (!result.acquired) throw sourceError("source-busy", "Project source is busy.");
    return result.value;
  } catch (error) {
    if (error instanceof ProjectSourceError || String(error?.code || "").startsWith("DOTAIOS_")) throw error;
    throw new ProjectSourceError(
      "DOTAIOS_PROJECT_SOURCE_APPLY_FAILED",
      "Project source change could not be applied safely."
    );
  }
}

async function readAuthorizationSnapshot(stateCoordinates) {
  const { homePath, projectId, sourceId, filesystem } = stateCoordinates;
  try {
    const result = await withOperationLock(
      sourceStateLockPath(homePath, projectId, sourceId),
      () => readProjectSourceAuthorizationSnapshotUnderLock(stateCoordinates),
      {
        filesystem,
        format: SOURCE_LOCK_FORMAT,
        strictOwnedState: true,
        ownedDirectories: projectSourceOwnedDirectories(homePath, "locks")
      }
    );
    if (!result.acquired) throw sourceError("authorization-state-invalid", "Project source authorization is busy.");
    return result.value;
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw sourceError("authorization-state-invalid", "Project source authorization is unavailable.");
  }
}

function assertExactApply(options, plan) {
  if (!options.operationId || !options.planFingerprint) {
    throw sourceError("apply-proof-required", "Apply requires the displayed operation id and plan fingerprint.");
  }
  assertFingerprint(options.planFingerprint, plan.plan_fingerprint);
}

function assertFingerprint(actual, expected) {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual) || actual !== expected) {
    throw sourceError("stale-plan", "Project source apply plan is stale.");
  }
}

function validateIdentifier(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9-]{1,64}$/.test(value)) {
    throw sourceError(`${field}-invalid`, `${field.replaceAll("-", " ")} is invalid`);
  }
  return value;
}

function validateOperationId(value) {
  return validateIdentifier(value, "operation-id");
}

function validateGrantId(value) {
  return validateIdentifier(value, "grant-id");
}

function validateBoundedText(value, name, maximum) {
  if (
    typeof value !== "string"
    || Array.from(value).length < 1
    || Array.from(value).length > maximum
    || /\p{Cc}/u.test(value)
    || /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw sourceError(`${name}-invalid`, `${name} must be 1-${maximum} safe code points`);
  }
  return value;
}

function validateFutureUtc(value, now) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || Date.parse(value) <= now().getTime()
  ) {
    throw sourceError("expiry-invalid", "expires-at must be an explicit future UTC timestamp");
  }
  return new Date(value).toISOString();
}

function sourceDeclarationPath(aiosPath, projectSlug, sourceId) {
  return path.join(aiosPath, "projects", projectSlug, "sources", `${validateSourceId(sourceId)}.md`);
}

function pathsOverlap(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  const relativeLeft = path.relative(leftPath, rightPath);
  const relativeRight = path.relative(rightPath, leftPath);
  return relativeLeft === ""
    || (!relativeLeft.startsWith(`..${path.sep}`) && relativeLeft !== ".." && !path.isAbsolute(relativeLeft))
    || (!relativeRight.startsWith(`..${path.sep}`) && relativeRight !== ".." && !path.isAbsolute(relativeRight));
}

async function lstatIfPresent(filesystem, filePath) {
  try {
    return await filesystem.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameRootIdentity(left, right) {
  return left?.type === right?.type && left?.dev === right?.dev && left?.ino === right?.ino;
}

function stableReason(error) {
  if (error instanceof ProjectSourceError) return error.details.reason || error.code.replace(/^DOTAIOS_/, "").toLowerCase();
  if (error?.code === "DOTAIOS_PROJECT_SOURCE_STATE_INVALID") return "authorization-state-invalid";
  if (
    error?.code === "DOTAIOS_CONTEXT_SOURCE_CHANGED"
    || error?.code === "DOTAIOS_EVIDENCE_CHANGED"
  ) return "source-changed";
  if (
    error?.code === "DOTAIOS_PROJECT_SOURCE_BOUND_EXCEEDED"
    || error?.code === "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED"
  ) return "source-bound-exceeded";
  if (typeof error?.code === "string" && error.code.startsWith("DOTAIOS_PROJECT_SELECTOR_")) {
    return error.code.replace("DOTAIOS_PROJECT_SELECTOR_", "project-").toLowerCase();
  }
  return "source-unavailable";
}

function sourceError(reason, message) {
  return new ProjectSourceError("DOTAIOS_PROJECT_SOURCE_REFUSED", message, { reason });
}

function taskSyntaxError() {
  return new ProjectSourceError(
    "DOTAIOS_PROJECT_SOURCE_TASK_INVALID",
    "task must contain 1-500 code points without control characters"
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
