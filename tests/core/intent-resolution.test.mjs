import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../../packages/core/src/projects.mjs";

const run = promisify(execFile);

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
  await fs.writeFile(path.join(projectPath, "AGENTS.md"), "EXTERNAL_INSTRUCTION_CANARY\n");
  await run("git", ["-C", projectPath, "init", "-q"]);
  await run("git", ["-C", projectPath, "remote", "add", "origin", "https://github.com/customer/client-work.git"]);
  await registerApprovedProject({
    aiosPath,
    homePath,
    projectPath,
    slug: "client-work",
    purpose: "Prepare the client's approved launch.",
    createId: () => "project-client-001",
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
  await fs.writeFile(path.join(projectPath, "AGENTS.md"), "OTHER_EXTERNAL_INSTRUCTION_CANARY\n");
  await run("git", ["-C", projectPath, "init", "-q"]);
  await run("git", ["-C", projectPath, "remote", "add", "origin", `https://github.com/customer/${slug}.git`]);
  await registerApprovedProject({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    projectPath,
    slug,
    purpose,
    createId: () => id,
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
    clock: () => new Date("2026-08-29T08:00:00.000Z"),
    resolveProjectRoute: async () => {
      throw new Error("explicit Google tool precedence must skip project-native routing");
    }
  });

  assert.equal(result.schema, "dotaios.intent-resolution/v1");
  assert.equal(Object.hasOwn(result, "project_route"), false);
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
  assert.deepEqual(result.omissions, ["supplemental_project_sources_not_requested"]);
  assert.deepEqual(result.recovery, { required: false, action: null });
  assert.deepEqual(result.next_action, {
    state: "approval_required",
    approval: "direct_user_required",
    summary: "Review this recommendation and ask the user to approve before acting."
  });
  assert.equal(result.location, fixture.projectPath);
  assert.equal(Object.keys(result).at(-1), "location", "verified location is disclosed last");
});

test("EPR-012: implicit project candidate does not evaluate memory, AIOS skills, or tools", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  await fs.writeFile(
    path.join(fixture.aiosPath, "skills", "plan-today", "SKILL.md"),
    "---\nname: [this would fail if read\n---\n"
  );

  const result = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent: "Prepare the client's approved launch.",
    supportedConventionKinds: ["agents-md"]
  });

  assert.equal(result.status, "partial");
  assert.equal(result.project, null);
  assert.equal(result.project_route.status, "candidate");
  assert.match(result.project_route.approval_binding, /^[a-f0-9]{64}$/);
  assert.equal(result.memory.scope, null);
  assert.equal(result.memory.context, "");
  assert.equal(result.skill.status, "not_evaluated");
  assert.equal(Object.hasOwn(result, "tool"), false);
  assert.equal(result.location, null);
  assert.match(result.next_action.summary, /direct approval/i);
  assert.match(result.next_action.summary, /immediately.*exact resolution/i);
  assert.match(result.next_action.summary, /fresh context/i);
  assert.match(result.next_action.summary, /changing directory.*insufficient/i);
});

test("EPR-012: an unsupported host receives path-free guidance before memory or skill composition", async (t) => {
  const { resolveIntentResolution, renderIntentResolution } = await import(
    "../../packages/core/src/intent-resolution.mjs"
  );
  const fixture = await makeFixture(t);
  await fs.writeFile(
    path.join(fixture.aiosPath, "skills", "plan-today", "SKILL.md"),
    "---\nname: [this would fail if read\n---\n"
  );

  const result = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent: "Prepare the client's approved launch.",
    supportedConventionKinds: ["claude-md"]
  });
  const rendered = renderIntentResolution(result);

  assert.equal(result.status, "refused");
  assert.equal(result.project_route.status, "unsupported_by_host");
  assert.equal(result.project_route.reason, "no_supported_convention");
  assert.equal(result.location, null);
  assert.equal(result.memory.context, "");
  assert.equal(result.skill.status, "not_evaluated");
  assert.equal(Object.hasOwn(result, "tool"), false);
  assert.doesNotMatch(
    rendered,
    new RegExp(fixture.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("EPR-012 and EPR-015: exact native route survives an AIOS skill no-match", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await makeFixture(t);
  const intent = "Prepare the client's approved launch.";
  const support = ["agents-md", "repository-skill"];
  const candidate = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent,
    supportedConventionKinds: support
  });
  let exactRouteCalls = 0;

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent,
    supportedConventionKinds: support,
    approvalBinding: candidate.project_route.approval_binding
  }, {
    clock: () => new Date("2026-08-29T08:00:00.000Z"),
    resolveProjectRoute: async (request) => {
      exactRouteCalls += 1;
      return resolveProjectRoute(request);
    }
  });

  assert.equal(exactRouteCalls, 1, "exact success must not re-run the router");
  assert.equal(result.project_route.status, "ready");
  assert.equal(result.skill.status, "no_match");
  assert.equal(Object.hasOwn(result, "tool"), false);
  assert.equal(result.location, await fs.realpath(fixture.projectPath));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.next_action, {
    state: "fresh_context_required",
    approval: "not_applicable",
    summary: "Start a fresh context rooted at the verified project for the approved action; changing directory in this run is insufficient."
  });
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
  assert.equal(unknown.project_route.reason, "approval_binding_required");
  assert.equal(detached.status, "partial");
  assert.equal(detached.project_route.status, "no_match");
  assert.equal(unknown.location, null);
  assert.equal(detached.location, null);

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

  const primary = await resolveIntentResolution({
    ...fixture,
    cwd: child,
    intent: "Prepare the client's approved launch.",
    supportedConventionKinds: ["agents-md"]
  });
  const supplementalAttempt = await resolveIntentResolution({ ...fixture, cwd: supplemental, intent: "plan my day" });
  assert.equal(primary.project_route.status, "candidate");
  assert.equal(primary.location, null);
  assert.equal(supplementalAttempt.status, "partial");
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
    apply: true
  });
  const ambiguousCwd = await resolveIntentResolution({
    ...fixture,
    cwd: path.join(movedNested, "inside"),
    intent: "plan my day",
    supportedConventionKinds: ["agents-md"]
  });
  assert.equal(ambiguousCwd.status, "partial");
  assert.equal(ambiguousCwd.project_route.status, "no_match");
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
  const discoveryOptions = {
    ...fixture,
    cwd: fixture.root,
    intent: "Prepare the client's approved launch.",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  };
  const dependencies = { clock: () => new Date("2026-08-29T08:00:00.000Z") };
  const candidate = await resolveIntentResolution(discoveryOptions, dependencies);
  const options = {
    ...discoveryOptions,
    project: "client-work",
    approvalBinding: candidate.project_route.approval_binding
  };

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
  const intent = "Prepare the client's approved launch.";
  const supportedConventionKinds = ["agents-md", "repository-skill"];
  const candidate = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent,
    supportedConventionKinds
  });
  for (const budget of [1024, 32000]) {
    const result = await resolveIntentResolution({
      ...fixture,
      project: "client-work",
      intent,
      supportedConventionKinds,
      approvalBinding: candidate.project_route.approval_binding,
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

test("EPR-012 and EPR-014: exact requests refuse missing, malformed, stale, and action-mismatched bindings path-free", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const intent = "Prepare the client's approved launch.";
  const supportedConventionKinds = ["agents-md"];
  const candidate = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent,
    supportedConventionKinds
  });
  const cases = [
    ["missing", undefined, intent, "approval_binding_required"],
    ["malformed", "not-a-binding", intent, "approval_binding_required"],
    ["stale", "0".repeat(64), intent, "approval_binding_mismatch"],
    ["action-mismatched", candidate.project_route.approval_binding, "Prepare a different launch action.", "approval_binding_mismatch"]
  ];

  for (const budget of [1024, 8000]) {
    for (const [name, approvalBinding, exactIntent, reason] of cases) {
      await t.test(`${name} at budget ${budget}`, async () => {
        const result = await resolveIntentResolution({
          ...fixture,
          project: "client-work",
          intent: exactIntent,
          supportedConventionKinds,
          approvalBinding,
          visibleCharacterBudget: budget
        });
        const rendered = renderIntentResolution(result);

        assert.equal(result.status, "refused");
        assert.equal(result.project_route.reason, reason);
        assert.equal(result.location, null);
        assert.ok(rendered.length <= budget, `${name} rendered ${rendered.length} > ${budget}`);
        assert.doesNotMatch(
          rendered,
          new RegExp(fixture.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        );
      });
    }
  }
});

test("EPR-012: the compact explicit-tool refusal always fits the 1,024-character minimum", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);

  const result = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.projectPath,
    intent: "plan my day",
    tool: { capability: "google.gmail.inbox" },
    visibleCharacterBudget: 1024
  });
  const rendered = renderIntentResolution(result);

  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.ok(rendered.length <= 1024, `${rendered.length} must fit 1024`);
  assert.equal(Object.hasOwn(result, "project_route"), false);
  assert.deepEqual(result.skill, {
    status: "not_evaluated",
    name: null,
    resource: null,
    confidence: 0,
    reason: "project_not_verified"
  });
  assert.equal(result.budget.limit, 1024);
  assert.equal(result.budget.used, rendered.length);
});

test("EPR-012: a compact missing-project Google refusal preserves tool precedence", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);

  const result = await resolveIntentResolution({
    ...fixture,
    project: "missing-project",
    intent: "plan my day",
    tool: { capability: "google.gmail.inbox" },
    visibleCharacterBudget: 1024
  });
  const rendered = renderIntentResolution(result);

  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.ok(rendered.length <= 1024, `${rendered.length} must fit 1024`);
  assert.equal(Object.hasOwn(result, "project_route"), false);
  assert.deepEqual(result.skill, {
    status: "not_evaluated",
    name: null,
    resource: null,
    confidence: 0,
    reason: "project_not_verified"
  });
  assert.equal(result.budget.used, rendered.length);
});

test("EPR-012 and EPR-014: a compact exact-root refusal preserves its authority reason", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const intent = "Prepare the client's approved launch.";
  const supportedConventionKinds = ["agents-md"];
  const candidate = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent,
    supportedConventionKinds
  });
  await fs.rename(fixture.projectPath, `${fixture.projectPath}-replaced`);
  await fs.mkdir(fixture.projectPath);

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent,
    supportedConventionKinds,
    approvalBinding: candidate.project_route.approval_binding,
    visibleCharacterBudget: 1024
  });
  const rendered = renderIntentResolution(result);

  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.ok(rendered.length <= 1024, `${rendered.length} must fit 1024`);
  assert.deepEqual(result.project_route, {
    status: "refused",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason: "project_identity_unverified"
  });
  assert.deepEqual(result.skill, {
    status: "not_evaluated",
    name: null,
    resource: null,
    confidence: 0,
    reason: "project_route_not_ready"
  });
  assert.equal(result.budget.used, rendered.length);
  assert.doesNotMatch(
    rendered,
    new RegExp(fixture.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
});

test("an unreadable local routing authority returns one path-free fixed refusal", async (t) => {
  const { resolveIntentResolution, renderIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const intent = "Prepare the client's approved launch.";
  const supportedConventionKinds = ["agents-md", "repository-skill"];
  const candidate = await resolveIntentResolution({
    ...fixture,
    cwd: fixture.root,
    intent,
    supportedConventionKinds
  });
  const skillPath = path.join(fixture.aiosPath, "skills", "plan-today", "SKILL.md");
  await fs.writeFile(skillPath, "---\nname: [broken\n---\n");

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent,
    supportedConventionKinds,
    approvalBinding: candidate.project_route.approval_binding
  });
  const rendered = renderIntentResolution(result);
  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.equal(result.project_route.status, "refused");
  assert.equal(result.project_route.route, null);
  assert.equal(result.memory.receipt, "Memory: This project");
  assert.doesNotMatch(
    rendered,
    new RegExp(fixture.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.doesNotMatch(rendered, new RegExp(fixture.aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
