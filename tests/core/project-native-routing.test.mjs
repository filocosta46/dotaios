import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { registerProject } from "../../packages/core/src/projects.mjs";

const run = promisify(execFile);

test("EPR-003: project routing exposes one generic resolver interface", async () => {
  let routing = null;
  try {
    routing = await import("../../packages/core/src/project-native-routing.mjs");
  } catch {
    // The first RED cycle proves the generic module does not exist yet.
  }

  assert.equal(typeof routing?.resolveProjectRoute, "function");
});

test("EPR-003: ordinary intent returns one metadata-only registered project candidate", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const projects = [
    projectRecord({
      id: "project-launch-001",
      slug: "launch-work",
      name: "Launch work",
      purpose: "Prepare and track product launches.",
      repository: "https://github.com/customer/launch-work"
    }),
    projectRecord({
      id: "project-finance-001",
      slug: "finance-work",
      name: "Finance work",
      purpose: "Review invoices and reconcile accounts.",
      repository: "https://github.com/customer/finance-work"
    })
  ];
  const inspections = [];

  const result = await resolveProjectRoute({
    intent: "Prepare and track this product launch."
  }, {
    loadRegisteredProjects: async () => projects,
    inspectLiveRemote: async (project) => {
      inspections.push(["git", project.slug]);
      return project.repository;
    },
    inspectConventionInventory: async (project) => {
      inspections.push(["conventions", project.slug]);
      return [convention("agents-md", "AGENTS.md", project.slug === "launch-work" ? "201" : "301")];
    }
  });

  assert.deepEqual(result, {
    status: "candidate",
    project: {
      id: "project-launch-001",
      slug: "launch-work",
      name: "Launch work",
      purpose: "Prepare and track product launches.",
      repository: "https://github.com/customer/launch-work",
      placement: "external"
    },
    match: {
      kind: "purpose_overlap",
      confidence: 1,
      fields: ["purpose"]
    },
    routability: {
      trust: "registered-user-owned",
      effect: "unknown",
      approval: "direct_user_required",
      conventions: [{ kind: "agents-md", resource: "AGENTS.md" }]
    },
    route: null,
    reason: "unique_registered_project_match"
  });
  assert.deepEqual(inspections, [
    ["git", "launch-work"],
    ["git", "finance-work"],
    ["conventions", "launch-work"],
    ["conventions", "finance-work"]
  ]);
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects|command|argv|environment|content/);
});

test("EPR-003: ordinary intent can match the registered slug when the remote basename differs", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-acme-tax-001",
    slug: "acme-tax",
    name: "Quarterly filing workspace",
    purpose: "Prepare annual compliance records.",
    repository: "https://github.com/customer/ledger-worktree"
  });

  const result = await resolveProjectRoute({
    intent: "Please work in acme-tax"
  }, {
    loadRegisteredProjects: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "191")]
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "acme-tax");
  assert.deepEqual(result.match, {
    kind: "slug_overlap",
    confidence: 1,
    fields: ["slug"]
  });
});

test("EPR-001, EPR-005, and EPR-015: exact stable ID returns a freshly revalidated advisory route", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-launch-001",
    slug: "launch-work",
    name: "Launch work",
    purpose: "Prepare and track product launches.",
    repository: "https://github.com/customer/launch-work"
  });
  const allConventions = [
    convention("claude-md", "CLAUDE.md", "203"),
    convention("repository-skill", ".agents/skills/launch/SKILL.md", "202"),
    convention("agents-md", "AGENTS.md", "201")
  ];
  let catalogReads = 0;
  let remoteReads = 0;
  let conventionReads = 0;

  const result = await resolveProjectRoute({
    intent: "Prepare this launch.",
    projectSelector: "project-launch-001",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  }, {
    loadRegisteredProjects: async () => {
      catalogReads += 1;
      return [{ ...project, rootIdentity: { ...project.rootIdentity } }];
    },
    inspectLiveRemote: async () => {
      remoteReads += 1;
      return project.repository;
    },
    inspectConventionInventory: async () => {
      conventionReads += 1;
      return structuredClone(allConventions);
    }
  });

  assert.deepEqual(result, {
    status: "ready",
    project: {
      id: "project-launch-001",
      slug: "launch-work",
      name: "Launch work",
      purpose: "Prepare and track product launches.",
      repository: "https://github.com/customer/launch-work",
      placement: "external"
    },
    match: {
      kind: "exact_handle",
      confidence: 1,
      fields: ["stable_id"]
    },
    routability: {
      trust: "registered-user-owned",
      effect: "unknown",
      approval: "direct_user_required",
      conventions: [
        { kind: "agents-md", resource: "AGENTS.md" },
        { kind: "claude-md", resource: "CLAUDE.md" },
        { kind: "repository-skill", resource: ".agents/skills/launch/SKILL.md" }
      ]
    },
    route: {
      kind: "project-native",
      project_id: "project-launch-001",
      project_slug: "launch-work",
      location: "/customer/projects/launch-work",
      advisory: true,
      revalidate_before_entry: true,
      fresh_context_required: true,
      conventions: [
        convention("agents-md", "AGENTS.md", "201"),
        convention("repository-skill", ".agents/skills/launch/SKILL.md", "202")
      ]
    },
    reason: "exact_project_ready"
  });
  assert.equal(catalogReads, 2, "exact routing must re-read registered identity");
  assert.equal(remoteReads, 2, "exact routing must re-read the authoritative live remote");
  assert.equal(conventionReads, 2, "exact routing must re-observe convention identities");
});

test("EPR-015: a host refuses a project whose only convention it does not support", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-research-001",
    slug: "research-work",
    name: "Research work",
    purpose: "Collect public research sources.",
    repository: "https://github.com/customer/research-work"
  });

  const result = await resolveProjectRoute({
    intent: "Collect research sources.",
    projectSelector: "research-work",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  }, {
    loadRegisteredProjects: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("claude-md", "CLAUDE.md", "401")]
  });

  assert.equal(result.status, "unsupported_by_host");
  assert.equal(result.route, null);
  assert.equal(result.reason, "no_supported_convention");
  assert.deepEqual(result.routability.conventions, [{ kind: "claude-md", resource: "CLAUDE.md" }]);
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects\/research-work/);
});

test("EPR-004: colliding display-name matches are ambiguous and disclose handles only", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const projects = [
    projectRecord({
      id: "project-alpha-001",
      slug: "alpha-ops",
      name: "Customer operations",
      purpose: "Coordinate the alpha account.",
      repository: "https://github.com/customer/alpha-ops"
    }),
    projectRecord({
      id: "project-beta-001",
      slug: "beta-ops",
      name: "Customer operations",
      purpose: "Coordinate the beta account.",
      repository: "https://github.com/customer/beta-ops"
    })
  ];

  const result = await resolveProjectRoute({
    intent: "Use Customer operations to coordinate this account."
  }, {
    loadRegisteredProjects: async () => projects,
    inspectLiveRemote: async (project) => project.repository,
    inspectConventionInventory: async (project) => [convention("agents-md", "AGENTS.md", project.id)]
  });

  assert.deepEqual(result, {
    status: "ambiguous",
    project: null,
    match: { kind: "colliding_display_name", confidence: 0.5, fields: ["name"] },
    routability: null,
    route: null,
    reason: "multiple_registered_project_matches",
    candidates: [
      { id: "project-alpha-001", slug: "alpha-ops", name: "Customer operations" },
      { id: "project-beta-001", slug: "beta-ops", name: "Customer operations" }
    ]
  });
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects/);
});

test("EPR-004: one eligible project containing cwd wins before lexical matching", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const projects = [
    projectRecord({
      id: "project-alpha-001",
      slug: "alpha-ops",
      name: "Alpha operations",
      purpose: "Coordinate the alpha account.",
      repository: "https://github.com/customer/alpha-ops"
    }),
    projectRecord({
      id: "project-beta-001",
      slug: "beta-ops",
      name: "Beta operations",
      purpose: "Coordinate the beta account.",
      repository: "https://github.com/customer/beta-ops"
    })
  ];

  const result = await resolveProjectRoute({
    intent: "Do the next approved task.",
    cwd: "/customer/projects/alpha-ops/nested"
  }, {
    loadRegisteredProjects: async () => projects,
    inspectLiveRemote: async (project) => project.repository,
    inspectConventionInventory: async (project) => [convention("agents-md", "AGENTS.md", project.id)],
    isPathWithin: async (root, candidate) => candidate.startsWith(`${root}/`)
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "alpha-ops");
  assert.deepEqual(result.match, {
    kind: "current_directory",
    confidence: 1,
    fields: ["registered_root"]
  });
  assert.equal(result.route, null);
});

test("EPR-014: implicit discovery refuses the 33rd active project before live inspection", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const projects = Array.from({ length: 33 }, (_, index) => projectRecord({
    id: `project-bounded-${String(index).padStart(3, "0")}`,
    slug: `bounded-${index}`,
    name: `Bounded ${index}`,
    purpose: `Handle bounded workflow ${index}.`,
    repository: `https://github.com/customer/bounded-${index}`
  }));
  let inspections = 0;

  const result = await resolveProjectRoute({ intent: "Handle bounded workflow 1." }, {
    loadRegisteredProjects: async () => projects,
    inspectLiveRemote: async () => {
      inspections += 1;
      throw new Error("the discovery bound must win before Git inspection");
    },
    inspectConventionInventory: async () => {
      inspections += 1;
      throw new Error("the discovery bound must win before convention inspection");
    }
  });

  assert.deepEqual(result, {
    status: "refused",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason: "discovery_bound_exceeded"
  });
  assert.equal(inspections, 0);
});

test("EPR-014: implicit discovery permits at most eight concurrent live-Git observations", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const projects = Array.from({ length: 16 }, (_, index) => projectRecord({
    id: `project-concurrent-${String(index).padStart(3, "0")}`,
    slug: `concurrent-${index}`,
    name: `Concurrent ${index}`,
    purpose: index === 7 ? "Prepare the unique launch dossier." : `Handle unrelated workflow ${index}.`,
    repository: `https://github.com/customer/concurrent-${index}`
  }));
  let activeGit = 0;
  let maximumGit = 0;

  const result = await resolveProjectRoute({ intent: "Prepare the unique launch dossier." }, {
    loadRegisteredProjects: async () => projects,
    inspectLiveRemote: async (project) => {
      activeGit += 1;
      maximumGit = Math.max(maximumGit, activeGit);
      await new Promise((resolve) => setImmediate(resolve));
      activeGit -= 1;
      return project.repository;
    },
    inspectConventionInventory: async (project) => [convention("agents-md", "AGENTS.md", project.id)]
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "concurrent-7");
  assert.ok(maximumGit <= 8, `expected at most 8 concurrent Git observations, saw ${maximumGit}`);
});

test("EPR-004: a slug colliding with another stable ID refuses exact routing as ambiguous", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const alpha = projectRecord({
    id: "project-alpha-001",
    slug: "shared-handle",
    name: "Alpha",
    purpose: "Coordinate alpha work.",
    repository: "https://github.com/customer/alpha"
  });
  const beta = projectRecord({
    id: "shared-handle",
    slug: "beta",
    name: "Beta",
    purpose: "Coordinate beta work.",
    repository: "https://github.com/customer/beta"
  });
  let inspections = 0;

  const result = await resolveProjectRoute({
    intent: "Coordinate work.",
    projectSelector: "shared-handle",
    supportedConventionKinds: ["agents-md"]
  }, {
    loadRegisteredProjects: async () => [alpha, beta],
    inspectLiveRemote: async () => {
      inspections += 1;
      throw new Error("ambiguous handles must not reach Git inspection");
    },
    inspectConventionInventory: async () => {
      inspections += 1;
      throw new Error("ambiguous handles must not reach convention inspection");
    }
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.route, null);
  assert.equal(result.reason, "ambiguous_project_handle");
  assert.deepEqual(result.candidates, [
    { id: "shared-handle", slug: "beta", name: "Beta" },
    { id: "project-alpha-001", slug: "shared-handle", name: "Alpha" }
  ]);
  assert.equal(inspections, 0);
});

test("EPR-001 through EPR-003: default adapters route a real registered repository without body content", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-native-route-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "customer-project");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");
  await fs.writeFile(path.join(projectPath, "AGENTS.md"), "CONVENTION_BODY_CANARY\n");
  await fs.writeFile(path.join(projectPath, "customer-data.txt"), "PROJECT_DATA_CANARY\n");
  await run("git", ["-C", projectPath, "init", "-q"]);
  await run("git", ["-C", projectPath, "remote", "add", "origin", "https://github.com/customer/customer-project.git"]);
  await registerApprovedProject({
    aiosPath,
    homePath,
    projectPath,
    slug: "customer-project",
    purpose: "Prepare and track product launches.",
    createId: () => "project-customer-001"
  });
  await fs.appendFile(
    path.join(aiosPath, "projects", "customer-project", "README.md"),
    "\nPORTABLE_README_BODY_CANARY\n"
  );

  const result = await resolveProjectRoute({
    aiosPath,
    homePath,
    intent: "Prepare and track this product launch."
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "customer-project");
  assert.deepEqual(result.routability.conventions, [{ kind: "agents-md", resource: "AGENTS.md" }]);
  assert.equal(result.route, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /CONVENTION_BODY_CANARY|PROJECT_DATA_CANARY|PORTABLE_README_BODY_CANARY/
  );
});

test("EPR-001: origin remains authoritative while multiple non-origin fallbacks refuse implicitly", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "remote-routing",
    purpose: "Prepare the unique remote routing launch.",
    conventions: ["AGENTS.md"]
  });
  await run("git", ["-C", fixture.projectPath, "remote", "add", "backup", "https://github.com/customer/backup.git"]);

  const withOrigin = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique remote routing launch."
  });
  assert.equal(withOrigin.status, "candidate");

  await run("git", ["-C", fixture.projectPath, "remote", "remove", "origin"]);
  await run("git", ["-C", fixture.projectPath, "remote", "add", "mirror", "https://github.com/customer/mirror.git"]);
  const withoutOrigin = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique remote routing launch."
  });
  assert.equal(withoutOrigin.status, "no_match");
  assert.equal(withoutOrigin.route, null);
  assert.doesNotMatch(JSON.stringify(withoutOrigin), new RegExp(fixture.projectPath));
});

test("EPR-001: exactly one safe fallback remote is accepted and conflicting origin URLs are not", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "fallback-routing",
    purpose: "Prepare the unique fallback routing audit.",
    conventions: ["AGENTS.md"]
  });
  const registeredRemote = "https://github.com/customer/fallback-routing.git";
  await run("git", ["-C", fixture.projectPath, "remote", "remove", "origin"]);
  await run("git", ["-C", fixture.projectPath, "remote", "add", "upstream", registeredRemote]);

  const fallback = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique fallback routing audit."
  });
  assert.equal(fallback.status, "candidate");

  await run("git", ["-C", fixture.projectPath, "remote", "rename", "upstream", "origin"]);
  await run("git", [
    "-C", fixture.projectPath, "config", "--add", "remote.origin.url",
    "https://github.com/customer/conflicting.git"
  ]);
  const conflictingOrigin = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique fallback routing audit."
  });
  assert.equal(conflictingOrigin.status, "no_match");
  assert.equal(conflictingOrigin.route, null);
});

test("EPR-001: one non-origin fetch remote remains authoritative beside a push-only remote", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "fetch-authority",
    purpose: "Prepare the unique fetch authority audit.",
    conventions: ["AGENTS.md"]
  });
  const registeredRemote = "https://github.com/customer/fetch-authority.git";
  await run("git", ["-C", fixture.projectPath, "remote", "remove", "origin"]);
  await run("git", ["-C", fixture.projectPath, "remote", "add", "upstream", registeredRemote]);
  await run("git", [
    "-C", fixture.projectPath, "config", "remote.publisher.pushurl",
    "https://github.com/customer/publish-only.git"
  ]);

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique fetch authority audit."
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "fetch-authority");
  assert.equal(result.route, null);
});

test("EPR-001: live remote authority is local-only and requires a local fetch refspec", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "local-authority",
    purpose: "Prepare the unique local authority audit.",
    conventions: ["AGENTS.md"]
  });
  const registeredRemote = "https://github.com/customer/local-authority.git";
  const globalConfigPath = path.join(fixture.root, "global.gitconfig");
  await run("git", ["config", "--file", globalConfigPath, "remote.origin.url", registeredRemote]);
  await run("git", ["-C", fixture.projectPath, "remote", "remove", "origin"]);
  const execFileAsync = (file, args, options) => run(file, args, {
    ...options,
    env: {
      ...options.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
      GIT_CONFIG_NOSYSTEM: "1"
    }
  });
  const resolve = () => resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique local authority audit."
  }, { execFileAsync });

  const inherited = await resolve();
  assert.equal(inherited.status, "no_match");

  await run("git", [
    "-C", fixture.projectPath, "config", "--local",
    "remote.origin.url", registeredRemote
  ]);
  const missingFetch = await resolve();
  assert.equal(missingFetch.status, "no_match");

  await run("git", [
    "-C", fixture.projectPath, "config", "--local",
    "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"
  ]);
  const localFetchAuthority = await resolve();
  assert.equal(localFetchAuthority.status, "candidate");
  assert.equal(localFetchAuthority.project.slug, "local-authority");
});

test("EPR-001: an invalidly named second local fetch remote refuses fallback authority", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "invalid-fetch-name",
    purpose: "Prepare the unique invalid fetch-name audit.",
    conventions: ["AGENTS.md"]
  });
  const registeredRemote = "https://github.com/customer/invalid-fetch-name.git";
  await run("git", ["-C", fixture.projectPath, "remote", "remove", "origin"]);
  await run("git", ["-C", fixture.projectPath, "remote", "add", "upstream", registeredRemote]);
  await run("git", [
    "-C", fixture.projectPath, "config", "--local",
    "remote.bad/name.url", "https://github.com/customer/bad-name.git"
  ]);
  await run("git", [
    "-C", fixture.projectPath, "config", "--local",
    "remote.bad/name.fetch", "+refs/heads/*:refs/remotes/bad-name/*"
  ]);

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique invalid fetch-name audit."
  });

  assert.equal(result.status, "no_match");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.projectPath));
});

test("EPR-015: the generic support declaration accepts CLAUDE.md without changing core", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "claude-native",
    purpose: "Organize the unique research archive.",
    conventions: ["CLAUDE.md"]
  });

  const codexResult = await resolveProjectRoute({
    ...fixture.options,
    intent: "Organize the unique research archive.",
    projectSelector: "claude-native",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  });
  assert.equal(codexResult.status, "unsupported_by_host");
  assert.equal(codexResult.route, null);
  assert.doesNotMatch(JSON.stringify(codexResult), new RegExp(fixture.projectPath));

  const compatibleResult = await resolveProjectRoute({
    ...fixture.options,
    intent: "Organize the unique research archive.",
    projectSelector: "claude-native",
    supportedConventionKinds: ["claude-md"]
  });
  assert.equal(compatibleResult.status, "ready");
  assert.equal(compatibleResult.route.location, fixture.projectPath);
  assert.deepEqual(compatibleResult.route.conventions.map(({ kind, resource }) => ({ kind, resource })), [
    { kind: "claude-md", resource: "CLAUDE.md" }
  ]);
});

test("EPR-002 and EPR-014: exactly 66 inert convention observations are accepted", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const skillResources = Array.from(
    { length: 64 },
    (_, index) => `.agents/skills/skill-${String(index).padStart(2, "0")}/SKILL.md`
  );
  const fixture = await createRegisteredFixture(t, {
    slug: "bounded-conventions",
    purpose: "Prepare the uniquely bounded convention audit.",
    conventions: ["AGENTS.md", "CLAUDE.md", ...skillResources]
  });

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the uniquely bounded convention audit.",
    projectSelector: "bounded-conventions",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  });

  assert.equal(result.status, "ready");
  assert.equal(result.routability.conventions.length, 66);
  assert.equal(result.route.conventions.length, 65);
  assert.deepEqual(
    result.routability.conventions,
    [...result.routability.conventions].sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.resource.localeCompare(right.resource)
    ))
  );
});

test("EPR-014: a 65th skill convention refuses implicit discovery path-free", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const skillResources = Array.from(
    { length: 65 },
    (_, index) => `.agents/skills/skill-${String(index).padStart(2, "0")}/SKILL.md`
  );
  const fixture = await createRegisteredFixture(t, {
    slug: "overflow-conventions",
    purpose: "Prepare the unique overflow convention audit.",
    conventions: skillResources
  });

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique overflow convention audit."
  });

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "discovery_bound_exceeded");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.projectPath));
});

test("EPR-015: invalid or invented universal convention support refuses before inspection", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  let reads = 0;
  const result = await resolveProjectRoute({
    intent: "Prepare the launch.",
    projectSelector: "launch-work",
    supportedConventionKinds: ["all-agents"]
  }, {
    loadRegisteredProjects: async () => {
      reads += 1;
      return [];
    }
  });

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "invalid_host_support");
  assert.equal(reads, 0);
});

test("EPR-014: exact final root, remote, or convention replacement refuses without a path", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const base = projectRecord({
    id: "project-race-001",
    slug: "race-work",
    name: "Race work",
    purpose: "Prepare the race audit.",
    repository: "https://github.com/customer/race-work"
  });

  await t.test("root", async () => {
    let reads = 0;
    const result = await resolveProjectRoute({
      intent: "Prepare the race audit.",
      projectSelector: "race-work",
      supportedConventionKinds: ["agents-md"]
    }, {
      loadRegisteredProjects: async () => [{
        ...base,
        rootIdentity: { ...base.rootIdentity, ino: reads++ === 0 ? base.id : "replaced" }
      }],
      inspectLiveRemote: async () => base.repository,
      inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "501")]
    });
    assertPathFreeIdentityRefusal(result);
  });

  await t.test("remote", async () => {
    let reads = 0;
    const result = await resolveProjectRoute({
      intent: "Prepare the race audit.",
      projectSelector: "race-work",
      supportedConventionKinds: ["agents-md"]
    }, {
      loadRegisteredProjects: async () => [{ ...base, rootIdentity: { ...base.rootIdentity } }],
      inspectLiveRemote: async () => reads++ === 0
        ? base.repository
        : "https://github.com/customer/replaced",
      inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "501")]
    });
    assertPathFreeIdentityRefusal(result);
  });

  await t.test("convention", async () => {
    let reads = 0;
    const result = await resolveProjectRoute({
      intent: "Prepare the race audit.",
      projectSelector: "race-work",
      supportedConventionKinds: ["agents-md"]
    }, {
      loadRegisteredProjects: async () => [{ ...base, rootIdentity: { ...base.rootIdentity } }],
      inspectLiveRemote: async () => base.repository,
      inspectConventionInventory: async () => [
        convention("agents-md", "AGENTS.md", reads++ === 0 ? "501" : "replaced")
      ]
    });
    assertPathFreeIdentityRefusal(result);
  });
});

test("EPR-002: an adapter cannot claim a linked, invented, or off-contract convention", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-unsafe-convention-001",
    slug: "unsafe-convention",
    name: "Unsafe convention",
    purpose: "Inspect the unsafe convention.",
    repository: "https://github.com/customer/unsafe-convention"
  });
  const linked = convention("agents-md", "AGENTS.md", "601");
  linked.observed_identity.nlink = 2;

  const result = await resolveProjectRoute({
    intent: "Inspect the unsafe convention.",
    projectSelector: "unsafe-convention",
    supportedConventionKinds: ["agents-md"]
  }, {
    loadRegisteredProjects: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [linked]
  });

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "project_not_routable");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects\/unsafe-convention/);
});

test("EPR-014: aggregate registration frontmatter over 64 KiB refuses before Git", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-metadata-bound-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectsPath = path.join(aiosPath, "projects");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(projectsPath, { recursive: true });
  for (let index = 0; index < 70; index += 1) {
    const slug = `inactive-${String(index).padStart(2, "0")}`;
    const projectDirectory = path.join(projectsPath, slug);
    await fs.mkdir(projectDirectory);
    await fs.writeFile(path.join(projectDirectory, "README.md"), [
      "---",
      `id: project-${slug}-001`,
      `project: ${slug}`,
      `name: Inactive ${index}`,
      `description: ${"bounded ".repeat(120)}`,
      "status: inactive",
      `repo_url: https://github.com/customer/${slug}.git`,
      "---",
      "README_BODY_MUST_NOT_BE_A_DISCOVERY_FALLBACK"
    ].join("\n"));
  }

  const result = await resolveProjectRoute({
    aiosPath,
    homePath,
    intent: "Prepare a bounded audit."
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "discovery_bound_exceeded");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root));
});

test("EPR-004 and EPR-014: exact slug or stable ID ignores unrelated implicit metadata bounds", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "exact-bounded",
    purpose: "Prepare the exact bounded routing audit.",
    conventions: ["AGENTS.md"]
  });
  const projectsPath = path.join(fixture.aiosPath, "projects");
  for (let index = 0; index < 70; index += 1) {
    const slug = `unrelated-inactive-${String(index).padStart(2, "0")}`;
    const projectDirectory = path.join(projectsPath, slug);
    await fs.mkdir(projectDirectory);
    await fs.writeFile(path.join(projectDirectory, "README.md"), [
      "---",
      `id: project-${slug}-001`,
      `project: ${slug}`,
      `name: Unrelated inactive ${index}`,
      `description: ${"unrelated ".repeat(110)}`,
      "status: inactive",
      `repo_url: https://github.com/customer/${slug}.git`,
      "---",
      "UNRELATED_README_BODY_CANARY"
    ].join("\n"));
  }

  for (const projectSelector of ["exact-bounded", "project-exact-bounded-001"]) {
    const result = await resolveProjectRoute({
      ...fixture.options,
      intent: "Prepare the exact bounded routing audit.",
      projectSelector,
      supportedConventionKinds: ["agents-md"]
    });
    assert.equal(result.status, "ready", projectSelector);
    assert.equal(result.project.slug, "exact-bounded", projectSelector);
    assert.equal(result.route.location, fixture.projectPath, projectSelector);
  }
});

test("EPR-002: linked convention lookalikes do not make a real project routable", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "linked-conventions",
    purpose: "Inspect the unique linked convention audit."
  });
  const hardlinkSource = path.join(fixture.projectPath, "hardlink-source.txt");
  await fs.writeFile(hardlinkSource, "HARDLINK_BODY_CANARY\n");
  await fs.link(hardlinkSource, path.join(fixture.projectPath, "AGENTS.md"));
  await fs.symlink(hardlinkSource, path.join(fixture.projectPath, "CLAUDE.md"));
  await fs.mkdir(path.join(fixture.projectPath, ".agents"), { recursive: true });
  await fs.symlink(
    fixture.projectPath,
    path.join(fixture.projectPath, ".agents", "skills")
  );

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Inspect the unique linked convention audit.",
    projectSelector: "linked-conventions",
    supportedConventionKinds: ["agents-md", "claude-md", "repository-skill"]
  });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "project_not_routable");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), /HARDLINK_BODY_CANARY/);
});

test("EPR-001: two forged IDs mapped to one root are ineligible for routing", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "registered-root",
    purpose: "Handle the original registered workflow.",
    conventions: ["AGENTS.md"]
  });
  const forgedSlug = "forged-root";
  const forgedDirectory = path.join(fixture.aiosPath, "projects", forgedSlug);
  await fs.mkdir(forgedDirectory, { recursive: true });
  await fs.writeFile(path.join(forgedDirectory, "README.md"), [
    "---",
    "id: project-forged-root-001",
    `project: ${forgedSlug}`,
    "name: Forged root",
    "description: Prepare the uniquely forged mapping audit.",
    "status: active",
    "repo_url: https://github.com/customer/registered-root.git",
    "---",
    "FORGED_README_BODY_CANARY"
  ].join("\n"));
  const statePath = path.join(fixture.homePath, ".dotaios", "projects.json");
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  state.paths["project-forged-root-001"] = structuredClone(
    state.paths["project-registered-root-001"]
  );
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the uniquely forged mapping audit."
  });
  assert.equal(result.status, "no_match");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.projectPath));

  for (const projectSelector of [forgedSlug, "project-forged-root-001"]) {
    const exact = await resolveProjectRoute({
      ...fixture.options,
      intent: "Prepare the uniquely forged mapping audit.",
      projectSelector,
      supportedConventionKinds: ["agents-md"]
    });
    assert.equal(exact.status, "refused", projectSelector);
    assert.equal(exact.reason, "project_identity_unverified", projectSelector);
    assert.equal(exact.route, null, projectSelector);
    assert.doesNotMatch(JSON.stringify(exact), new RegExp(fixture.projectPath));
  }
});

test("EPR-001 and EPR-004: exact slug selection retains global duplicate-ID conflict detection", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "duplicate-id-owner",
    purpose: "Prepare the unique duplicate-ID ownership audit.",
    conventions: ["AGENTS.md"]
  });
  const shadowSlug = "duplicate-id-shadow";
  const shadowDirectory = path.join(fixture.aiosPath, "projects", shadowSlug);
  await fs.mkdir(shadowDirectory, { recursive: true });
  await fs.writeFile(path.join(shadowDirectory, "README.md"), [
    "---",
    "id: project-duplicate-id-owner-001",
    `project: ${shadowSlug}`,
    "name: Duplicate ID shadow",
    "description: Prepare a shadow registration record.",
    "status: active",
    "repo_url: https://github.com/customer/duplicate-id-owner.git",
    "---",
    "SHADOW_README_BODY_CANARY"
  ].join("\n"));

  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique duplicate-ID ownership audit.",
    projectSelector: "duplicate-id-owner",
    supportedConventionKinds: ["agents-md"]
  });

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "project_identity_unverified");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.projectPath));
});

function projectRecord({ id, slug, name, purpose, repository }) {
  return {
    id,
    slug,
    name,
    purpose,
    repository,
    status: "active",
    projectPath: `/customer/projects/${slug}`,
    mappingStatus: "verified",
    pathAvailable: true,
    placement: "external",
    rootIdentity: { type: "directory", dev: "101", ino: id }
  };
}

function convention(kind, resource, ino) {
  const normalizedIno = /^\d+$/.test(ino)
    ? ino
    : String(Array.from(ino).reduce((total, character) => total + character.codePointAt(0), 0));
  return {
    kind,
    resource,
    observed_identity: {
      type: "file",
      dev: "101",
      ino: normalizedIno,
      mode: 33188,
      nlink: 1,
      size: "128",
      mtime_ns: "1788000000000000000",
      ctime_ns: "1788000000000000000"
    }
  };
}

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

async function createRegisteredFixture(t, {
  slug,
  purpose,
  conventions = [],
  remote = `https://github.com/customer/${slug}.git`
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-native-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, slug);
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{\"schema_version\":\"1.2.0\"}\n");
  for (const resource of conventions) {
    const conventionPath = path.join(projectPath, ...resource.split("/"));
    await fs.mkdir(path.dirname(conventionPath), { recursive: true });
    await fs.writeFile(conventionPath, `BODY_CANARY_${resource}\n`);
  }
  await run("git", ["-C", projectPath, "init", "-q"]);
  await run("git", ["-C", projectPath, "remote", "add", "origin", remote]);
  await registerApprovedProject({
    aiosPath,
    homePath,
    projectPath,
    slug,
    purpose,
    createId: () => `project-${slug}-001`
  });
  return { root, homePath, aiosPath, projectPath, options: { aiosPath, homePath } };
}

function assertPathFreeIdentityRefusal(result) {
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "project_identity_unverified");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects\/race-work/);
}
