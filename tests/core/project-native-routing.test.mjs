import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import {
  readBoundedProjectRegistrations,
  registerProject
} from "../../packages/core/src/projects.mjs";

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
  const dependencies = {
    readProjectRegistrations: async ({ projectSelector }) => projectSelector === null
      ? projects
      : projects.filter((project) => project.id === projectSelector || project.slug === projectSelector),
    inspectLiveRemote: async (project) => {
      inspections.push(["git", project.slug]);
      return project.repository;
    },
    inspectConventionInventory: async (project) => {
      inspections.push(["conventions", project.slug]);
      return [convention("agents-md", "AGENTS.md", project.slug === "launch-work" ? "201" : "301")];
    }
  };

  const result = await resolveProjectRoute({
    intent: "Prepare and track this product launch.",
    supportedConventionKinds: ["repository-skill", "agents-md"]
  }, dependencies);

  assert.match(result.approval_binding, /^[a-f0-9]{64}$/);
  const { approval_binding: approvalBinding, ...candidateResult } = result;
  assert.equal(typeof approvalBinding, "string");
  assert.deepEqual(candidateResult, {
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
      confidence: 0.75,
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
  const exact = await resolveProjectRoute({
    intent: "Prepare and track this product launch.",
    projectSelector: result.project.id,
    supportedConventionKinds: ["agents-md", "repository-skill"],
    approvalBinding: result.approval_binding
  }, dependencies);
  assert.equal(exact.status, "ready");
});

test("R4: exact resolution preserves an approved separated match below the raw-score threshold", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const projects = [
    projectRecord({
      id: "project-invoice-001",
      slug: "invoice-work",
      name: "Invoice work",
      purpose: "Billing invoices",
      repository: "https://github.com/customer/invoice-work"
    }),
    projectRecord({
      id: "project-account-001",
      slug: "account-work",
      name: "Account work",
      purpose: "Billing accounts finance operations administration compliance records review archive planning",
      repository: "https://github.com/customer/account-work"
    })
  ];
  const dependencies = {
    readProjectRegistrations: async () => projects,
    inspectLiveRemote: async (project) => project.repository,
    inspectConventionInventory: async (project) => [
      convention("agents-md", "AGENTS.md", project.id === "project-invoice-001" ? "211" : "212")
    ]
  };
  const intent = "Billing reports";
  const candidate = await resolveProjectRoute({
    intent,
    supportedConventionKinds: ["agents-md"]
  }, dependencies);

  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.project.id, "project-invoice-001");
  assert.equal(candidate.match.confidence, 0.75);

  const exact = await resolveProjectRoute({
    intent,
    projectSelector: candidate.project.id,
    supportedConventionKinds: ["agents-md"],
    approvalBinding: candidate.approval_binding
  }, dependencies);

  assert.equal(exact.status, "ready");
  assert.equal(exact.project.id, candidate.project.id);
});

test("EPR-003: a concrete action can match the registered slug when the remote basename differs", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-acme-tax-001",
    slug: "acme-tax",
    name: "Quarterly filing workspace",
    purpose: "Prepare annual compliance records.",
    repository: "https://github.com/customer/ledger-worktree"
  });

  const result = await resolveProjectRoute({
    intent: "Please prepare annual compliance records in acme-tax",
    supportedConventionKinds: ["agents-md"]
  }, {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "191")]
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "acme-tax");
  assert.deepEqual(result.match, {
    kind: "purpose_overlap",
    confidence: 0.9,
    fields: ["purpose"]
  });
});

test("R2: a project handle without a concrete action never requests approval", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-annual-compliance-001",
    slug: "annual-compliance",
    name: "Annual compliance",
    purpose: "Prepare annual compliance records.",
    repository: "https://github.com/customer/ledger-worktree"
  });
  const dependencies = {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "191")]
  };

  for (const intent of [
    "annual-compliance",
    "Please work in annual-compliance",
    "Take me to annual-compliance",
    "Show annual-compliance",
    "annual-compliance now",
    "What about annual-compliance?",
    "Take me to records in annual-compliance",
    "What about records in annual-compliance?",
    "Bring me to records in annual-compliance",
    "Enter records in annual-compliance",
    "Load records in annual-compliance",
    "Access records in annual-compliance"
  ]) {
    const result = await resolveProjectRoute({
      intent,
      supportedConventionKinds: ["agents-md"]
    }, dependencies);

    assert.equal(result.status, "no_match", intent);
    assert.equal(result.route, null, intent);
    assert.equal(result.approval_binding, undefined, intent);
  }
});

test("R2: action words inside a project handle do not count as the requested action", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");

  for (const [handle, purpose] of [
    ["reporting", "Create reporting workflows."],
    ["research", "Research public evidence."],
    ["design-system", "Design reusable system components."]
  ]) {
    const project = projectRecord({
      id: `project-${handle}-001`,
      slug: handle,
      name: handle,
      purpose,
      repository: `https://github.com/customer/${handle}`
    });
    const result = await resolveProjectRoute({
      intent: handle,
      supportedConventionKinds: ["agents-md"]
    }, {
      readProjectRegistrations: async () => [project],
      inspectLiveRemote: async () => project.repository,
      inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", handle)]
    });

    assert.equal(result.status, "no_match", handle);
    assert.equal(result.approval_binding, undefined, handle);
  }
});

test("R2: an action outside an action-named project handle remains actionable", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-reporting-001",
    slug: "reporting",
    name: "reporting",
    purpose: "Create reporting workflows.",
    repository: "https://github.com/customer/reporting"
  });
  const result = await resolveProjectRoute({
    intent: "Prepare reporting",
    supportedConventionKinds: ["agents-md"]
  }, {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "reporting")]
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "reporting");
});

test("EPR-004: one weak lexical overlap does not become a confident project match", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const project = projectRecord({
    id: "project-tax-records-001",
    slug: "annual-compliance",
    name: "Quarterly filing workspace",
    purpose: "Prepare annual tax compliance records and archive supporting customer documents.",
    repository: "https://github.com/customer/ledger-worktree"
  });

  const result = await resolveProjectRoute({
    intent: "Please tax"
  }, {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("agents-md", "AGENTS.md", "192")]
  });

  assert.deepEqual(result, {
    status: "no_match",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason: "no_registered_project_match"
  });
});

test("EPR-001, EPR-005, and EPR-015: exact stable ID requires the candidate binding and one fresh observation", async () => {
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
  const catalogSelectors = [];
  let remoteReads = 0;
  let conventionReads = 0;

  const dependencies = {
    readProjectRegistrations: async ({ projectSelector }) => {
      catalogSelectors.push(projectSelector);
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
  };
  const proposal = await resolveProjectRoute({
    intent: "Prepare and track this product launch.",
    supportedConventionKinds: ["repository-skill", "agents-md"]
  }, dependencies);
  assert.equal(proposal.status, "candidate");
  assert.match(proposal.approval_binding, /^[a-f0-9]{64}$/);

  const result = await resolveProjectRoute({
    intent: "Prepare and track this product launch.",
    projectSelector: "project-launch-001",
    supportedConventionKinds: ["agents-md", "repository-skill"],
    approvalBinding: proposal.approval_binding
  }, dependencies);

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
  assert.deepEqual(catalogSelectors, [null, "project-launch-001"]);
  assert.equal(remoteReads, 2, "each router call observes the authoritative live remote once");
  assert.equal(conventionReads, 2, "each router call observes convention identities once");
});

test("R3: approval binding normalizes action, host support, remotes, and observation ordering with framed fields", async () => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const base = projectRecord({
    id: "project-binding-001",
    slug: "binding-work",
    name: "Binding work",
    purpose: "Prepare the unique approval binding launch.",
    repository: "https://github.com/customer/binding-work"
  });
  const firstConventions = [
    convention("repository-skill", ".agents/skills/launch/SKILL.md", "902"),
    convention("agents-md", "AGENTS.md", "901")
  ];
  const candidateFor = (project, {
    intent = "Prepare  the unique approval binding launch cafe\u0301.",
    support = ["repository-skill", "agents-md"],
    liveRemote = "https://github.com/customer/binding-work.git",
    conventions = firstConventions
  } = {}) => resolveProjectRoute({
    intent,
    supportedConventionKinds: support
  }, {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => liveRemote,
    inspectConventionInventory: async () => conventions
  });

  const first = await candidateFor(base);
  const reordered = await candidateFor(base, {
    intent: "Prepare the unique approval binding launch café.",
    support: ["agents-md", "repository-skill"],
    liveRemote: "https://github.com/customer/binding-work",
    conventions: [...firstConventions].reverse()
  });
  assert.equal(first.status, "candidate");
  assert.equal(reordered.status, "candidate");
  assert.equal(first.approval_binding, reordered.approval_binding);

  const reframed = await candidateFor({
    ...base,
    name: "Binding wor",
    purpose: "k Prepare the unique approval binding launch."
  });
  assert.equal(reframed.status, "candidate");
  assert.notEqual(
    first.approval_binding,
    reframed.approval_binding,
    "stable JSON field framing must not permit concatenation-equivalent public fields"
  );
});

test("R4: exact resolution refuses every approval-bound continuity drift without a path", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const base = projectRecord({
    id: "project-continuity-001",
    slug: "continuity-work",
    name: "Continuity work",
    purpose: "Prepare the unique continuity launch.",
    repository: "https://github.com/customer/continuity-work"
  });
  const baseConventions = [
    convention("agents-md", "AGENTS.md", "911"),
    convention("repository-skill", ".agents/skills/continuity/SKILL.md", "912")
  ];
  const cases = [
    ["stable project id", { project: { ...base, id: "project-continuity-002" } }],
    ["mapping to another root", {
      project: {
        ...base,
        projectPath: "/customer/projects/equivalent-looking-root",
        mappingPath: "/customer/projects/equivalent-looking-root",
        rootIdentity: { type: "directory", dev: "101", ino: "9991" }
      }
    }],
    ["renamed same physical root and updated mapping", {
      project: {
        ...base,
        projectPath: "/customer/projects/renamed-continuity-work",
        mappingPath: "/customer/projects/renamed-continuity-work"
      }
    }],
    ["registered root identity", {
      project: { ...base, rootIdentity: { ...base.rootIdentity, ino: "9992" } }
    }],
    ["canonical registered remote and authoritative live remote", {
      project: { ...base, repository: "https://github.com/customer/moved-continuity-work" },
      liveRemote: "https://github.com/customer/moved-continuity-work"
    }],
    ["observed convention identity", {
      conventions: [
        convention("agents-md", "AGENTS.md", "9993"),
        baseConventions[1]
      ]
    }],
    ["match-bearing public registration name", {
      project: { ...base, name: "Renamed continuity work" }
    }],
    ["match-bearing public registration slug", {
      project: { ...base, slug: "renamed-continuity-work" }
    }],
    ["match-bearing public registration purpose and explanation basis", {
      project: { ...base, purpose: "Prepare the unique continuity release." },
      exactIntent: "Prepare the unique continuity release."
    }],
    ["public registration placement", {
      project: { ...base, placement: "managed" }
    }],
    ["normalized host support", {
      exactSupport: ["agents-md", "claude-md"]
    }],
    ["normalized action", {
      exactIntent: "Prepare the unique continuity launch and publish it."
    }]
  ];

  for (const [name, mutation] of cases) {
    await t.test(name, async () => {
      let exactPhase = false;
      const dependencies = {
        readProjectRegistrations: async ({ projectSelector }) => {
          exactPhase = projectSelector !== null;
          return [exactPhase ? (mutation.project || base) : base];
        },
        inspectLiveRemote: async () => exactPhase
          ? (mutation.liveRemote || mutation.project?.repository || base.repository)
          : base.repository,
        inspectConventionInventory: async () => structuredClone(
          exactPhase ? (mutation.conventions || baseConventions) : baseConventions
        )
      };
      const proposal = await resolveProjectRoute({
        intent: "Prepare the unique continuity launch.",
        supportedConventionKinds: ["repository-skill", "agents-md"]
      }, dependencies);
      assert.equal(proposal.status, "candidate", name);

      const exact = await resolveProjectRoute({
        intent: mutation.exactIntent || "Prepare the unique continuity launch.",
        projectSelector: base.id,
        supportedConventionKinds: mutation.exactSupport || ["agents-md", "repository-skill"],
        approvalBinding: proposal.approval_binding
      }, dependencies);
      assertPathFreeApprovalRefusal(exact);
    });
  }
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
    supportedConventionKinds: ["agents-md", "repository-skill"]
  }, {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [convention("claude-md", "CLAUDE.md", "401")]
  });

  assert.equal(result.status, "unsupported_by_host");
  assert.equal(result.route, null);
  assert.equal(result.reason, "no_supported_convention");
  assert.equal(result.match.kind, "purpose_overlap");
  assert.deepEqual(result.match.fields, ["purpose"]);
  assert.deepEqual(result.routability.conventions, [{ kind: "claude-md", resource: "CLAUDE.md" }]);
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects\/research-work/);
});

test("EPR-004: tied lexical matches are ambiguous and disclose handles only", async () => {
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
    intent: "Use Customer operations to coordinate this account.",
    supportedConventionKinds: ["agents-md"]
  }, {
    readProjectRegistrations: async () => projects,
    inspectLiveRemote: async (project) => project.repository,
    inspectConventionInventory: async (project) => [convention("agents-md", "AGENTS.md", project.id)]
  });

  assert.deepEqual(result, {
    status: "ambiguous",
    project: null,
    match: { kind: "low_separation", confidence: 0.5, fields: ["metadata"] },
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

test("EPR-004: a vague action inside a registered cwd does not bypass lexical matching", async () => {
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
    cwd: "/customer/projects/alpha-ops/nested",
    supportedConventionKinds: ["agents-md"]
  }, {
    readProjectRegistrations: async () => projects,
    inspectLiveRemote: async (project) => project.repository,
    inspectConventionInventory: async (project) => [convention("agents-md", "AGENTS.md", project.id)],
    isPathWithin: async (root, candidate) => candidate.startsWith(`${root}/`)
  });

  assert.deepEqual(result, {
    status: "no_match",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason: "no_registered_project_match"
  });
});

test("EPR-014: implicit discovery refuses the 33rd active project before local mapping content is read", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-active-route-bound-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectsPath = path.join(aiosPath, "projects");
  const stateRoot = path.join(homePath, ".dotaios");
  const statePath = path.join(stateRoot, "projects.json");
  await fs.mkdir(homePath, { recursive: true });
  await fs.mkdir(projectsPath, { recursive: true });
  for (let index = 0; index < 33; index += 1) {
    const slug = `bounded-${String(index).padStart(2, "0")}`;
    const projectDirectory = path.join(projectsPath, slug);
    await fs.mkdir(projectDirectory);
    await fs.writeFile(path.join(projectDirectory, "README.md"), [
      "---",
      `id: project-${slug}-001`,
      `project: ${slug}`,
      `name: Bounded ${index}`,
      `description: Handle bounded workflow ${index}.`,
      "status: active",
      `repo_url: https://github.com/customer/${slug}.git`,
      "---",
      "README_BODY_MUST_STAY_UNREAD"
    ].join("\n"));
  }
  let stateReads = 0;
  const filesystem = {
    ...fs,
    readFile: async (target, ...args) => {
      if (path.resolve(String(target)) === statePath) stateReads += 1;
      return fs.readFile(target, ...args);
    }
  };

  const result = await resolveProjectRoute({
    aiosPath,
    homePath,
    filesystem,
    intent: "Handle bounded workflow 1."
  });

  assert.deepEqual(result, {
    status: "refused",
    project: null,
    match: null,
    routability: null,
    route: null,
    reason: "discovery_bound_exceeded"
  });
  assert.equal(stateReads, 0, "the active bound must win before machine-local state content is read");
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

  const result = await resolveProjectRoute({
    intent: "Prepare the unique launch dossier.",
    supportedConventionKinds: ["agents-md"]
  }, {
    readProjectRegistrations: async () => projects,
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

test("EPR-014: bounded registration mapping and placement verification permits at most eight concurrent observations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-registration-concurrency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectsPath = path.join(aiosPath, "projects");
  const statePath = path.join(homePath, ".dotaios", "projects.json");
  const projectPaths = new Set();
  const paths = {};
  await fs.mkdir(projectsPath, { recursive: true });
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  for (let index = 0; index < 16; index += 1) {
    const slug = `registration-concurrent-${String(index).padStart(2, "0")}`;
    const id = `project-${slug}-001`;
    const projectPath = path.join(root, slug);
    const projectDirectory = path.join(projectsPath, slug);
    await fs.mkdir(projectPath);
    await fs.mkdir(projectDirectory);
    await fs.writeFile(path.join(projectDirectory, "README.md"), [
      "---",
      `id: ${id}`,
      `project: ${slug}`,
      `name: Registration concurrent ${index}`,
      `description: Handle registration concurrency workflow ${index}.`,
      "status: active",
      `repo_url: https://github.com/customer/${slug}.git`,
      "---",
      "README_BODY_MUST_STAY_UNREAD"
    ].join("\n"));
    const stats = await fs.lstat(projectPath, { bigint: true });
    projectPaths.add(path.resolve(projectPath));
    paths[id] = {
      path: projectPath,
      root_identity: {
        type: "directory",
        dev: stats.dev.toString(),
        ino: stats.ino.toString()
      }
    };
  }
  await fs.writeFile(statePath, `${JSON.stringify({ version: 1, paths }, null, 2)}\n`);

  let activeObservations = 0;
  let maximumObservations = 0;
  const filesystem = {
    ...fs,
    lstat: async (target, ...args) => {
      const tracked = projectPaths.has(path.resolve(String(target)));
      if (tracked) {
        activeObservations += 1;
        maximumObservations = Math.max(maximumObservations, activeObservations);
        await new Promise((resolve) => setImmediate(resolve));
      }
      try {
        return await fs.lstat(target, ...args);
      } finally {
        if (tracked) activeObservations -= 1;
      }
    }
  };

  const registrations = await readBoundedProjectRegistrations({
    aiosPath,
    homePath,
    statePath,
    fs: filesystem
  });

  assert.equal(registrations.length, 16);
  assert.ok(
    maximumObservations <= 8,
    `expected at most 8 concurrent mapping observations, saw ${maximumObservations}`
  );
});

test("EPR-014: stalled local Git inspection returns a path-free no-match within the configured bound", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "git-timeout",
    purpose: "Prepare the unique Git timeout audit.",
    conventions: ["AGENTS.md"]
  });
  const observedTimeouts = [];
  const stalledGit = async (_executable, _args, options) => {
    observedTimeouts.push(options.timeout);
    if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0) {
      return new Promise(() => {});
    }
    const error = new Error("Git inspection timed out");
    error.killed = true;
    error.signal = "SIGTERM";
    throw error;
  };
  const deadline = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("router exceeded the Git inspection bound")), 100);
  });

  const result = await Promise.race([
    resolveProjectRoute({
      ...fixture.options,
      intent: "Prepare the unique Git timeout audit.",
      supportedConventionKinds: ["agents-md"]
    }, { execFileAsync: stalledGit }),
    deadline
  ]);

  assert.equal(result.status, "no_match");
  assert.equal(result.route, null);
  assert.ok(observedTimeouts.length > 0);
  assert.ok(observedTimeouts.every((timeout) => Number.isSafeInteger(timeout) && timeout > 0));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.projectPath));
});

test("EPR-004: a changed colliding exact handle refuses approval path-free", async () => {
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
    supportedConventionKinds: ["agents-md"],
    approvalBinding: "0".repeat(64)
  }, {
    readProjectRegistrations: async () => [alpha, beta],
    inspectLiveRemote: async () => {
      inspections += 1;
      throw new Error("ambiguous handles must not reach Git inspection");
    },
    inspectConventionInventory: async () => {
      inspections += 1;
      throw new Error("ambiguous handles must not reach convention inspection");
    }
  });

  assert.equal(result.status, "refused");
  assert.equal(result.route, null);
  assert.equal(result.reason, "approval_binding_mismatch");
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
  let externalBodyReads = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property === "open") {
        return async (filePath, ...args) => {
          const relative = path.relative(projectPath, path.resolve(String(filePath)));
          if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
            externalBodyReads += 1;
            throw new Error("external project bodies must remain unopened");
          }
          return fs.open(filePath, ...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const result = await resolveProjectRoute({
    aiosPath,
    homePath,
    filesystem,
    intent: "Prepare and track this product launch.",
    supportedConventionKinds: ["agents-md"]
  });

  assert.equal(result.status, "candidate");
  assert.equal(result.project.slug, "customer-project");
  assert.deepEqual(result.routability.conventions, [{ kind: "agents-md", resource: "AGENTS.md" }]);
  assert.equal(result.route, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /CONVENTION_BODY_CANARY|PROJECT_DATA_CANARY|PORTABLE_README_BODY_CANARY/
  );
  const exact = await resolveProjectRoute({
    aiosPath,
    homePath,
    filesystem,
    intent: "Prepare and track this product launch.",
    projectSelector: result.project.id,
    supportedConventionKinds: ["agents-md"],
    approvalBinding: result.approval_binding
  });
  assert.equal(exact.status, "ready");
  assert.equal(externalBodyReads, 0);
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
    intent: "Prepare the unique remote routing launch.",
    supportedConventionKinds: ["agents-md"]
  });
  assert.equal(withOrigin.status, "candidate");

  await run("git", ["-C", fixture.projectPath, "remote", "remove", "origin"]);
  await run("git", ["-C", fixture.projectPath, "remote", "add", "mirror", "https://github.com/customer/mirror.git"]);
  const withoutOrigin = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique remote routing launch.",
    supportedConventionKinds: ["agents-md"]
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
    intent: "Prepare the unique fallback routing audit.",
    supportedConventionKinds: ["agents-md"]
  });
  assert.equal(fallback.status, "candidate");

  await run("git", ["-C", fixture.projectPath, "remote", "rename", "upstream", "origin"]);
  await run("git", [
    "-C", fixture.projectPath, "config", "--add", "remote.origin.url",
    "https://github.com/customer/conflicting.git"
  ]);
  const conflictingOrigin = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique fallback routing audit.",
    supportedConventionKinds: ["agents-md"]
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
    intent: "Prepare the unique fetch authority audit.",
    supportedConventionKinds: ["agents-md"]
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
    intent: "Prepare the unique local authority audit.",
    supportedConventionKinds: ["agents-md"]
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
    intent: "Prepare the unique invalid fetch-name audit.",
    supportedConventionKinds: ["agents-md"]
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
    supportedConventionKinds: ["agents-md", "repository-skill"]
  });
  assert.equal(codexResult.status, "unsupported_by_host");
  assert.equal(codexResult.route, null);
  assert.doesNotMatch(JSON.stringify(codexResult), new RegExp(fixture.projectPath));

  const compatibleProposal = await resolveProjectRoute({
    ...fixture.options,
    intent: "Organize the unique research archive.",
    supportedConventionKinds: ["claude-md"]
  });
  assert.equal(compatibleProposal.status, "candidate");
  const compatibleResult = await resolveProjectRoute({
    ...fixture.options,
    intent: "Organize the unique research archive.",
    projectSelector: "claude-native",
    supportedConventionKinds: ["claude-md"],
    approvalBinding: compatibleProposal.approval_binding
  });
  assert.equal(compatibleResult.status, "ready");
  assert.equal(compatibleResult.route.location, await fs.realpath(fixture.projectPath));
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

  const proposal = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the uniquely bounded convention audit.",
    supportedConventionKinds: ["agents-md", "repository-skill"]
  });
  assert.equal(proposal.status, "candidate");
  const result = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the uniquely bounded convention audit.",
    projectSelector: "bounded-conventions",
    supportedConventionKinds: ["repository-skill", "agents-md"],
    approvalBinding: proposal.approval_binding
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
    intent: "Prepare the unique overflow convention audit.",
    supportedConventionKinds: ["repository-skill"]
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
    readProjectRegistrations: async () => {
      reads += 1;
      return [];
    }
  });

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "invalid_host_support");
  assert.equal(reads, 0);
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
    supportedConventionKinds: ["agents-md"],
    approvalBinding: "0".repeat(64)
  }, {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [linked]
  });

  assert.equal(result.status, "refused");
  assert.equal(result.reason, "project_identity_unverified");
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
  const proposal = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the exact bounded routing audit.",
    supportedConventionKinds: ["agents-md"]
  });
  assert.equal(proposal.status, "candidate");
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
      supportedConventionKinds: ["agents-md"],
      approvalBinding: proposal.approval_binding
    });
    assert.equal(result.status, "ready", projectSelector);
    assert.equal(result.project.slug, "exact-bounded", projectSelector);
    assert.equal(result.route.location, await fs.realpath(fixture.projectPath), projectSelector);
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
    supportedConventionKinds: ["agents-md", "claude-md", "repository-skill"]
  });
  assert.equal(result.status, "no_match");
  assert.equal(result.reason, "no_registered_project_match");
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
    intent: "Prepare the uniquely forged mapping audit.",
    supportedConventionKinds: ["agents-md"]
  });
  assert.equal(result.status, "no_match");
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.projectPath));

  for (const projectSelector of [forgedSlug, "project-forged-root-001"]) {
    const exact = await resolveProjectRoute({
      ...fixture.options,
      intent: "Prepare the uniquely forged mapping audit.",
      projectSelector,
      supportedConventionKinds: ["agents-md"],
      approvalBinding: "0".repeat(64)
    });
    assert.equal(exact.status, "refused", projectSelector);
    assert.equal(exact.reason, "project_identity_unverified", projectSelector);
    assert.equal(exact.route, null, projectSelector);
    assert.doesNotMatch(JSON.stringify(exact), new RegExp(fixture.projectPath));
  }
});

test("EPR-001 and EPR-004: an inactive duplicate stable ID cannot emit a candidate doomed at exact resolution", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "inactive-duplicate-owner",
    purpose: "Prepare the unique inactive duplicate ownership audit.",
    conventions: ["AGENTS.md"]
  });
  const shadowSlug = "inactive-duplicate-shadow";
  const shadowDirectory = path.join(fixture.aiosPath, "projects", shadowSlug);
  await fs.mkdir(shadowDirectory, { recursive: true });
  await fs.writeFile(path.join(shadowDirectory, "README.md"), [
    "---",
    "id: project-inactive-duplicate-owner-001",
    `project: ${shadowSlug}`,
    "name: Inactive duplicate shadow",
    "description: Prepare an inactive shadow registration record.",
    "status: inactive",
    "repo_url: https://github.com/customer/inactive-duplicate-owner.git",
    "---",
    "INACTIVE_SHADOW_README_BODY_CANARY"
  ].join("\n"));

  const candidate = await resolveProjectRoute({
    ...fixture.options,
    intent: "Prepare the unique inactive duplicate ownership audit.",
    supportedConventionKinds: ["agents-md"]
  });

  assert.equal(candidate.status, "no_match");
  assert.equal(candidate.route, null);
  assert.doesNotMatch(JSON.stringify(candidate), new RegExp(fixture.projectPath));
});

test("EPR-001: mapping state inside AIOS or reached through a symlink refuses before registration records are read", async (t) => {
  const { resolveProjectRoute } = await import("../../packages/core/src/project-native-routing.mjs");
  const fixture = await createRegisteredFixture(t, {
    slug: "unsafe-state-owner",
    purpose: "Prepare the unique unsafe state authority audit.",
    conventions: ["AGENTS.md"]
  });
  const safeStatePath = path.join(fixture.homePath, ".dotaios", "projects.json");
  const unsafeStatePath = path.join(fixture.aiosPath, "portable-projects.json");
  const symlinkedStatePath = path.join(fixture.root, "linked-projects.json");
  await fs.copyFile(safeStatePath, unsafeStatePath);
  await fs.symlink(unsafeStatePath, symlinkedStatePath);

  for (const statePath of [unsafeStatePath, symlinkedStatePath]) {
    let registrationReads = 0;
    const filesystem = {
      ...fs,
      readFile: async (target, ...args) => {
        if (path.basename(String(target)) === "README.md") registrationReads += 1;
        return fs.readFile(target, ...args);
      }
    };
    const result = await resolveProjectRoute({
      ...fixture.options,
      statePath,
      filesystem,
      intent: "Prepare the unique unsafe state authority audit.",
      supportedConventionKinds: ["agents-md"]
    });

    assert.equal(result.status, "refused", statePath);
    assert.equal(result.reason, "project_identity_unverified", statePath);
    assert.equal(result.route, null, statePath);
    assert.equal(registrationReads, 0, statePath);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(fixture.root), statePath);
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
    supportedConventionKinds: ["agents-md"],
    approvalBinding: "0".repeat(64)
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
    mappingPath: `/customer/projects/${slug}`,
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

function assertPathFreeApprovalRefusal(result) {
  assert.equal(result.status, "refused");
  assert.ok(
    ["approval_binding_mismatch", "project_identity_unverified"].includes(result.reason),
    `unexpected refusal reason: ${result.reason}`
  );
  assert.equal(result.route, null);
  assert.doesNotMatch(JSON.stringify(result), /\/customer\/projects\//);
}
