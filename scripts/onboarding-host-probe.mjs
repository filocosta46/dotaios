#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const HASH_256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;

export const NATIVE_EVENT_TYPES = Object.freeze([
  "profile_authenticated",
  "global_bridge_discovered",
  "global_bridge_invoked",
  "bounded_context_received",
  "work_understood",
  "action_proposed",
  "approval_waiting",
]);

if (isMain()) {
  try {
    runProducerCli(process.argv.slice(2));
  } catch {
    process.stderr.write("Native evidence production refused.\n");
    process.exitCode = 1;
  }
}

export function runProducerCli(args) {
  const { requestPath, receiptPath } = parseProducerArgs(args);
  const request = readBoundedJson(requestPath, 128 * 1024, "Native producer request");
  assertExactKeys(request, [
    "run_root", "profile_root", "work_root", "ambient_home", "repo_boundary",
    "credential_paths", "challenge", "events_path", "prompt_path", "bridge_path",
    "native_run_id", "client_version",
  ], "Native producer request");
  validateOwnedProfile({
    runRoot: request.run_root,
    profileRoot: request.profile_root,
    workRoot: request.work_root,
    ambientHome: request.ambient_home,
    repoBoundary: request.repo_boundary,
    credentialPaths: request.credential_paths,
    requireAuthenticated: true,
  });
  const run = fs.realpathSync(request.run_root);
  const requestFile = admittedInputFile(requestPath, run, "Native producer request");
  const eventsFile = admittedInputFile(request.events_path, run, "Native events");
  const promptFile = admittedInputFile(request.prompt_path, run, "Native prompt");
  const bridgeFile = admittedInputFile(request.bridge_path, run, "Global bridge evidence");
  if (requestFile !== fs.realpathSync(requestPath)) throw new Error("Native producer request identity changed.");
  const destination = absentReceiptPath(receiptPath, run);
  let receipt;
  try {
    validateChallenge(request.challenge);
    assertRuntimeOs(request.challenge.os);
    receipt = produceNativeReceipt({
      runRoot: request.run_root,
      profileRoot: request.profile_root,
      workRoot: request.work_root,
      ambientHome: request.ambient_home,
      repoBoundary: request.repo_boundary,
      credentialPaths: request.credential_paths,
      challenge: request.challenge,
      events: readBoundedJson(eventsFile, 256 * 1024, "Native events"),
      prompt: decodeUtf8(readBoundedFile(promptFile, MAX_PROMPT_BYTES), "Native prompt"),
      bridgeBytes: readBoundedFile(bridgeFile, 1024 * 1024),
      nativeRunId: request.native_run_id,
      clientVersion: request.client_version,
    });
  } finally {
    fs.rmSync(run, { recursive: true, force: false });
  }
  fs.writeFileSync(destination, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return receipt;
}

export function produceNativeReceipt({
  runRoot,
  profileRoot,
  workRoot,
  ambientHome,
  repoBoundary,
  credentialPaths,
  challenge,
  events,
  prompt,
  bridgeBytes,
  nativeRunId,
  clientVersion,
}) {
  validateChallenge(challenge);
  validateOwnedProfile({
    runRoot,
    profileRoot,
    workRoot,
    ambientHome,
    repoBoundary,
    credentialPaths,
    requireAuthenticated: true,
  });
  if (typeof prompt !== "string" || prompt.length === 0 || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new Error("Native prompt must be non-empty and bounded.");
  }
  if (sha256(Buffer.from(prompt, "utf8")) !== challenge.prompt_sha256) {
    throw new Error("Native prompt does not match the protected challenge.");
  }
  if (!Buffer.isBuffer(bridgeBytes) || bridgeBytes.length === 0 || bridgeBytes.length > 1024 * 1024) {
    throw new Error("Global bridge evidence must be one non-empty bounded Buffer.");
  }
  if (sha256(bridgeBytes) !== challenge.bridge_sha256) {
    throw new Error("Global bridge bytes do not match the protected challenge.");
  }
  if (
    typeof nativeRunId !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(nativeRunId)
  ) {
    throw new Error("Native run identity is not admitted.");
  }
  validateClientVersion(challenge.client, clientVersion);
  validateNativeEvents(events, challenge, nativeRunId);
  return {
    schema: "dotaios.native-receipt.v1",
    produced: "yes",
    client: challenge.client,
    client_version: clientVersion,
    os: challenge.os,
    challenge_id: challenge.challenge_id,
    challenge_sha256: sha256(Buffer.from(canonicalJson(challenge), "utf8")),
    source_commit: challenge.source_commit,
    reviewed_pr: { ...challenge.reviewed_pr },
    artifact_sha256: challenge.artifact_sha256,
    dependency_graph_sha256: challenge.dependency_graph_sha256,
    bridge_sha256: challenge.bridge_sha256,
    prompt_sha256: challenge.prompt_sha256,
    native_events_sha256: sha256(Buffer.from(canonicalJson(events), "utf8")),
    native_run_sha256: sha256(Buffer.from(nativeRunId, "utf8")),
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
}

export function validateOwnedProfile({
  runRoot,
  profileRoot,
  workRoot = null,
  ambientHome = null,
  repoBoundary = null,
  credentialPaths = [],
  requireAuthenticated = false,
}) {
  const run = privateDirectory(runRoot, "Owned run root");
  const profile = privateDirectory(profileRoot, "Owned profile root");
  if (!isWithin(profile, run) || profile === run) {
    throw new Error("Owned profile must be a child of the owned run root.");
  }
  for (const [label, boundary] of [["ambient home", ambientHome], ["repository", repoBoundary]]) {
    if (!boundary) continue;
    const canonicalBoundary = fs.realpathSync(boundary);
    if (isWithin(run, canonicalBoundary) || isWithin(canonicalBoundary, run)) {
      throw new Error(`Owned run root must remain outside the ${label}.`);
    }
  }
  if (workRoot) {
    const work = privateDirectory(workRoot, "Owned external work root");
    if (!isWithin(work, run) || work === profile) {
      throw new Error("External work root must be isolated inside the owned run root.");
    }
  }
  assertRegularTree(profile);
  if (!Array.isArray(credentialPaths)) throw new Error("Credential paths must be an array.");
  if (requireAuthenticated && credentialPaths.length === 0) {
    throw new Error("The isolated profile is unauthenticated; no owned credential record exists.");
  }
  for (const credentialPath of credentialPaths) {
    const requested = fs.lstatSync(credentialPath);
    if (!requested.isFile() || requested.isSymbolicLink()) {
      throw new Error("Every credential record must be one regular file inside the owned profile.");
    }
    if (process.platform !== "win32" && (requested.mode & 0o077) !== 0) {
      throw new Error("Every credential record must use private permissions.");
    }
    const credential = fs.realpathSync(credentialPath);
    if (!isWithin(credential, profile) || credential === profile) {
      throw new Error("Credential records must remain inside the owned profile.");
    }
  }
  return { runRoot: run, profileRoot: profile };
}

export function buildNativeLaunch({ client, executable, profileRoot, workRoot, prompt }) {
  if (client !== "codex" && client !== "claude") {
    throw new Error("Native launch client must be codex or claude.");
  }
  if (typeof prompt !== "string" || prompt.length === 0 || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new Error("Native launch prompt must be non-empty and bounded.");
  }
  if (!path.isAbsolute(executable)) throw new Error("Native launch requires one explicit executable path.");
  const canonicalExecutable = fs.realpathSync(executable);
  const executableStats = fs.lstatSync(canonicalExecutable);
  if (!executableStats.isFile() || executableStats.isSymbolicLink()) {
    throw new Error("Native launch executable must resolve to one regular file.");
  }
  const profile = privateDirectory(profileRoot, "Owned profile root");
  const work = privateDirectory(workRoot, "Owned external work root");
  const env = {
    HOME: profile,
    USERPROFILE: profile,
    PATH: path.dirname(canonicalExecutable),
    DOTAIOS_NO_UPDATE_CHECK: "1",
    LANG: "C",
    LC_ALL: "C",
  };
  const args = client === "codex"
    ? ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", work, "-"]
    : ["--print", "--no-session-persistence", "--permission-mode", "plan", "--tools", "Skill", "--setting-sources", "user"];
  if (client === "codex") env.CODEX_HOME = path.join(profile, ".codex");
  else env.CLAUDE_CONFIG_DIR = path.join(profile, ".claude");
  return {
    executable: canonicalExecutable,
    args,
    cwd: work,
    env,
    stdin: prompt,
  };
}

export function runSetupPreview({
  cliEntrypoint,
  runRoot,
  profileRoot,
  aiosRoot,
  protectedRoots = [],
}) {
  const { runRoot: run, profileRoot: profile } = validateOwnedProfile({ runRoot, profileRoot });
  if (!path.isAbsolute(cliEntrypoint)) throw new Error("Setup preview requires an explicit CLI entrypoint.");
  const cli = fs.realpathSync(cliEntrypoint);
  const cliStats = fs.lstatSync(cli);
  if (!cliStats.isFile() || cliStats.isSymbolicLink()) {
    throw new Error("Setup preview CLI entrypoint must be one regular file.");
  }
  const requestedTarget = path.resolve(aiosRoot);
  const target = path.join(fs.realpathSync(path.dirname(requestedTarget)), path.basename(requestedTarget));
  if (!isWithin(target, run) || target === run || fs.existsSync(target)) {
    throw new Error("Setup preview target must be one absent path inside the owned run root.");
  }
  if (!Array.isArray(protectedRoots)) throw new Error("Protected roots must be an array.");
  const roots = [run, ...protectedRoots.map((root) => fs.realpathSync(root))];
  for (const protectedRoot of roots.slice(1)) {
    if (isWithin(protectedRoot, run) || isWithin(run, protectedRoot)) {
      throw new Error("Protected roots must remain outside the owned run root.");
    }
  }
  const before = roots.map(snapshotRegularTree);
  const result = spawnSync(process.execPath, [
    cli, "setup", "--dry-run", "--path", target, "--home", profile,
  ], {
    cwd: run,
    encoding: "utf8",
    env: {
      HOME: profile,
      USERPROFILE: profile,
      PATH: path.dirname(process.execPath),
      DOTAIOS_NO_UPDATE_CHECK: "1",
      LANG: "C",
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Setup preview failed: ${boundedDiagnostic(result)}`);
  const after = roots.map(snapshotRegularTree);
  if (JSON.stringify(before) !== JSON.stringify(after) || fs.existsSync(target)) {
    throw new Error("Setup preview changed a declared or protected root.");
  }
  return {
    setup_preview: "yes",
    protected_roots_unchanged: "yes",
    preview_sha256: sha256(Buffer.from(result.stdout || "", "utf8")),
  };
}

function privateDirectory(directory, label) {
  if (!path.isAbsolute(directory || "")) throw new Error(`${label} must be absolute.`);
  const requested = fs.lstatSync(directory);
  if (!requested.isDirectory() || requested.isSymbolicLink()) {
    throw new Error(`${label} must be one regular directory, not a link.`);
  }
  if (process.platform !== "win32" && (requested.mode & 0o077) !== 0) {
    throw new Error(`${label} must use private 0700 permissions.`);
  }
  return fs.realpathSync(directory);
}

function parseProducerArgs(args) {
  const parsed = { requestPath: null, receiptPath: null };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key !== "--request" && key !== "--receipt") throw new Error("Unknown native producer option.");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Native producer option requires a value.");
    const field = key === "--request" ? "requestPath" : "receiptPath";
    if (parsed[field]) throw new Error("Native producer option may be provided only once.");
    parsed[field] = path.resolve(value);
    index += 1;
  }
  if (!parsed.requestPath || !parsed.receiptPath) throw new Error("Native producer requires request and receipt paths.");
  return parsed;
}

function readBoundedJson(file, limit, label) {
  const bytes = readBoundedFile(file, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid bounded JSON.`);
  }
}

function readBoundedFile(file, limit) {
  const requested = fs.lstatSync(file);
  if (!requested.isFile() || requested.isSymbolicLink() || requested.size <= 0 || requested.size > limit) {
    throw new Error("Native producer input must be one non-empty bounded regular file.");
  }
  return fs.readFileSync(fs.realpathSync(file));
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}

function admittedInputFile(file, runRoot, label) {
  if (!path.isAbsolute(file || "")) throw new Error(`${label} path must be absolute.`);
  const requested = fs.lstatSync(file);
  if (!requested.isFile() || requested.isSymbolicLink()) throw new Error(`${label} must be one regular file.`);
  const canonical = fs.realpathSync(file);
  if (!isWithin(canonical, runRoot) || canonical === runRoot) throw new Error(`${label} must remain inside the owned run root.`);
  return canonical;
}

function absentReceiptPath(file, runRoot) {
  const requested = path.resolve(file);
  if (fs.existsSync(requested)) throw new Error("Native receipt destination must not already exist.");
  const parent = privateDirectory(path.dirname(requested), "Native receipt parent");
  const canonical = path.join(parent, path.basename(requested));
  if (isWithin(canonical, runRoot) || isWithin(runRoot, canonical)) {
    throw new Error("Native receipt destination must remain outside the owned run root.");
  }
  return canonical;
}

function validateChallenge(challenge) {
  assertRecord(challenge, "Native challenge");
  assertExactKeys(challenge, [
    "schema", "challenge_id", "nonce", "client", "os", "source_commit", "reviewed_pr",
    "artifact_sha256", "dependency_graph_sha256", "bridge_sha256", "prompt_sha256",
    "issued_at", "expires_at",
  ], "Native challenge");
  if (challenge.schema !== "dotaios.native-challenge.v1") throw new Error("Native challenge schema is not admitted.");
  if (!HASH_256.test(challenge.challenge_id || "")) throw new Error("Native challenge ID must be one SHA-256 value.");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(challenge.nonce || "")) throw new Error("Native challenge nonce is not admitted.");
  if (challenge.client !== "codex" && challenge.client !== "claude") throw new Error("Native challenge client is not admitted.");
  if (!["linux", "macos", "windows"].includes(challenge.os)) throw new Error("Native challenge OS is not admitted.");
  if (!GIT_OBJECT_ID.test(challenge.source_commit || "")) throw new Error("Native challenge source commit is invalid.");
  for (const field of ["artifact_sha256", "dependency_graph_sha256", "bridge_sha256", "prompt_sha256"]) {
    if (!HASH_256.test(challenge[field] || "")) throw new Error(`Native challenge ${field} is invalid.`);
  }
  assertRecord(challenge.reviewed_pr, "Native challenge reviewed PR");
  assertExactKeys(challenge.reviewed_pr, ["number", "head", "required_checks_sha256"], "Native challenge reviewed PR");
  if (!Number.isSafeInteger(challenge.reviewed_pr.number) || challenge.reviewed_pr.number <= 0) {
    throw new Error("Native challenge reviewed PR number is invalid.");
  }
  if (!GIT_OBJECT_ID.test(challenge.reviewed_pr.head || "")) throw new Error("Native challenge reviewed PR head is invalid.");
  if (!HASH_256.test(challenge.reviewed_pr.required_checks_sha256 || "")) {
    throw new Error("Native challenge required-check identity is invalid.");
  }
  const issued = Date.parse(challenge.issued_at);
  const expires = Date.parse(challenge.expires_at);
  if (
    !Number.isFinite(issued)
    || !Number.isFinite(expires)
    || new Date(issued).toISOString() !== challenge.issued_at
    || new Date(expires).toISOString() !== challenge.expires_at
    || expires <= issued
    || expires - issued > 60 * 60 * 1000
  ) {
    throw new Error("Native challenge validity window is invalid.");
  }
}

function validateClientVersion(client, clientVersion) {
  const pattern = client === "codex"
    ? /^codex-cli [0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/
    : /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6} \(Claude Code\)$/;
  if (typeof clientVersion !== "string" || !pattern.test(clientVersion)) {
    throw new Error("Native client version is not the client's exact bounded public version form.");
  }
}

function assertRuntimeOs(challengeOs) {
  const runtimeOs = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];
  if (!runtimeOs || challengeOs !== runtimeOs) {
    throw new Error("Native challenge OS does not match the producer runtime.");
  }
}

function validateNativeEvents(events, challenge, nativeRunId) {
  if (!Array.isArray(events) || events.length !== NATIVE_EVENT_TYPES.length) {
    throw new Error("Native event set is incomplete.");
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assertRecord(event, "Native event");
    assertExactKeys(event, [
      "sequence", "type", "challenge_id", "client", "reviewed_pr_head",
      "native_run_id", "evidence_sha256",
    ], "Native event");
    if (event.sequence !== index + 1 || event.type !== NATIVE_EVENT_TYPES[index]) {
      throw new Error("Native events must use the exact admitted order and types.");
    }
    if (event.challenge_id !== challenge.challenge_id) throw new Error("Native event challenge identity drifted.");
    if (event.client !== challenge.client) throw new Error("Native event client drifted.");
    if (event.reviewed_pr_head !== challenge.reviewed_pr.head) throw new Error("Native event reviewed PR head drifted.");
    if (event.native_run_id !== nativeRunId) throw new Error("Native event run identity drifted.");
    if (!HASH_256.test(event.evidence_sha256 || "")) throw new Error("Native event evidence hash is invalid.");
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const admitted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(admitted)) {
    throw new Error(`${label} contains fields outside the admitted schema.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertRegularTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stats = fs.lstatSync(candidate);
      if (stats.isSymbolicLink()) throw new Error("Owned profile contains a symbolic link.");
      if (stats.isDirectory()) pending.push(candidate);
      else if (!stats.isFile()) throw new Error("Owned profile contains a special file.");
    }
  }
}

function snapshotRegularTree(root) {
  const digest = createHash("sha256");
  const pending = [[root, ""]];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const [current, relative] = pending.pop();
    const stats = fs.lstatSync(current);
    entries += 1;
    if (entries > MAX_SNAPSHOT_ENTRIES) throw new Error("Protected-root snapshot contains too many entries.");
    digest.update(`${relative}\0${stats.mode}\0${stats.size}\0${stats.mtimeMs}\0`);
    if (stats.isSymbolicLink()) {
      digest.update(fs.readlinkSync(current));
    } else if (stats.isDirectory()) {
      const children = fs.readdirSync(current).sort().reverse();
      for (const child of children) pending.push([path.join(current, child), path.join(relative, child)]);
    } else if (stats.isFile()) {
      bytes += stats.size;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Protected-root snapshot exceeds its byte boundary.");
      digest.update(fs.readFileSync(current));
    } else {
      digest.update("special");
    }
  }
  return digest.digest("hex");
}

function isWithin(candidate, boundary) {
  const relative = path.relative(boundary, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedDiagnostic(result) {
  return `${result.stderr || ""}\n${result.stdout || ""}`.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
}

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
