import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import {
  bundledCliInvocation,
  exactCliInvocation,
  isExactCandidatePackageSpec
} from "../../../core/src/bridges.mjs";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import {
  regularFilePreimageMetadata,
  replaceFileIfUnchanged,
  sameRegularFile,
  validateManagedFilePath
} from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const MANAGED_SCHEDULE_REPAIR_FORMAT = "dotaios-managed-schedule-repair-plan/v1";
const RECOGNIZED_SCHEDULE_PREDECESSORS = new Set(["2.0.9", "2.0.10"]);
const TERMINAL_SCHEDULE_FIELDS = new Set(["name", "cadence", "command"]);
const UNSAFE_TERMINAL_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Bidi_Control}/u;
export const OFFICIAL_SCHEDULES = Object.freeze([
  Object.freeze({ name: "daily-brief", cadence: "daily", commandTail: "brief" }),
  Object.freeze({ name: "weekly-health-check", cadence: "weekly", commandTail: "doctor" }),
  Object.freeze({ name: "weekly-memory-audit", cadence: "weekly", commandTail: "memory audit --all-memory" })
]);
const OFFICIAL_SCHEDULE_COMMANDS = new Map(
  OFFICIAL_SCHEDULES.map(({ name, commandTail }) => [name, commandTail])
);

export async function scheduleCommand(args) {
  if (hasHelpFlag(args)) {
    printScheduleHelp();
    return;
  }

  const options = parseOptions(args);
  const [subcommand, name] = options.positionals;
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const schedulesPath = path.join(target, "schedules.yml");
  const scheduleFile = await readSchedules(schedulesPath);
  const schedules = scheduleFile.schedules;

  if (!subcommand || subcommand === "list") {
    printSchedules(schedules);
    return;
  }

  if (subcommand === "due") {
    printDueSchedules(schedules, new Date());
    return;
  }

  if (subcommand === "doctor") {
    printScheduleDoctor(schedules, target);
    return;
  }

  if (subcommand === "install") {
    await installScheduleHandoff(schedules, target, options);
    return;
  }

  if (subcommand === "run") {
    if (!name) throw new Error("Usage: dotaios schedule run <name>");
    await runSchedule(scheduleFile, schedulesPath, name, target, options);
    return;
  }

  if (subcommand === "run-due") {
    await runDueSchedules(scheduleFile, schedulesPath, target, options);
    return;
  }

  throw new Error(`Unknown schedule command: ${subcommand}`);
}

function parseOptions(args = []) {
  const options = { dryRun: false, path: null, positionals: [], target: null, yes: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--target") {
      options.target = readOptionValue(args, index, "--target");
      index += 1;
    } else if (arg === "--yes") {
      options.yes = true;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printScheduleHelp() {
  console.log(`Usage:
  dotaios schedule <command> [options]

Commands:
  list          Show configured schedules
  due           Show enabled schedules due now
  doctor        Check local schedule configuration and handoff options
  install       Print or install an OS scheduler handoff
  run <name>    Run one configured DotAIOS command
  run-due       Run every enabled schedule due now

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --dry-run     Show the command without running it
  --target <t>  Scheduler target: launchd, cron, or task-scheduler
  --yes         Allow guarded local scheduler file installation
`);
}

async function readSchedules(schedulesPath) {
  const stable = await readStableScheduleSource(schedulesPath);
  if (!stable) return { source: null, stats: null, schedules: [] };
  const { source: content, stats: after } = stable;
  const schedules = parseScheduleMaps(content).flatMap((scheduleMap, scheduleIndex) => {
    if (!isMap(scheduleMap)) return [];
    const schedule = {};
    for (const pair of scheduleMap.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !isScalar(pair.value)) continue;
      const key = pair.key.value;
      const value = pair.value.value;
      if (TERMINAL_SCHEDULE_FIELDS.has(key) && typeof value === "string") {
        assertSafeScheduleText(value, key, scheduleIndex);
      }
      schedule[key] = key === "enabled" ? value !== false && value !== "false" : value;
    }
    return typeof schedule.name === "string" && schedule.name ? [schedule] : [];
  });
  return { source: content, stats: after, schedules };
}

function assertSafeScheduleText(value, field, scheduleIndex) {
  const unsafe = value.match(UNSAFE_TERMINAL_TEXT)?.[0];
  if (!unsafe) return;
  const codePoint = unsafe.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  throw new Error(
    `Schedule ${field} in entry ${scheduleIndex + 1} contains the control character U+${codePoint}.`
  );
}

async function readStableScheduleSource(schedulesPath) {
  let before;
  try {
    before = await fs.lstat(schedulesPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Refusing to read an unsafe schedules file: ${schedulesPath}`);
  }
  const bytes = await fs.readFile(schedulesPath);
  const source = bytes.toString("utf8");
  const after = await fs.lstat(schedulesPath);
  if (!sameRegularFile(after, before)) {
    throw new Error(`Schedules changed while being read: ${schedulesPath}`);
  }
  return { bytes, source, stats: after };
}

function printSchedules(schedules) {
  if (schedules.length === 0) {
    console.log("No schedules configured.");
    return;
  }

  console.log("Name                 Cadence   Enabled   Command");
  for (const schedule of schedules) {
    console.log(`${pad(schedule.name, 20)} ${pad(schedule.cadence || "manual", 9)} ${pad(String(schedule.enabled !== false), 9)} ${schedule.command || "-"}`);
  }
}

function printDueSchedules(schedules, now) {
  const due = schedules.filter((schedule) => isDue(schedule, now));
  if (due.length === 0) {
    console.log("No schedules due.");
    return;
  }

  console.log("Due schedules");
  for (const schedule of due) {
    console.log(`- ${schedule.name}: ${schedule.command}`);
  }
}

function printScheduleDoctor(schedules, target) {
  const cli = bundledCliInvocation();
  const due = schedules.filter((schedule) => isDue(schedule, new Date()));
  console.log("DotAIOS schedule doctor");
  console.log(`AIOS path: ${target}`);
  console.log(`${schedules.length ? "[ok]" : "[missing]"} schedules configured: ${schedules.length}`);
  console.log(`${due.length ? "[due]" : "[ok]"} due now: ${due.length}`);
  console.log("");
  console.log("Local handoff options:");
  console.log(`- macOS: ${cli} schedule install --dry-run --target launchd`);
  console.log(`- Linux: ${cli} schedule install --dry-run --target cron`);
  console.log(`- Windows: ${cli} schedule install --dry-run --target task-scheduler`);
  console.log("");
  console.log(`DotAIOS does not run a daemon. OS schedulers should call \`${cli} schedule run-due\`.`);
}

async function installScheduleHandoff(schedules, target, options) {
  const scheduler = options.target || defaultSchedulerTarget();
  if (!["launchd", "cron", "task-scheduler"].includes(scheduler)) {
    throw new Error("Invalid --target. Use launchd, cron, or task-scheduler.");
  }

  const plan = schedulerPlan(scheduler, target);
  console.log(`DotAIOS schedule ${options.dryRun ? "dry run" : "install"}`);
  console.log(`Target: ${scheduler}`);
  console.log(`AIOS path: ${target}`);
  console.log(`Configured schedules: ${schedules.length}`);
  console.log("");
  console.log(plan.description);
  console.log("");
  console.log(plan.content);

  if (options.dryRun) return;
  if (!options.yes) {
    throw new Error("Refusing to install scheduler handoff without --yes. Re-run with --dry-run first, then add --yes if it looks right.");
  }

  if (scheduler === "launchd") {
    await fs.mkdir(path.dirname(plan.path), { recursive: true });
    await fs.writeFile(plan.path, plan.content);
    console.log(`\nWrote ${plan.path}`);
    console.log("Load it with: launchctl load ~/Library/LaunchAgents/com.dotaios.schedule.plist");
    return;
  }

  throw new Error(`${scheduler} install is print-only for now. Use the dry-run output with your local scheduler.`);
}

async function runSchedule(scheduleFile, schedulesPath, name, target, options) {
  const { schedules } = scheduleFile;
  const schedule = schedules.find((item) => item.name === name);
  if (!schedule) throw new Error(`No schedule named ${name}`);
  if (schedule.enabled === false) throw new Error(`Schedule is disabled: ${name}`);
  if (!schedule.command) throw new Error(`Schedule has no command: ${name}`);

  const argv = scheduledCliArgs(schedule.command);
  // Validate the source-preserving last_run edit before dry-run output or
  // execution. Ambiguous names, duplicate YAML keys, and flow mappings without
  // an existing scalar boundary fail closed even when the command is not run.
  const renderLastRun = planScheduleLastRunUpdate(scheduleFile.source, name);

  const commandArgs = argv.includes("--path") ? argv : [...argv, "--path", target];
  console.log(`${options.dryRun ? "Would run" : "Running"} in-package DotAIOS: ${commandArgs.join(" ")}`);
  if (options.dryRun) return;

  const cli = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...commandArgs], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Schedule ${name} failed with status ${result.status}`);
  }

  const lastRun = new Date().toISOString();
  const nextSource = renderLastRun(lastRun);
  const replacement = await replaceFileIfUnchanged(schedulesPath, scheduleFile.source, nextSource, {
    boundaryRoot: target,
    expectedStats: scheduleFile.stats,
    mode: scheduleFile.stats.mode & 0o777,
    backupMode: scheduleFile.stats.mode & 0o777
  });
  if (!replacement.replaced) {
    throw new Error(`Schedule file changed while ${name} was running; preserved the concurrent edit and did not record last_run.`);
  }
  if (replacement.preservedPath) {
    await fs.rm(replacement.preservedPath, { force: true }).catch(() => {});
  }
  scheduleFile.source = nextSource;
  scheduleFile.stats = await fs.lstat(schedulesPath);
}

async function runDueSchedules(scheduleFile, schedulesPath, target, options) {
  const { schedules } = scheduleFile;
  const due = schedules.filter((schedule) => isDue(schedule, new Date()));
  if (due.length === 0) {
    console.log("No schedules due.");
    return;
  }

  for (const schedule of due) {
    await runSchedule(scheduleFile, schedulesPath, schedule.name, target, options);
  }
}

function isDue(schedule, now) {
  if (schedule.enabled === false) return false;
  const cadence = schedule.cadence || "manual";
  if (cadence === "manual") return false;
  if (!schedule.last_run) return true;

  const lastRun = new Date(schedule.last_run);
  if (Number.isNaN(lastRun.getTime())) return true;

  const ageMs = now.getTime() - lastRun.getTime();
  if (cadence === "daily") return ageMs >= 24 * 60 * 60 * 1000;
  if (cadence === "weekly") return ageMs >= 7 * 24 * 60 * 60 * 1000;
  if (cadence === "monthly") return ageMs >= 30 * 24 * 60 * 60 * 1000;
  return false;
}

function defaultSchedulerTarget() {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "win32") return "task-scheduler";
  return "cron";
}

function schedulerPlan(scheduler, target) {
  const cli = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const node = process.execPath;
  const command = `${shellQuote(node)} ${shellQuote(cli)} schedule run-due --path ${shellQuote(target)}`;
  if (scheduler === "launchd") {
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.dotaios.schedule.plist");
    return {
      path: plistPath,
      description: `Would write ${plistPath} to run due schedules every hour.`,
      content: launchdPlist({ node, cli, target })
    };
  }
  if (scheduler === "cron") {
    return {
      path: null,
      description: "Add this line with `crontab -e` to run due schedules every hour.",
      content: `0 * * * * ${command}`
    };
  }
  return {
    path: null,
    description: "Create this Windows Task Scheduler action to run due schedules every hour.",
    content: `Program: ${node}\nArguments: ${shellQuote(cli)} schedule run-due --path ${shellQuote(target)}`
  };
}

function launchdPlist({ node, cli, target }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dotaios.schedule</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(cli)}</string>
    <string>schedule</string>
    <string>run-due</string>
    <string>--path</string>
    <string>${escapeXml(target)}</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(os.homedir(), "Library", "Logs", "dotaios-schedule.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(os.homedir(), "Library", "Logs", "dotaios-schedule.err.log"))}</string>
</dict>
</plist>
`;
}

export function planManagedScheduleRepair(source, { candidateVersion } = {}) {
  return buildManagedScheduleRepairPlan(source, { candidateVersion });
}

export async function previewManagedScheduleFile(
  schedulesPath,
  {
    candidateVersion,
    boundaryRoot = path.dirname(path.resolve(schedulesPath))
  } = {}
) {
  const targetPath = path.resolve(schedulesPath);
  const stats = await validateManagedFilePath(targetPath, boundaryRoot);
  if (!stats) {
    return attachScheduleFileEvidence(
      buildManagedScheduleRepairPlan("", {
        candidateVersion,
        targetPath,
        preimageMetadata: null
      }),
      "",
      null,
      Buffer.alloc(0)
    );
  }

  const stable = await readStableScheduleSource(targetPath);
  if (!stable) {
    throw new Error(`Schedules changed while their repair preview was being read: ${targetPath}`);
  }
  return attachScheduleFileEvidence(
    buildManagedScheduleRepairPlan(stable.source, {
      candidateVersion,
      targetPath,
      preimageMetadata: regularFilePreimageMetadata(stable.stats)
    }),
    stable.source,
    stable.stats,
    stable.bytes
  );
}

export async function applyManagedScheduleFile(
  schedulesPath,
  {
    candidateVersion,
    expectedFingerprint,
    boundaryRoot = path.dirname(path.resolve(schedulesPath)),
    beforeReplace = null,
    beforePublish = null,
    beforeCommit = null,
    beforeRename = null,
    beforeVerify = null
  } = {}
) {
  if (typeof expectedFingerprint !== "string" || !expectedFingerprint) {
    throw new Error("Managed schedule repair requires the exact preview fingerprint.");
  }

  const targetPath = path.resolve(schedulesPath);
  const plan = await previewManagedScheduleFile(targetPath, {
    candidateVersion,
    boundaryRoot
  });
  if (plan.fingerprint !== expectedFingerprint) {
    return {
      action: "conflict",
      status: "blocked-conflict",
      path: targetPath,
      note: "schedules.yml changed after preview; left the current file untouched"
    };
  }
  if (plan.status === "blocked-conflict") {
    return {
      action: "conflict",
      status: "blocked-conflict",
      path: targetPath,
      conflicts: plan.conflicts
    };
  }
  if (plan.status === "current") {
    return { action: "unchanged", status: "verified", path: targetPath };
  }
  if (plan.status !== "ready" || !plan._stats) {
    throw new Error("Managed schedule repair preview is not applicable.");
  }

  const next = applyManagedScheduleRepair(plan._source, plan);
  const replacement = await replaceFileIfUnchanged(targetPath, plan._source, next, {
    boundaryRoot,
    expectedStats: plan._stats,
    mode: plan._stats.mode & 0o777,
    backupMode: plan._stats.mode & 0o777,
    beforeReplace,
    beforePublish,
    beforeCommit,
    beforeRename
  });
  if (!replacement.replaced) {
    return {
      action: "conflict",
      status: "blocked-conflict",
      path: targetPath,
      note: "schedules.yml changed during repair; left the concurrent edit untouched",
      ...(replacement.preservedPath ? { preservedPath: replacement.preservedPath } : {})
    };
  }

  const nextBytes = Buffer.from(next, "utf8");
  try {
    await beforeVerify?.({ destination: targetPath, next: nextBytes });
    const verified = await previewManagedScheduleFile(targetPath, {
      candidateVersion,
      boundaryRoot
    });
    if (
      verified.status === "current"
      && verified._stats?.isFile()
      && !verified._stats.isSymbolicLink()
      && verified.preimage_fingerprint === fingerprintText(next)
      && verified._bytes.equals(nextBytes)
    ) {
      return {
        action: "updated",
        status: "verified",
        path: targetPath,
        ...(replacement.preservedPath ? { preservedPath: replacement.preservedPath } : {})
      };
    }
  } catch {
    // Verification is intentionally fail-closed after publication: concurrent
    // bytes stay in place for the caller to inspect rather than being restored.
  }
  return {
    action: "updated",
    status: "recovery-required",
    path: targetPath,
    note: "schedule fields were published but post-write verification did not reach current",
    ...(replacement.preservedPath ? { preservedPath: replacement.preservedPath } : {})
  };
}

function buildManagedScheduleRepairPlan(
  source,
  {
    candidateVersion,
    targetPath = null,
    preimageMetadata = null
  } = {}
) {
  const candidateInvocation = exactCliInvocation(candidateVersion);
  const preimageFingerprint = fingerprintText(source);
  const changes = [];
  const conflicts = [];
  const base = {
    format: MANAGED_SCHEDULE_REPAIR_FORMAT,
    domain: "managed-schedules",
    target: targetPath ? { kind: "schedule-command-fields", path: targetPath } : null,
    preimage_fingerprint: preimageFingerprint,
    preimage_metadata: preimageMetadata,
    candidate_version: candidateVersion,
    candidate_invocation: candidateInvocation
  };

  let scheduleMaps;
  try {
    scheduleMaps = parseScheduleMaps(source);
  } catch (error) {
    return finalizeScheduleRepairPlan({
      ...base,
      status: "blocked-conflict",
      changes,
      conflicts: [{ reason: "invalid-schedules-yaml", detail: error.message }]
    });
  }

  const byName = new Map();
  for (const scheduleMap of scheduleMaps) {
    if (!isMap(scheduleMap)) continue;
    const namePair = findMapPair(scheduleMap, "name");
    if (!namePair || !isScalar(namePair.value) || typeof namePair.value.value !== "string") continue;
    const name = namePair.value.value;
    if (!OFFICIAL_SCHEDULE_COMMANDS.has(name)) continue;
    const existing = byName.get(name) || [];
    existing.push(scheduleMap);
    byName.set(name, existing);
  }

  for (const [name, commandTail] of OFFICIAL_SCHEDULE_COMMANDS) {
    const matches = byName.get(name) || [];
    if (matches.length > 1) {
      conflicts.push({ name, reason: "ambiguous-official-schedule", detail: "more than one schedule uses this generated name" });
      continue;
    }
    if (matches.length === 0) continue;

    const commandPair = findMapPair(matches[0], "command");
    if (
      !commandPair
      || !isScalar(commandPair.value)
      || typeof commandPair.value.value !== "string"
      || !Array.isArray(commandPair.value.range)
    ) {
      conflicts.push({ name, reason: "ambiguous-official-command", detail: "command is missing or is not one scalar string" });
      continue;
    }

    const current = `${candidateInvocation} ${commandTail}`;
    const start = commandPair.value.range[0];
    const end = commandPair.value.range[1];
    if (
      commandPair.value.type !== "QUOTE_DOUBLE"
      || source.slice(start, end) !== JSON.stringify(commandPair.value.value)
    ) {
      conflicts.push({
        name,
        reason: "custom-official-command",
        detail: "the command scalar is not an exact package-generated field"
      });
      continue;
    }
    const predecessor = classifyOfficialScheduleCommand(commandPair.value.value, commandTail, current);
    if (predecessor === "current") continue;
    if (!predecessor) {
      conflicts.push({
        name,
        reason: "custom-official-command",
        detail: "the command is not an exact generated 2.0.9/2.0.10 predecessor"
      });
      continue;
    }

    changes.push({
      name,
      field: "command",
      from: commandPair.value.value,
      to: current,
      start,
      end,
      expected: source.slice(start, end),
      replacement: JSON.stringify(current)
    });
  }

  return finalizeScheduleRepairPlan({
    ...base,
    status: conflicts.length > 0 ? "blocked-conflict" : changes.length > 0 ? "ready" : "current",
    changes,
    conflicts
  });
}

export function applyManagedScheduleRepair(source, plan) {
  if (plan?.format !== MANAGED_SCHEDULE_REPAIR_FORMAT) {
    throw new Error("Managed schedule repair plan has an unsupported format.");
  }
  if (plan.fingerprint !== scheduleRepairPlanFingerprint(plan)) {
    throw new Error("Managed schedule repair preview plan fingerprint is invalid.");
  }
  if (fingerprintText(source) !== plan.preimage_fingerprint) {
    throw new Error("Managed schedule repair plan is stale; preview the current schedules.yml again.");
  }
  const checkedPlan = buildManagedScheduleRepairPlan(source, {
    candidateVersion: plan.candidate_version,
    targetPath: plan.target?.path || null,
    preimageMetadata: plan.preimage_metadata ?? null
  });
  if (checkedPlan.fingerprint !== plan.fingerprint) {
    throw new Error("Managed schedule repair preview plan no longer matches its canonical field changes.");
  }
  if (checkedPlan.status === "blocked-conflict" || checkedPlan.conflicts.length) {
    throw new Error("Managed schedule repair is blocked by a conflict; no schedule fields were changed.");
  }
  if (checkedPlan.status === "current") return source;
  if (checkedPlan.status !== "ready") {
    throw new Error("Managed schedule repair plan is invalid.");
  }

  let next = source;
  for (const change of [...checkedPlan.changes].sort((left, right) => right.start - left.start)) {
    if (source.slice(change.start, change.end) !== change.expected) {
      throw new Error("Managed schedule repair plan no longer matches its command scalar preimage.");
    }
    next = `${next.slice(0, change.start)}${change.replacement}${next.slice(change.end)}`;
  }

  const verified = buildManagedScheduleRepairPlan(next, {
    candidateVersion: plan.candidate_version,
    targetPath: plan.target?.path || null,
    preimageMetadata: plan.preimage_metadata ?? null
  });
  if (verified.status !== "current") {
    throw new Error("Managed schedule repair verification failed; no file should be published.");
  }
  return next;
}

function parseCommand(command) {
  return command.match(/"[^"]+"|'[^']+'|\S+/g)?.map(unquote) || [];
}

function scheduledCliArgs(command) {
  const argv = parseCommand(command);
  const executable = argv[0];
  if (["dotaios", "aios"].includes(executable)) return argv.slice(1);
  if (executable === "npx" && isExactCandidatePackageSpec(argv[1])) return argv.slice(2);
  throw new Error("Schedules only run DotAIOS commands. Use cron manually for arbitrary commands.");
}

function classifyOfficialScheduleCommand(value, commandTail, current) {
  if (value === current) return "current";
  if (value === `dotaios ${commandTail}`) return "bare-predecessor";
  const match = /^npx dotaios@([^\s]+) (.+)$/.exec(value);
  if (!match || match[2] !== commandTail || !RECOGNIZED_SCHEDULE_PREDECESSORS.has(match[1])) return null;
  return `version-${match[1]}`;
}

function parseScheduleMaps(source) {
  if (typeof source !== "string") throw new Error("schedules.yml must be text");
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    keepSourceTokens: true
  });
  if (document.errors.length > 0) throw new Error(document.errors[0].message);
  if (document.contents == null) return [];
  if (!isMap(document.contents)) throw new Error("schedules.yml must contain one mapping");
  const schedules = document.get("schedules", true);
  if (schedules == null) return [];
  if (!isSeq(schedules)) throw new Error("schedules must be a sequence");
  return schedules.items;
}

function findMapPair(map, key) {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key) || null;
}

function renderScalarLike(node, value) {
  if (node.type === "QUOTE_SINGLE") return `'${value.replaceAll("'", "''")}'`;
  if (node.type === "PLAIN") return value;
  return JSON.stringify(value);
}

function fingerprintText(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function finalizeScheduleRepairPlan(plan) {
  return {
    ...plan,
    fingerprint: scheduleRepairPlanFingerprint(plan)
  };
}

function attachScheduleFileEvidence(plan, source, stats, bytes) {
  Object.defineProperties(plan, {
    _bytes: { value: bytes },
    _source: { value: source },
    _stats: { value: stats }
  });
  return plan;
}

function scheduleRepairPlanFingerprint(plan) {
  return fingerprintText(JSON.stringify({
    format: plan.format,
    target: plan.target,
    status: plan.status,
    preimage_fingerprint: plan.preimage_fingerprint,
    preimage_metadata: plan.preimage_metadata,
    candidate_version: plan.candidate_version,
    candidate_invocation: plan.candidate_invocation,
    changes: plan.changes.map(({ name, field, from, to, start, end, expected, replacement }) => ({
      name,
      field,
      from,
      to,
      start,
      end,
      expected,
      replacement
    })),
    conflicts: plan.conflicts
  }));
}

function planScheduleLastRunUpdate(source, name) {
  const matches = parseScheduleMaps(source).filter((scheduleMap) => {
    if (!isMap(scheduleMap)) return false;
    const pair = findMapPair(scheduleMap, "name");
    return isScalar(pair?.value) && pair.value.value === name;
  });
  if (matches.length !== 1) {
    throw new Error(`Cannot record last_run for ambiguous schedule: ${name}`);
  }

  const scheduleMap = matches[0];
  const lastRunPair = findMapPair(scheduleMap, "last_run");
  if (lastRunPair) {
    if (!isScalar(lastRunPair.value) || !Array.isArray(lastRunPair.value.range)) {
      throw new Error(`Cannot replace a non-scalar last_run for schedule: ${name}`);
    }
    const start = lastRunPair.value.range[0];
    const end = lastRunPair.value.range[1];
    return (timestamp) => (
      `${source.slice(0, start)}${renderScalarLike(lastRunPair.value, timestamp)}${source.slice(end)}`
    );
  }

  if (scheduleMap.flow) {
    throw new Error(`Cannot add last_run to a flow-style schedule without a safe field boundary: ${name}`);
  }

  if (!Array.isArray(scheduleMap.range)) {
    throw new Error(`Cannot locate schedule fields for: ${name}`);
  }
  const firstPair = scheduleMap.items[0];
  if (!firstPair?.key?.range) throw new Error(`Cannot locate schedule indentation for: ${name}`);
  const lineStart = source.lastIndexOf("\n", firstPair.key.range[0] - 1) + 1;
  const firstPrefix = source.slice(lineStart, firstPair.key.range[0]);
  const indent = firstPrefix.replace(/-\s*$/u, (marker) => " ".repeat(marker.length));
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const insertAt = scheduleMap.range[1];
  const leadingEol = insertAt > 0 && !/[\r\n]/u.test(source[insertAt - 1]) ? eol : "";
  return (timestamp) => {
    const addition = `${leadingEol}${indent}last_run: ${JSON.stringify(timestamp)}${eol}`;
    return `${source.slice(0, insertAt)}${addition}${source.slice(insertAt)}`;
  };
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function shellQuote(value) {
  const string = String(value);
  return /^[A-Za-z0-9_./:=,+-]+$/.test(string) ? string : `'${string.replace(/'/g, "'\\''")}'`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pad(value, size) {
  return value.padEnd(size, " ");
}
