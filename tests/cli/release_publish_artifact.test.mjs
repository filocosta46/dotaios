import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePublishArtifact,
  publishDecision,
} from "../../scripts/release-checklist.mjs";

// pruneBundledDependencyJunk only runs inside pack:admission. A maintainer who
// types `npm publish` in the repo root re-packs whatever node_modules happens to
// hold, which is how a dependency's test suite reached the registry. The
// checklist is the last read-only gate before that command, so it has to look at
// the exact bytes about to be published and refuse the known-dirty shapes.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const checklist = path.join(repoRoot, "scripts", "release-checklist.mjs");
const FIXTURE_VERSION = "9.8.7";

const CLEAN_ENTRIES = Object.freeze([
  "package/package.json",
  "package/npm-shrinkwrap.json",
  "package/README.md",
  "package/packages/cli/src/index.mjs",
  "package/node_modules/turndown/lib/turndown.cjs.js",
]);

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function makeTarball(entries) {
  const chunks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, "utf8");
    chunks.push(tarHeader(name, body.length), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function packageContents(extra = {}) {
  return {
    "package/package.json": JSON.stringify({ name: "dotaios", version: FIXTURE_VERSION }),
    "package/npm-shrinkwrap.json": JSON.stringify({ lockfileVersion: 3, packages: {} }),
    "package/README.md": "# DotAIOS\n",
    ...extra,
  };
}

function writeArtifact(t, label, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, `dotaios-${FIXTURE_VERSION}.tgz`);
  fs.writeFileSync(artifact, makeTarball(contents));
  return artifact;
}

function runChecklist(args) {
  return spawnSync(process.execPath, [checklist, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: path.dirname(process.execPath) },
  });
}

function releaseAdmissionForArtifact(artifact, {
  artifactSha256 = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
  includeFullReleaseEvidence = false,
  includePublicAuthority = true,
} = {}) {
  const sourceCommit = "a".repeat(40);
  const dependencyGraphSha256 = "5".repeat(64);
  const source = {
    schema: "dotaios.reviewed-source.v1",
    source_go: "GO",
    source_commit: sourceCommit,
    reviewed_pr: {
      number: 123,
      head: sourceCommit,
      required_checks_sha256: "b".repeat(64),
    },
  };
  const packageReceipt = {
    schema: "dotaios.package-admission.v1",
    verdict: "go",
    package_go: "GO",
    source_commit: sourceCommit,
    artifact: {
      name: "dotaios",
      version: FIXTURE_VERSION,
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
      third_party_notices_admitted: true,
    },
  };
  const publicAuthority = includePublicAuthority ? {
    schema: "dotaios.public-release-authority.v1",
    authorized: "yes",
    source_commit: sourceCommit,
    artifact_sha256: artifactSha256,
  } : undefined;
  const admission = {
    source,
    package_receipt: packageReceipt,
    public_authority: publicAuthority,
  };
  if (!includeFullReleaseEvidence) return admission;

  const nativeAdmission = (client, digit) => ({
    schema: "dotaios.native-admission.v1",
    client,
    native_agent_go: "GO",
    challenge_id: digit.repeat(64),
    source_commit: sourceCommit,
    reviewed_pr_head: sourceCommit,
    artifact_sha256: artifactSha256,
    dependency_graph_sha256: dependencyGraphSha256,
    consume: {
      challenge_id: digit.repeat(64),
      receipt_sha256: digit.repeat(64),
    },
  });
  return {
    ...admission,
    registry_receipt: {
      schema: "dotaios.registry-artifact.v1",
      package: "dotaios",
      version: FIXTURE_VERSION,
      artifact_sha256: artifactSha256,
      dependency_source: "npm-shrinkwrap",
      git_head: sourceCommit,
      integrity_sha512: `sha512-${"A".repeat(86)}==`,
    },
    native_admissions: [nativeAdmission("codex", "6"), nativeAdmission("claude", "7")],
    evidence_commit: {
      schema: "dotaios.evidence-commit.v1",
      evidence_go: "GO",
      candidate_source_commit: sourceCommit,
      evidence_commit: "c".repeat(40),
      reviewed_pr: { number: 124, head: "c".repeat(40) },
      package_tree_sha256: "d".repeat(64),
      evidence_files_sha256: "e".repeat(64),
    },
    non_founder_outcome: {
      schema: "dotaios.non-founder-outcome.v1",
      completed: "yes",
      source_commit: sourceCommit,
      artifact_sha256: artifactSha256,
      instruction_file_designed: "no",
      transcript_retained: "no",
    },
  };
}

function writeAdmission(t, label, admission) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const admissionPath = path.join(root, "admission.json");
  fs.writeFileSync(admissionPath, JSON.stringify(admission));
  return admissionPath;
}

test("a clean artifact listing is admitted for publication", () => {
  const verdict = evaluatePublishArtifact(CLEAN_ENTRIES);
  assert.equal(verdict.publish_artifact, "ADMITTED");
  assert.deepEqual(verdict.refusals, []);
});

test("a bundled dependency test fixture refuses the artifact", () => {
  const verdict = evaluatePublishArtifact([
    ...CLEAN_ENTRIES,
    "package/node_modules/@mixmark-io/domino/test/fixture/jquery-1.9.1.js",
  ]);
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.equal(verdict.refusals.length, 1);
  assert.match(verdict.refusals[0], /jquery-1\.9\.1\.js/);
});

test("a bundled dependency test corpus refuses the artifact", () => {
  const verdict = evaluatePublishArtifact([
    ...CLEAN_ENTRIES,
    "package/node_modules/@mixmark-io/domino/test/html5lib-tests.json",
  ]);
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.match(verdict.refusals[0], /html5lib-tests\.json/);
});

test("an artifact without the frozen dependency graph refuses publication", () => {
  const verdict = evaluatePublishArtifact(
    CLEAN_ENTRIES.filter((entry) => entry !== "package/npm-shrinkwrap.json")
  );
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.match(verdict.refusals[0], /npm-shrinkwrap\.json/);
});

test("every dirty condition is reported at once rather than one per run", () => {
  const verdict = evaluatePublishArtifact([
    "package/package.json",
    "package/node_modules/@mixmark-io/domino/test/fixture/jquery-1.9.1.js",
    "package/node_modules/@mixmark-io/domino/test/html5lib-tests.json",
  ]);
  assert.equal(verdict.publish_artifact, "REFUSED");
  assert.equal(verdict.refusals.length, 3);
});

test("publication needs both a GO admission and an admitted artifact", () => {
  assert.equal(publishDecision("GO", "ADMITTED").go, true);
  assert.equal(publishDecision("GO", "REFUSED").go, false);
  assert.equal(publishDecision("GO", "NOT PROVIDED").go, false);
  assert.equal(publishDecision("NO-GO", "ADMITTED").go, false);
});

test("the checklist refuses a dirty pack and never prints a publish command", (t) => {
  const artifact = writeArtifact(t, "dirty-artifact", packageContents({
    "package/node_modules/@mixmark-io/domino/test/fixture/jquery-1.9.1.js": "// jquery\n",
  }));

  const result = runChecklist(["--artifact", artifact]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(result.stdout, /Publish artifact: REFUSED/);
  assert.match(result.stdout, /jquery-1\.9\.1\.js/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("the checklist refuses a pack that lost its frozen dependency graph", (t) => {
  const contents = packageContents();
  delete contents["package/npm-shrinkwrap.json"];
  const artifact = writeArtifact(t, "unfrozen-artifact", contents);

  const result = runChecklist(["--artifact", artifact]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: REFUSED/);
  assert.match(result.stdout, /npm-shrinkwrap\.json/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("a clean pack is admitted even while the release itself stays NO-GO", (t) => {
  const artifact = writeArtifact(t, "clean-artifact", packageContents());

  const result = runChecklist(["--artifact", artifact]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: ADMITTED/);
  assert.match(result.stdout, /Public-release admission: NO-GO/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("the checklist refuses clean bytes that do not match the package receipt", (t) => {
  const artifact = writeArtifact(t, "receipt-mismatch", packageContents());
  const admission = releaseAdmissionForArtifact(artifact, {
    artifactSha256: "4".repeat(64),
    includeFullReleaseEvidence: true,
  });
  const admissionPath = writeAdmission(t, "receipt-mismatch", admission);

  const result = runChecklist(["--admission", admissionPath, "--artifact", artifact]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: REFUSED/);
  assert.match(result.stdout, /SHA-256 does not match the package receipt/);
  assert.doesNotMatch(result.stdout, /npm publish|npm dist-tag/i);
});

test("candidate publication authorizes the exact admitted bytes once", (t) => {
  const artifact = writeArtifact(t, "candidate", packageContents());
  const admissionPath = writeAdmission(
    t,
    "candidate",
    releaseAdmissionForArtifact(artifact),
  );

  const result = runChecklist([
    "--candidate-publish", "--admission", admissionPath, "--artifact", artifact,
  ]);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Candidate publication: GO/);
  assert.match(result.stdout, /npm publish .*\.tgz --tag candidate/);
  assert.doesNotMatch(result.stdout, /npm dist-tag/i);
});

test("candidate publication needs explicit authority", (t) => {
  const artifact = writeArtifact(t, "candidate-no-authority", packageContents());
  const admissionPath = writeAdmission(
    t,
    "candidate-no-authority",
    releaseAdmissionForArtifact(artifact, { includePublicAuthority: false }),
  );

  const result = runChecklist([
    "--candidate-publish", "--admission", admissionPath, "--artifact", artifact,
  ]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Candidate publication: NO-GO/);
  assert.doesNotMatch(result.stdout, /npm publish|npm dist-tag/i);
});

test("full public GO promotes the already-published candidate instead of republishing", (t) => {
  const artifact = writeArtifact(t, "public-release", packageContents());
  const admissionPath = writeAdmission(
    t,
    "public-release",
    releaseAdmissionForArtifact(artifact, { includeFullReleaseEvidence: true }),
  );

  const result = runChecklist(["--admission", admissionPath, "--artifact", artifact]);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /npm dist-tag add dotaios@9\.8\.7 latest/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("an unadmitted pack is reported rather than silently skipped", () => {
  const result = runChecklist([]);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Publish artifact: NOT PROVIDED/);
  assert.doesNotMatch(result.stdout, /npm publish/i);
});

test("the release runbook publishes one candidate and promotes it without repacking", async () => {
  const runbook = await fs.promises.readFile(
    path.join(repoRoot, ".claude", "commands", "release-check.md"),
    "utf8"
  );
  assert.match(runbook, /--artifact/);
  assert.match(runbook, /--candidate-publish/);
  assert.match(runbook, /npm publish <[^>]*\.tgz>|npm publish .*admitted/i);
  assert.match(runbook, /npm dist-tag add/);
  assert.doesNotMatch(runbook, /npm publish\s*$/m);
});

test("inherited Object members are not option names", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const result = runChecklist([name, "value"]);
    assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Unknown option/, name);
  }
});
