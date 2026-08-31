#!/usr/bin/env node
// DotAIOS release admission owner. Read-only: never publishes, tags, pushes,
// changes npm tags, or creates GitHub Releases.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ADMISSION_ASSERTION_KEYS } from "./onboarding-release-acceptance.mjs";

const HASH_256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;
const NATIVE_EVENT_TYPES = [
  "profile_authenticated",
  "global_bridge_discovered",
  "global_bridge_invoked",
  "bounded_context_received",
  "work_understood",
  "action_proposed",
  "approval_waiting",
];
const RECEIPT_KEYS = [
  "schema", "produced", "client", "client_version", "os", "challenge_id",
  "challenge_sha256", "source_commit", "reviewed_pr", "artifact_sha256",
  "dependency_graph_sha256", "bridge_sha256", "prompt_sha256",
  "native_events_sha256", "native_run_sha256", "event_types", "profile", "limitations",
];

if (isMain()) {
  try {
    process.exitCode = runReleaseChecklist(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Release admission refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export function verifyNativeEvidence({ challenge, receipt, events, ledger, expected, now }) {
  validateChallenge(challenge);
  validateExpected(expected);
  validateLedger(ledger);
  assertExactKeys(receipt, RECEIPT_KEYS, "Native receipt");
  if (receipt.schema !== "dotaios.native-receipt.v1" || receipt.produced !== "yes") {
    throw new Error("Native receipt was not produced by the admitted producer.");
  }
  validateClientVersion(challenge.client, receipt.client_version);
  const current = Date.parse(now);
  if (!Number.isFinite(current) || new Date(current).toISOString() !== now) {
    throw new Error("Native evidence verification time is invalid.");
  }
  if (current < Date.parse(challenge.issued_at) || current > Date.parse(challenge.expires_at)) {
    throw new Error("Native challenge expired or is not yet valid.");
  }

  const challengeSha256 = sha256(Buffer.from(canonicalJson(challenge), "utf8"));
  const issued = ledger.issued.filter((entry) => entry.challenge_id === challenge.challenge_id);
  if (issued.length !== 1) throw new Error("Native challenge was not issued exactly once by the protected ledger.");
  assertExactKeys(issued[0], ["challenge_id", "challenge_sha256", "client", "reviewed_pr_head"], "Issued challenge");
  if (
    issued[0].challenge_sha256 !== challengeSha256
    || issued[0].client !== challenge.client
    || issued[0].reviewed_pr_head !== challenge.reviewed_pr.head
  ) {
    throw new Error("Native challenge does not match the protected issued record.");
  }
  if (ledger.consumed.includes(challenge.challenge_id)) {
    throw new Error("Native challenge was already consumed; replay is refused.");
  }

  const expectedBindings = {
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
  if (canonicalJson(expectedBindings) !== canonicalJson(expected)) {
    throw new Error("Native challenge drifted from the expected client, reviewed head, checks, source, or artifact.");
  }

  validateEvents(events, challenge);
  const eventDigest = sha256(Buffer.from(canonicalJson(events), "utf8"));
  const nativeRunIds = new Set(events.map((event) => event.native_run_id));
  if (nativeRunIds.size !== 1) throw new Error("Native events do not share one run identity.");
  const nativeRunSha256 = sha256(Buffer.from([...nativeRunIds][0], "utf8"));
  const expectedReceipt = {
    schema: "dotaios.native-receipt.v1",
    produced: "yes",
    client: challenge.client,
    client_version: receipt.client_version,
    os: challenge.os,
    challenge_id: challenge.challenge_id,
    challenge_sha256: challengeSha256,
    source_commit: challenge.source_commit,
    reviewed_pr: { ...challenge.reviewed_pr },
    artifact_sha256: challenge.artifact_sha256,
    dependency_graph_sha256: challenge.dependency_graph_sha256,
    bridge_sha256: challenge.bridge_sha256,
    prompt_sha256: challenge.prompt_sha256,
    native_events_sha256: eventDigest,
    native_run_sha256: nativeRunSha256,
    event_types: [...NATIVE_EVENT_TYPES],
    profile: {
      isolated: "yes",
      authenticated: "yes",
      credentials_confined: "yes",
      teardown_required: "yes",
    },
    limitations: [
      "non-malicious-operator-evidence",
      "no-physical-host-attestation",
    ],
  };
  if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
    throw new Error("Native receipt fields do not match independently verified challenge and event evidence.");
  }
  return {
    schema: "dotaios.native-admission.v1",
    client: challenge.client,
    native_agent_go: "GO",
    challenge_id: challenge.challenge_id,
    source_commit: challenge.source_commit,
    reviewed_pr_head: challenge.reviewed_pr.head,
    artifact_sha256: challenge.artifact_sha256,
    dependency_graph_sha256: challenge.dependency_graph_sha256,
    consume: {
      challenge_id: challenge.challenge_id,
      receipt_sha256: sha256(Buffer.from(canonicalJson(receipt), "utf8")),
    },
  };
}

export function runReleaseChecklist(args, { output = console.log } = {}) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const options = parseOptions(args);
  output(`DotAIOS release checklist — v${pkg.version}`);
  const admission = options.admission
    ? evaluateReleaseAdmission(readBoundedAdmission(options.admission))
    : evaluateReleaseAdmission({});
  output(`Package admission: ${admission.package_admission}`);
  output(`Native-agent admission: ${admission.native_agent_admission}`);
  output(`Public-release admission: ${admission.public_release_admission}`);
  return admission.public_release_admission === "GO" ? 0 : 1;
}

export function evaluateReleaseAdmission(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Release admission input must be an object.");
  }
  assertAllowedKeys(input, [
    "source", "package_receipt", "registry_receipt", "native_admissions",
    "evidence_commit", "non_founder_outcome", "public_authority",
  ], "Release admission input");
  const source = input.source;
  const packageReceipt = input.package_receipt;
  const packageAssertions = packageReceipt?.assertions;
  const packageGo = Boolean(
    hasExactKeys(source, ["schema", "source_go", "source_commit", "reviewed_pr"])
    && source.schema === "dotaios.reviewed-source.v1"
    && source.source_go === "GO"
    && GIT_OBJECT_ID.test(source.source_commit || "")
    && hasExactKeys(source.reviewed_pr, ["number", "head", "required_checks_sha256"])
    && Number.isSafeInteger(source.reviewed_pr.number)
    && source.reviewed_pr.number > 0
    && source.reviewed_pr.head === source.source_commit
    && HASH_256.test(source.reviewed_pr.required_checks_sha256 || "")
    && hasExactKeys(packageReceipt, ["schema", "verdict", "package_go", "source_commit", "artifact", "assertions"])
    && packageReceipt.schema === "dotaios.package-admission.v1"
    && packageReceipt.verdict === "go"
    && packageReceipt.package_go === "GO"
    && packageReceipt.source_commit === source.source_commit
    && hasExactKeys(packageReceipt.artifact, ["name", "version", "sha256", "payload_sha256", "dependency_graph_sha256"])
    && packageReceipt.artifact.name === "dotaios"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageReceipt.artifact.version || "")
    && HASH_256.test(packageReceipt.artifact.sha256 || "")
    && HASH_256.test(packageReceipt.artifact.payload_sha256 || "")
    && HASH_256.test(packageReceipt.artifact.dependency_graph_sha256 || "")
    && hasExactKeys(packageAssertions, PACKAGE_ADMISSION_ASSERTION_KEYS)
    && Object.values(packageAssertions).every((value) => value === true)
  );
  const nativeAdmissions = Array.isArray(input.native_admissions) ? input.native_admissions : [];
  const nativeClients = new Set(nativeAdmissions.map((entry) => entry?.client));
  const nativeGo = packageGo
    && nativeAdmissions.length === 2
    && nativeClients.size === 2
    && nativeClients.has("codex")
    && nativeClients.has("claude")
    && nativeAdmissions.every((entry) => (
      hasExactKeys(entry, [
        "schema", "client", "native_agent_go", "challenge_id", "source_commit",
        "reviewed_pr_head", "artifact_sha256", "dependency_graph_sha256", "consume",
      ])
      && entry.schema === "dotaios.native-admission.v1"
      && entry.native_agent_go === "GO"
      && entry.source_commit === source.source_commit
      && entry.reviewed_pr_head === source.reviewed_pr?.head
      && entry.artifact_sha256 === packageReceipt.artifact.sha256
      && entry.dependency_graph_sha256 === packageReceipt.artifact.dependency_graph_sha256
      && HASH_256.test(entry.challenge_id || "")
      && hasExactKeys(entry.consume, ["challenge_id", "receipt_sha256"])
      && entry.consume.challenge_id === entry.challenge_id
      && HASH_256.test(entry.consume.receipt_sha256 || "")
    ));
  const registry = input.registry_receipt;
  const evidence = input.evidence_commit;
  const nonFounder = input.non_founder_outcome;
  const authority = input.public_authority;
  const publicGo = nativeGo
    && hasExactKeys(registry, [
      "schema", "package", "version", "artifact_sha256", "dependency_source",
      "git_head", "integrity_sha512",
    ])
    && registry.schema === "dotaios.registry-artifact.v1"
    && registry.package === "dotaios"
    && registry.version === packageReceipt.artifact.version
    && registry.dependency_source === "npm-shrinkwrap"
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(registry.integrity_sha512 || "")
    && registry.git_head === source.source_commit
    && registry.artifact_sha256 === packageReceipt.artifact.sha256
    && hasExactKeys(evidence, [
      "schema", "evidence_go", "candidate_source_commit", "evidence_commit",
      "reviewed_pr", "package_tree_sha256", "evidence_files_sha256",
    ])
    && evidence.schema === "dotaios.evidence-commit.v1"
    && evidence.evidence_go === "GO"
    && evidence.candidate_source_commit === source.source_commit
    && GIT_OBJECT_ID.test(evidence.evidence_commit || "")
    && hasExactKeys(evidence.reviewed_pr, ["number", "head"])
    && evidence.reviewed_pr.head === evidence.evidence_commit
    && HASH_256.test(evidence.package_tree_sha256 || "")
    && HASH_256.test(evidence.evidence_files_sha256 || "")
    && hasExactKeys(nonFounder, [
      "schema", "completed", "source_commit", "artifact_sha256",
      "instruction_file_designed", "transcript_retained",
    ])
    && nonFounder.schema === "dotaios.non-founder-outcome.v1"
    && nonFounder.completed === "yes"
    && nonFounder.source_commit === source.source_commit
    && nonFounder.artifact_sha256 === packageReceipt.artifact.sha256
    && nonFounder.instruction_file_designed === "no"
    && nonFounder.transcript_retained === "no"
    && hasExactKeys(authority, ["schema", "authorized", "source_commit", "artifact_sha256"])
    && authority.schema === "dotaios.public-release-authority.v1"
    && authority.authorized === "yes"
    && authority.source_commit === source.source_commit
    && authority.artifact_sha256 === packageReceipt.artifact.sha256;
  return {
    schema: "dotaios.release-admission.v1",
    package_admission: packageGo ? "GO" : "NO-GO",
    native_agent_admission: nativeGo ? "GO" : "NO-GO",
    public_release_admission: publicGo ? "GO" : "NO-GO",
  };
}

function parseOptions(args) {
  const parsed = { admission: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--admission") throw new Error(`Unknown option: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (parsed.admission) throw new Error("--admission may be provided only once");
    parsed.admission = path.resolve(value);
    index += 1;
  }
  return parsed;
}

function readBoundedAdmission(file) {
  const stats = readFileStats(file);
  if (stats.size <= 0 || stats.size > 512 * 1024) throw new Error("Release admission input is outside its byte boundary.");
  try {
    return JSON.parse(readFileSync(realpathSync(file), "utf8"));
  } catch (error) {
    throw new Error(`Release admission input is invalid JSON: ${error.message}`);
  }
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertAllowedKeys(value, allowed, label) {
  const admitted = new Set(allowed);
  if (Object.keys(value).some((key) => !admitted.has(key))) {
    throw new Error(`${label} contains fields outside the admitted schema.`);
  }
}

function readFileStats(file) {
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Release admission input must be one regular file.");
  return stats;
}

function validateChallenge(challenge) {
  assertExactKeys(challenge, [
    "schema", "challenge_id", "nonce", "client", "os", "source_commit", "reviewed_pr",
    "artifact_sha256", "dependency_graph_sha256", "bridge_sha256", "prompt_sha256",
    "issued_at", "expires_at",
  ], "Native challenge");
  if (challenge.schema !== "dotaios.native-challenge.v1") throw new Error("Native challenge schema is invalid.");
  if (!HASH_256.test(challenge.challenge_id || "") || !/^[A-Za-z0-9_-]{32,128}$/.test(challenge.nonce || "")) {
    throw new Error("Native challenge identity is invalid.");
  }
  if (!["codex", "claude"].includes(challenge.client) || !["linux", "macos", "windows"].includes(challenge.os)) {
    throw new Error("Native challenge client or OS is invalid.");
  }
  if (!GIT_OBJECT_ID.test(challenge.source_commit || "")) throw new Error("Native challenge source commit is invalid.");
  for (const field of ["artifact_sha256", "dependency_graph_sha256", "bridge_sha256", "prompt_sha256"]) {
    if (!HASH_256.test(challenge[field] || "")) throw new Error(`Native challenge ${field} is invalid.`);
  }
  assertExactKeys(challenge.reviewed_pr, ["number", "head", "required_checks_sha256"], "Reviewed PR challenge");
  if (!Number.isSafeInteger(challenge.reviewed_pr.number) || challenge.reviewed_pr.number <= 0) {
    throw new Error("Reviewed PR challenge number is invalid.");
  }
  if (!GIT_OBJECT_ID.test(challenge.reviewed_pr.head || "") || !HASH_256.test(challenge.reviewed_pr.required_checks_sha256 || "")) {
    throw new Error("Reviewed PR challenge identity is invalid.");
  }
  const issued = Date.parse(challenge.issued_at);
  const expires = Date.parse(challenge.expires_at);
  if (
    !Number.isFinite(issued) || !Number.isFinite(expires)
    || new Date(issued).toISOString() !== challenge.issued_at
    || new Date(expires).toISOString() !== challenge.expires_at
    || expires <= issued || expires - issued > 60 * 60 * 1000
  ) throw new Error("Native challenge validity window is invalid.");
}

function validateClientVersion(client, clientVersion) {
  const pattern = client === "codex"
    ? /^codex-cli [0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/
    : /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6} \(Claude Code\)$/;
  if (typeof clientVersion !== "string" || !pattern.test(clientVersion)) {
    throw new Error("Native receipt client version is not the client's exact bounded public version form.");
  }
}

function validateExpected(expected) {
  assertExactKeys(expected, [
    "client", "source_commit", "reviewed_pr_number", "reviewed_pr_head",
    "required_checks_sha256", "artifact_sha256", "dependency_graph_sha256",
    "bridge_sha256", "prompt_sha256",
  ], "Expected native identity");
}

function validateLedger(ledger) {
  assertExactKeys(ledger, ["schema", "issued", "consumed"], "Native challenge ledger");
  if (ledger.schema !== "dotaios.native-challenge-ledger.v1" || !Array.isArray(ledger.issued) || !Array.isArray(ledger.consumed)) {
    throw new Error("Native challenge ledger is invalid.");
  }
  if (new Set(ledger.consumed).size !== ledger.consumed.length || ledger.consumed.some((id) => !HASH_256.test(id))) {
    throw new Error("Native challenge consumed ledger is invalid.");
  }
}

function validateEvents(events, challenge) {
  if (!Array.isArray(events) || events.length !== NATIVE_EVENT_TYPES.length) throw new Error("Native event set is incomplete.");
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assertExactKeys(event, [
      "sequence", "type", "challenge_id", "client", "reviewed_pr_head",
      "native_run_id", "evidence_sha256",
    ], "Native event");
    if (
      event.sequence !== index + 1 || event.type !== NATIVE_EVENT_TYPES[index]
      || event.challenge_id !== challenge.challenge_id || event.client !== challenge.client
      || event.reviewed_pr_head !== challenge.reviewed_pr.head
      || typeof event.native_run_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(event.native_run_id)
      || !HASH_256.test(event.evidence_sha256 || "")
    ) throw new Error("Native event does not match the exact challenge contract.");
  }
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const admitted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(admitted)) throw new Error(`${label} contains fields outside the admitted schema.`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
