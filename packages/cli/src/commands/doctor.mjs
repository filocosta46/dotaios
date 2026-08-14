import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { SETUP_TRANSACTION_FILE, defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { pathExists, readJson } from "../../../core/src/files.mjs";
import { previewMigration } from "../../../core/src/migrations.mjs";
import {
  MANAGED_END,
  MANAGED_START,
  bridgePath,
  bridgePointer,
  findManagedBlock,
  isAgentInstalled,
  loadAgentRegistry
} from "../../../core/src/bridges.mjs";
import { USER_MAINTAINED_CONTEXT_FILES } from "../../../core/src/memory-audit.mjs";
import { inspectSkillHealth } from "../../../core/src/skill-health.mjs";
import { checkForUpdate } from "../adapters/npm-registry.mjs";
import { hasHelpFlag, parsePathHomeOptions } from "../lib/args.mjs";

const MIN_NODE_MAJOR = 20;
// Read defensively at load: a health check must never be the thing that
// crashes. An unreadable package.json degrades to an unknown version, which
// the update check then skips rather than failing on.
function readInstalledVersion() {
  try {
    return JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
    ).version || null;
  } catch {
    return null;
  }
}

const INSTALLED_VERSION = readInstalledVersion();

const HELP_TEXT = `Usage:
  dotaios doctor [options]

One-stop health check. Looks at Node version, terminal, the AIOS folder,
agent bridges, and prints one line per check so a non-technical user can
follow along.

Options:
  --path <dir>  Check an AIOS folder other than ~/aios
  --home <dir>  Check agent bridges somewhere other than your home
  --verbose     Show paths and operator-level diagnostic detail
`;

export async function doctorCommand(args, { detection } = {}) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const verbose = args.includes("--verbose");
  const options = parsePathHomeOptions(args.filter((arg) => arg !== "--verbose"));
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const homePath = path.resolve(expandHome(options.home || os.homedir()));

  const checks = [];

  checks.push(checkNodeVersion());
  checks.push(checkTerminal());
  checks.push(await checkAiosFolder(target));
  checks.push(await checkUnfinishedSetup(target));
  checks.push(await checkAiosConfig(target));
  checks.push(await checkSecretBoundary(target));
  checks.push(checkTrackedGitlinks(target));
  checks.push(await checkMemoryHealth(target));
  checks.push(await checkContextFreshness(target));
  checks.push(await checkLatestVersion({ currentVersion: INSTALLED_VERSION }));
  checks.push(...await checkAgentBridges(target, homePath, detection, { verbose }));

  console.log("DotAIOS doctor");
  console.log("");
  for (const rawCheck of checks) {
    const check = verbose ? rawCheck : conciseDoctorCheck(rawCheck);
    const display = (value) => verbose ? String(value || "") : humanizeDoctorPath(value, target, homePath);
    console.log(`${tag(check.status)} ${display(check.name)}`);
    if (check.detail) console.log(`        ${display(check.detail)}`);
    if (check.fix) console.log(`        Fix: ${display(check.fix)}`);
  }

  console.log("");
  console.log("Using another local AI tool that can read files? Paste this line into it:");
  console.log(`  Read ${verbose ? path.join(target, "AGENTS.md") : humanizeDoctorPath(path.join(target, "AGENTS.md"), target, homePath)} first and follow it.`);
  console.log("  Browser chats need an attached file or a pasted, reviewed brief.");
  console.log("");

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");

  if (failed.length === 0 && warned.length === 0) {
    console.log("Everything looks good. Ask Claude Code: \"What am I working on?\"");
    return;
  }

  if (failed.length > 0) {
    console.log(`Found ${failed.length} blocking issue(s). Fix those first, then run \`dotaios doctor\` again.`);
    process.exitCode = 1;
  } else {
    console.log(`Found ${warned.length} warning(s). DotAIOS works, but consider the fixes above.`);
  }
}

const STATUS_TAGS = { ok: "[ok]", warn: "[warn]", fail: "[fail]" };

function tag(status) {
  return STATUS_TAGS[status] || "[fail]";
}

export async function checkSecretBoundary(target, {
  platform = process.platform,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
  fileSystem = fs
} = {}) {
  const name = "Local secret file is private and outside memory";
  const secretPath = path.join(target, ".env");
  let stats;
  try {
    stats = await fileSystem.lstat(secretPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { name, status: "ok", detail: "No local .env file is present." };
    }
    return {
      name,
      status: "fail",
      detail: "The local .env file could not be inspected safely.",
      fix: "Keep credentials in provider-owned auth or a password manager; otherwise replace .env with a private regular file."
    };
  }

  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    return {
      name,
      status: "fail",
      detail: ".env must be one ordinary local file, never a link or shared hard link.",
      fix: "Remove the linked .env and create a private local regular file instead."
    };
  }
  if (platform !== "win32" && (stats.mode & 0o077) !== 0) {
    return {
      name,
      status: "fail",
      detail: ".env can be read or changed by another local account.",
      fix: "Run `chmod 600 <aios-folder>/.env`, then run `dotaios doctor` again."
    };
  }
  if (platform !== "win32" && currentUid !== null && stats.uid !== currentUid) {
    return {
      name,
      status: "fail",
      detail: ".env is owned by another local account.",
      fix: "Replace .env with a private file owned by your current account, then run `dotaios doctor` again."
    };
  }
  if (platform === "win32") {
    return {
      name,
      status: "warn",
      detail: ".env is a local regular file and is excluded from memory, but DotAIOS did not verify its Windows ACL privacy.",
      fix: "Review the file's Windows Security permissions so only your account can read it, or keep credentials in provider-owned auth or Windows Credential Manager."
    };
  }
  return {
    name,
    status: "ok",
    detail: ".env is a private local file; search, MCP, and sync exclude it."
  };
}

// A gitlink (mode 160000) records another repository's commit id instead of the
// files themselves, so every clone of this AIOS folder gets an empty directory
// where the content appears to be, and nothing reports the loss. The sync
// guards refuse to write new gitlinks but cannot see ones already committed.
export function checkTrackedGitlinks(target, { runGit = readGitIndex } = {}) {
  const name = "No nested Git repositories tracked in the AIOS folder";
  const index = runGit(target);
  if (index.kind === "not-a-repo") {
    return { name, status: "ok", detail: "Folder is not a Git repository; nothing to check." };
  }
  // Anything else — git missing, index too large for the buffer, a timeout —
  // means the check did not run. Reporting that as a pass would state a
  // specific thing we did not verify, on the folders most likely to have
  // accumulated a vendored repository.
  if (index.kind === "unavailable") {
    return {
      name,
      status: "warn",
      detail: `Could not read the Git index (${index.reason}); this check did not run.`,
      fix: "Ensure `git` is installed and the folder is readable, then re-run `dotaios doctor`."
    };
  }

  const gitlinks = index.entries
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter(Boolean);
  if (gitlinks.length === 0) return { name, status: "ok" };

  return {
    name,
    status: "warn",
    detail: `${gitlinks.length} path(s) are committed as pointers to another repository, so a clone of this folder gets them empty: ${gitlinks.join(", ")}.`,
    fix: `Remove the pointer and re-add the files, for each path: \`git rm --cached <path>\`, delete the nested \`.git\` directory inside it, then \`git add <path>\`.`
  };
}

function readGitIndex(target) {
  // -z turns off git's octal quoting of non-ASCII paths, so a reported path can
  // be pasted straight into the suggested `git rm --cached` fix. The buffer is
  // raised well past spawnSync's 1MB default, which a folder of a few thousand
  // tracked files already exceeds.
  const result = spawnSync("git", ["-C", target, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    return { kind: "unavailable", reason: result.error.code || "git could not be run" };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "");
    if (/not a git repository/i.test(stderr)) return { kind: "not-a-repo" };
    return { kind: "unavailable", reason: stderr.trim().split("\n")[0] || `git exited ${result.status}` };
  }
  return { kind: "index", entries: result.stdout || "" };
}

function checkNodeVersion() {
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { name: `Node.js ${raw}`, status: "ok" };
  }
  return {
    name: `Node.js ${raw}`,
    status: "fail",
    detail: `DotAIOS needs Node.js ${MIN_NODE_MAJOR} or newer.`,
    fix: "Install Node.js from https://nodejs.org (pick the LTS download)."
  };
}

function checkTerminal() {
  if (process.stdin.isTTY) {
    return { name: "Running in a real Terminal", status: "ok" };
  }
  return {
    name: "Running in a real Terminal",
    status: "warn",
    detail: "Some commands need an interactive terminal (init, interview).",
    fix: "Open the Terminal app on Mac (cmd+space → Terminal) or 'cmd' on Windows, then re-run."
  };
}

async function checkAiosFolder(target) {
  if (await pathExists(target)) {
    return { name: `AIOS folder at ${target}`, status: "ok" };
  }
  return {
    name: `AIOS folder at ${target}`,
    status: "fail",
    detail: "No folder found at this path.",
    fix: "Run `npx dotaios setup` to create it."
  };
}

async function checkUnfinishedSetup(target) {
  if (!await pathExists(path.join(target, SETUP_TRANSACTION_FILE))) {
    return { name: "Setup completed", status: "ok" };
  }
  return {
    name: "Setup completed",
    status: "fail",
    detail: "An unfinished setup still owns this folder, so its files may be incomplete.",
    fix: `Run \`npx dotaios setup${pathOptionFor(target)}\` again to finish it.`
  };
}

async function checkAiosConfig(target) {
  const configPath = path.join(target, "aios.json");
  const config = await readJson(configPath, null);
  if (!config) {
    return {
      name: "aios.json present",
      status: "fail",
      detail: "Config file missing or unreadable.",
      fix: "Run `npx dotaios init --force` to add missing base files."
    };
  }
  const tools = (config.ai_tools || []).join(", ") || "none";
  let migration;
  try {
    migration = await previewMigration({ aiosPath: target });
  } catch (error) {
    return {
      name: "aios.json schema compatibility",
      status: "fail",
      detail: error.message,
      fix: "Install a DotAIOS release that supports this folder schema. This build will not write it."
    };
  }
  if (migration.status === "recovery_required") {
    return {
      name: "aios.json migration transaction",
      status: "fail",
      detail: `Interrupted plan: ${migration.transaction_ids.join(", ")}`,
      fix: `Run \`npx dotaios migrate --recover${pathOptionFor(target)}\`.`
    };
  }
  if (migration.status === "ready") {
    return {
      name: "aios.json schema update",
      status: "warn",
      detail: `schema ${migration.plan.from_schema_version} → ${migration.plan.to_schema_version}, plan ${migration.plan.plan_id}`,
      fix: `Run \`npx dotaios migrate${pathOptionFor(target)}\` to preview it.`
    };
  }
  return {
    name: "aios.json present",
    status: "ok",
    detail: `schema ${config.schema_version || "?"}, ai_tools: ${tools}`
  };
}

const MAINTENANCE_LOOKBACK_DAYS = 90;

// Maintenance receipts are the only per-file evidence of what auto-maintenance
// did. Read them by hand: the shared JSONL reader quarantines corrupt lines by
// WRITING a .bad.jsonl sidecar, and a health check must not mutate the folder
// it inspects — nor race the maintenance it is auditing.
async function readMaintenanceReceipts(eventsPath, sinceMs) {
  let content;
  try {
    content = await fs.readFile(eventsPath, "utf8");
  } catch {
    return [];
  }
  const receipts = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // The quarantine check already reports unparseable lines.
    }
    if (entry?.type !== "memory.maintenance") continue;
    const ts = Date.parse(entry.ts);
    if (Number.isFinite(ts) && ts < sinceMs) continue;
    receipts.push(entry);
  }
  return receipts;
}

/**
 * Memory health: corrupt-line quarantine counts, last compaction time, archive
 * size, live signal count, and — the point of the check — whether
 * auto-maintenance has been removing signal files without archiving them.
 *
 * The unarchived-removal verdict is receipt-driven, not directory-driven: a
 * stale archive left over from six months ago must not certify today's
 * deletions as fine. Receipts are per-file evidence; a directory is not.
 * It also means this check hardcodes nothing about where the archive lives.
 *
 * Exported so the safety tests can drive it directly.
 */
export async function checkMemoryHealth(target) {
  const memoryDir = path.join(target, "memory");
  const eventsPath = path.join(memoryDir, "events.jsonl");
  if (!await pathExists(eventsPath)) {
    return { name: "Memory health", status: "ok", detail: "No events log yet — nothing to check." };
  }

  const quarantineFiles = [
    `${eventsPath}.bad.jsonl`,
    `${path.join(memoryDir, "events-archive.jsonl")}.bad.jsonl`,
    `${path.join(memoryDir, "signals-archive.jsonl")}.bad.jsonl`
  ];
  let signalFiles = 0;
  try {
    const signalsDir = path.join(memoryDir, "signals");
    for (const name of await fs.readdir(signalsDir)) {
      // .bad.jsonl also ends in .jsonl, so it must be tested first.
      if (name.endsWith(".bad.jsonl")) quarantineFiles.push(path.join(signalsDir, name));
      else if (name.endsWith(".jsonl")) signalFiles += 1;
    }
  } catch {
    // No signals dir yet.
  }

  let badTotal = 0;
  const badDetails = [];
  for (const file of quarantineFiles) {
    try {
      const lines = (await fs.readFile(file, "utf8")).split("\n").filter((line) => line.trim()).length;
      if (lines > 0) {
        badTotal += lines;
        badDetails.push(`${path.basename(file)}: ${lines}`);
      }
    } catch {
      // Missing quarantine file — clean.
    }
  }

  let lastCompaction = "never";
  try {
    const state = JSON.parse(await fs.readFile(path.join(memoryDir, ".maintenance.json"), "utf8"));
    if (state.lastRun) lastCompaction = new Date(state.lastRun).toISOString();
  } catch {
    // No maintenance state yet.
  }

  let archiveBytes = 0;
  for (const name of ["events-archive.jsonl", "signals-archive.jsonl"]) {
    try {
      archiveBytes += (await fs.stat(path.join(memoryDir, name))).size;
    } catch {
      // That archive does not exist yet.
    }
  }

  const receipts = await readMaintenanceReceipts(
    eventsPath,
    Date.now() - MAINTENANCE_LOOKBACK_DAYS * 86_400_000
  );
  let unarchivedRemovals = 0;
  for (const entry of receipts) {
    const removed = Number(entry.signal_files_removed) || 0;
    const archived = Number(entry.signal_files_archived) || 0;
    if (removed > archived) unarchivedRemovals += removed - archived;
  }

  const detail = `${badTotal} bad line(s)${badDetails.length > 0 ? ` (${badDetails.join(", ")})` : ""}, ${signalFiles} signal file(s), last compaction: ${lastCompaction}, archive: ${(archiveBytes / 1024).toFixed(1)} KB`;
  if (badTotal > 0) {
    return {
      name: "Memory health",
      status: "warn",
      detail,
      fix: "Corrupt lines are preserved in the .bad.jsonl file(s) next to their source — review and clean them up."
    };
  }
  if (unarchivedRemovals > 0) {
    return {
      name: "Memory health",
      status: "warn",
      detail: `${detail}. ${unarchivedRemovals} signal file(s) were removed without an archive in the last ${MAINTENANCE_LOOKBACK_DAYS} days.`,
      fix: "Those signals were deleted by DotAIOS 1.26 or earlier and cannot be recovered here — restore them from a backup or your sync repository if you need them. Releases from 1.27 archive signals to memory/signals-archive.jsonl instead."
    };
  }
  return { name: "Memory health", status: "ok", detail };
}

// One quarter. Short enough that a file describing finished work gets caught,
// long enough that a steady month never trains the user to ignore doctor.
const CONTEXT_STALE_DAYS = 90;

/**
 * Freshness of the files the user (or an agent for them) writes. mtime only —
 * this check never opens a file. Comparing mtimeMs against Date.now() keeps it
 * in UTC milliseconds, so there are no date strings, no local-time parsing and
 * no DST hazard; ages floor to whole days and clamp at 0 so clock skew or a
 * restored backup prints "0 day(s)" rather than a negative number.
 *
 * Generated files are excluded on purpose: warning that a template DotAIOS
 * itself wrote has not changed is noise, and noise is how you get a check
 * nobody reads.
 */
export async function checkContextFreshness(target, { staleDays = CONTEXT_STALE_DAYS, now = Date.now } = {}) {
  const nowMs = now();
  const ages = await Promise.all(USER_MAINTAINED_CONTEXT_FILES.map(async (relative) => {
    try {
      const stats = await fs.stat(path.join(target, relative));
      return { relative, days: Math.max(0, Math.floor((nowMs - stats.mtimeMs) / 86_400_000)) };
    } catch {
      return null; // Absent files are the folder check's business, not this one.
    }
  }));

  const present = ages.filter(Boolean);
  if (present.length === 0) {
    return { name: "Context freshness", status: "ok", detail: "No context files yet — nothing to check." };
  }

  const stale = present.filter((file) => file.days > staleDays).sort((a, b) => b.days - a.days);
  if (stale.length === 0) {
    const newest = Math.min(...present.map((file) => file.days));
    return {
      name: "Context freshness",
      status: "ok",
      detail: `${present.length} context file(s), most recent edit ${newest} day(s) ago.`
    };
  }

  return {
    name: "Context freshness",
    status: "warn",
    detail: `Unchanged for over ${staleDays} days: ${stale.map((file) => `${file.relative} (${file.days} day(s))`).join(", ")}.`,
    fix: "Tell your agent what changed, or run `npx dotaios@latest interview --review`. The `memory-maintenance` skill retires claims that stopped being true."
  };
}

/**
 * Is a newer DotAIOS published? Foreground-only, runs solely because the user
 * asked for a health check. Never fails the check when the network is down or
 * the user opted out — an offline machine is not an unhealthy one.
 * Exported so tests can drive it with an injected fetch.
 */
export async function checkLatestVersion({ currentVersion, fetchImpl, timeoutMs, env } = {}) {
  const result = await checkForUpdate({ currentVersion, fetchImpl, timeoutMs, env });

  if (result.updateAvailable) {
    return {
      name: "DotAIOS version",
      status: "warn",
      detail: `${result.current} installed, ${result.latest} available.`,
      fix: `Inspect \`npm view dotaios@${result.latest} version dist.integrity dist.tarball gitHead scripts dependencies\`, then run the exact reviewed release as \`npx dotaios@${result.latest} <command>\`.`
    };
  }

  const installed = result.current ? `${result.current} installed` : "installed version unknown";

  if (result.skipped) {
    return {
      name: "DotAIOS version",
      status: "ok",
      detail: `${installed}, ${skipReason(result.skipped)}.`
    };
  }

  return { name: "DotAIOS version", status: "ok", detail: `${installed}, up to date.` };
}

// Say what actually happened — an unreadable version is not a network problem.
function skipReason(skipped) {
  if (skipped === "disabled") return "update check disabled (DOTAIOS_NO_UPDATE_CHECK)";
  if (skipped === "timeout" || skipped === "unreachable" || String(skipped).startsWith("status-")) {
    return "could not reach the npm registry — skipped, working offline is fine";
  }
  return "update check unavailable";
}

async function checkAgentBridges(target, homePath, detection = {}, { verbose = false } = {}) {
  const results = [];
  let foundBridge = false;
  let foundNativeRuntime = false;
  let anyInstalled = false;

  const registry = await loadAgentRegistry(target);
  const runtimes = await readNativeRuntimes(target, homePath, detection);
  for (const agent of registry) {
    if (!await isAgentInstalled(homePath, agent, detection)) {
      if (verbose) {
        results.push({
          name: `${agent.name} (not installed)`,
          status: "ok",
          detail: "Not detected on this machine — nothing to connect."
        });
      }
      continue;
    }
    anyInstalled = true;

    if (!agent.bridge) {
      const verdict = nativeRuntimeCheck(agent, target, runtimes);
      results.push(verdict);
      // Only a runtime that really is configured counts as something being
      // connected. Counting an unconfigured one here suppressed the
      // "At least one AI tool connected" warning below.
      if (verdict.status === "ok") foundNativeRuntime = true;
      continue;
    }

    const filePath = bridgePath(homePath, agent) || path.join(homePath, agent.detect);
    let content;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: `${agent.name} is installed but not connected yet (no bridge at ${filePath}).`,
        fix: "Run `npx dotaios activate`."
      });
      continue;
    }

    const managedBlock = findManagedBlock(content);
    const { entrypoint, current, retired, accepted } = bridgePointer(target);
    const managedLines = managedBlock?.text.split(/\r?\n/) || [];
    const hasExactPointer = accepted.some((pointer) => managedLines.includes(pointer));
    if (hasExactPointer) {
      if (managedBlock.text.includes("read_session_digest")) {
        results.push({
          name: `${agent.name} bridge`,
          status: "warn",
          detail: "Managed bridge predates v1.23 and still calls the retired read_session_digest surface.",
          fix: `Run \`${repointCommand(target)}\` to refresh it.`
        });
      } else if (!await pathExists(entrypoint)) {
        // The pointer is right and the file it names is gone. This needs its own
        // branch: falling through to the repoint case below would call a correct
        // pointer wrong and hand the user a command that cannot restore the file.
        results.push({
          name: `${agent.name} bridge`,
          status: "warn",
          detail: `Bridge points at this AIOS folder, but its entrypoint is missing (${entrypoint}).`,
          fix: `Run \`npx dotaios init${pathOptionFor(target)}\` to restore the missing base files.`
        });
      } else if (!managedLines.includes(current)) {
        // Ours, and pointing at the right folder, but written by an older
        // release. Accepting the spelling is what keeps an upgrade from turning
        // every installed bridge red; reporting it healthy is what stopped the
        // fix from ever reaching anyone already installed. `activate` is the
        // only thing that rewrites the block, and nothing else asks them to.
        //
        // Only the `@` spelling is expanded by the host, so only it costs the
        // user the whole folder on every request. The other retired spellings
        // are prose and merely out of date; saying otherwise would be false.
        const stale = retired.filter((pointer) => managedLines.includes(pointer));
        results.push({
          name: `${agent.name} bridge`,
          status: "warn",
          detail: stale.some((pointer) => pointer.startsWith("@"))
            ? "Bridge is from an older version and still loads your whole AIOS folder into every session."
            : "Bridge is from an older version and does not match what this release writes.",
          fix: `Run \`${refreshCommand(target)}\` to update it.`
        });
      } else {
        results.push({ name: `${agent.name} bridge`, status: "ok" });
      }
      // The bridge does point here, so the aggregate "nothing is connected"
      // warning would be a second, less specific report of the same fact.
      foundBridge = true;
    } else if (managedBlock) {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: "Bridge points to a different AIOS folder.",
        fix: `Run \`${repointCommand(target)}\` to repoint.`
      });
    } else if (content.includes(MANAGED_START) || content.includes(MANAGED_END)) {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: "Managed bridge markers are malformed; DotAIOS preserved the file.",
        fix: `Inspect ${filePath}, remove or repair only the malformed DotAIOS marker lines, then run \`npx dotaios activate --path ${target}\`.`
      });
    } else {
      results.push({
        name: `${agent.name} bridge`,
        status: "warn",
        detail: "Existing unmanaged file. DotAIOS will not overwrite.",
        // activate's own remedy for this exact file is --merge. doctor used to
        // answer --overwrite, which replaces what the user wrote.
        fix: `Inspect ${filePath}; to keep what it says and add DotAIOS below it, run \`npx dotaios activate --merge\`.`
      });
    }
  }

  if (!anyInstalled) {
    results.push({
      name: "Local AI apps",
      status: "warn",
      detail: "No supported local AI app was detected on this machine.",
      fix: "Install Claude Code, Cursor, Codex, or Gemini, then run `npx dotaios activate`."
    });
  } else if (!foundBridge && !foundNativeRuntime) {
    results.push({
      name: "At least one AI tool connected",
      status: "warn",
      detail: "An AI tool is installed but no managed bridge points at this AIOS folder yet.",
      fix: "Run `npx dotaios activate`."
    });
  }

  return results;
}

function conciseDoctorCheck(check) {
  const name = check.name
    .replace(/ bridge$/, "")
    .replace(/ native skills$/, "");
  return {
    ...check,
    name,
    detail: conciseDoctorDetail(check)
  };
}

function conciseDoctorDetail(check) {
  const detail = check.detail;
  if (!detail) return detail;
  const exact = new Map([
    ["Bridge points to a different AIOS folder.", "This app is connected to a different AIOS folder."],
    ["An AI tool is installed but no managed bridge points at this AIOS folder yet.",
      "A local AI app is installed but is not connected to this AIOS folder yet."],
    ["Managed bridge predates v1.23 and still calls the retired read_session_digest surface.",
      "This app connection is from an older DotAIOS version."],
    ["Bridge is from an older version and still loads your whole AIOS folder into every session.",
      "This app connection is from an older version and still loads your whole AIOS folder into every session."],
    ["Bridge is from an older version and does not match what this release writes.",
      "This app connection is from an older DotAIOS version."],
    ["Managed bridge markers are malformed; DotAIOS preserved the file.",
      "The DotAIOS connection markers are damaged; your file was preserved."],
    ["Could not read this AIOS folder, so its native skill configuration is unverified.",
      "Could not read this AIOS folder, so the app connection is unverified."]
  ]);
  if (exact.has(detail)) return exact.get(detail);
  if (check.name.endsWith(" bridge")) {
    const missingPrefix = `${check.name.slice(0, -" bridge".length)} is installed but not connected yet (no bridge at `;
    if (detail.startsWith(missingPrefix) && detail.endsWith(").")) {
      const opaquePath = detail.slice(missingPrefix.length, -2);
      return `${check.name.slice(0, -" bridge".length)} is installed but not connected yet (no connection at ${opaquePath}).`;
    }
    const entrypointPrefix = "Bridge points at this AIOS folder, but its entrypoint is missing (";
    if (detail.startsWith(entrypointPrefix) && detail.endsWith(").")) {
      const opaquePath = detail.slice(entrypointPrefix.length, -2);
      return `This app is connected to this AIOS folder, but its entrypoint is missing (${opaquePath}).`;
    }
  }
  return detail;
}

function humanizeDoctorPath(value, target, homePath) {
  let output = String(value || "");
  const resolvedHome = path.resolve(homePath);
  const resolvedTarget = path.resolve(target);
  const targetRelative = path.relative(resolvedHome, resolvedTarget);
  if (targetRelative && !targetRelative.startsWith("..") && !path.isAbsolute(targetRelative)) {
    output = output.split(resolvedTarget).join(`~/${targetRelative.split(path.sep).join("/")}`);
  } else if (resolvedTarget === resolvedHome) {
    output = output.split(resolvedTarget).join("~");
  }
  return output.split(resolvedHome).join("~");
}

// A runtime with no bridge file keeps its skills in its own configuration, so
// the only honest answer comes from reading that configuration. inspectSkillHealth
// already does exactly this for every mode; doctor consumes it rather than
// growing a third reader of the same files.
async function readNativeRuntimes(aiosPath, homePath, detection) {
  try {
    const { runtimes } = await inspectSkillHealth({ aiosPath, homePath, detection });
    return new Map(runtimes.map((runtime) => [runtime.name, runtime]));
  } catch {
    // An unreadable AIOS folder is already reported by the folder and config
    // checks above. It must not stop the agent section from finishing.
    return null;
  }
}

function nativeRuntimeCheck(agent, target, runtimes) {
  const name = `${agent.name} native skills`;
  const capabilities = runtimes?.get(agent.name)?.capabilities;
  if (!capabilities) {
    return {
      name,
      status: "warn",
      detail: "Could not read this AIOS folder, so its native skill configuration is unverified.",
      fix: `Fix the AIOS folder problems above, then run \`npx dotaios doctor${pathOptionFor(target)}\` again.`
    };
  }
  if (capabilities.configured === "yes" && capabilities.projected === "yes") {
    return { name, status: "ok" };
  }
  const skillsDir = path.join(target, "skills");
  if (agent.skills?.mode === "config-external-dir") {
    return {
      name,
      status: "warn",
      detail: `Detected, but ~/${agent.skills.configFile} does not list ${skillsDir}.`,
      fix: `Add ${skillsDir} to ${agent.skills.key || "skills.external_dirs"} in ~/${agent.skills.configFile}, then run \`npx dotaios skills doctor\`.`
    };
  }
  return {
    name,
    status: "warn",
    detail: `Detected, but ~/${agent.skills?.dir} has no live links to ${skillsDir}.`,
    fix: `Run \`npx dotaios activate${pathOptionFor(target)}\` to connect its skills.`
  };
}

function repointCommand(target) {
  return `npx dotaios activate${pathOptionFor(target)} --overwrite`;
}

// A managed block DotAIOS already owns is spliced in place without --overwrite,
// and the text the user wrote around it is preserved. Only an unmanaged file
// needs the overwriting form, so do not send someone there to fix our own block.
function refreshCommand(target) {
  return `npx dotaios activate${pathOptionFor(target)}`;
}

function pathOptionFor(target) {
  const defaultPath = path.resolve(expandHome(defaultAiosPath()));
  return target === defaultPath ? "" : ` --path ${shellQuote(target)}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
