import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  NATIVE_EVENT_TYPES,
  produceNativeReceipt,
} from "../../scripts/onboarding-host-probe.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const producer = path.join(repoRoot, "scripts", "onboarding-host-probe.mjs");
const RUNTIME_OS = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];

assert.ok(RUNTIME_OS, `unsupported test platform: ${process.platform}`);

test("the native producer emits one bounded sanitized receipt without a verdict", (t) => {
  const fixture = receiptFixture(t);
  const receipt = produceNativeReceipt(fixture);

  assert.deepEqual(Object.keys(receipt).sort(), [
    "artifact_sha256",
    "bridge_sha256",
    "challenge_id",
    "challenge_sha256",
    "client",
    "client_version",
    "dependency_graph_sha256",
    "event_types",
    "limitations",
    "native_events_sha256",
    "native_run_sha256",
    "os",
    "produced",
    "profile",
    "prompt_sha256",
    "reviewed_pr",
    "schema",
    "source_commit",
  ]);
  assert.equal(receipt.schema, "dotaios.native-receipt.v1");
  assert.equal(receipt.produced, "yes");
  assert.deepEqual(receipt.event_types, NATIVE_EVENT_TYPES);
  assert.deepEqual(receipt.profile, {
    isolated: "yes",
    authenticated: "yes",
    credentials_confined: "yes",
    teardown_required: "yes",
  });
  assert.deepEqual(receipt.limitations, [
    "non-malicious-operator-evidence",
    "no-physical-host-attestation",
  ]);
  assert.match(receipt.challenge_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.native_events_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.native_run_sha256, /^[a-f0-9]{64}$/);

  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    "verdict", "GO", "outcome", fixture.challenge.nonce, fixture.nativeRunId,
    fixture.prompt, fixture.profileRoot, fixture.ambientHome, "synthetic-login-marker",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.ok(serialized.length < 3_000);
});

test("the native producer refuses manual outcomes, event substitution, and unauthenticated profiles", (t) => {
  const fixture = receiptFixture(t);
  const changes = [
    ["manual challenge verdict", { challenge: { ...fixture.challenge, verdict: "GO" } }],
    ["manual event outcome", { events: fixture.events.map((event, index) => index === 0 ? { ...event, outcome: "success" } : event) }],
    ["missing event", { events: fixture.events.slice(0, -1) }],
    ["cross-client event", { events: fixture.events.map((event, index) => index === 1 ? { ...event, client: "claude" } : event) }],
    ["altered PR head", { events: fixture.events.map((event) => ({ ...event, reviewed_pr_head: "f".repeat(40) })) }],
    ["mixed native run", { events: fixture.events.map((event, index) => index === 1 ? { ...event, native_run_id: "run-b" } : event) }],
    ["altered prompt", { prompt: `${fixture.prompt} changed` }],
    ["unauthenticated", { credentialPaths: [] }],
    ["path-like version", { clientVersion: "/private/tmp/codex-cli 0.149.1" }],
    ["unrecognized secret in version", { clientVersion: "codex-cli 0.149.1 private-canary-value" }],
    ["wrong vendor version", { clientVersion: "2.1.247 (Claude Code)" }],
  ];

  for (const [label, changed] of changes) {
    assert.throws(
      () => produceNativeReceipt({ ...fixture, ...changed }),
      /challenge|event|client|review|run|prompt|auth|credential|version|field|admitted/i,
      label,
    );
  }

  const outsideCredential = path.join(fixture.root, "ambient-credential.json");
  fs.writeFileSync(outsideCredential, "synthetic\n", { mode: 0o600 });
  assert.throws(
    () => produceNativeReceipt({ ...fixture, credentialPaths: [outsideCredential] }),
    /credential|profile/i,
  );
});

test("the native producer accepts only the exact public version form for each client", (t) => {
  const codex = receiptFixture(t);
  assert.equal(produceNativeReceipt(codex).client_version, "codex-cli 0.149.1");

  const claude = receiptFixture(t);
  claude.challenge = { ...claude.challenge, client: "claude" };
  claude.events = claude.events.map((event) => ({ ...event, client: "claude" }));
  claude.clientVersion = "2.1.247 (Claude Code)";
  assert.equal(produceNativeReceipt(claude).client_version, "2.1.247 (Claude Code)");
});

test("the executable writes only the sanitized receipt and tears down the owned profile", (t) => {
  const fixture = receiptFixture(t);
  const { result, receiptPath } = executeProducer(fixture);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(fixture.runRoot), false, "owned credentials and profile must be removed");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.produced, "yes");
  assert.equal(receipt.client, "codex");
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(fixture.prompt), false);
  assert.equal(serialized.includes(fixture.challenge.nonce), false);
  assert.equal(serialized.includes(fixture.profileRoot), false);
  assert.equal(result.stdout, "");
});

test("the executable refuses a challenge for a different runtime OS", (t) => {
  const fixture = receiptFixture(t);
  const mismatchedOs = ["linux", "macos", "windows"].find((candidate) => candidate !== RUNTIME_OS);
  fixture.challenge = { ...fixture.challenge, os: mismatchedOs };

  const { result, receiptPath } = executeProducer(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(receiptPath), false);
});

test("the executable removes its owned run after post-admission rejection", (t) => {
  const fixture = receiptFixture(t);
  fixture.clientVersion = "codex-cli 0.149.1 private-canary-value";

  const { result, receiptPath } = executeProducer(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(receiptPath), false);
  assert.equal(fs.existsSync(fixture.runRoot), false, "owned run and profile must be removed");
  assert.equal(fs.existsSync(fixture.profileRoot), false, "owned profile must be removed");
});

function executeProducer(fixture) {
  const promptPath = path.join(fixture.runRoot, "prompt.txt");
  const bridgePath = path.join(fixture.runRoot, "bridge.txt");
  const eventsPath = path.join(fixture.runRoot, "events.json");
  const requestPath = path.join(fixture.runRoot, "request.json");
  const receiptPath = path.join(fixture.root, "sanitized-receipt.json");
  fs.writeFileSync(promptPath, fixture.prompt, { mode: 0o600 });
  fs.writeFileSync(bridgePath, fixture.bridgeBytes, { mode: 0o600 });
  fs.writeFileSync(eventsPath, JSON.stringify(fixture.events), { mode: 0o600 });
  fs.writeFileSync(requestPath, JSON.stringify({
    run_root: fixture.runRoot,
    profile_root: fixture.profileRoot,
    work_root: fixture.workRoot,
    ambient_home: fixture.ambientHome,
    repo_boundary: fixture.repoBoundary,
    credential_paths: fixture.credentialPaths,
    challenge: fixture.challenge,
    events_path: eventsPath,
    prompt_path: promptPath,
    bridge_path: bridgePath,
    native_run_id: fixture.nativeRunId,
    client_version: fixture.clientVersion,
  }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    producer, "--request", requestPath, "--receipt", receiptPath,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: path.dirname(process.execPath) },
  });
  return { result, receiptPath };
}

function receiptFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-native-receipt-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runRoot = path.join(root, "owned-run");
  const profileRoot = path.join(runRoot, "profile");
  const workRoot = path.join(runRoot, "external-work");
  const ambientHome = path.join(root, "ambient-home");
  const repoBoundary = path.join(root, "repository");
  for (const directory of [runRoot, profileRoot, workRoot, ambientHome, repoBoundary]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }
  const credential = path.join(profileRoot, "credentials.json");
  fs.writeFileSync(credential, "synthetic-login-marker\n", { mode: 0o600 });
  const prompt = "Use the installed global bridge. Explain the work and propose one action.";
  const bridgeBytes = Buffer.from("bounded global bridge bytes\n");
  const nativeRunId = "native-run-123";
  const challenge = {
    schema: "dotaios.native-challenge.v1",
    challenge_id: "1".repeat(64),
    nonce: "challenge_nonce_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    client: "codex",
    os: RUNTIME_OS,
    source_commit: "a".repeat(40),
    reviewed_pr: {
      number: 123,
      head: "b".repeat(40),
      required_checks_sha256: "c".repeat(64),
    },
    artifact_sha256: "d".repeat(64),
    dependency_graph_sha256: "e".repeat(64),
    bridge_sha256: sha256(bridgeBytes),
    prompt_sha256: sha256(Buffer.from(prompt)),
    issued_at: "2026-08-28T08:00:00.000Z",
    expires_at: "2026-08-28T08:30:00.000Z",
  };
  const events = NATIVE_EVENT_TYPES.map((type, index) => ({
    sequence: index + 1,
    type,
    challenge_id: challenge.challenge_id,
    client: challenge.client,
    reviewed_pr_head: challenge.reviewed_pr.head,
    native_run_id: nativeRunId,
    evidence_sha256: String(index + 1).repeat(64).slice(0, 64),
  }));
  return {
    root,
    runRoot,
    profileRoot,
    workRoot,
    ambientHome,
    repoBoundary,
    credentialPaths: [credential],
    challenge,
    events,
    prompt,
    bridgeBytes,
    nativeRunId,
    clientVersion: "codex-cli 0.149.1",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
