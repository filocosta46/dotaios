import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveExternalProjectCapability
} from "../../packages/core/src/external-project-capability-resolver.mjs";

const CAREER_OPS_CARD = {
  id: "career-ops.evaluate-job",
  title: "Evaluate a job with Career Ops",
  outcome: "Use this Career Ops project to evaluate one job. Career Ops may create or update onboarding files, a report, a PDF, and tracker data in the project or its configured data and tracker locations. It must not submit an application.",
  provider: "santifer/career-ops",
  source: "https://github.com/santifer/career-ops",
  scope: "project",
  effect: "mixed",
  trust: "curated-external-user-owned",
  approval: "fresh"
};

const VERIFIED_CAREER_OPS_PROJECT = {
  id: "project-career-ops-001",
  identity: "verified",
  repoUrl: "https://github.com/santifer/career-ops.git"
};

test("AC-1: ordinary job-evaluation intent discovers the exact Career Ops card without a route", async () => {
  let liveRemoteReads = 0;
  let entrypointInspections = 0;

  const result = await resolveExternalProjectCapability({
    intent: "Evaluate this role with my Career Ops setup.",
    requestedCapability: null,
    project: VERIFIED_CAREER_OPS_PROJECT
  }, {
    readLiveRepoUrl: async () => {
      liveRemoteReads += 1;
      return "git@github.com:santifer/career-ops.git";
    },
    inspectContainedEntrypoints: async () => {
      entrypointInspections += 1;
      throw new Error("discovery must not inspect project entrypoints");
    }
  });

  assert.deepEqual(result, {
    status: "discovered",
    card: CAREER_OPS_CARD,
    route: null,
    reason: "capability_selection_required"
  });
  assert.equal(liveRemoteReads, 1);
  assert.equal(entrypointInspections, 0);
  assert.equal(JSON.stringify(result).includes("project-career-ops-001"), false);
});

test("AC-2: the exact capability returns only observed advisory project-native entrypoints", async () => {
  const agentsIdentity = {
    type: "file",
    dev: "101",
    ino: "201",
    mode: 33188,
    nlink: 1,
    size: "512",
    mtime_ns: "1788000000000000000",
    ctime_ns: "1788000000000000000"
  };
  const skillIdentity = {
    type: "file",
    dev: "101",
    ino: "202",
    mode: 33188,
    nlink: 1,
    size: "384",
    mtime_ns: "1788000001000000000",
    ctime_ns: "1788000001000000000"
  };
  let liveRemoteReads = 0;
  let entrypointInspections = 0;

  const result = await resolveExternalProjectCapability({
    intent: "Use the selected project capability.",
    requestedCapability: "career-ops.evaluate-job",
    project: VERIFIED_CAREER_OPS_PROJECT
  }, {
    readLiveRepoUrl: async () => {
      liveRemoteReads += 1;
      return "https://github.com/santifer/career-ops";
    },
    inspectContainedEntrypoints: async ({ entrypoints }) => {
      entrypointInspections += 1;
      assert.deepEqual(entrypoints, [
        { host: "agents", resource: "AGENTS.md" },
        { host: "claude-code", resource: "CLAUDE.md" },
        { host: "agent-skills", resource: ".agents/skills/career-ops/SKILL.md" }
      ]);
      return [
        { resource: "AGENTS.md", observed_identity: agentsIdentity },
        { resource: ".agents/skills/career-ops/SKILL.md", observed_identity: skillIdentity }
      ];
    }
  });

  assert.deepEqual(result, {
    status: "matched",
    card: CAREER_OPS_CARD,
    route: {
      kind: "project-native",
      project_id: "project-career-ops-001",
      advisory: true,
      entrypoints: [
        { host: "agents", resource: "AGENTS.md", observed_identity: agentsIdentity },
        {
          host: "agent-skills",
          resource: ".agents/skills/career-ops/SKILL.md",
          observed_identity: skillIdentity
        }
      ]
    },
    reason: "exact_capability_matched"
  });
  assert.equal(liveRemoteReads, 2);
  assert.equal(entrypointInspections, 1);
  assert.equal(JSON.stringify(result).includes("projectPath"), false);
});

test("INV-2: a live remote replacement during exact selection refuses the stale route", async () => {
  const liveRepoUrls = [
    "https://github.com/santifer/career-ops.git",
    "https://github.com/acme/replaced.git"
  ];
  let liveRemoteReads = 0;
  let entrypointInspections = 0;

  const result = await resolveExternalProjectCapability({
    intent: "Evaluate this role.",
    requestedCapability: "career-ops.evaluate-job",
    project: VERIFIED_CAREER_OPS_PROJECT
  }, {
    readLiveRepoUrl: async () => liveRepoUrls[liveRemoteReads++],
    inspectContainedEntrypoints: async () => {
      entrypointInspections += 1;
      return [{
        resource: "AGENTS.md",
        observed_identity: {
          type: "file",
          dev: "101",
          ino: "201",
          mode: 33188,
          nlink: 1,
          size: "512",
          mtime_ns: "1788000000000000000",
          ctime_ns: "1788000000000000000"
        }
      }];
    }
  });

  assert.deepEqual(result, {
    status: "refused",
    card: CAREER_OPS_CARD,
    route: null,
    reason: "live_repository_changed"
  });
  assert.equal(liveRemoteReads, 2);
  assert.equal(entrypointInspections, 1);
});

test("INV-2: a stored project identity change during inspection refuses the stale route", async () => {
  const project = { ...VERIFIED_CAREER_OPS_PROJECT };
  let liveRemoteReads = 0;

  const result = await resolveExternalProjectCapability({
    intent: "Evaluate this role.",
    requestedCapability: "career-ops.evaluate-job",
    project
  }, {
    readLiveRepoUrl: async () => {
      liveRemoteReads += 1;
      return "https://github.com/santifer/career-ops.git";
    },
    inspectContainedEntrypoints: async ({ project: inspectedProject }) => {
      inspectedProject.id = "../secret-project";
      inspectedProject.repoUrl = "https://github.com/acme/replaced.git";
      return [{
        resource: "AGENTS.md",
        observed_identity: {
          type: "file",
          dev: "101",
          ino: "201",
          mode: 33188,
          nlink: 1,
          size: "512",
          mtime_ns: "1788000000000000000",
          ctime_ns: "1788000000000000000"
        }
      }];
    }
  });

  assert.deepEqual(result, {
    status: "refused",
    card: CAREER_OPS_CARD,
    route: null,
    reason: "project_identity_changed"
  });
  assert.equal(liveRemoteReads, 1);
});

test("INV-2: a mapped project root change during inspection refuses the stale route", async () => {
  const project = {
    ...VERIFIED_CAREER_OPS_PROJECT,
    projectPath: "/verified/career-ops",
    mappingStatus: "verified",
    pathAvailable: true,
    placement: "external",
    rootIdentity: { type: "directory", dev: "101", ino: "301" }
  };
  const inspectedPaths = [];

  const result = await resolveExternalProjectCapability({
    intent: "Evaluate this role.",
    requestedCapability: "career-ops.evaluate-job",
    project
  }, {
    readLiveRepoUrl: async (inspectedProject) => {
      inspectedPaths.push(inspectedProject.projectPath);
      return "https://github.com/santifer/career-ops.git";
    },
    inspectContainedEntrypoints: async ({ project: inspectedProject }) => {
      inspectedProject.projectPath = "/unregistered/career-ops";
      inspectedProject.rootIdentity = { type: "directory", dev: "101", ino: "999" };
      return [{
        resource: "AGENTS.md",
        observed_identity: {
          type: "file",
          dev: "101",
          ino: "201",
          mode: 33188,
          nlink: 1,
          size: "512",
          mtime_ns: "1788000000000000000",
          ctime_ns: "1788000000000000000"
        }
      }];
    }
  });

  assert.deepEqual(result, {
    status: "refused",
    card: CAREER_OPS_CARD,
    route: null,
    reason: "project_identity_changed"
  });
  assert.deepEqual(inspectedPaths, ["/verified/career-ops"]);
});

test("INV-3: malformed capability selectors refuse before inspecting the project", async () => {
  const malformed = [
    [],
    {},
    "",
    " career-ops.evaluate-job",
    "career-ops.evaluate-job\n",
    "x".repeat(101)
  ];

  for (const requestedCapability of malformed) {
    const result = await resolveExternalProjectCapability({
      intent: "Evaluate this role.",
      requestedCapability,
      project: VERIFIED_CAREER_OPS_PROJECT
    }, {
      readLiveRepoUrl: async () => {
        throw new Error("malformed selectors must be refused before Git inspection");
      },
      inspectContainedEntrypoints: async () => {
        throw new Error("malformed selectors must be refused before entrypoint inspection");
      }
    });

    assert.deepEqual(result, {
      status: "refused",
      card: null,
      route: null,
      reason: "invalid_requested_capability"
    });
  }
});

test("AC-3: malformed intent refuses before exact capability selection can inspect the project", async () => {
  const malformed = [
    null,
    [],
    "",
    " evaluate this role",
    "evaluate this role\u0000",
    "\ud800",
    "x".repeat(1001)
  ];

  for (const intent of malformed) {
    const result = await resolveExternalProjectCapability({
      intent,
      requestedCapability: "career-ops.evaluate-job",
      project: VERIFIED_CAREER_OPS_PROJECT
    }, {
      readLiveRepoUrl: async () => {
        throw new Error("malformed intent must be refused before Git inspection");
      },
      inspectContainedEntrypoints: async () => {
        throw new Error("malformed intent must be refused before entrypoint inspection");
      }
    });

    assert.deepEqual(result, {
      status: "refused",
      card: null,
      route: null,
      reason: "invalid_intent"
    });
  }
});

test("INV-2: stored and live canonical repository identity both gate every route", async () => {
  let liveRemoteReads = 0;
  let entrypointInspections = 0;
  const dependencies = (liveRepoUrl) => ({
    readLiveRepoUrl: async () => {
      liveRemoteReads += 1;
      return liveRepoUrl;
    },
    inspectContainedEntrypoints: async () => {
      entrypointInspections += 1;
      return [{
        resource: "AGENTS.md",
        observed_identity: {
          type: "file",
          dev: "101",
          ino: "201",
          mode: 33188,
          nlink: 1,
          size: "512",
          mtime_ns: "1788000000000000000",
          ctime_ns: "1788000000000000000"
        }
      }];
    }
  });
  const input = {
    intent: "Evaluate this role.",
    requestedCapability: "career-ops.evaluate-job"
  };

  const otherRepository = await resolveExternalProjectCapability({
    ...input,
    project: { ...VERIFIED_CAREER_OPS_PROJECT, repoUrl: "https://github.com/acme/other.git" }
  }, dependencies("https://github.com/santifer/career-ops.git"));
  assert.deepEqual(otherRepository, {
    status: "no_match",
    card: null,
    route: null,
    reason: "repository_not_supported"
  });

  const unverified = await resolveExternalProjectCapability({
    ...input,
    project: {
      ...VERIFIED_CAREER_OPS_PROJECT,
      identity: "claimed",
      projectPath: "/private/FORGED_PROJECT_PATH_CANARY"
    }
  }, dependencies("https://github.com/santifer/career-ops.git"));
  assert.deepEqual(unverified, {
    status: "refused",
    card: null,
    route: null,
    reason: "project_identity_unverified"
  });
  assert.equal(JSON.stringify(unverified).includes("FORGED_PROJECT_PATH_CANARY"), false);

  const unsafeProjectId = await resolveExternalProjectCapability({
    ...input,
    project: { ...VERIFIED_CAREER_OPS_PROJECT, id: "../secret" }
  }, dependencies("https://github.com/santifer/career-ops.git"));
  assert.deepEqual(unsafeProjectId, {
    status: "refused",
    card: null,
    route: null,
    reason: "project_identity_unverified"
  });

  for (const liveRepoUrl of [
    null,
    "https://token@github.com/santifer/career-ops.git",
    "https://github.com/acme/replaced.git"
  ]) {
    const changed = await resolveExternalProjectCapability({
      ...input,
      project: VERIFIED_CAREER_OPS_PROJECT
    }, dependencies(liveRepoUrl));
    assert.deepEqual(changed, {
      status: "refused",
      card: null,
      route: null,
      reason: "live_repository_mismatch"
    });
  }

  assert.equal(liveRemoteReads, 3, "only valid stored identities reach live Git inspection");
  assert.equal(entrypointInspections, 0);
});

test("AC-3: missing or unsafe entrypoint observations refuse with no route", async () => {
  const regularIdentity = {
    type: "file",
    dev: "101",
    ino: "201",
    mode: 33188,
    nlink: 1,
    size: "512",
    mtime_ns: "1788000000000000000",
    ctime_ns: "1788000000000000000"
  };
  const cases = [
    [[], "project_entrypoint_missing"],
    [[{ resource: "AGENTS.md", observed_identity: { ...regularIdentity, type: "symlink" } }], "entrypoint_observation_unsafe"],
    [[{ resource: "AGENTS.md", observed_identity: { ...regularIdentity, mode: 16877 } }], "entrypoint_observation_unsafe"],
    [[{ resource: "AGENTS.md", observed_identity: { ...regularIdentity, nlink: 2 } }], "entrypoint_observation_unsafe"],
    [[{ resource: "README.md", observed_identity: regularIdentity }], "entrypoint_observation_unsafe"]
  ];

  for (const [observations, reason] of cases) {
    const result = await resolveExternalProjectCapability({
      intent: "Evaluate this role.",
      requestedCapability: "career-ops.evaluate-job",
      project: VERIFIED_CAREER_OPS_PROJECT
    }, {
      readLiveRepoUrl: async () => "https://github.com/santifer/career-ops.git",
      inspectContainedEntrypoints: async () => observations
    });
    assert.deepEqual(result, {
      status: "refused",
      card: CAREER_OPS_CARD,
      route: null,
      reason
    });
  }
});

test("INV-1 and AC-4: external project data cannot add executable or content fields to a route", async () => {
  const observedIdentity = {
    type: "file",
    dev: "101",
    ino: "201",
    mode: 33188,
    nlink: 1,
    size: "512",
    mtime_ns: "1788000000000000000",
    ctime_ns: "1788000000000000000",
    body: "EXTERNAL_BODY_CANARY",
    path: "/private/EXTERNAL_SECRET_PATH_CANARY"
  };
  const project = {
    ...VERIFIED_CAREER_OPS_PROJECT,
    projectPath: "/private/PROJECT_PATH_CANARY",
    command: "EXTERNAL_COMMAND_CANARY",
    argv: ["EXTERNAL_ARGV_CANARY"],
    environment: { TOKEN: "EXTERNAL_SECRET_CANARY" }
  };

  const result = await resolveExternalProjectCapability({
    intent: "Evaluate this role.",
    requestedCapability: "career-ops.evaluate-job",
    project
  }, {
    readLiveRepoUrl: async () => "https://github.com/santifer/career-ops.git",
    inspectContainedEntrypoints: async () => [{
      host: "shell",
      resource: "AGENTS.md",
      observed_identity: observedIdentity,
      body: "EXTERNAL_BODY_CANARY",
      path: "/private/EXTERNAL_SECRET_PATH_CANARY",
      command: "EXTERNAL_COMMAND_CANARY",
      argv: ["EXTERNAL_ARGV_CANARY"],
      environment: { TOKEN: "EXTERNAL_SECRET_CANARY" }
    }]
  });

  assert.equal(result.status, "matched");
  assert.deepEqual(result.route.entrypoints, [{
    host: "agents",
    resource: "AGENTS.md",
    observed_identity: {
      type: "file",
      dev: "101",
      ino: "201",
      mode: 33188,
      nlink: 1,
      size: "512",
      mtime_ns: "1788000000000000000",
      ctime_ns: "1788000000000000000"
    }
  }]);
  assert.doesNotMatch(JSON.stringify(result), /EXTERNAL_|\/private\//);

  const forbiddenKeys = new Set([
    "argv",
    "body",
    "command",
    "content",
    "env",
    "environment",
    "executable",
    "path",
    "secret",
    "shell"
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden route field: ${key}`);
      visit(nested);
    }
  };
  visit(result);
});

test("AC-3: an unknown exact capability remains inert without project inspection", async () => {
  let dependencyReads = 0;
  const result = await resolveExternalProjectCapability({
    intent: "Evaluate this role.",
    requestedCapability: "career-ops.submit-application",
    project: VERIFIED_CAREER_OPS_PROJECT
  }, {
    readLiveRepoUrl: async () => {
      dependencyReads += 1;
      throw new Error("unknown capabilities must not inspect Git");
    },
    inspectContainedEntrypoints: async () => {
      dependencyReads += 1;
      throw new Error("unknown capabilities must not inspect entrypoints");
    }
  });

  assert.deepEqual(result, {
    status: "no_match",
    card: null,
    route: null,
    reason: "unsupported_capability"
  });
  assert.equal(dependencyReads, 0);
});
