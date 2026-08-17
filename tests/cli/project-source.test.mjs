import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  CAMPAIGN_TASK,
  OTHER_PROJECT_CANARY,
  createProjectSourceRetrievalFixture,
  snapshotTree,
} from "../fixtures/project-source-retrieval.mjs";
import { projectSourceCommand } from "../../packages/cli/src/commands/project-source.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("spawned CLI retrieves one project's complete campaign asset references with finite consent", assertCliRetrieval);

function assertCliRetrieval() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const grantApplied = authorizeCliSource(fixture, true);
    assertAllowedCliRetrieval(fixture, grantApplied);
  } finally {
    fixture.cleanup();
  }
}

test("spawned CLI revokes one project-source grant before later retrieval", assertCliRevocation);

function assertCliRevocation() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const grantApplied = authorizeCliSource(fixture);
    const allowed = runJson(retrieveArgs(fixture));
    assert.equal(allowed.decision, "allowed");
    const receiptPath = accessReceiptPath(fixture);
    const receiptsBeforeRevoke = fs.readFileSync(receiptPath);
    revokeCliGrant(fixture, grantApplied.grant_id);
    assert.deepEqual(fs.readFileSync(receiptPath), receiptsBeforeRevoke);
    assertRevokedCliRetrieval(fixture, grantApplied.grant_id, receiptPath);
  } finally {
    fixture.cleanup();
  }
}

test("human grant preview presents the complete finite read consent", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const addPreview = runJson(sourceAddArgs(fixture));
    assert.equal(runJson(sourceAddArgs(fixture, addPreview)).applied, true);
    const preview = runCli([
      "project", "source", "grant", "acme-campaign", "campaign-assets",
      "--purpose", "Launch campaign assets",
      "--expires-at", "2099-01-01T00:00:00.000Z",
      "--path", fixture.aiosPath,
      "--home", fixture.homePath,
    ]);
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    assert.match(preview.stdout, /Project:\s+acme-campaign \(project-acme-001\)/);
    assert.match(preview.stdout, /Source:\s+Campaign assets \(campaign-assets\)/);
    assert.match(preview.stdout, /Scope:\s+read/);
    assert.match(preview.stdout, /Purpose:\s+Launch campaign assets/);
    assert.match(preview.stdout, /Approval timing:\s+when this exact preview is applied/);
    assert.match(preview.stdout, /Expires:\s+2099-01-01T00:00:00.000Z/);
  } finally {
    fixture.cleanup();
  }
});

test("advanced grant and revoke output separates portable and machine-local authorization effects", async (t) => {
  await t.test("human preview and apply", () => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      applySourceDeclaration(fixture);

      const grantPreview = runCli(withoutJson(sourceGrantArgs(fixture)));
      assert.equal(grantPreview.status, 0, grantPreview.stderr || grantPreview.stdout);
      assertAuthorizationEffects(grantPreview.stdout, fixture, "grant");

      const grantProof = runJson(sourceGrantArgs(fixture));
      const grantApplied = runCli(withoutJson(sourceGrantArgs(fixture, grantProof)));
      assert.equal(grantApplied.status, 0, grantApplied.stderr || grantApplied.stdout);
      assertAuthorizationEffects(grantApplied.stdout, fixture, "grant");
      assert.match(grantApplied.stdout, new RegExp(`Grant ID: ${grantProof.grant_id}`));

      const revokePreview = runCli(withoutJson(sourceRevokeArgs(fixture, grantProof.grant_id)));
      assert.equal(revokePreview.status, 0, revokePreview.stderr || revokePreview.stdout);
      assertAuthorizationEffects(revokePreview.stdout, fixture, "revocation");

      const revokeProof = runJson(sourceRevokeArgs(fixture, grantProof.grant_id));
      const revokeApplied = runCli(withoutJson(sourceRevokeArgs(fixture, grantProof.grant_id, revokeProof)));
      assert.equal(revokeApplied.status, 0, revokeApplied.stderr || revokeApplied.stdout);
      assertAuthorizationEffects(revokeApplied.stdout, fixture, "revocation");
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("JSON preview and apply", () => {
    const fixture = createProjectSourceRetrievalFixture();
    try {
      applySourceDeclaration(fixture);

      const grantPreview = runJson(sourceGrantArgs(fixture));
      assertJsonAuthorizationEffects(grantPreview, fixture, "grant");
      const grantApplied = runJson(sourceGrantArgs(fixture, grantPreview));
      assertJsonAuthorizationEffects(grantApplied, fixture, "grant");
      assert.equal(grantApplied.grant_id, grantPreview.grant_id);

      const revokePreview = runJson(sourceRevokeArgs(fixture, grantApplied.grant_id));
      assertJsonAuthorizationEffects(revokePreview, fixture, "revocation");
      const revokeApplied = runJson(sourceRevokeArgs(fixture, grantApplied.grant_id, revokePreview));
      assertJsonAuthorizationEffects(revokeApplied, fixture, "revocation");
    } finally {
      fixture.cleanup();
    }
  });
});

test("project-source help is reachable at every nested boundary and explains search selectors", () => {
  for (const args of [
    ["project", "--help"],
    ["project", "source", "--help"],
    ["project", "source", "grant", "--help"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const subcommand of ["add", "bind", "grant", "revoke", "retrieve", "connect"]) {
      assert.match(result.stdout, new RegExp(`project source ${subcommand}\\b`), args.join(" "));
    }
  }
  const search = runCli(["search", "--help"]);
  assert.equal(search.status, 0, search.stderr || search.stdout);
  assert.match(
    search.stdout,
    /Use --project to select a portable project corpus; use --session-project only to filter session tags\./,
  );
});

test("spawned guided connect previews once, applies with --yes, and retrieves the exact tracer", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const portableBefore = snapshotTree(fixture.aiosPath);
    const localBefore = snapshotTree(path.join(fixture.homePath, ".dotaios"));
    const preview = runJson(sourceConnectArgs(fixture));
    assert.equal(preview.operation, "connect");
    assert.equal(preview.applied, false);
    assert.equal(preview.project, "acme-campaign");
    assert.equal(preview.project_id, "project-acme-001");
    assert.equal(preview.source_id, "campaign-assets");
    assert.equal(preview.label, "Campaign assets");
    assert.equal(preview.scope, "read");
    assert.equal(preview.purpose, "Launch campaign assets");
    assert.equal(preview.approval_timing, "when --yes confirms this exact connection");
    assert.equal(preview.approved_at, null);
    assert.equal(preview.expires_at, "2099-01-01T00:00:00.000Z");
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), localBefore);

    const human = runCli(sourceConnectArgs(fixture, { json: false }));
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /Project:\s+acme-campaign \(project-acme-001\)/);
    assert.match(human.stdout, /Source:\s+Campaign assets \(campaign-assets\)/);
    assert.match(human.stdout, /Scope:\s+read/);
    assert.match(human.stdout, /Purpose:\s+Launch campaign assets/);
    assert.match(human.stdout, /Approval timing:\s+when --yes confirms this exact connection/);
    assert.match(human.stdout, /Expires:\s+2099-01-01T00:00:00.000Z/);
    assert.match(
      human.stdout,
      /Portable effect:\s+projects\/acme-campaign\/sources\/campaign-assets\.md/,
    );
    assert.ok(human.stdout.includes(`Local folder: ${fs.realpathSync(fixture.sourceRoot)}`));

    const connected = runJson(sourceConnectArgs(fixture, { yes: true }));
    assert.equal(connected.applied, true);
    assert.equal(connected.idempotent, false);
    assert.match(connected.grant_id, /^[a-f0-9-]+$/);
    assert.match(connected.approved_at, /^\d{4}-\d{2}-\d{2}T/);
    const rerun = runJson(sourceConnectArgs(fixture, { yes: true }));
    assert.equal(rerun.applied, true);
    assert.equal(rerun.idempotent, true);
    assert.equal(rerun.grant_id, connected.grant_id);

    assertAllowedCliRetrieval(fixture, connected);
  } finally {
    fixture.cleanup();
  }
});

test("guided connect and the project-search selector migration are documented", () => {
  const projectDocs = fs.readFileSync(path.join(repoRoot, "docs", "projects.md"), "utf8");
  const gettingStarted = fs.readFileSync(path.join(repoRoot, "docs", "getting-started.md"), "utf8");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  for (const document of [projectDocs, gettingStarted]) {
    assert.match(document, /project source connect <project> <folder>/);
    assert.match(document, /`--project` selects the portable project corpus/);
    assert.match(document, /`--session-project` filters session tags only/);
  }
  assert.match(changelog, /guided `project source connect`/);
  assert.match(changelog, /`search --project` now selects the portable project corpus/);
  assert.match(changelog, /`--session-project` remains the session-tag filter/);
});

test("project identity documentation matches the bounded cross-namespace collision scan", () => {
  const architecture = fs.readFileSync(path.join(repoRoot, "docs", "architecture.md"), "utf8");
  const plan = fs.readFileSync(
    path.join(repoRoot, "docs", "plans", "2026-08-10-003-feat-consumer-project-source-retrieval-plan.md"),
    "utf8",
  );

  assert.match(
    architecture,
    /both slug and stable-ID selectors\s+perform a bounded identity-only\s+catalog scan/i,
  );
  assert.match(architecture, /neighboring project bodies and source declarations\s+are never read/i);
  assert.match(
    plan,
    /KTD15\.[\s\S]*both slug and stable-ID selectors perform a bounded identity-only scan/i,
  );
  assert.match(plan, /detect slug\/stable-ID namespace collisions/i);
  assert.match(
    plan,
    /U4\.[\s\S]*both direct slug and stable-ID selectors scan bounded identity-only catalog headers/i,
  );
});

test("guided connect resumes only matching source-only state and refuses mismatches", () => {
  const resumable = createProjectSourceRetrievalFixture();
  try {
    const addPreview = runJson(sourceAddArgs(resumable));
    assert.equal(runJson(sourceAddArgs(resumable, addPreview)).applied, true);
    const connected = runJson(sourceConnectArgs(resumable, { yes: true }));
    assert.equal(connected.applied, true);
    assert.equal(connected.idempotent, false);
  } finally {
    resumable.cleanup();
  }

  const mismatched = createProjectSourceRetrievalFixture();
  try {
    const addPreview = runJson(sourceAddArgs(mismatched));
    assert.equal(runJson(sourceAddArgs(mismatched, addPreview)).applied, true);
    const otherRoot = path.join(mismatched.root, "other-assets");
    fs.mkdirSync(otherRoot);
    const localBefore = snapshotTree(path.join(mismatched.homePath, ".dotaios"));
    const refused = runCli(sourceConnectArgs(mismatched, { yes: true, folder: otherRoot }));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /does not match this connection/);
    assert.deepEqual(snapshotTree(path.join(mismatched.homePath, ".dotaios")), localBefore);
  } finally {
    mismatched.cleanup();
  }
});

function authorizeCliSource(fixture, verifyPreview = false) {
  const portableBefore = snapshotTree(fixture.aiosPath);
  const localBefore = snapshotTree(path.join(fixture.homePath, ".dotaios"));
  const addPreview = runJson(sourceAddArgs(fixture));
  assert.equal(addPreview.applied, false);
  assert.match(addPreview.operation_id, /^[a-f0-9-]+$/);
  assert.match(addPreview.plan_fingerprint, /^[a-f0-9]{64}$/);
  if (verifyPreview) {
    assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
    assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), localBefore);
  }
  assert.equal(runJson(sourceAddArgs(fixture, addPreview)).applied, true);
  const grantPreview = runJson(sourceGrantArgs(fixture));
  assert.equal(grantPreview.applied, false);
  assert.equal(grantPreview.scope, "read");
  assert.equal(grantPreview.approved_at, null);
  assert.equal(grantPreview.expires_at, "2099-01-01T00:00:00.000Z");
  const applied = runJson(sourceGrantArgs(fixture, grantPreview));
  assert.equal(applied.applied, true);
  assert.match(applied.grant_id, /^[a-f0-9-]+$/);
  assert.equal(applied.scope, "read");
  assert.match(applied.approved_at, /^\d{4}-\d{2}-\d{2}T/);
  return applied;
}

function applySourceDeclaration(fixture) {
  const preview = runJson(sourceAddArgs(fixture));
  assert.equal(runJson(sourceAddArgs(fixture, preview)).applied, true);
}

function withoutJson(args) {
  return args.filter((argument) => argument !== "--json");
}

function assertAuthorizationEffects(output, fixture, authorizationEffect) {
  assert.match(output, /Portable effect:\s+none/);
  assert.match(output, new RegExp(`Machine-local authorization effect:\\s+${authorizationEffect}`));
  assertPathFreeAuthorizationOutput(output, fixture);
}

function assertJsonAuthorizationEffects(result, fixture, authorizationEffect) {
  assert.deepEqual(result.portable, { effect: "none" });
  assert.deepEqual(result.machine_local, { authorization_effect: authorizationEffect });
  assertPathFreeAuthorizationOutput(JSON.stringify(result), fixture);
}

function assertPathFreeAuthorizationOutput(output, fixture) {
  assert.equal(output.includes(fixture.aiosPath), false);
  assert.equal(output.includes(fixture.homePath), false);
  assert.equal(output.includes(fixture.sourceRoot), false);
  assert.doesNotMatch(output, /\.dotaios|project-sources\/grants|project-sources\/bindings/);
}

function assertAllowedCliRetrieval(fixture, grantApplied) {
  const portableBefore = snapshotTree(fixture.aiosPath);
  const sourceBefore = snapshotTree(fixture.sourceRoot);
  const result = runJson(retrieveArgs(fixture));
  assert.equal(result.decision, "allowed");
  assert.equal(result.project_id, "project-acme-001");
  assert.equal(result.project, "acme-campaign");
  assert.equal(result.source_id, "campaign-assets");
  assert.deepEqual(result.references.map((reference) => reference.path), fixture.expectedPaths);
  assert.ok(result.references.every((reference) => validCliReference(reference, result)));
  const receipts = readReceipts(fixture);
  assertAllowedReceipt(receipts, result, grantApplied);
  assert.deepEqual(snapshotTree(fixture.aiosPath), portableBefore);
  assert.deepEqual(snapshotTree(fixture.sourceRoot), sourceBefore);
  assertRetrievalHasNoContentOrForeignState(fixture, result, receipts);
}

function validCliReference(reference, result) {
  return reference.project_id === "project-acme-001"
    && reference.source_id === "campaign-assets"
    && reference.type === "regular-file"
    && /^\d+$/.test(reference.size_bytes)
    && /^\d+$/.test(reference.mtime_ns)
    && reference.resolved_at === result.resolved_at
    && reference.receipt_id === result.receipt_id;
}

function assertAllowedReceipt(receipts, result, grantApplied) {
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.equal(receipt.decision, "allowed");
  assert.equal(receipt.task, CAMPAIGN_TASK);
  assert.equal(receipt.receipt_id, result.receipt_id);
  assert.equal(receipt.grant.scope, "read");
  assert.equal(receipt.grant.purpose, "Launch campaign assets");
  assert.equal(receipt.grant.approved_at, grantApplied.approved_at);
  assert.equal(receipt.grant.expires_at, grantApplied.expires_at);
  assert.equal(receipt.grant.revoked_at, null);
  assert.deepEqual(Object.keys(receipt.grant.root_identity).sort(), ["dev", "ino", "type"]);
  assert.deepEqual(receipt.references, result.references);
}

function assertRetrievalHasNoContentOrForeignState(fixture, result, receipts) {
  const serialized = JSON.stringify({ result, receipts });
  assert.doesNotMatch(serialized, /CONTENT_READ_CANARY/);
  assert.doesNotMatch(serialized, new RegExp(OTHER_PROJECT_CANARY));
  assert.equal(serialized.includes(fixture.sourceRoot), false);
  assert.equal(serialized.includes(path.join(fixture.homePath, ".dotaios")), false);
}

function revokeCliGrant(fixture, grantId) {
  const localBefore = snapshotTree(path.join(fixture.homePath, ".dotaios"));
  const preview = runJson(sourceRevokeArgs(fixture, grantId));
  assert.equal(preview.applied, false);
  assert.equal(preview.grant_id, grantId);
  assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), localBefore);
  assert.equal(runJson(sourceRevokeArgs(fixture, grantId, preview)).applied, true);
}

function assertRevokedCliRetrieval(fixture, grantId, receiptPath) {
  const refused = runJson(retrieveArgs(fixture));
  assert.equal(refused.decision, "refused");
  assert.equal(refused.reason, "grant-revoked");
  assert.deepEqual(refused.references, []);
  const receipts = fs.readFileSync(receiptPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1].task, CAMPAIGN_TASK);
  assert.equal(receipts[1].reason, "grant-revoked");
  assert.equal(receipts[1].grant.grant_id, grantId);
  assert.deepEqual(receipts[1].references, []);
  assert.equal(JSON.stringify({ refused, receipts }).includes(fixture.sourceRoot), false);
}

function sourceAddArgs(fixture, proof = null) {
  return [
    "project", "source", "add", "acme-campaign", fixture.sourceRoot,
    "--source-id", "campaign-assets", "--label", "Campaign assets",
    "--purpose", "Launch campaign assets",
    ...applyProofArgs(proof), ...commonFixtureArgs(fixture),
  ];
}

function sourceGrantArgs(fixture, proof = null) {
  return [
    "project", "source", "grant", "acme-campaign", "campaign-assets",
    "--purpose", "Launch campaign assets", "--expires-at", "2099-01-01T00:00:00.000Z",
    ...applyProofArgs(proof), ...commonFixtureArgs(fixture),
  ];
}

function sourceRevokeArgs(fixture, grantId, proof = null) {
  return [
    "project", "source", "revoke", "acme-campaign", "campaign-assets", "--grant-id", grantId,
    ...applyProofArgs(proof), ...commonFixtureArgs(fixture),
  ];
}

test("spawned guided connect wires a folder without asking for a timestamp", assertConnectWithoutExpiry);

function assertConnectWithoutExpiry() {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    // An explicit date is still honoured, and still wins over the default.
    const explicit = runJson(withExpiry(sourceConnectArgs(fixture), "2077-01-01T00:00:00.000Z"));
    assert.equal(explicit.expires_at, "2077-01-01T00:00:00.000Z");

    // Omitting it entirely is the point of this change.
    const preview = runJson(withoutExpiry(sourceConnectArgs(fixture)));
    assert.equal(preview.applied, false);
    assert.equal(preview.expires_at, "2099-01-01T00:00:00.000Z");

    const connected = runJson(withoutExpiry(sourceConnectArgs(fixture, { yes: true })));
    assert.equal(connected.applied, true);
    assert.match(connected.grant_id, /^[a-f0-9-]+$/);
    assert.equal(connected.expires_at, "2099-01-01T00:00:00.000Z");

    // The folder is usable immediately, with no timestamp ever typed.
    assert.equal(runJson(retrieveArgs(fixture)).decision, "allowed");
  } finally {
    fixture.cleanup();
  }
}

function withoutExpiry(args) {
  const index = args.indexOf("--expires-at");
  return index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function withExpiry(args, value) {
  const index = args.indexOf("--expires-at");
  return index === -1 ? args : [...args.slice(0, index + 1), value, ...args.slice(index + 2)];
}

function sourceConnectArgs(fixture, { yes = false, json = true, folder = fixture.sourceRoot } = {}) {
  return [
    "project", "source", "connect", "acme-campaign", folder,
    "--source-id", "campaign-assets", "--label", "Campaign assets",
    "--purpose", "Launch campaign assets", "--expires-at", "2099-01-01T00:00:00.000Z",
    ...(yes ? ["--yes"] : []),
    "--path", fixture.aiosPath,
    "--home", fixture.homePath,
    ...(json ? ["--json"] : []),
  ];
}

function retrieveArgs(fixture) {
  return [
    "project", "source", "retrieve", "acme-campaign", "--task", CAMPAIGN_TASK,
    ...commonFixtureArgs(fixture),
  ];
}

function applyProofArgs(proof) {
  return proof
    ? ["--operation-id", proof.operation_id, "--plan-fingerprint", proof.plan_fingerprint, "--apply"]
    : [];
}

function commonFixtureArgs(fixture) {
  return ["--path", fixture.aiosPath, "--home", fixture.homePath, "--json"];
}

function accessReceiptPath(fixture) {
  return path.join(fixture.homePath, ".dotaios", "project-sources", "access-receipts.jsonl");
}

function readReceipts(fixture) {
  return fs.readFileSync(accessReceiptPath(fixture), "utf8").trim().split("\n").map(JSON.parse);
}

test("spawned CLI refuses incomplete grant and revoke previews without writing local state", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const before = snapshotTree(path.join(fixture.homePath, ".dotaios"));
    const failures = [
      runCli([
        "project", "source", "grant", "acme-campaign", "campaign-assets",
        "--expires-at", "2099-01-01T00:00:00.000Z",
        "--path", fixture.aiosPath,
        "--home", fixture.homePath,
        "--json",
      ]),
      runCli([
        "project", "source", "grant", "acme-campaign", "campaign-assets",
        "--purpose", "Launch campaign assets",
        "--path", fixture.aiosPath,
        "--home", fixture.homePath,
        "--json",
      ]),
      runCli([
        "project", "source", "revoke", "acme-campaign", "campaign-assets",
        "--path", fixture.aiosPath,
        "--home", fixture.homePath,
        "--json",
      ]),
    ];
    assert.ok(failures.every((result) => result.status === 1));
    const errors = failures.map((result) => JSON.parse(result.stderr));
    assert.deepEqual(errors.map((error) => error.error.reason), [
      "invalid-request", "invalid-request", "invalid-request",
    ]);
    assert.match(errors[0].error.message, /--purpose is required/);
    assert.match(errors[1].error.message, /--expires-at is required/);
    assert.match(errors[2].error.message, /--grant-id is required/);
    assert.deepEqual(snapshotTree(path.join(fixture.homePath, ".dotaios")), before);
  } finally {
    fixture.cleanup();
  }
});

test("JSON source errors never expose raw filesystem exceptions or paths", async () => {
  const output = {
    lines: [],
    errors: [],
    log(value) { this.lines.push(value); },
    error(value) { this.errors.push(value); },
  };
  const filesystem = Object.create(fsp);
  filesystem.realpath = async () => {
    const error = new Error("EACCES: /private/client-secret");
    error.code = "EACCES";
    throw error;
  };
  await assert.rejects(
    () => projectSourceCommand([
      "add", "acme-campaign", "/private/client-secret",
      "--source-id", "campaign-assets",
      "--label", "Campaign assets",
      "--purpose", "Launch campaign assets",
      "--path", "/private/portable-aios",
      "--home", "/private/home",
      "--json",
    ], { output, fs: filesystem }),
  );
  const payload = JSON.parse(output.errors[0]);
  assert.equal(payload.error.code, "DOTAIOS_PROJECT_SOURCE_INVALID_REQUEST");
  assert.equal(payload.error.reason, "invalid-request");
  assert.equal(payload.error.message, "Project source request is invalid.");
  assert.doesNotMatch(JSON.stringify(payload), /private|EACCES|client-secret/);
});

function runJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DOTAIOS_ALLOW_AUTO_SYNC_HOOK: "0" },
  });
}
