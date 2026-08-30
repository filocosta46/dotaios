import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../../packages/core/src/projects.mjs";

async function registerApprovedProject(options) {
  const preview = await registerProject({ ...options, apply: false, yes: false });
  return registerProject({
    ...options,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true,
    yes: false
  });
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-intent-resolution-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "client-work");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");
  await registerApprovedProject({
    aiosPath,
    homePath,
    projectPath,
    slug: "client-work",
    purpose: "Prepare the client's approved launch.",
    createId: () => "project-client-001",
    readRepoUrl: async () => null,
    apply: true
  });
  await fs.mkdir(path.join(aiosPath, "skills", "plan-today"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "plan-today", "SKILL.md"),
    "---\nname: plan-today\ndescription: Plan the day.\ntriggers: [plan my day]\n---\n# Plan today\n"
  );
  await fs.mkdir(path.join(aiosPath, "connections", "apis"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "connections", "apis", "google-workspace.md"), "configured\n");
  return { root, aiosPath, homePath, projectPath };
}

async function addProject(fixture, { slug, id, purpose }) {
  const projectPath = path.join(fixture.root, slug);
  await fs.mkdir(projectPath, { recursive: true });
  await registerApprovedProject({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectPath,
    slug,
    purpose,
    createId: () => id,
    readRepoUrl: async () => null,
    apply: true
  });
  return projectPath;
}

test("one local call returns the verified project, context, skill, configured tool, and approval state", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);

  const result = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.projectPath,
    intent: "plan my day",
    tool: { capability: "google.gmail.inbox" },
    visibleCharacterBudget: 8000
  }, {
    clock: () => new Date("2026-08-29T08:00:00.000Z")
  });

  assert.equal(result.schema, "dotaios.intent-resolution/v1");
  assert.equal(result.status, "matched");
  assert.deepEqual(result.project, {
    id: "project-client-001",
    slug: "client-work",
    name: "client-work",
    purpose: "Prepare the client's approved launch.",
    identity: "verified"
  });
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.equal(result.memory.scope, "client-work");
  assert.equal(result.skill.status, "matched");
  assert.equal(result.skill.name, "plan-today");
  assert.equal(result.skill.resource, "skills/plan-today/SKILL.md");
  assert.deepEqual(result.tool, {
    status: "matched",
    capability: "google.gmail.inbox",
    connection: "google-workspace",
    configured: true,
    authenticated: "unknown",
    argv_suffix: ["google", "inbox", "--json"]
  });
  assert.equal(result.next_action.state, "approval_required");
  assert.equal(result.next_action.approval, "direct_user_required");
  assert.equal(result.location, fixture.projectPath);
  assert.equal(Object.keys(result).at(-1), "location", "verified location is disclosed last");
});

test("skill and tool no-match remain explicit without suppressing the verified primary location", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const result = await resolveIntentResolution({
    ...fixture,
    project: "project-client-001",
    intent: "xyzzy quux",
    tool: { capability: "google.chat.read" }
  }, { clock: () => new Date("2026-08-29T08:00:00.000Z") });

  assert.equal(result.status, "partial");
  assert.equal(result.skill.status, "no_match");
  assert.equal(result.tool.status, "no_match");
  assert.equal(result.location, fixture.projectPath);
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.equal(result.memory.context.includes("Memory: Shared"), false);
});

test("a replaced primary root returns a path-free refusal with no Shared fallback", async (t) => {
  const { resolveIntentResolution, renderIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  await fs.rename(fixture.projectPath, `${fixture.projectPath}-replaced`);
  await fs.mkdir(fixture.projectPath);

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent: "plan my day"
  });
  const rendered = renderIntentResolution(result);

  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.doesNotMatch(rendered, new RegExp(fixture.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rendered, /Memory: Shared/);
});

test("a forged mapping inside the AIOS folder is not accepted as a primary location", async (t) => {
  const { resolveIntentResolution, renderIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const unsafePath = path.join(fixture.aiosPath, "inside-primary");
  await fs.mkdir(unsafePath);
  const stats = await fs.lstat(unsafePath, { bigint: true });
  const statePath = path.join(fixture.homePath, ".dotaios", "projects.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.paths["project-client-001"] = {
    path: unsafePath,
    root_identity: { type: "directory", dev: stats.dev.toString(), ino: stats.ino.toString() }
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent: "plan my day"
  });
  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.doesNotMatch(
    renderIntentResolution(result),
    new RegExp(unsafePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("unknown, detached, neighboring, and ambiguous selection refuse without choosing a project", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const neighbor = path.join(fixture.root, "neighbor");
  await fs.mkdir(neighbor);

  const unknown = await resolveIntentResolution({
    ...fixture,
    project: "missing-project",
    intent: "plan my day"
  });
  const detached = await resolveIntentResolution({
    ...fixture,
    cwd: neighbor,
    intent: "plan my day"
  });
  assert.equal(unknown.status, "refused");
  assert.equal(detached.status, "refused");
  assert.equal(unknown.location, null);
  assert.equal(detached.location, null);

  const secondPath = await addProject(fixture, {
    slug: "second-work",
    id: "project-client-002",
    purpose: "Second project."
  });
  await fs.writeFile(
    path.join(fixture.aiosPath, "projects", "client-work", "README.md"),
    "---\nid: project-client-001\nproject: shared-name\nname: First\ndescription: First project.\nstatus: active\ndomain: [build]\nrepo_url: null\n---\n# First\n"
  );
  await fs.writeFile(
    path.join(fixture.aiosPath, "projects", "second-work", "README.md"),
    "---\nid: project-client-002\nproject: shared-name\nname: Second\ndescription: Second project.\nstatus: active\ndomain: [build]\nrepo_url: null\n---\n# Second\n"
  );
  const ambiguous = await resolveIntentResolution({
    ...fixture,
    project: "shared-name",
    intent: "plan my day"
  });
  assert.equal(ambiguous.status, "refused");
  assert.equal(ambiguous.location, null);
  assert.ok(secondPath.endsWith("second-work"));
});

test("current-directory inference requires one primary attachment and ignores supplemental or neighbor folders", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const child = path.join(fixture.projectPath, "work", "drafts");
  const supplemental = path.join(fixture.root, "supplemental-assets");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(supplemental);
  await fs.mkdir(path.join(fixture.aiosPath, "projects", "client-work", "sources"), { recursive: true });
  await fs.writeFile(
    path.join(fixture.aiosPath, "projects", "client-work", "sources", "assets.json"),
    `${JSON.stringify({ id: "assets", path: supplemental })}\n`
  );

  const primary = await resolveIntentResolution({ ...fixture, cwd: child, intent: "plan my day" });
  const supplementalAttempt = await resolveIntentResolution({ ...fixture, cwd: supplemental, intent: "plan my day" });
  assert.equal(primary.location, fixture.projectPath);
  assert.equal(supplementalAttempt.status, "refused");
  assert.equal(supplementalAttempt.location, null);

  const nestedPrimary = await addProject(fixture, {
    slug: "nested-primary",
    id: "project-nested-001",
    purpose: "A separately registered nested root."
  });
  const nestedChild = path.join(nestedPrimary, "inside");
  await fs.mkdir(nestedChild);
  // Move the separately registered root under the first one, then explicitly
  // re-register it so both identities are valid and cwd inference must refuse
  // rather than choosing the deepest/first attachment.
  const movedNested = path.join(fixture.projectPath, "nested-primary");
  await fs.rename(nestedPrimary, movedNested);
  await registerApprovedProject({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectPath: movedNested,
    slug: "nested-primary",
    purpose: "A separately registered nested root.",
    readRepoUrl: async () => null,
    apply: true
  });
  const ambiguousCwd = await resolveIntentResolution({
    ...fixture,
    cwd: path.join(movedNested, "inside"),
    intent: "plan my day"
  });
  assert.equal(ambiguousCwd.status, "refused");
  assert.equal(ambiguousCwd.location, null);
});

test("project-scoped context excludes another project's canaries and is deterministic with a fixed clock", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  await addProject(fixture, {
    slug: "other-work",
    id: "project-other-001",
    purpose: "OTHER_PROJECT_PURPOSE_CANARY"
  });
  const sessions = path.join(fixture.aiosPath, "memory", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "index.jsonl"), [
    JSON.stringify({ session_id: "one", project: "client-work", captured_at: "2026-08-29T07:00:00.000Z", title: "CLIENT_CONTEXT_CANARY", agent: "codex", turns: 2 }),
    JSON.stringify({ session_id: "two", project: "other-work", captured_at: "2026-08-29T07:30:00.000Z", title: "OTHER_CONTEXT_CANARY", agent: "codex", turns: 3 })
  ].join("\n"));
  const options = { ...fixture, project: "client-work", intent: "plan my day" };
  const dependencies = { clock: () => new Date("2026-08-29T08:00:00.000Z") };

  const first = await resolveIntentResolution(options, dependencies);
  const second = await resolveIntentResolution(options, dependencies);
  assert.deepEqual(first, second);
  assert.match(first.memory.context, /CLIENT_CONTEXT_CANARY/);
  assert.doesNotMatch(JSON.stringify(first), /OTHER_CONTEXT_CANARY|OTHER_PROJECT_PURPOSE_CANARY|other-work/);
});

test("the closed envelope accepts only the 1,024 through 32,000 character budget and reports exact use", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  for (const budget of [1024, 32000]) {
    const result = await resolveIntentResolution({
      ...fixture,
      project: "client-work",
      intent: "plan my day",
      visibleCharacterBudget: budget
    }, { clock: () => new Date("2026-08-29T08:00:00.000Z") });
    const rendered = renderIntentResolution(result);
    assert.ok(rendered.length <= budget, `${rendered.length} must fit ${budget}`);
    assert.equal(result.budget.limit, budget);
    assert.equal(result.budget.used, rendered.length);
    if (result.status === "refused") assert.equal(result.location, null);
  }
  await assert.rejects(
    resolveIntentResolution({ ...fixture, intent: "plan my day", visibleCharacterBudget: 1023 }),
    /1024 to 32000/
  );
  await assert.rejects(
    resolveIntentResolution({ ...fixture, intent: "plan my day", visibleCharacterBudget: 32001 }),
    /1024 to 32000/
  );
});

test("an unreadable local routing authority returns one path-free fixed refusal", async (t) => {
  const { resolveIntentResolution, renderIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const skillPath = path.join(fixture.aiosPath, "skills", "plan-today", "SKILL.md");
  await fs.writeFile(skillPath, "---\nname: [broken\n---\n");

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent: "plan my day"
  });
  const rendered = renderIntentResolution(result);
  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.doesNotMatch(rendered, new RegExp(fixture.aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
