import assert from "node:assert/strict";
import test from "node:test";

import { resolveProjectRoute } from "../../packages/core/src/project-native-routing.mjs";

test("quoted purpose metadata reports purpose provenance and keeps approval binding stable", async () => {
  const project = projectRecord({
    id: "project-tax-work-001",
    slug: "tax-work",
    name: "Tax operations",
    purpose: "Prepare the \"tax-work\" quarterly filing dossier.",
    repository: "https://github.com/customer/filing-ledger"
  });
  const dependencies = projectDependencies(project);
  const request = {
    intent: "Prepare quarterly filing dossier.",
    supportedConventionKinds: ["agents-md"]
  };

  const first = await resolveProjectRoute(request, dependencies);
  const repeated = await resolveProjectRoute(request, dependencies);

  assert.equal(first.status, "candidate");
  assert.deepEqual(first.match, {
    kind: "purpose_overlap",
    confidence: 0.8,
    fields: ["purpose"]
  });
  assert.equal(repeated.approval_binding, first.approval_binding);

  const exact = await resolveProjectRoute({
    ...request,
    projectSelector: first.project.id,
    approvalBinding: first.approval_binding
  }, dependencies);

  assert.equal(exact.status, "ready");
});

test("overlapping registration values report the scorer's first matching field", async () => {
  const project = projectRecord({
    id: "project-release-board-001",
    slug: "release-board",
    name: "Coordinate release archive",
    purpose: "Coordinate release archive",
    repository: "https://github.com/customer/release-ledger"
  });
  const dependencies = projectDependencies(project);
  const request = {
    intent: "Review Coordinate release archive follow-up.",
    supportedConventionKinds: ["agents-md"]
  };

  const first = await resolveProjectRoute(request, dependencies);
  const repeated = await resolveProjectRoute(request, dependencies);

  assert.equal(first.status, "candidate");
  assert.equal(first.match.kind, "name_overlap");
  assert.deepEqual(first.match.fields, ["name"]);
  assert.equal(repeated.approval_binding, first.approval_binding);

  const exact = await resolveProjectRoute({
    ...request,
    projectSelector: first.project.id,
    approvalBinding: first.approval_binding
  }, dependencies);

  assert.equal(exact.status, "ready");
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
    rootIdentity: { type: "directory", dev: "101", ino: "501" }
  };
}

function projectDependencies(project) {
  return {
    readProjectRegistrations: async () => [project],
    inspectLiveRemote: async () => project.repository,
    inspectConventionInventory: async () => [{
      kind: "agents-md",
      resource: "AGENTS.md",
      observed_identity: {
        type: "file",
        dev: "101",
        ino: "601",
        mode: 33188,
        nlink: 1,
        size: "128",
        mtime_ns: "1788000000000000000",
        ctime_ns: "1788000000000000000"
      }
    }]
  };
}
