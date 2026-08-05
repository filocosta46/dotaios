import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  processBirthToken,
  processRecordIsAlive
} from "../../../core/src/process-identity.mjs";
import { readProjectCatalog } from "../../../core/src/projects.mjs";
import { schemaVersion } from "../../../core/src/schema.mjs";
import {
  assertMirrorContentSafe,
  findSensitiveMirrorPaths,
  nestedRepoMessage
} from "./mirror-content-policy.mjs";

export { nestedRepoMessage } from "./mirror-content-policy.mjs";

const INDEX_TRANSACTION_SCHEMA = "dotaios.git-index-transaction.v1";
const INDEX_TRANSACTION_RECEIPT = "receipt.json";
const INDEX_TRANSACTION_BACKUP = "index.backup";
const INDEX_TRANSACTION_RESTORE = "index.restore";
const INDEX_TRANSACTION_CANDIDATE = "index.candidate";
const INDEX_TRANSACTION_COMMIT = "index.commit";
const INDEX_TRANSACTION_COMMIT_LOCK = "index.commit.lock";
const INDEX_TRANSACTION_LOCK_CLAIM = "index.lock-claim";
const INDEX_TRANSACTION_MAX_RECEIPT_BYTES = 16_384;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSAFE_TRANSACTION_OWNERSHIP = "DOTAIOS_UNSAFE_TRANSACTION_OWNERSHIP";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Strip an embedded credential (https://x-access-token:TOKEN@host) from any
// string before it reaches an error message or log. git echoes the full
// remote URL on auth/network failures.
function redactToken(text) {
  return String(text).replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

function parseRemoteTreeEntries(output) {
  const entries = [];
  for (const record of String(output || "").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const metadata = tab === -1 ? "" : record.slice(0, tab);
    const treePath = tab === -1 ? "" : record.slice(tab + 1);
    const [mode, type, oid, ...extra] = metadata.split(/\s+/);
    if (
      !/^[0-7]{6}$/.test(mode || "")
      || !/^(?:blob|tree|commit)$/.test(type || "")
      || !/^[0-9a-f]{40,64}$/i.test(oid || "")
      || extra.length > 0
      || !treePath
    ) {
      throw new Error("incoming mirror tree inspection returned an invalid record");
    }
    entries.push({ mode, type, oid, path: treePath });
  }
  return entries;
}

function assertIncomingMirrorTree(entries) {
  let ignoreEntry = null;
  let configEntry = null;
  const sensitivePaths = findSensitiveMirrorPaths(entries.map((entry) => entry.path));
  if (sensitivePaths.length > 0) {
    throw new Error(
      `Incoming private mirror contains private or regenerable local files at ${sensitivePaths.join(", ")}; sync stopped before changing local files.`
    );
  }
  for (const entry of entries) {
    const portablePath = entry.path.replaceAll("\\", "/").toLowerCase();
    if (entry.mode === "120000") {
      throw new Error(`Incoming private mirror contains a symbolic link at ${entry.path}; sync stopped before changing local files.`);
    }
    if (entry.mode === "160000") {
      throw new Error(`Incoming private mirror contains a nested Git repository pointer at ${entry.path}; sync stopped before changing local files.`);
    }
    if (portablePath === "workspaces" || portablePath.startsWith("workspaces/")) {
      throw new Error(`Incoming private mirror contains a tracked local-workspace path at ${entry.path}; sync stopped before changing local files.`);
    }
    if (portablePath === ".gitignore") {
      if (entry.path !== ".gitignore") {
        throw new Error(`Incoming private mirror contains a case-aliased .gitignore path at ${entry.path}; sync stopped before changing local files.`);
      }
      ignoreEntry = entry;
    }
    if (portablePath === "aios.json") {
      if (entry.path !== "aios.json") {
        throw new Error(`Incoming private mirror contains a case-aliased aios.json path at ${entry.path}; sync stopped before changing local files.`);
      }
      configEntry = entry;
    }
  }
  if (!ignoreEntry || ignoreEntry.type !== "blob" || !/^100(?:644|755)$/.test(ignoreEntry.mode)) {
    throw new Error("Incoming private mirror is missing a regular root .gitignore privacy boundary; sync stopped before changing local files.");
  }
  if (!configEntry || configEntry.type !== "blob" || !/^100(?:644|755)$/.test(configEntry.mode)) {
    throw new Error("Incoming private mirror is missing a regular root aios.json configuration; sync stopped before changing local files.");
  }
}

// Remove any embedded credential from a remote URL, leaving the plain https URL.
export function stripEmbeddedCredential(url) {
  return String(url).replace(/\/\/[^@/]+@/, "//");
}

// Per-invocation credential helper: git calls it with the operation ("get")
// and we answer from an env var. Passed via `-c` so it NEVER persists in
// .git/config, and the token travels in the environment, never in argv or on
// disk. An empty helper first clears any inherited global helper.
const CREDENTIAL_HELPER =
  '!f() { ' +
  'test "$1" = get || exit 0; ' +
  'protocol= host= path=; ' +
  'while IFS= read -r line; do ' +
  'case "$line" in ' +
  'protocol=*) protocol=${line#protocol=} ;; ' +
  'host=*) host=${line#host=} ;; ' +
  'path=*) path=${line#path=} ;; ' +
  'esac; ' +
  'done; ' +
  'test "$protocol" = https || exit 0; ' +
  'test "$host" = github.com || exit 0; ' +
  'test "$path" = "$DOTAIOS_SYNC_REPO_PATH" || exit 0; ' +
  'printf "username=x-access-token\\npassword=%s\\n" "$DOTAIOS_SYNC_TOKEN"; ' +
  '}; f "$@"';

export function defaultSpawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// A non-technical user's machine often has no global git identity. Without one
// `git commit` (and `git rebase`) fail with "Author identity unknown". Stamp a
// DotAIOS identity into every git invocation so sync never depends on the
// user's global git config. These env vars override user.name/user.email.
const SYNC_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "DotAIOS Sync",
  GIT_AUTHOR_EMAIL: "sync@dotaios.local",
  GIT_COMMITTER_NAME: "DotAIOS Sync",
  GIT_COMMITTER_EMAIL: "sync@dotaios.local"
};

// Parse `git status --porcelain -z` output into the list of paths to stage.
// Each entry is "XY <path>" NUL-separated; renames/copies (X = R or C) carry a
// second NUL-separated field with the source path, which we drop — staging the
// destination path is enough for git to record the rename. Empty input -> [].
export function parsePorcelainZ(stdout) {
  if (!stdout) return [];
  const fields = stdout.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    paths.push(path);
    const code = status[0];
    // R/C entries are followed by the original path in its own NUL field.
    if (code === "R" || code === "C") i += 1;
  }
  return paths;
}

const MIRROR_HOOKS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "hooks");

export function sanitizedGitEnvironment(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_") && key !== "DOTAIOS_SYNC_TOKEN") clean[key] = value;
  }
  return { ...clean, ...SYNC_GIT_IDENTITY };
}

export function parseUrlRewriteRules(output) {
  return String(output || "").split("\0").flatMap((entry) => {
    if (!entry) return [];
    const newline = entry.indexOf("\n");
    if (newline === -1) return [];
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    const match = key.match(/^url\.(.*)\.(insteadof|pushinsteadof)$/i);
    return match && value
      ? [{ replacement: match[1], prefix: value, kind: match[2].toLowerCase() }]
      : [];
  });
}

export function rewrittenDestination(destination, operation, rules) {
  const preferredKind = operation === "push" ? "pushinsteadof" : "insteadof";
  let candidates = rules.filter((rule) => rule.kind === preferredKind && destination.startsWith(rule.prefix));
  if (operation === "push" && candidates.length === 0) {
    candidates = rules.filter((rule) => rule.kind === "insteadof" && destination.startsWith(rule.prefix));
  }
  if (candidates.length === 0) return destination;
  const longest = Math.max(...candidates.map((rule) => rule.prefix.length));
  const effective = new Set(candidates
    .filter((rule) => rule.prefix.length === longest)
    .map((rule) => rule.replacement + destination.slice(rule.prefix.length)));
  return effective.size === 1 ? [...effective][0] : null;
}

export function createGit({
  cwd,
  spawnImpl = defaultSpawn,
  env = process.env,
  accessToken = null,
  expectedRepoFullName = null,
  filesystem = fs,
  indexTransactionLifecycle = {}
} = {}) {
  const gitEnv = sanitizedGitEnvironment(env);
  // Authenticate network ops via the inline helper instead of a token-in-URL
  // remote. Empty-then-set clears any inherited global helper first.
  const credArgs = accessToken
    ? [
        "-c", "credential.helper=",
        "-c", "credential.useHttpPath=true",
        "-c", `credential.helper=${CREDENTIAL_HELPER}`
      ]
    : [];

  function run(args, { indexFile, credentialed = false } = {}) {
    const commandEnv = {
      ...gitEnv,
      ...(indexFile && { GIT_INDEX_FILE: indexFile }),
      ...(credentialed && accessToken && {
        DOTAIOS_SYNC_TOKEN: accessToken,
        DOTAIOS_SYNC_REPO_PATH: `${expectedRepoFullName}.git`
      })
    };
    return spawnImpl("git", args, { cwd, env: commandEnv });
  }

  function networkDestination() {
    if (!accessToken) return "origin";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepoFullName || "")) {
      throw new Error("sync repository identity is unavailable; refusing credentialed Git access");
    }
    return `https://github.com/${expectedRepoFullName}.git`;
  }

  async function readUrlRewriteRules() {
    const configured = await run([
      "config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"
    ]);
    if (configured.code !== 0 && configured.code !== 1) {
      throw new Error(
        `could not inspect effective Git configuration; refusing credentialed Git access: ${redactToken(configured.stderr.trim()) || `git config exited ${configured.code}`}`
      );
    }
    return parseUrlRewriteRules(configured.stdout);
  }

  async function preflightCredentialedNetwork(operation) {
    const destination = networkDestination();
    const effective = rewrittenDestination(destination, operation, await readUrlRewriteRules());
    if (effective !== destination) {
      throw new Error(
        `effective Git URL rewrite changes the ${operation} destination; refusing credentialed Git access before contacting the network`
      );
    }
    return destination;
  }

  async function runCredentialedNetwork(args) {
    const disabledHooksPath = await filesystem.mkdtemp(
      path.join(os.tmpdir(), "dotaios-disabled-hooks-")
    );
    try {
      return await run(
        [...credArgs, "-c", `core.hooksPath=${disabledHooksPath}`, ...args],
        { credentialed: true }
      );
    } finally {
      await filesystem.rm(disabledHooksPath, { recursive: true, force: true });
    }
  }

  async function validateIgnoreBoundary(ignoreContent) {
    const probeRoot = await filesystem.mkdtemp(
      path.join(os.tmpdir(), "dotaios-incoming-ignore-")
    );
    try {
      await filesystem.writeFile(path.join(probeRoot, ".gitignore"), ignoreContent, {
        flag: "wx",
        mode: 0o600
      });
      await filesystem.mkdir(path.join(probeRoot, "workspaces"));
      const init = await spawnImpl(
        "git",
        ["-c", "init.templateDir=", "init", "--quiet"],
        { cwd: probeRoot, env: gitEnv }
      );
      if (init.code !== 0) {
        throw new Error(
          `incoming mirror ignore probe could not initialize: ${redactToken(init.stderr.trim()) || `git init exited ${init.code}`}`
        );
      }
      const ignored = await spawnImpl(
        "git",
        ["check-ignore", "--no-index", "-q", "--", "workspaces/"],
        { cwd: probeRoot, env: gitEnv }
      );
      if (ignored.code === 1) {
        throw new Error("Incoming private mirror does not effectively ignore /workspaces/; sync stopped before applying remote files.");
      }
      if (ignored.code !== 0) {
        throw new Error(
          `incoming mirror ignore probe failed: ${redactToken(ignored.stderr.trim()) || `git check-ignore exited ${ignored.code}`}`
        );
      }
    } finally {
      await filesystem.rm(probeRoot, { recursive: true, force: true });
    }
  }

  async function validateIncomingProjectCatalog(entries, remoteRef) {
    const projectEntries = entries.filter((entry) => {
      const portablePath = entry.path.replaceAll("\\", "/");
      const parts = portablePath.split("/");
      if (
        portablePath.toLowerCase() === "projects"
        || (parts.length === 2 && parts[0].toLowerCase() === "projects")
      ) {
        throw new Error(`Incoming private mirror contains a non-directory project catalog path at ${entry.path}; sync stopped before applying remote files.`);
      }
      if (portablePath.toLowerCase().startsWith("projects/") && !portablePath.startsWith("projects/")) {
        throw new Error(`Incoming private mirror contains a case-aliased project path at ${entry.path}; sync stopped before applying remote files.`);
      }
      return portablePath.startsWith("projects/");
    });
    if (projectEntries.length === 0) return;

    const probeRoot = await filesystem.mkdtemp(
      path.join(os.tmpdir(), "dotaios-incoming-projects-")
    );
    try {
      const projectNames = new Set();
      for (const entry of projectEntries) {
        const parts = entry.path.split("/");
        if (parts.length < 2 || !parts[1]) continue;
        projectNames.add(parts[1]);
      }
      for (const name of projectNames) {
        await filesystem.mkdir(path.join(probeRoot, "projects", name), { recursive: true });
      }
      for (const entry of projectEntries) {
        const parts = entry.path.split("/");
        if (parts.length !== 3 || parts[2] !== "README.md") continue;
        if (entry.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode)) {
          throw new Error(`Incoming project catalog has an unsafe README at ${entry.path}.`);
        }
        const content = await run(["cat-file", "blob", `${remoteRef}:${entry.path}`]);
        if (content.code !== 0) {
          throw new Error(`incoming project catalog inspection failed: ${redactToken(content.stderr.trim()) || `git cat-file exited ${content.code}`}`);
        }
        await filesystem.writeFile(path.join(probeRoot, ...parts), content.stdout, {
          flag: "wx",
          mode: 0o600
        });
      }
      try {
        await readProjectCatalog({ aiosPath: probeRoot, fs: filesystem });
      } catch (error) {
        throw new Error(`Incoming project catalog is invalid: ${error.message}`);
      }
    } finally {
      await filesystem.rm(probeRoot, { recursive: true, force: true });
    }
  }

  async function validateMirrorTreeRef(treeRef, { allowLegacyBoundary = false } = {}) {
    const tree = await run(["ls-tree", "-r", "-z", "--full-tree", treeRef]);
    if (tree.code !== 0) {
      throw new Error(
        `mirror tree inspection failed: ${redactToken(tree.stderr.trim()) || `git ls-tree exited ${tree.code}`}`
      );
    }
    const entries = parseRemoteTreeEntries(tree.stdout);
    assertIncomingMirrorTree(entries);
    await validateIncomingProjectCatalog(entries, treeRef);
    const ignore = await run(["cat-file", "blob", `${treeRef}:.gitignore`]);
    if (ignore.code !== 0) {
      throw new Error(
        `mirror ignore inspection failed: ${redactToken(ignore.stderr.trim()) || `git cat-file exited ${ignore.code}`}`
      );
    }
    let legacyBoundary = false;
    if (!ignore.stdout.split(/\r?\n/).some((line) => line === "/workspaces/")) {
      if (allowLegacyBoundary) legacyBoundary = true;
      else {
        throw new Error("Private mirror does not contain the exact /workspaces/ ignore rule; sync stopped before applying files.");
      }
    }
    if (!legacyBoundary) {
      try {
        await validateIgnoreBoundary(ignore.stdout);
      } catch (error) {
        if (allowLegacyBoundary && /does not effectively ignore \/workspaces\//i.test(error.message)) {
          legacyBoundary = true;
        } else {
          throw error;
        }
      }
    }

    const configFile = await run(["cat-file", "blob", `${treeRef}:aios.json`]);
    if (configFile.code !== 0) {
      throw new Error("Private mirror does not contain a readable root aios.json configuration; sync stopped before applying files.");
    }
    try {
      const config = JSON.parse(configFile.stdout);
      const version = config?.schema_version;
      const legacyVersions = new Set(["1.0.0", "1.1.0"]);
      if (version === schemaVersion) {
        // Current schema: no extra compatibility state.
      } else if (allowLegacyBoundary && legacyVersions.has(version)) {
        legacyBoundary = true;
      } else {
        throw new Error(`unsupported folder schema ${String(version || "unknown")}`);
      }
    } catch (error) {
      throw new Error(`Incoming private mirror has an invalid aios.json configuration: ${error.message}`);
    }
    return { legacyBoundary };
  }

  async function assertNoActiveGitOperation() {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "REBASE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer"
    ]) {
      const resolved = await run(["rev-parse", "--git-path", marker]);
      if (resolved.code !== 0 || !resolved.stdout.trim()) continue;
      const markerPath = path.isAbsolute(resolved.stdout.trim())
        ? resolved.stdout.trim()
        : path.resolve(cwd, resolved.stdout.trim());
      try {
        await filesystem.lstat(markerPath);
        throw new Error(`Git operation ${marker} is already in progress; sync stopped without staging or committing it.`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  // Heal a legacy token-embedded remote (older installs stored the credential
  // in the URL) down to the plain URL before any network op, so the token
  // stops living in .git/config. Local, cheap, idempotent.
  async function ensurePlainRemote() {
    if (!accessToken) return;
    const { code, stdout } = await run(["remote", "get-url", "origin"]);
    if (code !== 0) return;
    const current = stdout.trim();
    const plain = stripEmbeddedCredential(current);
    if (plain !== current) {
      const updated = await run(["remote", "set-url", "origin", plain]);
      if (updated.code !== 0) {
        throw new Error(
          `could not remove the embedded Git credential: ${redactToken(updated.stderr.trim()) || `git remote exited ${updated.code}`}`
        );
      }
    }
  }

  async function inspectWorkspaceRepository(workspacePath) {
    const [topLevel, head, origin] = await Promise.all([
      run(["-C", workspacePath, "rev-parse", "--show-toplevel"]),
      run(["-C", workspacePath, "rev-parse", "--verify", "HEAD"]),
      run(["-C", workspacePath, "remote", "get-url", "origin"])
    ]);
    return {
      topLevelPath: topLevel.code === 0 ? topLevel.stdout.trim() : null,
      head: head.code === 0 && /^[0-9a-f]{40,64}$/i.test(head.stdout.trim())
        ? head.stdout.trim()
        : null,
      remoteUrl: origin.code === 0 ? origin.stdout.trim() : null
    };
  }

  async function validateLocalConfig() {
    const configPath = path.join(cwd, "aios.json");
    let handle;
    try {
      handle = await filesystem.open(
        configPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
      );
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new Error("root aios.json is not a regular file");
      }
      const config = JSON.parse(await handle.readFile("utf8"));
      if (config?.schema_version !== schemaVersion) {
        throw new Error(
          `unsupported folder schema ${String(config?.schema_version || "unknown")}`
        );
      }
    } catch (error) {
      throw new Error(
        `Local private mirror has an invalid aios.json configuration: ${error.message}`
      );
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function validateLocalMirrorContent({ outerGit = true } = {}) {
    await validateLocalConfig();
    let workspacesRootIgnored = null;
    let indexedEntries = "";
    if (outerGit) {
      const ignored = await run(["check-ignore", "--no-index", "-q", "--", "workspaces/"]);
      if (ignored.code !== 0 && ignored.code !== 1) {
        throw new Error(
          `git ignore inspection failed: ${redactToken(ignored.stderr.trim()) || `git check-ignore exited ${ignored.code}`}`
        );
      }
      workspacesRootIgnored = ignored.code === 0;
      const indexed = await run(["ls-files", "-s", "-z"]);
      if (indexed.code !== 0) {
        throw new Error(
          `git index inspection failed: ${redactToken(indexed.stderr.trim()) || `git ls-files exited ${indexed.code}`}`
        );
      }
      indexedEntries = indexed.stdout;
    }
    const projectCatalog = await readProjectCatalog({ aiosPath: cwd, fs: filesystem });
    await assertMirrorContentSafe({
      root: cwd,
      changedPaths: [],
      indexedEntries,
      workspacesRootIgnored,
      inspectWholeTree: true,
      projectCatalog,
      inspectWorkspaceRepository,
      filesystem
    });
  }

  async function readIndexSnapshot(indexPath) {
    let handle;
    try {
      handle = await filesystem.open(
        indexPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
      );
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new Error("Git index is not a regular file; sync refused to replace it.");
      }
      return {
        bytes: await handle.readFile(),
        identity: `${stats.dev}:${stats.ino}`
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function indexSnapshotsMatch(left, right) {
    if (left === null || right === null) return left === right;
    return left.identity === right.identity && left.bytes.equals(right.bytes);
  }

  async function lstatIfPresent(targetPath) {
    try {
      return await filesystem.lstat(targetPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeSyncedFile(targetPath, content, options = {}) {
    let handle;
    try {
      handle = await filesystem.open(targetPath, options.flag || "wx", options.mode || 0o600);
      await handle.writeFile(content, options.encoding ? { encoding: options.encoding } : undefined);
      await handle.sync();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function syncDirectory(directoryPath) {
    let handle;
    try {
      handle = await filesystem.open(directoryPath, "r");
      await handle.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function indexTransactionRoot(indexPath) {
    return `${indexPath}.dotaios-transaction`;
  }

  function indexLockMarker(transactionId) {
    return `${INDEX_TRANSACTION_SCHEMA}:${transactionId}\n`;
  }

  function transactionWorkIndexName(indexPath, pid, transactionId) {
    return `${path.basename(indexPath)}.dotaios-work-${pid}-${transactionId}`;
  }

  function unsafeTransactionOwnership(message) {
    const error = new Error(message);
    error.code = UNSAFE_TRANSACTION_OWNERSHIP;
    return error;
  }

  function hasExactKeys(value, keys) {
    return value
      && typeof value === "object"
      && !Array.isArray(value)
      && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  }

  function isCanonicalTimestamp(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return false;
    try {
      return new Date(milliseconds).toISOString() === value;
    } catch {
      return false;
    }
  }

  function validIndexRecord(record, { mayBeAbsent = false } = {}) {
    if (!hasExactKeys(record, ["exists", "sha256", "size"])) return false;
    if (typeof record.exists !== "boolean" || (!mayBeAbsent && !record.exists)) return false;
    if (!Number.isSafeInteger(record.size) || record.size < 0) return false;
    if (!record.exists) return record.sha256 === null && record.size === 0;
    return typeof record.sha256 === "string"
      && /^[0-9a-f]{64}$/.test(record.sha256)
      && record.size >= 1;
  }

  function validIndexTransactionReceipt(receipt) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
    const required = [
      "base_head",
      "candidate",
      "candidate_tree",
      "created_at",
      "lock",
      "original",
      "pid",
      "schema",
      "transaction_id",
      "work_index"
    ];
    const allowed = typeof receipt.process_started_at === "string"
      ? [...required, "process_started_at"]
      : required;
    if (!hasExactKeys(receipt, allowed)) return false;
    if (receipt.schema !== INDEX_TRANSACTION_SCHEMA) return false;
    if (!TRANSACTION_ID_PATTERN.test(receipt.transaction_id || "")) {
      return false;
    }
    if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) return false;
    if (!isCanonicalTimestamp(receipt.created_at)) return false;
    if (receipt.base_head !== null && !OBJECT_ID_PATTERN.test(receipt.base_head || "")) return false;
    if (!OBJECT_ID_PATTERN.test(receipt.candidate_tree || "")) return false;
    if (!validIndexRecord(receipt.original, { mayBeAbsent: true })) return false;
    if (!validIndexRecord(receipt.candidate)) return false;
    if (!hasExactKeys(receipt.work_index, ["dev", "ino", "name"])
      || typeof receipt.work_index.dev !== "string"
      || !/^\d+$/.test(receipt.work_index.dev)
      || typeof receipt.work_index.ino !== "string"
      || !/^\d+$/.test(receipt.work_index.ino)
      || typeof receipt.work_index.name !== "string"
      || !/^[A-Za-z0-9._-]+$/.test(receipt.work_index.name)) {
      return false;
    }
    if (receipt.process_started_at !== undefined
      && (receipt.process_started_at.length === 0 || receipt.process_started_at.length > 256)) {
      return false;
    }
    return hasExactKeys(receipt.lock, ["dev", "ino"])
      && typeof receipt.lock.dev === "string"
      && /^\d+$/.test(receipt.lock.dev)
      && typeof receipt.lock.ino === "string"
      && /^\d+$/.test(receipt.lock.ino);
  }

  async function readOwnedRegularFile(targetPath, {
    allowedLinks = [1],
    maxBytes = null
  } = {}) {
    const before = await lstatIfPresent(targetPath);
    if (!before?.isFile() || before.isSymbolicLink() || !allowedLinks.includes(before.nlink)) {
      throw new Error("Interrupted Git index transaction contains an unsafe file; refusing automatic recovery.");
    }
    if (maxBytes !== null && before.size > maxBytes) {
      throw new Error("Interrupted Git index transaction file is unexpectedly large; refusing automatic recovery.");
    }
    let handle;
    try {
      handle = await filesystem.open(
        targetPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
      );
      const stats = await handle.stat();
      if (!stats.isFile() || !allowedLinks.includes(stats.nlink)
        || stats.dev !== before.dev || stats.ino !== before.ino || stats.size !== before.size) {
        throw new Error("Interrupted Git index transaction file changed during inspection; refusing automatic recovery.");
      }
      return { bytes: await handle.readFile(), stats };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function readIndexTransaction(indexPath, root = indexTransactionRoot(indexPath)) {
    const rootStats = await lstatIfPresent(root);
    if (!rootStats) return null;
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("Interrupted Git index transaction path is unsafe; refusing automatic recovery.");
    }
    const receiptPath = path.join(root, INDEX_TRANSACTION_RECEIPT);
    const receiptFile = await readOwnedRegularFile(receiptPath, {
      maxBytes: INDEX_TRANSACTION_MAX_RECEIPT_BYTES
    });
    const receiptContent = receiptFile.bytes.toString("utf8");
    let receipt;
    try {
      receipt = JSON.parse(receiptContent);
    } catch {
      throw new Error("Interrupted Git index transaction receipt is unreadable; refusing automatic recovery.");
    }
    if (!validIndexTransactionReceipt(receipt)) {
      throw new Error("Interrupted Git index transaction receipt is invalid; refusing automatic recovery.");
    }
    const expectedWorkIndexName = transactionWorkIndexName(
      indexPath,
      receipt.pid,
      receipt.transaction_id
    );
    if (receipt.work_index.name !== expectedWorkIndexName) {
      throw unsafeTransactionOwnership(
        "Interrupted Git transaction work index is outside its exact owned namespace; refusing automatic recovery."
      );
    }

    const requiredEntries = [
      INDEX_TRANSACTION_COMMIT,
      INDEX_TRANSACTION_LOCK_CLAIM,
      INDEX_TRANSACTION_RECEIPT,
      ...(receipt.original.exists ? [INDEX_TRANSACTION_BACKUP] : [])
    ];
    const optionalEntries = [
      INDEX_TRANSACTION_CANDIDATE,
      INDEX_TRANSACTION_COMMIT_LOCK,
      ...(receipt.original.exists ? [INDEX_TRANSACTION_RESTORE] : [])
    ];
    const entries = (await filesystem.readdir(root)).sort();
    if (requiredEntries.some((entry) => !entries.includes(entry))
      || entries.some((entry) => !requiredEntries.includes(entry) && !optionalEntries.includes(entry))) {
      throw new Error("Interrupted Git index transaction contains unexpected files; refusing automatic recovery.");
    }

    let backup = null;
    if (receipt.original.exists) {
      const backupFile = await readOwnedRegularFile(path.join(root, INDEX_TRANSACTION_BACKUP));
      if (backupFile.bytes.length !== receipt.original.size
        || sha256(backupFile.bytes) !== receipt.original.sha256) {
        throw new Error("Interrupted Git index transaction backup was changed; refusing automatic recovery.");
      }
      backup = backupFile;
    }
    const marker = indexLockMarker(receipt.transaction_id);
    const lockClaimPath = path.join(root, INDEX_TRANSACTION_LOCK_CLAIM);
    const lockClaim = await readOwnedRegularFile(lockClaimPath, {
      allowedLinks: [1, 2],
      maxBytes: 256
    });
    if (String(lockClaim.stats.dev) !== receipt.lock.dev
      || String(lockClaim.stats.ino) !== receipt.lock.ino
      || lockClaim.bytes.toString("utf8") !== marker) {
      throw new Error("Interrupted Git index transaction lock claim changed; refusing automatic recovery.");
    }

    let candidateFile = null;
    const candidatePath = path.join(root, INDEX_TRANSACTION_CANDIDATE);
    if (entries.includes(INDEX_TRANSACTION_CANDIDATE)) {
      candidateFile = await readOwnedRegularFile(candidatePath);
      if (candidateFile.bytes.length !== receipt.candidate.size
        || sha256(candidateFile.bytes) !== receipt.candidate.sha256) {
        throw new Error("Interrupted Git index transaction candidate changed; refusing automatic recovery.");
      }
    }

    let restoreFile = null;
    const restorePath = path.join(root, INDEX_TRANSACTION_RESTORE);
    if (entries.includes(INDEX_TRANSACTION_RESTORE)) {
      restoreFile = await readOwnedRegularFile(restorePath);
      if (restoreFile.bytes.length !== receipt.original.size
        || sha256(restoreFile.bytes) !== receipt.original.sha256) {
        throw new Error("Interrupted Git index transaction restore file changed; refusing automatic recovery.");
      }
    }
    const commitPath = path.join(root, INDEX_TRANSACTION_COMMIT);
    const commitFile = await readOwnedRegularFile(commitPath);
    let commitLockFile = null;
    const commitLockPath = path.join(root, INDEX_TRANSACTION_COMMIT_LOCK);
    if (entries.includes(INDEX_TRANSACTION_COMMIT_LOCK)) {
      commitLockFile = await readOwnedRegularFile(commitLockPath);
    }
    return {
      root,
      rootStats,
      receiptPath,
      receiptFile,
      receiptContent,
      receipt,
      backup,
      candidateFile,
      candidatePath,
      restoreFile,
      restorePath,
      commitFile,
      commitPath,
      commitLockFile,
      commitLockPath,
      lockClaim,
      lockClaimPath,
      marker,
      workIndexPath: path.join(path.dirname(indexPath), receipt.work_index.name)
    };
  }

  function indexRecord(bytes) {
    return bytes === null
      ? { exists: false, sha256: null, size: 0 }
      : { exists: true, sha256: sha256(bytes), size: bytes.length };
  }

  function snapshotMatchesRecord(snapshot, record) {
    if (!record.exists) return snapshot === null;
    return snapshot !== null
      && snapshot.bytes.length === record.size
      && sha256(snapshot.bytes) === record.sha256;
  }

  async function createIndexTransaction(indexPath, {
    baseHead,
    candidate,
    candidateTree,
    original,
    transactionId,
    workIndexPath
  }) {
    const root = indexTransactionRoot(indexPath);
    if (!TRANSACTION_ID_PATTERN.test(transactionId || "")) {
      throw new Error("Git index transaction identity is invalid.");
    }
    const stagingRoot = `${root}.preparing-${process.pid}-${transactionId}`;
    const processStartedAt = processBirthToken(process.pid);
    const workIndexName = path.basename(workIndexPath);
    const expectedWorkIndexName = transactionWorkIndexName(indexPath, process.pid, transactionId);
    if (path.dirname(workIndexPath) !== path.dirname(indexPath)
      || workIndexName !== expectedWorkIndexName) {
      throw new Error("Git transaction work index path is outside its owned namespace.");
    }
    const workIndexStats = await filesystem.lstat(workIndexPath);
    if (!workIndexStats.isFile() || workIndexStats.isSymbolicLink() || workIndexStats.nlink !== 1) {
      throw new Error("Git transaction work index is not a private regular file.");
    }
    await filesystem.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    let published = false;
    try {
      if (original !== null) {
        await writeSyncedFile(path.join(stagingRoot, INDEX_TRANSACTION_BACKUP), original);
        await writeSyncedFile(path.join(stagingRoot, INDEX_TRANSACTION_RESTORE), original);
      }
      await writeSyncedFile(path.join(stagingRoot, INDEX_TRANSACTION_CANDIDATE), candidate);
      await writeSyncedFile(path.join(stagingRoot, INDEX_TRANSACTION_COMMIT), candidate);
      const marker = indexLockMarker(transactionId);
      const lockClaimPath = path.join(stagingRoot, INDEX_TRANSACTION_LOCK_CLAIM);
      await writeSyncedFile(lockClaimPath, marker, { encoding: "utf8" });
      const lockClaimStats = await filesystem.lstat(lockClaimPath);
      const receipt = {
        schema: INDEX_TRANSACTION_SCHEMA,
        transaction_id: transactionId,
        pid: process.pid,
        created_at: new Date().toISOString(),
        base_head: baseHead,
        candidate_tree: candidateTree,
        original: indexRecord(original),
        candidate: indexRecord(candidate),
        lock: { dev: String(lockClaimStats.dev), ino: String(lockClaimStats.ino) },
        work_index: {
          name: workIndexName,
          dev: String(workIndexStats.dev),
          ino: String(workIndexStats.ino)
        },
        ...(processStartedAt && { process_started_at: processStartedAt })
      };
      await writeSyncedFile(
        path.join(stagingRoot, INDEX_TRANSACTION_RECEIPT),
        `${JSON.stringify(receipt, null, 2)}\n`,
        { encoding: "utf8" }
      );
      await syncDirectory(stagingRoot);
      await indexTransactionLifecycle.afterPreparedTransaction?.();
      await filesystem.rename(stagingRoot, root);
      published = true;
      await syncDirectory(path.dirname(root));
      await indexTransactionLifecycle.afterTransactionPublished?.();
      const transaction = await readIndexTransaction(indexPath);
      if (transaction?.receipt.transaction_id !== transactionId) {
        throw new Error("Git index transaction ownership changed during publication.");
      }
      return transaction;
    } finally {
      if (!published) {
        await filesystem.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function installTransactionIndex(indexPath, transaction, kind) {
    if (kind === "restore" && !transaction.receipt.original.exists) {
      await filesystem.rm(indexPath, { force: true });
      await syncDirectory(path.dirname(indexPath));
      return;
    }
    const record = kind === "candidate"
      ? transaction.receipt.candidate
      : transaction.receipt.original;
    const sourcePath = kind === "candidate"
      ? transaction.candidatePath
      : transaction.restorePath;
    const expectedFile = kind === "candidate"
      ? transaction.candidateFile
      : transaction.restoreFile;
    if (!expectedFile) {
      throw new Error(`Git index transaction ${kind} file is missing; refusing replacement.`);
    }
    const current = await readOwnedRegularFile(sourcePath);
    if (current.stats.dev !== expectedFile.stats.dev
      || current.stats.ino !== expectedFile.stats.ino
      || current.bytes.length !== record.size
      || sha256(current.bytes) !== record.sha256) {
      throw new Error(`Git index transaction ${kind} file changed; refusing replacement.`);
    }
    await filesystem.rename(sourcePath, indexPath);
    await syncDirectory(path.dirname(indexPath));
  }

  async function readHeadOid({ allowUnborn = false } = {}) {
    const result = await run(["rev-parse", "--verify", "HEAD"]);
    const oid = result.stdout.trim().toLowerCase();
    if (result.code === 0 && OBJECT_ID_PATTERN.test(oid)) return oid;
    if (allowUnborn) {
      const symbolic = await run(["symbolic-ref", "--quiet", "HEAD"]);
      const ref = symbolic.stdout.trim();
      if (symbolic.code === 0 && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref)) {
        const exists = await run(["show-ref", "--verify", "--quiet", ref]);
        if (exists.code === 1) return null;
      }
    }
    throw new Error(
      `Git HEAD identity could not be verified: ${redactToken(result.stderr.trim()) || `git rev-parse exited ${result.code}`}`
    );
  }

  async function classifyTransactionHead(receipt) {
    const head = await readHeadOid({ allowUnborn: true });
    if (head === receipt.base_head) return { kind: "base", head };
    if (head === null) return { kind: "ambiguous", head };
    const parents = await run(["rev-list", "--parents", "-n", "1", head]);
    if (parents.code !== 0) {
      throw new Error(
        `Interrupted Git commit ancestry could not be verified: ${redactToken(parents.stderr.trim()) || `git rev-list exited ${parents.code}`}`
      );
    }
    const tokens = parents.stdout.trim().toLowerCase().split(/\s+/);
    const tree = await run(["rev-parse", "--verify", `${head}^{tree}`]);
    const treeOid = tree.stdout.trim().toLowerCase();
    if (tree.code !== 0 || !OBJECT_ID_PATTERN.test(treeOid)) {
      throw new Error(
        `Interrupted Git commit tree could not be verified: ${redactToken(tree.stderr.trim()) || `git rev-parse exited ${tree.code}`}`
      );
    }
    const exactParents = receipt.base_head === null
      ? tokens.length === 1 && tokens[0] === head
      : tokens.length === 2 && tokens[0] === head && tokens[1] === receipt.base_head;
    if (exactParents
      && treeOid === receipt.candidate_tree) {
      return { kind: "committed", head };
    }
    return { kind: "ambiguous", head };
  }

  async function assertTransactionHead(expectedHead) {
    const currentHead = await readHeadOid({ allowUnborn: true });
    if (currentHead !== expectedHead) {
      throw new Error(
        "Git HEAD changed across the index transaction cleanup boundary; durable recovery evidence was preserved."
      );
    }
  }

  async function inspectTransactionLock(indexPath, transaction) {
    const lockPath = `${indexPath}.lock`;
    const stats = await lstatIfPresent(lockPath);
    if (!stats) return null;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 2
      || String(stats.dev) !== transaction.receipt.lock.dev
      || String(stats.ino) !== transaction.receipt.lock.ino
      || stats.dev !== transaction.lockClaim.stats.dev
      || stats.ino !== transaction.lockClaim.stats.ino) {
      throw new Error("Git index lock ownership changed; refusing to remove a foreign lock.");
    }
    const lockFile = await readOwnedRegularFile(lockPath, {
      allowedLinks: [2],
      maxBytes: 256
    });
    if (lockFile.bytes.toString("utf8") !== transaction.marker) {
      throw new Error("Git index lock marker changed; refusing to remove a foreign lock.");
    }
    return { path: lockPath, stats: lockFile.stats, marker: transaction.marker };
  }

  async function removeOwnedIndexLock(ownership) {
    if (!ownership) return;
    const current = await lstatIfPresent(ownership.path);
    if (!current) return;
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 2
      || current.dev !== ownership.stats.dev || current.ino !== ownership.stats.ino) {
      throw new Error("Git index lock ownership changed; refusing to remove a foreign lock.");
    }
    const lockFile = await readOwnedRegularFile(ownership.path, {
      allowedLinks: [2],
      maxBytes: 256
    });
    if (lockFile.bytes.toString("utf8") !== ownership.marker) {
      throw new Error("Git index lock marker changed; refusing to remove a foreign lock.");
    }
    await filesystem.rm(ownership.path);
  }

  async function removeOwnedWorkIndex(transaction) {
    const current = await lstatIfPresent(transaction.workIndexPath);
    if (!current) return;
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || String(current.dev) !== transaction.receipt.work_index.dev
      || String(current.ino) !== transaction.receipt.work_index.ino) {
      throw new Error("Git transaction work index ownership changed; refusing to remove it.");
    }
    await filesystem.rm(transaction.workIndexPath);
  }

  async function cleanupIndexTransaction(indexPath, transaction, expectedHead) {
    const current = await readIndexTransaction(indexPath, transaction.root);
    if (!current) return;
    if (current.rootStats.dev !== transaction.rootStats.dev
      || current.rootStats.ino !== transaction.rootStats.ino
      || current.receiptContent !== transaction.receiptContent) {
      throw new Error("Git index transaction ownership changed; refusing automatic cleanup.");
    }
    await assertTransactionHead(expectedHead);
    const tombstone = `${indexTransactionRoot(indexPath)}.cleanup-${transaction.receipt.transaction_id}`;
    await filesystem.rename(transaction.root, tombstone);
    await syncDirectory(path.dirname(tombstone));
    await indexTransactionLifecycle.afterTransactionTombstoned?.();
    await assertTransactionHead(expectedHead);
    await filesystem.rm(tombstone, { recursive: true });
    await syncDirectory(path.dirname(tombstone));
  }

  async function cleanupOwnedIndexTransaction(indexPath, transaction, lockOwnership, expectedHead) {
    await assertTransactionHead(expectedHead);
    await removeOwnedIndexLock(lockOwnership);
    await removeOwnedWorkIndex(transaction);
    await cleanupIndexTransaction(indexPath, transaction, expectedHead);
  }

  async function verifiedResidueDisposition(indexPath, transaction) {
    const disposition = await classifyTransactionHead(transaction.receipt);
    const currentIndex = await readIndexSnapshot(indexPath);
    const expectedRecord = disposition.kind === "base"
      ? transaction.receipt.original
      : transaction.receipt.candidate;
    if (disposition.kind === "ambiguous") {
      throw new Error("Git HEAD moved outside the interrupted DotAIOS transaction; refusing residue cleanup.");
    }
    if (!snapshotMatchesRecord(currentIndex, expectedRecord)) {
      throw new Error("Interrupted Git transaction residue has an unexpected index state; refusing cleanup.");
    }
    return disposition;
  }

  async function recoverIndexTransactionResidue(indexPath) {
    const canonicalRoot = indexTransactionRoot(indexPath);
    const parent = path.dirname(canonicalRoot);
    const base = path.basename(canonicalRoot);
    let entries;
    try {
      entries = await filesystem.readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.name.startsWith(`${base}.cleanup-`) || !entry.isDirectory()) continue;
      const residueRoot = path.join(parent, entry.name);
      let transaction;
      try {
        transaction = await readIndexTransaction(indexPath, residueRoot);
      } catch (error) {
        if (error.code === UNSAFE_TRANSACTION_OWNERSHIP) throw error;
        // An interrupted recursive delete cannot block the canonical name. Its
        // partial tombstone is never trusted or removed automatically.
        continue;
      }
      if (entry.name !== `${base}.cleanup-${transaction.receipt.transaction_id}`) continue;
      if (processRecordIsAlive(transaction.receipt)) {
        throw new Error("Another live DotAIOS process is cleaning a Git index transaction.");
      }
      const disposition = await verifiedResidueDisposition(indexPath, transaction);
      const ownedLock = await inspectTransactionLock(indexPath, transaction);
      await assertTransactionHead(disposition.head);
      await removeOwnedIndexLock(ownedLock);
      await removeOwnedWorkIndex(transaction);
      await assertTransactionHead(disposition.head);
      await filesystem.rm(residueRoot, { recursive: true });
      await syncDirectory(parent);
    }

    for (const entry of entries) {
      if (!entry.name.startsWith(`${base}.preparing-`) || !entry.isDirectory()) continue;
      const residueRoot = path.join(parent, entry.name);
      let transaction;
      try {
        transaction = await readIndexTransaction(indexPath, residueRoot);
      } catch (error) {
        if (error.code === UNSAFE_TRANSACTION_OWNERSHIP) throw error;
        // A preparation stopped before publishing a complete signed receipt.
        // It cannot own the canonical transaction or conventional Git lock.
        continue;
      }
      if (entry.name !== `${base}.preparing-${transaction.receipt.pid}-${transaction.receipt.transaction_id}`) {
        continue;
      }
      if (processRecordIsAlive(transaction.receipt)) {
        throw new Error("Another live DotAIOS process is preparing a Git index transaction.");
      }
      const disposition = await verifiedResidueDisposition(indexPath, transaction);
      const ownedLock = await inspectTransactionLock(indexPath, transaction);
      await cleanupOwnedIndexTransaction(indexPath, transaction, ownedLock, disposition.head);
    }
  }

  async function recoverIndexTransaction(indexPath) {
    await recoverIndexTransactionResidue(indexPath);
    const transaction = await readIndexTransaction(indexPath);
    if (!transaction) return null;
    if (processRecordIsAlive(transaction.receipt)) {
      throw new Error("Another live DotAIOS process owns the Git index transaction; sync stopped without changing it.");
    }
    const lockOwnership = await inspectTransactionLock(indexPath, transaction);
    const disposition = await classifyTransactionHead(transaction.receipt);
    const currentIndex = await readIndexSnapshot(indexPath);

    if (disposition.kind === "base") {
      if (!snapshotMatchesRecord(currentIndex, transaction.receipt.original)) {
        if (!snapshotMatchesRecord(currentIndex, transaction.receipt.candidate)) {
          throw new Error("Interrupted Git index transaction no longer matches its original or candidate index; refusing automatic recovery.");
        }
        let recoveryLock = lockOwnership;
        if (!recoveryLock) {
          await filesystem.link(transaction.lockClaimPath, `${indexPath}.lock`);
          recoveryLock = await inspectTransactionLock(indexPath, transaction);
        }
        await installTransactionIndex(indexPath, transaction, "restore");
        const restored = await readIndexSnapshot(indexPath);
        if (!snapshotMatchesRecord(restored, transaction.receipt.original)) {
          throw new Error("Interrupted Git index transaction could not restore the exact original index.");
        }
        await cleanupOwnedIndexTransaction(indexPath, transaction, recoveryLock, disposition.head);
        return disposition;
      }
    } else if (disposition.kind === "committed") {
      if (!snapshotMatchesRecord(currentIndex, transaction.receipt.candidate)) {
        throw new Error("Interrupted Git commit has an unexpected index state; refusing automatic cleanup.");
      }
    } else {
      throw new Error("Git HEAD moved outside the interrupted DotAIOS transaction; refusing automatic recovery.");
    }

    await cleanupOwnedIndexTransaction(indexPath, transaction, lockOwnership, disposition.head);
    return disposition;
  }

  async function withLockedIndexCandidate(
    indexPath,
    replacement,
    original,
    expectedSnapshot,
    { baseHead, candidateTree, transactionId, workIndexPath },
    operation
  ) {
    const lockPath = `${indexPath}.lock`;
    let transaction;
    let lockOwnership;
    let candidateInstalled = false;
    let failure = null;
    let committed = false;
    let committedHead = null;
    transaction = await createIndexTransaction(indexPath, {
        baseHead,
        candidate: replacement,
        candidateTree,
        original,
        transactionId,
        workIndexPath
    });
    await removeOwnedWorkIndex(transaction);
    try {
        // This conventional lock excludes normal Git index writers. Its inode
        // and private marker are durably bound to the receipt before the real
        // index is replaced, so a later process never guesses lock ownership.
        await filesystem.link(transaction.lockClaimPath, lockPath);
        lockOwnership = await inspectTransactionLock(indexPath, transaction);
        await indexTransactionLifecycle.afterLockPublished?.();

        const currentSnapshot = await readIndexSnapshot(indexPath);
        if (!indexSnapshotsMatch(currentSnapshot, expectedSnapshot)) {
          throw new Error("Git index changed concurrently; sync left the newer staging state untouched.");
        }
        if (await readHeadOid({ allowUnborn: true }) !== baseHead) {
          throw new Error("Git HEAD changed concurrently; sync stopped before replacing the index.");
        }
        await installTransactionIndex(indexPath, transaction, "candidate");
        candidateInstalled = true;
        await indexTransactionLifecycle.afterCandidateInstalled?.();
        const commitIndex = await readOwnedRegularFile(transaction.commitPath);
        if (commitIndex.stats.dev !== transaction.commitFile.stats.dev
          || commitIndex.stats.ino !== transaction.commitFile.stats.ino
          || commitIndex.bytes.length !== transaction.receipt.candidate.size
          || sha256(commitIndex.bytes) !== transaction.receipt.candidate.sha256) {
          throw new Error("Git transaction commit index changed before commit.");
        }
        await operation(transaction.commitPath);
    } catch (error) {
      failure = error;
    }

    if (candidateInstalled) {
      let disposition;
      try {
        disposition = await classifyTransactionHead(transaction.receipt);
      } catch (verificationError) {
        throw new AggregateError(
          [failure, verificationError].filter(Boolean),
          "Git index transaction outcome could not be verified; its receipt, backup, and lock were preserved."
        );
      }
      if (disposition.kind === "committed") {
        committed = true;
        committedHead = disposition.head;
      } else if (disposition.kind === "base") {
        if (!failure) failure = new Error("Git commit did not advance HEAD.");
        try {
          await installTransactionIndex(indexPath, transaction, "restore");
          const restored = await readIndexSnapshot(indexPath);
          if (!snapshotMatchesRecord(restored, transaction.receipt.original)) {
            throw new Error("restored index does not match the durable backup receipt");
          }
          candidateInstalled = false;
        } catch (restoreError) {
          throw new AggregateError(
            [failure, restoreError].filter(Boolean),
            `Git failed and the original index could not be safely restored: ${failure?.message || "unknown failure"}`
          );
        }
      } else {
        throw new Error("Git HEAD moved outside the owned index transaction; recovery state was preserved.");
      }
    }

    try {
      if (transaction) {
        await cleanupOwnedIndexTransaction(
          indexPath,
          transaction,
          lockOwnership,
          committed ? committedHead : transaction.receipt.base_head
        );
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError].filter(Boolean),
        "Git index transaction cleanup failed; the durable receipt was preserved for recovery."
      );
    }
    if (failure && !committed) throw failure;
    return committedHead;
  }

  async function repositoryRootMatchesCwd() {
    const topLevel = await run(["rev-parse", "--show-toplevel"]);
    if (topLevel.code !== 0 || !topLevel.stdout.trim()) return false;
    try {
      const [actualRoot, expectedRoot] = await Promise.all([
        filesystem.realpath(topLevel.stdout.trim()),
        filesystem.realpath(cwd)
      ]);
      return actualRoot === expectedRoot;
    } catch {
      return false;
    }
  }

  return {
    async isRepositoryRoot() {
      return repositoryRootMatchesCwd();
    },

    async currentBranch() {
      const { code, stdout } = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (code !== 0) return null;
      const branch = stdout.trim();
      return branch || null;
    },

    async originUrl() {
      const { code, stdout, stderr } = await run(["remote", "get-url", "origin"]);
      if (code !== 0) {
        throw new Error(`could not read Git origin: ${redactToken(stderr.trim()) || `git remote exited ${code}`}`);
      }
      return stdout.trim();
    },

    async dirty() {
      const { stdout } = await run(["status", "--porcelain"]);
      return stdout.trim().length > 0;
    },

    async validateMirrorContent(options) {
      await validateLocalMirrorContent(options);
    },

    // Stage every changed path explicitly (never `git add -A`), then commit.
    // Enumerating the changed paths from `git status --porcelain -z` lets us add
    // each one by name, which keeps the commit surface explicit and lets a future
    // caller filter paths (skip large files, secrets, etc.). Deletions and
    // renames are staged by naming the destination path. Returns null when there
    // is nothing to commit.
    async commitAll(message) {
      const indexLocation = await run(["rev-parse", "--git-path", "index"]);
      if (indexLocation.code !== 0 || !indexLocation.stdout.trim()) {
        throw new Error(
          `git index location failed: ${redactToken(indexLocation.stderr.trim()) || `git rev-parse exited ${indexLocation.code}`}`
        );
      }
      const reportedIndexPath = indexLocation.stdout.trim();
      const indexPath = path.isAbsolute(reportedIndexPath)
        ? reportedIndexPath
        : path.resolve(cwd, reportedIndexPath);
      await assertNoActiveGitOperation();
      await recoverIndexTransaction(indexPath);
      await assertNoActiveGitOperation();
      const { stdout } = await run(["status", "--porcelain", "-z"]);
      const paths = parsePorcelainZ(stdout);
      if (paths.length === 0) return null;
      const indexed = await run(["ls-files", "-s", "-z"]);
      if (indexed.code !== 0) {
        throw new Error(
          `git index inspection failed: ${redactToken(indexed.stderr.trim()) || `git ls-files exited ${indexed.code}`}`
        );
      }
      await assertMirrorContentSafe({
        root: cwd,
        changedPaths: paths,
        indexedEntries: indexed.stdout,
        filesystem
      });
      const transactionId = randomUUID();
      const temporaryIndex = path.join(
        path.dirname(indexPath),
        transactionWorkIndexName(indexPath, process.pid, transactionId)
      );
      let originalIndex = null;
      try {
        const baseHead = await readHeadOid({ allowUnborn: true });
        const originalIndexSnapshot = await readIndexSnapshot(indexPath);
        originalIndex = originalIndexSnapshot?.bytes ?? null;
        if (originalIndex !== null) {
          await filesystem.writeFile(temporaryIndex, originalIndex, { flag: "wx", mode: 0o600 });
        } else {
          const populated = await run(["read-tree", "HEAD"], { indexFile: temporaryIndex });
          if (populated.code !== 0) {
            await filesystem.rm(temporaryIndex, { force: true });
          }
        }

        const addResult = await run(["add", "--", ...paths], { indexFile: temporaryIndex });
        if (addResult.code !== 0) {
          throw new Error(`git add failed: ${redactToken(addResult.stderr.trim())}`);
        }
        const candidate = await run(["ls-files", "-s", "-z"], { indexFile: temporaryIndex });
        if (candidate.code !== 0) {
          throw new Error(
            `git candidate index inspection failed: ${redactToken(candidate.stderr.trim()) || `git ls-files exited ${candidate.code}`}`
          );
        }
        await assertMirrorContentSafe({
          root: cwd,
          changedPaths: paths,
          indexedEntries: candidate.stdout,
          filesystem
        });
        // Catch working-tree/catalog races after the isolated add without
        // exposing the user's real index to the candidate state.
        await validateLocalMirrorContent();

        const staged = await run(["diff", "--cached", "--quiet"], { indexFile: temporaryIndex });
        if (staged.code === 0) return null;
        if (staged.code !== 1) {
          throw new Error(
            `git staged diff inspection failed: ${redactToken(staged.stderr.trim()) || `git diff exited ${staged.code}`}`
          );
        }

        const candidateBytes = await filesystem.readFile(temporaryIndex);
        const tree = await run(["write-tree"], { indexFile: temporaryIndex });
        const candidateTree = tree.stdout.trim().toLowerCase();
        if (tree.code !== 0 || !OBJECT_ID_PATTERN.test(candidateTree)) {
          throw new Error(
            `git candidate tree identity failed: ${redactToken(tree.stderr.trim()) || `git write-tree exited ${tree.code}`}`
          );
        }
        // Validate the immutable tree object, not the working tree that could
        // change after the isolated add. This binds the privacy boundary,
        // schema, sensitive-path policy, and project catalog to the exact tree
        // the transaction is about to commit.
        await validateMirrorTreeRef(candidateTree);
        const committedSha = await withLockedIndexCandidate(
          indexPath,
          candidateBytes,
          originalIndex,
          originalIndexSnapshot,
          { baseHead, candidateTree, transactionId, workIndexPath: temporaryIndex },
          async (commitIndexPath) => {
            await assertNoActiveGitOperation();
            const commit = await run([
              "-c", `core.hooksPath=${MIRROR_HOOKS_PATH}`,
              "-c", "commit.gpgSign=false",
              "commit", "-m", message
            ], { indexFile: commitIndexPath });
            if (commit.code !== 0) {
              throw new Error(`git commit failed: ${redactToken(commit.stderr.trim())}`);
            }
            await indexTransactionLifecycle.afterCommit?.();
          }
        );
        if (!OBJECT_ID_PATTERN.test(committedSha || "")) {
          throw new Error("git commit identity failed: transaction returned no verified commit");
        }
        return committedSha;
      } finally {
        await filesystem.rm(temporaryIndex, { force: true });
      }
    },

    async push(branch = "main", sourceSha) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sourceSha || "")) {
        throw new Error("invalid validated push commit");
      }
      const destination = accessToken
        ? await preflightCredentialedNetwork("push")
        : networkDestination();
      await ensurePlainRemote();
      const refspec = `${sourceSha}:refs/heads/${branch}`;
      const { code, stderr } = accessToken
        ? await runCredentialedNetwork(["push", destination, refspec])
        : await run(["push", destination, refspec]);
      if (code !== 0) throw new Error(`git push failed: ${redactToken(stderr.trim())}`);
    },

    async fetch(branch = "main") {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const destination = accessToken
        ? await preflightCredentialedNetwork("fetch")
        : networkDestination();
      await ensurePlainRemote();
      const fetchArgs = ["fetch", destination, `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
      const { code, stderr } = accessToken
        ? await runCredentialedNetwork(fetchArgs)
        : await run(["fetch", destination]);
      if (code !== 0) throw new Error(`git fetch failed: ${redactToken(stderr.trim())}`);
    },

    async validateFetchedMirrorTree(branch = "main", { allowLegacyBoundary = false } = {}) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      return validateMirrorTreeRef(`origin/${branch}`, { allowLegacyBoundary });
    },

    async validateMirrorCommit(sha) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha || "")) {
        throw new Error("invalid mirror commit identity");
      }
      await validateMirrorTreeRef(sha);
      return sha;
    },

    // Read the sync branch directly from the remote. This is deliberately
    // separate from fetch/rebase: `sync status` must be able to verify the
    // cached push receipt without changing the checkout or refs.
    async remoteHead(branch = "main") {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const ref = `refs/heads/${branch}`;
      const destination = accessToken
        ? await preflightCredentialedNetwork("fetch")
        : networkDestination();
      await ensurePlainRemote();
      const { code, stdout, stderr } = accessToken
        ? await runCredentialedNetwork(["ls-remote", destination, ref])
        : await run(["ls-remote", destination, ref]);
      if (code !== 0) {
        throw new Error(`git ls-remote failed: ${redactToken(stderr.trim())}`);
      }
      const [sha, returnedRef] = stdout.trim().split(/\s+/);
      if (!/^[0-9a-f]{40}$/i.test(sha || "") || returnedRef !== ref) {
        throw new Error("git ls-remote returned no valid sync branch ref");
      }
      return sha;
    },

    // Pull by rebasing local commits on top of origin. Local changes must be
    // committed before calling this — rebase refuses to run on a dirty tree.
    // Returns "up-to-date" (origin had nothing new), "rebased" (local commits
    // replayed cleanly on top of origin), or "conflict" (a real same-file
    // clash. The failed rebase is aborted so the tree is left untouched and
    // the caller can stop safely).
    async remoteState(branch = "main", { lastPushSha = null } = {}) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const destination = accessToken
        ? await preflightCredentialedNetwork("fetch")
        : networkDestination();
      await ensurePlainRemote();
      const result = accessToken
        ? await runCredentialedNetwork(["ls-remote", destination])
        : await run(["ls-remote", destination]);
      if (result.code !== 0) {
        throw new Error(`git ls-remote failed: ${redactToken(result.stderr.trim())}`);
      }
      const refs = result.stdout.split("\n").flatMap((line) => {
        const [sha, ref] = line.trim().split(/\s+/);
        return /^[0-9a-f]{40}$/i.test(sha || "") && ref ? [{ sha, ref }] : [];
      });
      const main = refs.find((entry) => entry.ref === `refs/heads/${branch}`);
      if (main) return { kind: "main-present", sha: main.sha };
      if (refs.length === 0 && !lastPushSha) return { kind: "never-pushed-empty" };
      return { kind: "unexpected-main-absent", refs: refs.map((entry) => entry.ref) };
    },

    async pullRebase(branch = "main", { lastPushSha = null } = {}) {
      await assertNoActiveGitOperation();
      const remote = await this.remoteState(branch, { lastPushSha });
      if (remote.kind === "never-pushed-empty") return "empty";
      if (remote.kind === "unexpected-main-absent") {
        throw new Error(
          remote.refs.length > 0
            ? `remote ${branch} is unexpectedly missing while other refs exist`
            : `remote ${branch} is unexpectedly missing after DotAIOS previously pushed it`
        );
      }
      await this.fetch(branch);
      // Bind the rest of this operation to the exact commit fetched now.
      // refs/remotes/origin/* are mutable local names; another Git process can
      // move one after validation. An object id remains immutable throughout
      // validation, candidate construction, and rebase.
      const fetched = await run([
        "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`
      ]);
      const fetchedSha = fetched.stdout.trim();
      if (
        fetched.code !== 0
        || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(fetchedSha)
      ) {
        throw new Error(
          `fetched mirror identity is invalid: ${redactToken(fetched.stderr.trim()) || `git rev-parse exited ${fetched.code}`}`
        );
      }
      const remoteTree = await validateMirrorTreeRef(fetchedSha, {
        allowLegacyBoundary: true
      });
      if (remoteTree.legacyBoundary) {
        // A rolling upgrade may diverge while another device is still on the
        // legacy schema. Require the local side to be current, then let the
        // immutable combined-tree validation below decide whether it is safe.
        await this.validateMirrorContent();
      }
      const behindResult = await run(["rev-list", "--count", `HEAD..${fetchedSha}`]);
      const behind = Number.parseInt(behindResult.stdout.trim(), 10);
      if (behindResult.code !== 0 || !Number.isInteger(behind) || behind < 0) {
        throw new Error(
          `fetched mirror ancestry inspection failed: ${redactToken(behindResult.stderr.trim()) || `git rev-list exited ${behindResult.code}`}`
        );
      }
      if (behind === 0) return "up-to-date";
      // Validate the clean three-way candidate without moving HEAD or touching
      // the checkout. Independent local and remote catalog changes can each be
      // valid alone but invalid together (for example duplicate project IDs).
      const candidate = await run(["merge-tree", "--write-tree", fetchedSha, "HEAD"]);
      if (candidate.code === 0) {
        const candidateTree = candidate.stdout.trim().split(/\s+/, 1)[0];
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(candidateTree || "")) {
          throw new Error("combined mirror tree inspection returned no valid tree identity");
        }
        await validateMirrorTreeRef(candidateTree);
      } else if (candidate.code !== 1) {
        throw new Error(
          `combined mirror tree inspection failed: ${redactToken(candidate.stderr.trim()) || `git merge-tree exited ${candidate.code}`}`
        );
      }
      const rebase = await run(["rebase", fetchedSha]);
      if (rebase.code !== 0) {
        // Abort so the working tree is restored to the pre-rebase state.
        // Best-effort: ignore the abort's own exit code.
        await run(["rebase", "--abort"]);
        return "conflict";
      }
      return "rebased";
    },

    async currentSha() {
      return (await run(["rev-parse", "HEAD"])).stdout.trim();
    },

    async isAncestor(ancestor, descendant = "HEAD") {
      if (!/^[0-9a-f]{40}$/i.test(ancestor || "")) {
        throw new Error("invalid Git commit receipt");
      }
      const result = await run(["merge-base", "--is-ancestor", ancestor, descendant]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new Error(
        `could not verify local Git ancestry: ${redactToken(result.stderr.trim()) || `git merge-base exited ${result.code}`}`
      );
    },

    async hasUnpushedCommits(branch = "main") {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const result = await run(["rev-list", "--count", `origin/${branch}..HEAD`]);
      const count = Number.parseInt(result.stdout.trim(), 10);
      if (result.code !== 0 || !Number.isInteger(count) || count < 0) {
        throw new Error(
          `could not inspect unpushed Git commits: ${redactToken(result.stderr.trim()) || `git rev-list exited ${result.code}`}`
        );
      }
      return count > 0;
    },

    async init() {
      try {
        const stats = await filesystem.lstat(path.join(cwd, ".git"));
        const isSymbolicLink = stats.isSymbolicLink();
        if (isSymbolicLink || (!stats.isDirectory() && !stats.isFile())) {
          const kind = isSymbolicLink ? "symbolic link" : "special file";
          throw new Error(`Root .git metadata is a ${kind}; refusing to initialize Git.`);
        }
        if (!await repositoryRootMatchesCwd()) {
          throw new Error("Root .git metadata does not belong to this AIOS folder; refusing to initialize Git.");
        }
        // An existing repository (including a legitimate linked worktree)
        // needs no initialization. Avoid rewriting its Git metadata.
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const { code, stderr } = await run(["init", "-b", "main"]);
      if (code !== 0) throw new Error(`git init failed: ${redactToken(stderr.trim())}`);
    },

    async addRemote(url) {
      // Never persist a credential in .git/config — store the plain URL and let
      // the inline credential helper authenticate network ops.
      const plain = stripEmbeddedCredential(url);
      // idempotent: remove first if exists
      await run(["remote", "remove", "origin"]); // ignore exit code
      const { code, stderr } = await run(["remote", "add", "origin", plain]);
      if (code !== 0) throw new Error(`git remote add failed: ${redactToken(stderr.trim())}`);
    },

    raw: run
  };
}
