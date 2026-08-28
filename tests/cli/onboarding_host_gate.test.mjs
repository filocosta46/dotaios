import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyNativeEvidence } from "../../scripts/release-checklist.mjs";
import {
  NATIVE_EVENT_TYPES,
  produceNativeReceipt,
} from "../../scripts/onboarding-host-probe.mjs";

test("the final owner admits only issued, current, exact-head native evidence", (t) => {
  const fixture = gateFixture(t);
  const result = verifyNativeEvidence(fixture.verification);

  assert.deepEqual(result, {
    schema: "dotaios.native-admission.v1",
    client: "codex",
    native_agent_go: "GO",
    challenge_id: fixture.challenge.challenge_id,
    source_commit: fixture.challenge.source_commit,
    reviewed_pr_head: fixture.challenge.reviewed_pr.head,
    artifact_sha256: fixture.challenge.artifact_sha256,
    dependency_graph_sha256: fixture.challenge.dependency_graph_sha256,
    consume: {
      challenge_id: fixture.challenge.challenge_id,
      receipt_sha256: result.consume.receipt_sha256,
    },
  });
  assert.match(result.consume.receipt_sha256, /^[a-f0-9]{64}$/);
});

test("the final owner rejects replay, cross-client, altered-head, expired, or producer-minted evidence", (t) => {
  const fixture = gateFixture(t);
  const verification = fixture.verification;
  const cases = [
    ["replayed", { ledger: { ...verification.ledger, consumed: [fixture.challenge.challenge_id] } }],
    ["cross-client", { expected: { ...verification.expected, client: "claude" } }],
    ["altered PR head", { expected: { ...verification.expected, reviewed_pr_head: "f".repeat(40) } }],
    ["expired", { now: "2026-08-28T09:00:00.000Z" }],
    ["unissued", { ledger: { ...verification.ledger, issued: [] } }],
    ["producer-minted", { ledger: { ...verification.ledger, issued: [{ ...verification.ledger.issued[0], challenge_sha256: "0".repeat(64) }] } }],
    ["manual verdict", { receipt: { ...verification.receipt, verdict: "GO" } }],
    ["not produced", { receipt: { ...verification.receipt, produced: "no" } }],
    ["event substitution", { events: verification.events.map((event, index) => index === 2 ? { ...event, evidence_sha256: "9".repeat(64) } : event) }],
    ["challenge substitution", { challenge: { ...verification.challenge, nonce: "substituted_nonce_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" } }],
  ];

  for (const [label, changed] of cases) {
    assert.throws(
      () => verifyNativeEvidence({ ...verification, ...changed }),
      /challenge|issued|consumed|replay|client|review|head|expired|receipt|event|produced|field/i,
      label,
    );
  }
});

test("the final owner independently admits only each client's exact public version form", (t) => {
  const codex = gateFixture(t);
  assert.equal(verifyNativeEvidence(codex.verification).client, "codex");

  const claude = gateFixture(t, { client: "claude", clientVersion: "2.1.247 (Claude Code)" });
  assert.equal(verifyNativeEvidence(claude.verification).client, "claude");

  const refused = [
    ["path-like", "/private/tmp/codex-cli 0.149.1"],
    ["unrecognized secret", "codex-cli 0.149.1 private-canary-value"],
    ["wrong vendor", "2.1.247 (Claude Code)"],
  ];
  for (const [label, clientVersion] of refused) {
    assert.throws(
      () => verifyNativeEvidence({
        ...codex.verification,
        receipt: { ...codex.verification.receipt, client_version: clientVersion },
      }),
      /client version/i,
      label,
    );
  }
});

function gateFixture(t, { client = "codex", clientVersion = "codex-cli 0.149.1" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-host-gate-test-"));
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
    client,
    os: "macos",
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
  const receipt = produceNativeReceipt({
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
    clientVersion,
  });
  const expected = {
    client: challenge.client,
    source_commit: challenge.source_commit,
    reviewed_pr_number: challenge.reviewed_pr.number,
    reviewed_pr_head: challenge.reviewed_pr.head,
    required_checks_sha256: challenge.reviewed_pr.required_checks_sha256,
    artifact_sha256: challenge.artifact_sha256,
    dependency_graph_sha256: challenge.dependency_graph_sha256,
    bridge_sha256: challenge.bridge_sha256,
    prompt_sha256: challenge.prompt_sha256,
  };
  const ledger = {
    schema: "dotaios.native-challenge-ledger.v1",
    issued: [{
      challenge_id: challenge.challenge_id,
      challenge_sha256: receipt.challenge_sha256,
      client: challenge.client,
      reviewed_pr_head: challenge.reviewed_pr.head,
    }],
    consumed: [],
  };
  return {
    challenge,
    verification: {
      challenge,
      receipt,
      events,
      ledger,
      expected,
      now: "2026-08-28T08:15:00.000Z",
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
