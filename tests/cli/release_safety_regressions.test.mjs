import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { MANAGED_END, MANAGED_START, bridgePointer } from "../../packages/core/src/bridges.mjs";
import { SETUP_TRANSACTION_FILE } from "../../packages/core/src/paths.mjs";
import { createAiosConfig } from "../../packages/core/src/schema.mjs";
import { initCommand } from "../../packages/cli/src/commands/init.mjs";
import {
  REQUIRED_RELEASE_CHECKS,
  verifyReviewedSource,
} from "../../scripts/verify-release-source.mjs";
import { verifyEvidenceCommit } from "../../scripts/verify-release-evidence-commit.mjs";
import { evaluateReleaseAdmission } from "../../scripts/release-checklist.mjs";
import { applyApprovedProjectRegistration } from "../helpers/project-registration.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const isolatedPath = "/usr/bin:/bin";

function makeSandbox(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    aiosPath: path.join(root, "aios"),
    homePath: path.join(root, "home"),
    processHomePath: path.join(root, "process-home")
  };
}

function registerApprovedProject(sandbox, projectPath) {
  const env = { ...process.env, HOME: sandbox.processHomePath, PATH: isolatedPath };
  applyApprovedProjectRegistration(
    (args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env
    }),
    [
      "project", "add", projectPath,
      "--path", sandbox.aiosPath,
      "--home", sandbox.homePath
    ]
  );
}

function runDoctor(t, label, bridgeContent, {
  entrypoint = false,
  removeAiosFolder = false,
  setupMarker = false,
  expectStatus = 0
} = {}) {
  const sandbox = makeSandbox(t, label);
  const bridgePath = path.join(sandbox.homePath, ".claude", "CLAUDE.md");
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.mkdirSync(sandbox.processHomePath, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(bridgePath), "settings.json"), "{}\n");
  fs.writeFileSync(
    path.join(sandbox.aiosPath, "aios.json"),
    `${JSON.stringify(createAiosConfig({ aiTools: [] }), null, 2)}\n`
  );
  if (entrypoint) {
    fs.writeFileSync(path.join(sandbox.aiosPath, "AGENTS.md"), "# My AIOS\n");
  }
  if (setupMarker) {
    fs.writeFileSync(
      path.join(sandbox.aiosPath, SETUP_TRANSACTION_FILE),
      `${JSON.stringify({ format: "dotaios-setup-transaction/v1", pid: 999999 })}\n`
    );
  }
  fs.writeFileSync(bridgePath, bridgeContent(sandbox.aiosPath));
  if (removeAiosFolder) {
    fs.rmSync(sandbox.aiosPath, { recursive: true, force: true });
  }

  const result = spawnSync(process.execPath, [
    cli,
    "doctor",
    "--path", sandbox.aiosPath,
    "--home", sandbox.homePath
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DOTAIOS_NO_UPDATE_CHECK: "1",
      HOME: sandbox.processHomePath,
      PATH: isolatedPath
    }
  });

  assert.equal(result.status, expectStatus, result.stderr);
  return result.stdout;
}

const malformedBridgeCases = {
  duplicate: (target) => [
    MANAGED_START,
    `@${path.join(target, "AGENTS.md")}`,
    MANAGED_END,
    MANAGED_START,
    "duplicate block",
    MANAGED_END,
    ""
  ].join("\n"),
  reversed: (target) => [
    MANAGED_END,
    `@${path.join(target, "AGENTS.md")}`,
    MANAGED_START,
    ""
  ].join("\n"),
  "start-only": (target) => [
    MANAGED_START,
    `@${path.join(target, "AGENTS.md")}`,
    ""
  ].join("\n"),
  "end-only": (target) => [
    `@${path.join(target, "AGENTS.md")}`,
    MANAGED_END,
    ""
  ].join("\n")
};

for (const [label, bridgeContent] of Object.entries(malformedBridgeCases)) {
  test(`doctor warns instead of reporting a healthy Claude bridge with ${label} managed markers`, (t) => {
    const output = runDoctor(t, `doctor-${label}`, bridgeContent);

    assert.match(output, /\[warn\] Claude Code\n/);
    assert.match(output, /connection markers are damaged/i);
    assert.doesNotMatch(output, /\[ok\] Claude Code\n/);
  });
}

test("doctor ignores a correct target outside a valid managed block for another AIOS folder", (t) => {
  const output = runDoctor(t, "doctor-wrong-managed-block", (target) => [
    `Unmanaged note mentioning ${path.join(target, "AGENTS.md")}`,
    MANAGED_START,
    "@/another/aios/AGENTS.md",
    MANAGED_END,
    ""
  ].join("\n"));

  assert.match(output, /\[warn\] Claude Code\n/);
  assert.match(output, /connected to a different AIOS folder/i);
  assert.doesNotMatch(output, /\[ok\] Claude Code\n/);
});

test("doctor ignores an expected-path comment inside a valid block with the wrong pointer", (t) => {
  const output = runDoctor(t, "doctor-wrong-pointer-comment", (target) => [
    MANAGED_START,
    "@/another/aios/AGENTS.md",
    `Diagnostic only: ${path.join(target, "AGENTS.md")}`,
    MANAGED_END,
    ""
  ].join("\n"));

  assert.match(output, /\[warn\] Claude Code\n/);
  assert.match(output, /connected to a different AIOS folder/i);
  assert.doesNotMatch(output, /\[ok\] Claude Code\n/);
});

// A bridge was validated by comparing the pointer line against a path doctor
// computed itself. Both sides came from the same in-memory target string, so
// they agreed perfectly while the file the pointer names was gone: doctor
// reported [ok] and then told the user to read a file that does not exist.
//
// The pointer comes from the writer, not a literal: a bridge spelled the way an
// older release spelled it is a different case with a different verdict, and
// hardcoding one here let these tests drift into asserting it by accident.
const managedPointerBridge = (target) => [
  MANAGED_START,
  bridgePointer(target).current,
  MANAGED_END,
  ""
].join("\n");

test("doctor warns when the bridge points at this AIOS folder but its entrypoint is gone", (t) => {
  const output = runDoctor(t, "doctor-missing-entrypoint", managedPointerBridge);

  assert.match(output, /\[warn\] Claude Code\n/);
  assert.match(output, /AGENTS\.md/);
  assert.doesNotMatch(output, /\[ok\] Claude Code\n/);
  // The pointer is correct — repointing is not the remedy and cannot help.
  assert.doesNotMatch(output, /connection points to a different AIOS folder/i);
});

// The bridge an older release wrote is still ours and still names this folder,
// so doctor must not call it wrong. But it is the `@` import this release exists
// to remove, and it keeps expanding the whole folder into every session until
// the user re-runs activate. Nothing else in the product tells them to, so if
// this row is [ok] the fix ships and reaches only new installs.
const olderBridgeWith = (pointer) => (target) => [
  "# DotAIOS Claude Code Bridge",
  "",
  MANAGED_START,
  "Read the user's DotAIOS context before recommendations that depend on identity, priorities, active work, memory, or writing style.",
  "",
  typeof pointer === "function" ? pointer(target) : pointer,
  "",
  "AGENTS.md is the single source of truth for this folder: who the user is, how it is organized, the rules, and the installed skills.",
  MANAGED_END,
  ""
].join("\n");

const legacyImportBridge = olderBridgeWith((target) => `@${path.join(target, "AGENTS.md")}`);

// Every retired spelling gets the same verdict, taken from bridgePointer rather
// than hardcoded here — a spelling added to `retired` without a doctor branch
// would otherwise keep reporting [ok] exactly like the `@` import did.
for (const [index, retiredPointer] of bridgePointer("/placeholder").retired.entries()) {
  test(`doctor tells an already-installed user to re-run activate for retired pointer ${index}`, (t) => {
    const output = runDoctor(
      t,
      `doctor-legacy-bridge-${index}`,
      olderBridgeWith((target) => retiredPointer.replace("/placeholder", target)),
      { entrypoint: true }
    );

    assert.match(output, /\[warn\] Claude Code\n/);
    assert.doesNotMatch(output, /\[ok\] Claude Code\n/);
    // The remedy has to name the command that rewrites the block. It is the only
    // one that does, and the user has no other signal that anything is stale.
    assert.match(output, /dotaios activate/);
    // Not "points to a different AIOS folder": the folder is right, the spelling
    // is old. Saying it is wrong sends the user to --overwrite for no reason.
    assert.doesNotMatch(output, /connection points to a different AIOS folder/i);
  });
}

// Only the `@` spelling is expanded by the host, so only it is described that
// way. Telling a Codex user their bridge loaded the whole folder would describe
// a problem their prose pointer never had.
test("only the @ import is described as loading the whole folder", (t) => {
  const importing = runDoctor(t, "doctor-legacy-import-detail", legacyImportBridge, { entrypoint: true });
  assert.match(importing, /loads your whole AIOS folder into every session/);

  const prose = runDoctor(
    t,
    "doctor-legacy-prose-detail",
    olderBridgeWith((target) => `DotAIOS entrypoint (read this file first): ${path.join(target, "AGENTS.md")}`),
    { entrypoint: true }
  );
  assert.match(prose, /\[warn\] Claude Code\n/);
  assert.doesNotMatch(prose, /loads your whole AIOS folder/);
});

// An old bridge is stale, not broken. Warning is what gets a non-developer to
// act; failing would tell every existing user their install is broken during an
// upgrade they have not run yet.
test("an older bridge is a warning, not a doctor failure", (t) => {
  const output = runDoctor(t, "doctor-legacy-bridge-exit", legacyImportBridge, { entrypoint: true });

  assert.match(output, /DotAIOS works/);
});

test("doctor warns about the bridge when the whole AIOS folder was removed", (t) => {
  const output = runDoctor(t, "doctor-removed-folder", managedPointerBridge, {
    removeAiosFolder: true,
    expectStatus: 1
  });

  assert.match(output, /\[warn\] Claude Code\n/);
  assert.doesNotMatch(output, /\[ok\] Claude Code\n/);
});

// Nothing else in the suite asserts a GREEN bridge; every other bridge
// assertion is doesNotMatch(/\[ok\]/). Without this, a fix that makes the
// bridge check warn forever would pass the whole suite.
test("doctor reports a healthy Claude bridge when the entrypoint really is there", (t) => {
  const output = runDoctor(t, "doctor-healthy-bridge", managedPointerBridge, { entrypoint: true });

  assert.match(output, /\[ok\] Claude Code\n/);
  assert.doesNotMatch(output, /\[warn\] Claude Code\n/);
});

// A marker on disk means init never finished, so the scaffold is still partial.
// doctor knew nothing about it and closed with "DotAIOS works".
test("doctor reports an unfinished setup instead of calling the folder healthy", (t) => {
  const output = runDoctor(t, "doctor-unfinished-setup", managedPointerBridge, {
    entrypoint: true,
    setupMarker: true,
    expectStatus: 1
  });

  assert.match(output, /\[fail\] Setup completed/);
  assert.match(output, /dotaios setup/);
  assert.doesNotMatch(output, /DotAIOS works/);
});

// doctor sent users to `activate --overwrite` for a file it had just called
// unmanaged, while activate's own remedy for the same file is `--merge`.
test("doctor names the non-destructive remedy for an unmanaged bridge file", (t) => {
  const output = runDoctor(t, "doctor-unmanaged-remedy", () => "My own notes for Claude.\n", {
    entrypoint: true
  });

  assert.match(output, /\[warn\] Claude Code\n/);
  assert.match(output, /activate --merge/);
  assert.doesNotMatch(output, /activate --overwrite/);
});

test("activate and attach report a preserved foreign project bridge as blocking", (t) => {
  const sandbox = makeSandbox(t, "project-bridge-collision");
  const projectPath = path.join(sandbox.root, "project");
  const projectBridge = path.join(projectPath, "AGENTS.md");
  const foreignBytes = Buffer.from("# Private project instructions\n");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(sandbox.homePath, { recursive: true });
  fs.mkdirSync(sandbox.processHomePath, { recursive: true });
  fs.writeFileSync(projectBridge, foreignBytes);

  const initialized = spawnSync(process.execPath, [
    cli, "init", "--yes", "--path", sandbox.aiosPath
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: sandbox.processHomePath, PATH: isolatedPath }
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  registerApprovedProject(sandbox, projectPath);

  for (const args of [
    ["activate", "--path", sandbox.aiosPath, "--home", sandbox.homePath, "--project", projectPath],
    ["attach", projectPath, "--path", sandbox.aiosPath, "--home", sandbox.homePath]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: sandbox.processHomePath, PATH: isolatedPath }
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(fs.readFileSync(projectBridge), foreignBytes);
    assert.match(`${result.stdout}\n${result.stderr}`, /needs attention/i);
  }
});

test("init preserves concurrently published skill catalogs and rejects the run", async (t) => {
  const sandbox = makeSandbox(t, "init-catalog-race");
  const indexPath = path.join(sandbox.aiosPath, "skills", "INDEX.md");
  const resolverPath = path.join(sandbox.aiosPath, "skills", "RESOLVER.md");
  const foreignIndex = Buffer.from("foreign index bytes\n\u0000\n", "utf8");
  const foreignResolver = Buffer.from("foreign resolver bytes\n\u0001\n", "utf8");

  await assert.rejects(
    initCommand(["--yes", "--path", sandbox.aiosPath], {
      quiet: true,
      afterCreateBaseTree: async () => {
        fs.writeFileSync(indexPath, foreignIndex);
        fs.writeFileSync(resolverPath, foreignResolver);
      }
    }),
    /skill catalog changed while init was running.*INDEX\.md.*RESOLVER\.md/is
  );

  assert.deepEqual(fs.readFileSync(indexPath), foreignIndex);
  assert.deepEqual(fs.readFileSync(resolverPath), foreignResolver);
});

test("setup fails closed when installed Claude has a malformed bridge", (t) => {
  const sandbox = makeSandbox(t, "setup-malformed-claude");
  const bridgePath = path.join(sandbox.homePath, ".claude", "CLAUDE.md");
  const malformedBridge = Buffer.from([
    MANAGED_END,
    "private Claude instructions",
    MANAGED_START,
    ""
  ].join("\n"));
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.mkdirSync(sandbox.processHomePath, { recursive: true });
  fs.writeFileSync(bridgePath, malformedBridge);
  fs.writeFileSync(path.join(path.dirname(bridgePath), "settings.json"), "{}\n");

  const result = spawnSync(process.execPath, [
    cli,
    "setup",
    "--yes",
    "--skip-reveal",
    "--path", sandbox.aiosPath,
    "--home", sandbox.homePath
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: sandbox.processHomePath,
      PATH: isolatedPath
    }
  });

  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.deepEqual(fs.readFileSync(bridgePath), malformedBridge);
  assert.match(output, /Folder created\. Tool connection needs attention/i);
  assert.doesNotMatch(output, /Install Claude Code/i);
});

test("release source admission requires a reviewed PR head and every exact required check", () => {
  const input = reviewedSourceFixture();
  const receipt = verifyReviewedSource(input);
  assert.equal(receipt.schema, "dotaios.reviewed-source.v1");
  assert.equal(receipt.source_go, "GO");
  assert.equal(receipt.source_commit, input.source_commit);
  assert.equal(receipt.reviewed_pr.number, input.pr.number);
  assert.equal(receipt.reviewed_pr.head, input.source_commit);
  assert.match(receipt.reviewed_pr.required_checks_sha256, /^[a-f0-9]{64}$/);

  const cases = [
    ["direct main", { pr: { ...input.pr, head_branch: "main" } }],
    ["unreviewed", { pr: { ...input.pr, approved_head_sha: "f".repeat(40) } }],
    ["open", { pr: { ...input.pr, state: "OPEN", merged: false } }],
    ["wrong commit", { source_commit: "e".repeat(40) }],
    ["required check subset", { required_checks: REQUIRED_RELEASE_CHECKS.slice(0, -1) }],
    ["invented required check", { required_checks: [...REQUIRED_RELEASE_CHECKS.slice(0, -1), "invented release gate"] }],
    ["extra required check", { required_checks: [...REQUIRED_RELEASE_CHECKS, "extra release gate"] }],
    ["missing check", { check_runs: input.check_runs.slice(0, -1) }],
    ["failed check", { check_runs: input.check_runs.map((check, index) => index === 0 ? { ...check, conclusion: "failure" } : check) }],
    ["stale check", { check_runs: input.check_runs.map((check, index) => index === 0 ? { ...check, head_sha: "d".repeat(40) } : check) }],
  ];
  for (const [label, changed] of cases) {
    assert.throws(
      () => verifyReviewedSource({ ...input, ...changed }),
      /review|source|commit|head|merged|required|check|main/i,
      label,
    );
  }
});

test("release admission CI checks out and packs the exact clean reviewed source", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const admissionJob = workflow.split("  admission-firewall:")[1];
  assert.ok(admissionJob, "release admission job must exist");
  assert.match(admissionJob, /uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(admissionJob, /test "\$\(git rev-parse HEAD\)" = "\$REVIEWED_SOURCE_COMMIT"/);
  assert.match(admissionJob, /test -z "\$\(git status --porcelain\)"/);
  assert.doesNotMatch(admissionJob, /--untracked-files=no/);
  assert.ok(
    admissionJob.indexOf("git rev-parse HEAD") < admissionJob.indexOf("npm run pack:admission"),
    "reviewed HEAD must be proved before package creation",
  );
  assert.ok(
    admissionJob.indexOf("git status --porcelain") < admissionJob.indexOf("npm run pack:admission"),
    "a fully clean source checkout must be proved before package creation",
  );
  assert.match(
    admissionJob,
    /npm run pack:admission -- --silent --source-commit "\$REVIEWED_SOURCE_COMMIT" --pack-destination \.artifacts/,
    "artifact construction must bind the already-verified source commit",
  );
  assert.match(
    admissionJob,
    /uses: actions\/upload-artifact@v4[\s\S]*?include-hidden-files: true/,
    "the upload step must admit evidence stored under .artifacts",
  );
});

test("evidence commit admission permits only reviewed sanitized evidence with unchanged package bytes", () => {
  const input = evidenceCommitFixture();
  const receipt = verifyEvidenceCommit(input);
  assert.deepEqual(receipt, {
    schema: "dotaios.evidence-commit.v1",
    evidence_go: "GO",
    candidate_source_commit: input.candidate_source_commit,
    evidence_commit: input.evidence_commit,
    reviewed_pr: {
      number: input.pr.number,
      head: input.evidence_commit,
    },
    package_tree_sha256: input.candidate_package_tree_sha256,
    evidence_files_sha256: receipt.evidence_files_sha256,
  });
  assert.match(receipt.evidence_files_sha256, /^[a-f0-9]{64}$/);

  const cases = [
    ["package file", { changes: [...input.changes, { path: "package.json", status: "modified", mode: "100644", blob_sha256: "9".repeat(64) }] }],
    ["tree drift", { evidence_package_tree_sha256: "8".repeat(64) }],
    ["linked evidence", { changes: input.changes.map((change, index) => index === 0 ? { ...change, mode: "120000" } : change) }],
    ["unreviewed evidence", { pr: { ...input.pr, approved_head_sha: "7".repeat(40) } }],
    ["direct main", { pr: { ...input.pr, head_branch: "main" } }],
  ];
  for (const [label, changed] of cases) {
    assert.throws(
      () => verifyEvidenceCommit({ ...input, ...changed }),
      /evidence|package|tree|file|link|review|head|main/i,
      label,
    );
  }
});

test("final admission reports package, native-agent, and public-release states separately", (t) => {
  const source = verifyReviewedSource(reviewedSourceFixture());
  const packageReceipt = {
    schema: "dotaios.package-admission.v1",
    verdict: "go",
    package_go: "GO",
    source_commit: source.source_commit,
    artifact: {
      name: "dotaios",
      version: "2.0.12",
      sha256: "4".repeat(64),
      payload_sha256: "3".repeat(64),
      dependency_graph_sha256: "5".repeat(64),
    },
    assertions: {
      archive_regular_files_only: true,
      artifact_identity_stable: true,
      bundled_graph_complete: true,
      candidate_loaded_without_ambient_modules: true,
      lifecycle_scripts_absent: true,
      shrinkwrap_admitted: true,
    },
  };
  const admission = evaluateReleaseAdmission({ source, package_receipt: packageReceipt });
  assert.equal(admission.package_admission, "GO");
  assert.equal(admission.native_agent_admission, "NO-GO");
  assert.equal(admission.public_release_admission, "NO-GO");

  const sandbox = makeSandbox(t, "release-checklist");
  const inputPath = path.join(sandbox.root, "admission.json");
  const sentinel = path.join(sandbox.root, "must-not-change.txt");
  fs.writeFileSync(inputPath, JSON.stringify({ source, package_receipt: packageReceipt }));
  fs.writeFileSync(sentinel, "unchanged\n");
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts", "release-checklist.mjs"), "--admission", inputPath,
  ], { cwd: repoRoot, encoding: "utf8", env: { PATH: path.dirname(process.execPath) } });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Package admission: GO/);
  assert.match(result.stdout, /Native-agent admission: NO-GO/);
  assert.match(result.stdout, /Public-release admission: NO-GO/);
  assert.doesNotMatch(result.stdout, /Safe to publish|npm publish|git push|gh release/i);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged\n");
});

test("public release reaches GO only with both native clients and every separately owned proof", () => {
  const input = completeReleaseAdmissionFixture();
  const admitted = evaluateReleaseAdmission(input);
  assert.equal(admitted.package_admission, "GO");
  assert.equal(admitted.native_agent_admission, "GO");
  assert.equal(admitted.public_release_admission, "GO");

  const cases = [
    ["missing client", { native_admissions: input.native_admissions.slice(0, 1) }],
    ["registry drift", { registry_receipt: { ...input.registry_receipt, git_head: "f".repeat(40) } }],
    ["evidence drift", { evidence_commit: { ...input.evidence_commit, candidate_source_commit: "e".repeat(40) } }],
    ["instruction design", { non_founder_outcome: { ...input.non_founder_outcome, instruction_file_designed: "yes" } }],
    ["no authority", { public_authority: undefined }],
  ];
  for (const [label, changed] of cases) {
    const result = evaluateReleaseAdmission({ ...input, ...changed });
    assert.equal(result.public_release_admission, "NO-GO", label);
  }

  const nativeCases = [
    ["source", { source_commit: "8".repeat(40) }],
    ["reviewed head", { reviewed_pr_head: "8".repeat(40) }],
    ["artifact", { artifact_sha256: "8".repeat(64) }],
    ["dependency graph", { dependency_graph_sha256: "8".repeat(64) }],
    ["consume challenge", { consume: { ...input.native_admissions[0].consume, challenge_id: "8".repeat(64) } }],
    ["consume receipt", { consume: { ...input.native_admissions[0].consume, receipt_sha256: "not-a-sha256" } }],
  ];
  for (const [label, changed] of nativeCases) {
    const nativeAdmissions = input.native_admissions.map((entry, index) => (
      index === 0 ? { ...entry, ...changed } : entry
    ));
    const result = evaluateReleaseAdmission({ ...input, native_admissions: nativeAdmissions });
    assert.equal(result.native_agent_admission, "NO-GO", label);
    assert.equal(result.public_release_admission, "NO-GO", label);
  }
});

function reviewedSourceFixture() {
  const head = "a".repeat(40);
  return {
    source_commit: head,
    pr: {
      number: 123,
      state: "MERGED",
      merged: true,
      base_branch: "main",
      head_branch: "codex/2-0-12-candidate",
      head_sha: head,
      approved_head_sha: head,
    },
    required_checks: [...REQUIRED_RELEASE_CHECKS],
    check_runs: REQUIRED_RELEASE_CHECKS.map((name) => ({
      name,
      conclusion: "success",
      head_sha: head,
    })),
  };
}

function evidenceCommitFixture() {
  const candidate = "a".repeat(40);
  const evidence = "b".repeat(40);
  return {
    candidate_source_commit: candidate,
    evidence_commit: evidence,
    candidate_package_tree_sha256: "c".repeat(64),
    evidence_package_tree_sha256: "c".repeat(64),
    pr: {
      number: 124,
      state: "MERGED",
      merged: true,
      base_branch: "main",
      head_branch: "codex/2-0-12-evidence",
      head_sha: evidence,
      approved_head_sha: evidence,
    },
    changes: [
      { path: "docs/release-evidence/2.0.12/index.json", status: "added", mode: "100644", blob_sha256: "d".repeat(64) },
      { path: "docs/release-evidence/2.0.12/codex.json", status: "added", mode: "100644", blob_sha256: "e".repeat(64) },
    ],
  };
}

function completeReleaseAdmissionFixture() {
  const source = verifyReviewedSource(reviewedSourceFixture());
  const artifactSha256 = "4".repeat(64);
  const dependencyGraphSha256 = "5".repeat(64);
  const packageReceipt = {
    schema: "dotaios.package-admission.v1",
    verdict: "go",
    package_go: "GO",
    source_commit: source.source_commit,
    artifact: {
      name: "dotaios",
      version: "2.0.12",
      sha256: artifactSha256,
      payload_sha256: "3".repeat(64),
      dependency_graph_sha256: dependencyGraphSha256,
    },
    assertions: {
      archive_regular_files_only: true,
      artifact_identity_stable: true,
      bundled_graph_complete: true,
      candidate_loaded_without_ambient_modules: true,
      lifecycle_scripts_absent: true,
      shrinkwrap_admitted: true,
    },
  };
  const native = (client, digit) => ({
    schema: "dotaios.native-admission.v1",
    client,
    native_agent_go: "GO",
    challenge_id: digit.repeat(64),
    source_commit: source.source_commit,
    reviewed_pr_head: source.reviewed_pr.head,
    artifact_sha256: artifactSha256,
    dependency_graph_sha256: dependencyGraphSha256,
    consume: {
      challenge_id: digit.repeat(64),
      receipt_sha256: digit.repeat(64),
    },
  });
  const evidence = verifyEvidenceCommit(evidenceCommitFixture());
  return {
    source,
    package_receipt: packageReceipt,
    registry_receipt: {
      schema: "dotaios.registry-artifact.v1",
      package: "dotaios",
      version: "2.0.12",
      artifact_sha256: artifactSha256,
      dependency_source: "npm-shrinkwrap",
      git_head: source.source_commit,
      integrity_sha512: `sha512-${"A".repeat(86)}==`,
    },
    native_admissions: [native("codex", "6"), native("claude", "7")],
    evidence_commit: evidence,
    non_founder_outcome: {
      schema: "dotaios.non-founder-outcome.v1",
      completed: "yes",
      source_commit: source.source_commit,
      artifact_sha256: artifactSha256,
      instruction_file_designed: "no",
      transcript_retained: "no",
    },
    public_authority: {
      schema: "dotaios.public-release-authority.v1",
      authorized: "yes",
      source_commit: source.source_commit,
      artifact_sha256: artifactSha256,
    },
  };
}
