import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  regularFilePreimageMetadata,
  replaceFileIfUnchanged,
  sameRegularFile,
  validateManagedFilePath,
  writeFileSafe
} from "./files.mjs";
import { isSafeRegistryPathText, parseExternalSkillsKey } from "./skill-config-key.mjs";

const MAX_AGENT_REGISTRY_BYTES = 1024 * 1024;
const MAX_AGENT_REGISTRY_ENTRIES = 256;
const MAX_AGENT_FIELD_BYTES = 1024;
const MAX_AGENT_SKILL_TARGETS = 128;
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const EXACT_CANDIDATE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const require = createRequire(import.meta.url);
const bundledAgentRegistry = require("./agents.json");
const bundledPackageVersion = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
).version;

export const MANAGED_START = "<!-- dotaios-managed:start -->";
export const MANAGED_END = "<!-- dotaios-managed:end -->";
const MANAGED_BRIDGE_PLAN_FORMAT = "dotaios-managed-bridge-plan/v1";

// Locate one complete managed block. Malformed or reversed markers are not
// ownership proof, so callers must preserve the file instead of editing it.
//
// The marker pair is a parameter because the bridges are not the only writer
// that owns a delimited block inside a file it does not own: `dotaios import`
// owns one in the user's own context, project, and vault markdown. The rule for
// "do I own this?" must be answered in exactly one place, so both use this.
export function findManagedBlock(text, startMarker = MANAGED_START, endMarker = MANAGED_END) {
  const start = text.indexOf(startMarker);
  const endStart = text.indexOf(endMarker);
  if (
    start < 0
    || endStart < 0
    || start !== text.lastIndexOf(startMarker)
    || endStart !== text.lastIndexOf(endMarker)
    || start >= endStart
  ) return null;
  const end = endStart + endMarker.length;
  return { start, end, text: text.slice(start, end) };
}

export async function previewManagedBridgeFile(
  destination,
  generatedContent,
  { refreshOnly = false, merge = false, overwrite = false, boundaryRoot = null } = {}
) {
  const generatedBlock = findManagedBlock(generatedContent);
  if (!generatedBlock) {
    throw new Error("Generated bridge content is missing its managed block.");
  }

  let stats = null;
  if (boundaryRoot) {
    try {
      stats = await validateManagedFilePath(destination, boundaryRoot, {
        allowMissingParents: true
      });
    } catch (error) {
      const reason = /unsafe file destination/i.test(error.message)
        ? "existing bridge path is not a regular file"
        : error.message;
      return managedBridgePlan({
        destination,
        action: "unsafe-target",
        status: "blocked-conflict",
        current: null,
        next: null,
        stats: null,
        reason
      });
    }
  } else {
    try {
      stats = await fs.lstat(destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (!stats) {
    return managedBridgePlan({
      destination,
      action: refreshOnly ? "none" : "create",
      status: refreshOnly ? "not-managed" : "ready",
      current: null,
      next: refreshOnly ? null : generatedContent,
      stats: null,
      reason: refreshOnly ? "bridge-does-not-exist" : null
    });
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    return managedBridgePlan({
      destination,
      action: "unsafe-target",
      status: "blocked-conflict",
      current: null,
      next: null,
      stats,
      reason: "existing bridge path is not a regular file"
    });
  }

  const current = await fs.readFile(destination, "utf8");
  const after = await fs.lstat(destination);
  if (!sameRegularFile(after, stats)) {
    return managedBridgePlan({
      destination,
      action: "conflict",
      status: "blocked-conflict",
      current,
      next: null,
      stats: after,
      reason: "bridge changed while its preview was being read"
    });
  }

  const existingBlock = findManagedBlock(current);
  if (!existingBlock) {
    const hasMarker = current.includes(MANAGED_START) || current.includes(MANAGED_END);
    if (!hasMarker && !refreshOnly && overwrite) {
      return managedBridgePlan({
        destination,
        action: "replace-unmanaged",
        status: "ready",
        current,
        next: generatedContent,
        stats: after,
        reason: null
      });
    }
    if (!hasMarker && !refreshOnly && merge) {
      const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      return managedBridgePlan({
        destination,
        action: "append-managed-block",
        status: "ready",
        current,
        next: `${current}${separator}${generatedBlock.text}\n`,
        stats: after,
        reason: null
      });
    }
    return managedBridgePlan({
      destination,
      action: hasMarker ? "kept" : "none",
      status: hasMarker ? "blocked-conflict" : "not-managed",
      current,
      next: null,
      stats: after,
      reason: hasMarker ? "managed markers are malformed; existing file kept" : "existing file is not managed by DotAIOS"
    });
  }

  const next = `${current.slice(0, existingBlock.start)}${generatedBlock.text}${current.slice(existingBlock.end)}`;
  return managedBridgePlan({
    destination,
    action: next === current ? "none" : "update-managed-block",
    status: next === current ? "current" : "ready",
    current,
    next,
    stats: after,
    reason: null
  });
}

export async function applyManagedBridgeFile(
  destination,
  generatedContent,
  {
    dryRun = false,
    merge = false,
    overwrite = false,
    refreshOnly = false,
    expectedFingerprint = null,
    boundaryRoot = null,
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null
  } = {}
) {
  const plan = await previewManagedBridgeFile(destination, generatedContent, {
    refreshOnly,
    merge,
    overwrite,
    boundaryRoot
  });

  if (expectedFingerprint && plan.fingerprint !== expectedFingerprint) {
    return {
      action: "conflict",
      path: destination,
      note: "bridge changed after preview; left the current file untouched"
    };
  }
  if (plan.status === "blocked-conflict") {
    return { action: plan.action, path: destination, note: plan.reason };
  }
  if (plan.status === "not-managed") {
    return refreshOnly
      ? { action: "unchanged", path: destination, note: plan.reason }
      : { action: "kept", path: destination, note: "existing unmanaged file" };
  }
  if (plan.status === "current") return { action: "unchanged", path: destination };

  if (dryRun) {
    const action = plan.action === "create"
      ? "would create"
      : plan.action === "append-managed-block"
        ? "would append"
        : "would update";
    return { action, path: destination };
  }

  if (plan.action === "create") {
    const result = await writeFileSafe(destination, planNext(plan), "preserve", { boundaryRoot });
    return result.action === "created"
      ? result
      : { action: "kept", path: destination, note: "another file appeared after preview" };
  }

  const stats = planStats(plan);
  const replacement = await replaceFileIfUnchanged(destination, planCurrent(plan), planNext(plan), {
    boundaryRoot,
    beforeReplace,
    beforePublish,
    beforeCommit,
    expectedStats: stats,
    mode: stats.mode & 0o777
  });
  if (!replacement.replaced) {
    return {
      action: "conflict",
      path: destination,
      note: `bridge changed during bridge update; left the concurrent edit untouched${replacement.preservedPath ? ` and preserved the previous file at ${path.basename(replacement.preservedPath)}` : ""}`
    };
  }
  if (plan.action === "append-managed-block") {
    return {
      action: "appended",
      path: destination,
      note: "added the DotAIOS block below your existing instructions"
    };
  }
  return {
    action: "updated",
    path: destination,
    ...(replacement.preservedPath ? { note: `preserved the previous file at ${path.basename(replacement.preservedPath)}` } : {})
  };
}

function managedBridgePlan({ destination, action, status, current, next, stats, reason }) {
  const preimage = current == null ? "missing" : hashBridgeText(current);
  const nextDigest = next == null ? null : hashBridgeText(next);
  const preimageMetadata = regularFilePreimageMetadata(stats);
  const fingerprint = hashBridgeText(JSON.stringify({
    format: MANAGED_BRIDGE_PLAN_FORMAT,
    path: destination,
    action,
    status,
    preimage,
    preimage_metadata: preimageMetadata,
    next: nextDigest,
    reason
  }));
  const plan = {
    format: MANAGED_BRIDGE_PLAN_FORMAT,
    domain: "managed-bridges",
    target: { kind: "bridge-managed-block", path: destination },
    status,
    action,
    fingerprint,
    preimage_fingerprint: preimage,
    preimage_metadata: preimageMetadata,
    next_fingerprint: nextDigest,
    ...(reason ? { reason } : {})
  };
  Object.defineProperties(plan, {
    _current: { value: current },
    _next: { value: next },
    _stats: { value: stats }
  });
  return plan;
}

function planCurrent(plan) {
  return plan._current;
}

function planNext(plan) {
  return plan._next;
}

function planStats(plan) {
  return plan._stats;
}

function hashBridgeText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

// The canonical entrypoint every bridge points at. One front door for every agent.
export const AGENT_ENTRYPOINT = "AGENTS.md";

// Each agent record:
//   name    human label
//   detect  path under the user's home that exists when the tool is installed
//   bridge  path under the user's home where DotAIOS writes the bridge file
function normalizeAgent(raw) {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) return null;
  const bridge = raw.bridge == null
    ? null
    : (typeof raw.bridge === "string" && raw.bridge.trim() ? raw.bridge.trim() : null);
  if (raw.bridge != null && bridge == null) return null;
  const skills = normalizeSkills(raw.skills);
  return {
    name: raw.name.trim(),
    detect: typeof raw.detect === "string" && raw.detect.trim() ? raw.detect.trim() : raw.bridge,
    ...(typeof raw.command === "string" && raw.command.trim() ? { command: raw.command.trim() } : {}),
    bridge,
    ...(skills ? { skills } : {})
  };
}

function normalizeSkills(raw) {
  if (!raw || typeof raw !== "object") return null;
  const config = normalizeSkillTarget(raw, { relativeOnly: true });
  if (!config) return null;

  const project = normalizeSkillTarget(raw.project, { relativeOnly: true });
  return project ? { ...config, project } : config;
}

function normalizeSkillTarget(raw, { relativeOnly = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
  if (mode !== "symlink" && mode !== "config-external-dir") return null;

  const config = { mode };
  if (isSafeRegistryPathText(raw.dir)) {
    const dir = raw.dir.trim();
    if (!relativeOnly || isSafeRelativePath(dir)) config.dir = dir;
  }
  if (isSafeRegistryPathText(raw.configFile)) {
    const configFile = raw.configFile.trim();
    if (!relativeOnly || isSafeRelativePath(configFile)) config.configFile = configFile;
  }
  if (parseExternalSkillsKey(raw.key)) config.key = raw.key;

  if (mode === "symlink" && !config.dir) return null;
  if (mode === "config-external-dir" && (!config.configFile || !config.key)) return null;
  return config;
}

function isSafeRelativePath(value) {
  return !path.isAbsolute(value)
    && !/^[a-zA-Z]:[\\/]/.test(value)
    && !value.split(/[\\/]+/).includes("..");
}

export function normalizeAgentRegistry(data) {
  const list = Array.isArray(data?.agents) ? data.agents : [];
  return list.map(normalizeAgent).filter(Boolean);
}

export function resolveClaudeConfigRoot(homePath, { env = process.env } = {}) {
  const raw = typeof env?.CLAUDE_CONFIG_DIR === "string"
    ? env.CLAUDE_CONFIG_DIR
    : "";
  return raw !== "" && path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(homePath, ".claude");
}

export function isClaudeCodeAgent(agent) {
  return String(agent?.name || "").toLowerCase() === "claude code";
}

function claudeConfigPath(homePath, declaredPath, { env = process.env } = {}) {
  const normalized = String(declaredPath || "").replaceAll("\\", "/");
  if (normalized === ".claude") return resolveClaudeConfigRoot(homePath, { env });
  if (!normalized.startsWith(".claude/")) return path.join(homePath, declaredPath);
  return path.join(
    resolveClaudeConfigRoot(homePath, { env }),
    ...normalized.slice(".claude/".length).split("/")
  );
}

// Load the shipped agent registry, then merge any user-defined registry at
// <aiosPath>/agents.json. User entries with the same name override the
// defaults; new names are appended. This is how anyone adds a new AI tool
// without waiting for a code release.
export async function loadAgentRegistry(aiosPath) {
  const defaultValue = bundledAgentRegistry;
  assertAgentRegistryBounds(defaultValue);
  const defaults = normalizeAgentRegistry(defaultValue);

  if (!aiosPath) return defaults;
  const userValue = await readStrictRegistryJson(path.join(aiosPath, "agents.json"), { allowMissing: true });
  if (userValue) assertAgentRegistryBounds(userValue);
  const userRegistry = normalizeAgentRegistry(userValue || { agents: [] });
  if (userRegistry.length === 0) return defaults;

  const byName = new Map();
  for (const agent of defaults) byName.set(agent.name.toLowerCase(), agent);
  for (const agent of userRegistry) byName.set(agent.name.toLowerCase(), agent);
  const merged = [...byName.values()];
  const targets = new Set(
    merged
      .filter((agent) => agent.skills?.mode === "symlink")
      .map((agent) => agent.skills.dir)
  );
  if (targets.size > MAX_AGENT_SKILL_TARGETS) {
    throw new Error(`Agent registry exceeds the ${MAX_AGENT_SKILL_TARGETS}-target bound.`);
  }
  return merged;
}

function assertAgentRegistryBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.agents)) {
    throw new Error("Agent registry must contain an agents array.");
  }
  if (value.agents.length > MAX_AGENT_REGISTRY_ENTRIES) {
    throw new Error(`Agent registry exceeds the ${MAX_AGENT_REGISTRY_ENTRIES}-entry bound.`);
  }
  for (const raw of value.agents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const values = [raw.name, raw.detect, raw.command, raw.bridge];
    for (const target of [raw.skills, raw.skills?.project]) {
      if (!target || typeof target !== "object" || Array.isArray(target)) continue;
      values.push(target.mode, target.dir, target.configFile, target.key);
    }
    if (values.some((field) => (
      typeof field === "string" && Buffer.byteLength(field, "utf8") > MAX_AGENT_FIELD_BYTES
    ))) throw new Error(`Agent registry field exceeds the ${MAX_AGENT_FIELD_BYTES}-byte bound.`);
  }
}

async function readStrictRegistryJson(filePath, { allowMissing = false } = {}) {
  let before;
  try {
    before = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error("Agent registry must be a single-link regular file.");
  }
  if (before.size > BigInt(MAX_AGENT_REGISTRY_BYTES)) {
    throw new Error(`Agent registry exceeds the ${MAX_AGENT_REGISTRY_BYTES}-byte bound.`);
  }
  const handle = await fs.open(filePath, "r");
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) throw new Error("Agent registry changed while opening.");
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== bytes.length
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
    ) throw new Error("Agent registry changed while reading.");
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw new Error("Agent registry is not valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Agent registry is not valid JSON.");
  }
}

export function bridgePath(homePath, agent, { env = process.env } = {}) {
  if (!agent.bridge) return null;
  return isClaudeCodeAgent(agent)
    ? claudeConfigPath(homePath, agent.bridge, { env })
    : path.join(homePath, agent.bridge);
}

function detectPaths(homePath, agent, { env = process.env } = {}) {
  if (!isClaudeCodeAgent(agent)) return [path.join(homePath, agent.detect)];
  const selected = claudeConfigPath(homePath, agent.detect, { env });
  const fallback = path.join(homePath, agent.detect);
  return selected === fallback ? [selected] : [selected, fallback];
}

// A declared command is the strongest signal on a fresh host, before the
// client creates its configuration directory.
export async function isAgentInstalled(
  homePath,
  agent,
  { env = process.env, platform = process.platform } = {}
) {
  if (agent.command && await isCommandAvailable(agent.command, { env, platform })) return true;
  for (const candidate of detectPaths(homePath, agent, { env })) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      // Try the next exact detection path. Claude may have a selected root and
      // a legacy default root, but activation writes only the selected root.
    }
  }
  return false;
}

async function findCommandsOnPath(
  command,
  { env = process.env, platform = process.platform } = {}
) {
  const pathValue = env.PATH || env.Path || env.path || "";
  const explicitPath = path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const directories = explicitPath ? [""] : pathValue.split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32" && !path.extname(command)
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  const matches = [];
  const seen = new Set();
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = explicitPath
        ? `${command}${extension}`
        : path.join(directory, `${command}${extension}`);
      try {
        await fs.access(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if ((await fs.stat(candidate)).isFile() && !seen.has(candidate)) {
          seen.add(candidate);
          matches.push(candidate);
        }
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return matches;
}

async function findCommandOnPath(command, options = {}) {
  return (await findCommandsOnPath(command, options))[0] || null;
}

function isExecutionLocalCommandShim(commandPath) {
  const binDirectory = path.dirname(commandPath);
  return path.basename(binDirectory).toLowerCase() === ".bin"
    && path.basename(path.dirname(binDirectory)).toLowerCase() === "node_modules";
}

export async function isCommandAvailable(command, options = {}) {
  return Boolean(await findCommandOnPath(command, options));
}

export async function inspectDotaiosOnPath({
  env = process.env,
  platform = process.platform
} = {}) {
  // npm exec and local package runners prepend node_modules/.bin to PATH. Those
  // shims are the running candidate, not a persistent CLI installation, so keep
  // scanning for the separate global installation doctor is meant to report.
  const commandPath = (await findCommandsOnPath("dotaios", { env, platform }))
    .find((candidate) => !isExecutionLocalCommandShim(candidate));
  if (!commandPath) return { status: "missing", ownership: "none" };

  const unknown = () => ({
    status: "unknown",
    ownership: "unowned",
    command_path: commandPath
  });

  try {
    const linkStats = await fs.lstat(commandPath);
    if (!linkStats.isSymbolicLink()) return unknown();

    const resolvedPath = await fs.realpath(commandPath);
    const entrypointStats = await fs.stat(resolvedPath);
    if (!entrypointStats.isFile()) return unknown();

    const packageRoot = path.resolve(path.dirname(resolvedPath), "../../..");
    const expectedEntrypoint = path.join(packageRoot, "packages", "cli", "src", "index.mjs");
    if (
      path.resolve(resolvedPath) !== expectedEntrypoint
      || path.basename(packageRoot) !== "dotaios"
      || path.basename(path.dirname(packageRoot)) !== "node_modules"
    ) return unknown();

    const packagePath = path.join(packageRoot, "package.json");
    const manifest = await readBoundedPackageManifest(packagePath);
    if (
      manifest?.name !== "dotaios"
      || typeof manifest.version !== "string"
      || !EXACT_CANDIDATE_VERSION.test(manifest.version)
      || manifest.bin?.dotaios !== "packages/cli/src/index.mjs"
    ) return unknown();

    const declaredEntrypoint = await fs.realpath(path.resolve(packageRoot, manifest.bin.dotaios));
    if (declaredEntrypoint !== resolvedPath) return unknown();

    return {
      status: "owned",
      ownership: "owned",
      command_path: commandPath,
      resolved_path: resolvedPath,
      package_path: packagePath,
      version: manifest.version
    };
  } catch {
    return unknown();
  }
}

async function readBoundedPackageManifest(filePath) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || before.size > BigInt(MAX_PACKAGE_MANIFEST_BYTES)
  ) return null;

  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) return null;

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== bytes.length
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
    ) return null;

    const text = STRICT_UTF8.decode(bytes);
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function readPackageVersion() {
  try {
    const raw = await fs.readFile(new URL("../../../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version || null;
  } catch {
    return null;
  }
}

// How a managed surface spells "run this DotAIOS candidate". PATH is not an
// authority for package identity: a global binary may be older than the package
// rendering the surface. Always pin the running package, and fail closed rather
// than silently selecting unreviewed npm code when its version is unreadable.
export async function resolveCliInvocation({
  version,
  platform = process.platform
} = {}) {
  const pinned = version === undefined ? await readPackageVersion() : version;
  return exactCliInvocation(pinned, { platform });
}

export function exactCandidatePackage(version) {
  if (typeof version !== "string" || !EXACT_CANDIDATE_VERSION.test(version)) {
    throw new Error("Could not read the running DotAIOS package version; refusing to emit an unpinned command.");
  }
  return `dotaios@${version}`;
}

export function isExactCandidatePackageSpec(value) {
  if (typeof value !== "string" || !value.startsWith("dotaios@")) return false;
  try {
    return exactCandidatePackage(value.slice("dotaios@".length)) === value;
  } catch {
    return false;
  }
}

export function npxExecutable({ platform = process.platform } = {}) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export function exactCliInvocation(version, options = {}) {
  return `${npxExecutable(options)} ${exactCandidatePackage(version)}`;
}

export function bundledCliInvocation(options = {}) {
  return exactCliInvocation(bundledPackageVersion, options);
}

function assertExactCandidateInvocation(cli) {
  const match = /^(?:npx|npx\.cmd) (dotaios@[^\s]+)$/.exec(cli || "");
  if (
    typeof cli !== "string"
    || !match
    || !isExactCandidatePackageSpec(match[1])
  ) {
    throw new Error("Managed bridges require an exact candidate DotAIOS invocation.");
  }
  return cli;
}

// The one spelling of "this bridge points at this AIOS folder". The writer
// emits `current`; a reader must accept every form in `accepted`, because
// bridges written by older releases are still valid. Both sides share this
// because they had drifted apart into a pure string comparison neither owned.
//
// The pointer names the folder in prose and never as `@<path>`. Hosts that
// support `@` expand it while loading the file, so an @-reference in a
// user-global bridge is not a pointer at all: it imports the whole folder
// router into every session, in every directory, for every request.
//
// `accepted` answers "is this one of ours?" and `current` answers "is this the
// one we write today?". They are different questions and a reader that only
// asks the first calls a stale bridge healthy: `accepted` deliberately includes
// retired spellings so activation and upgrade can recognize an owned bridge
// before refreshing it. Callers that report health must ask both.
export function bridgePointer(aiosPath) {
  const entrypoint = path.join(aiosPath, AGENT_ENTRYPOINT);
  const current = `DotAIOS keeps the user's personal context in a folder at ${aiosPath} (entrypoint: ${entrypoint}).`;
  // Older releases wrote these. Activation and the upgrade bridge target both
  // recognize them, so the installed file remains attributable until refresh.
  const retired = [
    `@${entrypoint}`,
    `DotAIOS entrypoint (read this file first): ${entrypoint}`,
    `Read ${entrypoint} first.`
  ];
  return { entrypoint, current, retired, accepted: [current, ...retired] };
}

// The managed block itself: a pointer to the AIOS folder and the rule for when
// to open it, not the folder's contents. Every host loads this file on every
// launch, so a session in an unrelated repository must end up with the path and
// the rule, and nothing else. When `skillsFirst` is true the skill catalog
// (INDEX.md + RESOLVER.md) is INLINED instead of pointed at, for agents that do
// not follow file references at all (headless fleet workers, MCP-only clients,
// browser-paste users). Default stays pointer-mode.
//
// The block is identical for every agent — only the file header around it names
// one. It lives here, alone, because `connect gemini` splices the same markers
// into the same file `activate` writes: a second body meant whichever command
// ran last silently replaced the other's.
export async function bridgeManagedBlock(aiosPath, { skillsFirst = false, skillsCatalog, cli } = {}) {
  const { current: pointerLine } = bridgePointer(aiosPath);
  const skillsIndex = path.join(aiosPath, "skills", "INDEX.md");
  const resolver = path.join(aiosPath, "skills", "RESOLVER.md");
  // Never a bare command name: see resolveCliInvocation.
  const dotaios = assertExactCandidateInvocation(cli ?? await resolveCliInvocation());

  const lines = [
    MANAGED_START,
    pointerLine,
    "Choose memory access for this session before any AIOS read:",
    "- `Private chat` locks `Memory: Off`: keep AIOS closed — no DotAIOS read, search, save, or capture. Say once that the host may keep its history.",
    `- In an attached working directory, or after \`Only this project\`, use \`Memory: This project\` and exclude all other memory. If not registered, keep AIOS closed, say so, offer \`${dotaios} activate\`, and never fall back to Shared. Only after registration and exact identity are verified, read AGENTS.md and run \`${dotaios} brief --compact --memory project --project <slug-or-id>\`.`,
    `- When the user asks \`Use my memory\`, use \`Memory: Shared\`; this is the default elsewhere. Only in Shared, read AGENTS.md and run \`${dotaios} brief --compact --memory shared\`.`,
    "Lead every response with the selected receipt: `Memory: Shared`, `Memory: This project`, or `Memory: Off`.",
    "Route events, signals, and saved sessions only through the canonical bounded projection."
  ];

  if (skillsFirst) {
    const [indexText, resolverText] = await Promise.all([
      skillsCatalog?.indexText ?? readCatalogFile(skillsIndex),
      skillsCatalog?.resolverText ?? readCatalogFile(resolver)
    ]);
    lines.push("");
    lines.push("## Skills first (inlined during DotAIOS activation)");
    lines.push("");
    lines.push("Match the user's intent to a skill below, then open that skill's SKILL.md before acting. If nothing fits, hand-roll the work and offer to skillify a repeat.");
    lines.push("");
    if (indexText) {
      lines.push("### Skills index", "", indexText.trim(), "");
    }
    if (resolverText) {
      lines.push("### Skill resolver", "", resolverText.trim(), "");
    }
  } else {
    // A path, not a catalog. Skills are linked into each host's native skills
    // directory, but the routing table is what turns "do the thing I always do"
    // into the right workflow, and only this line says where it lives.
    lines.push(`Skill routing: ${resolver} maps a request to one of the user's saved workflows; read it when a request looks like one, then open that SKILL.md before acting.`);
  }

  lines.push("Optional MCP: the adapter exposes exactly `read_working_context`, `search_aios`, and `resolve_skill`; it has no compatibility aliases.");
  lines.push(MANAGED_END);

  return lines.join("\n");
}

// The whole bridge file for one agent: the shared managed block under a header
// that names the host. Only the header differs between agents.
export async function bridgeContent(agent, aiosPath, options = {}) {
  const managedBlock = options.managedBlock ?? await bridgeManagedBlock(aiosPath, options);
  return [
    `# DotAIOS ${agent.name} Bridge`,
    "",
    managedBlock,
    ""
  ].join("\n");
}

async function readCatalogFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
