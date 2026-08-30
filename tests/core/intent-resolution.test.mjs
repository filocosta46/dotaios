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
  assert.deepEqual(result.project_route, {
    status: "not_evaluated",
    reason: "tool_selector_precedence",
    project: null,
    match: null,
    routability: null,
    route: null
  });
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
    intent: "Prepare the client's approved launch."
  }, {
    resolveProjectRoute: async () => ({
      status: "candidate",
      project: {
        id: "project-client-001",
        slug: "client-work",
        name: "client-work",
        purpose: "Prepare the client's approved launch.",
        repository: "https://github.com/customer/client-work.git",
        placement: "external"
      },
      match: { kind: "purpose_overlap", confidence: 1, fields: ["purpose"] },
      routability: {
        trust: "registered-user-owned",
        effect: "unknown",
        approval: "direct_user_required",
        conventions: [{ kind: "agents-md", resource: "AGENTS.md" }]
      },
      route: null,
      reason: "unique_registered_project_match"
    })
  });

  assert.equal(result.status, "partial");
  assert.equal(result.project, null);
  assert.equal(result.project_route.status, "candidate");
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

test("EPR-012 and EPR-015: exact native route survives an AIOS skill no-match", async (t) => {
  const { resolveIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent: "xyzzy quux",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  }, { clock: () => new Date("2026-08-29T08:00:00.000Z") });

  assert.equal(result.project_route.status, "ready");
  assert.equal(result.skill.status, "no_match");
  assert.equal(Object.hasOwn(result, "tool"), false);
  assert.equal(result.location, fixture.projectPath);
  assert.equal(result.status, "partial");
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
  assert.equal(unknown.status, "partial");
  assert.equal(unknown.project_route.status, "no_match");
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

  const primary = await resolveIntentResolution({ ...fixture, cwd: child, intent: "plan my day" });
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
    intent: "plan my day"
  });
  assert.equal(ambiguousCwd.status, "partial");
  assert.equal(ambiguousCwd.project_route.status, "ambiguous");
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
  const options = {
    ...fixture,
    project: "client-work",
    intent: "plan my day",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  };
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
      supportedConventionKinds: ["agents-md", "repository-skill"],
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

test("EPR-012: final exact revalidation cannot grow the envelope beyond its budget", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const initialRoute = readyProjectRoute(fixture);
  const expandedRoute = structuredClone(initialRoute);
  expandedRoute.routability.conventions.push(...Array.from(
    { length: 64 },
    (_, index) => ({
      kind: "repository-skill",
      resource: `.agents/skills/unhandled-${String(index).padStart(2, "0")}/SKILL.md`
    })
  ));
  const options = {
    ...fixture,
    project: "client-work",
    intent: "plan my day",
    supportedConventionKinds: ["agents-md"]
  };
  const fixedClock = () => new Date("2026-08-29T08:00:00.000Z");
  const baseline = await resolveIntentResolution({
    ...options,
    visibleCharacterBudget: 32000
  }, {
    clock: fixedClock,
    resolveProjectRoute: async () => structuredClone(initialRoute)
  });
  const tightBudget = renderIntentResolution(baseline).length;
  let routeReads = 0;

  const result = await resolveIntentResolution({
    ...options,
    visibleCharacterBudget: tightBudget
  }, {
    clock: fixedClock,
    resolveProjectRoute: async () => structuredClone(
      routeReads++ === 0 ? initialRoute : expandedRoute
    )
  });
  const rendered = renderIntentResolution(result);

  assert.equal(routeReads, 2);
  assert.ok(rendered.length <= tightBudget, `${rendered.length} must fit ${tightBudget}`);
  assert.equal(result.budget.used, rendered.length);
  assert.equal(result.status, "refused");
  assert.equal(result.location, null);
  assert.equal(result.next_action.summary, "fixed_envelope_exceeds_budget");
});

test("EPR-012 and EPR-014: final exact revalidation compares the complete public project identity", async (t) => {
  const {
    resolveIntentResolution,
    renderIntentResolution
  } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const initialRoute = readyProjectRoute(fixture);
  const mutations = [
    ["name", "Replaced client workspace"],
    ["purpose", "A concurrently replaced purpose."],
    ["placement", "managed"]
  ];

  for (const [field, replacement] of mutations) {
    await t.test(field, async () => {
      const finalRoute = structuredClone(initialRoute);
      finalRoute.project[field] = replacement;
      let routeReads = 0;
      const result = await resolveIntentResolution({
        ...fixture,
        project: "client-work",
        intent: "plan my day",
        supportedConventionKinds: ["agents-md"],
        visibleCharacterBudget: 8000
      }, {
        clock: () => new Date("2026-08-29T08:00:00.000Z"),
        resolveProjectRoute: async () => structuredClone(
          routeReads++ === 0 ? initialRoute : finalRoute
        )
      });
      const rendered = renderIntentResolution(result);

      assert.equal(routeReads, 2);
      assert.equal(result.status, "refused");
      assert.equal(result.location, null);
      assert.equal(result.project_route.status, "refused");
      assert.equal(result.project_route.route, null);
      assert.doesNotMatch(
        rendered,
        new RegExp(fixture.projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      );
    });
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
  assert.deepEqual(result.project_route, {
    status: "not_evaluated",
    reason: "tool_selector_precedence",
    project: null,
    match: null,
    routability: null,
    route: null
  });
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

test("an unreadable local routing authority returns one path-free fixed refusal", async (t) => {
  const { resolveIntentResolution, renderIntentResolution } = await import("../../packages/core/src/intent-resolution.mjs");
  const fixture = await makeFixture(t);
  const skillPath = path.join(fixture.aiosPath, "skills", "plan-today", "SKILL.md");
  await fs.writeFile(skillPath, "---\nname: [broken\n---\n");

  const result = await resolveIntentResolution({
    ...fixture,
    project: "client-work",
    intent: "plan my day",
    supportedConventionKinds: ["agents-md", "repository-skill"]
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

function readyProjectRoute(fixture) {
  return {
    status: "ready",
    project: {
      id: "project-client-001",
      slug: "client-work",
      name: "client-work",
      purpose: "Prepare the client's approved launch.",
      repository: "https://github.com/customer/client-work",
      placement: "external"
    },
    match: { kind: "exact_handle", confidence: 1, fields: ["stable_id"] },
    routability: {
      trust: "registered-user-owned",
      effect: "unknown",
      approval: "direct_user_required",
      conventions: [{ kind: "agents-md", resource: "AGENTS.md" }]
    },
    route: {
      kind: "project-native",
      project_id: "project-client-001",
      project_slug: "client-work",
      location: fixture.projectPath,
      advisory: true,
      revalidate_before_entry: true,
      fresh_context_required: true,
      conventions: [{
        kind: "agents-md",
        resource: "AGENTS.md",
        observed_identity: {
          type: "file",
          dev: "101",
          ino: "201",
          mode: 33188,
          nlink: 1,
          size: "128",
          mtime_ns: "1788000000000000000",
          ctime_ns: "1788000000000000000"
        }
      }]
    },
    reason: "exact_project_ready"
  };
}
