import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { pathExists } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

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
  const schedules = await readSchedules(schedulesPath);

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
    await runSchedule(schedules, schedulesPath, name, target, options);
    return;
  }

  if (subcommand === "run-due") {
    await runDueSchedules(schedules, schedulesPath, target, options);
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
  if (!await pathExists(schedulesPath)) return [];

  const content = await fs.readFile(schedulesPath, "utf8");
  const schedules = [];
  let current = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "schedules:" || line === "schedules: []" || line.startsWith("#")) continue;

    if (line.startsWith("- ")) {
      if (current) schedules.push(current);
      current = {};
      parseScheduleField(line.slice(2), current);
    } else if (current) {
      parseScheduleField(line, current);
    }
  }

  if (current) schedules.push(current);
  return schedules.filter((schedule) => schedule.name);
}

function parseScheduleField(line, schedule) {
  const separator = line.indexOf(":");
  if (separator === -1) return;

  const key = line.slice(0, separator).trim();
  const value = unquote(line.slice(separator + 1).trim());
  schedule[key] = key === "enabled" ? value !== "false" : value;
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
  const due = schedules.filter((schedule) => isDue(schedule, new Date()));
  console.log("DotAIOS schedule doctor");
  console.log(`AIOS path: ${target}`);
  console.log(`${schedules.length ? "[ok]" : "[missing]"} schedules configured: ${schedules.length}`);
  console.log(`${due.length ? "[due]" : "[ok]"} due now: ${due.length}`);
  console.log("");
  console.log("Local handoff options:");
  console.log("- macOS: dotaios schedule install --dry-run --target launchd");
  console.log("- Linux: dotaios schedule install --dry-run --target cron");
  console.log("- Windows: dotaios schedule install --dry-run --target task-scheduler");
  console.log("");
  console.log("DotAIOS does not run a daemon. OS schedulers should call `dotaios schedule run-due`.");
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

async function runSchedule(schedules, schedulesPath, name, target, options) {
  const schedule = schedules.find((item) => item.name === name);
  if (!schedule) throw new Error(`No schedule named ${name}`);
  if (schedule.enabled === false) throw new Error(`Schedule is disabled: ${name}`);
  if (!schedule.command) throw new Error(`Schedule has no command: ${name}`);

  const argv = parseCommand(schedule.command);
  const executable = argv.shift();
  if (!["dotaios", "aios"].includes(executable)) {
    throw new Error("v1.1 schedules only run DotAIOS commands. Use cron manually for arbitrary commands.");
  }

  const commandArgs = argv.includes("--path") ? argv : [...argv, "--path", target];
  console.log(`${options.dryRun ? "Would run" : "Running"}: dotaios ${commandArgs.join(" ")}`);
  if (options.dryRun) return;

  const cli = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...commandArgs], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Schedule ${name} failed with status ${result.status}`);
  }

  schedule.last_run = new Date().toISOString();
  await fs.writeFile(schedulesPath, serializeSchedules(schedules));
}

async function runDueSchedules(schedules, schedulesPath, target, options) {
  const due = schedules.filter((schedule) => isDue(schedule, new Date()));
  if (due.length === 0) {
    console.log("No schedules due.");
    return;
  }

  for (const schedule of due) {
    await runSchedule(schedules, schedulesPath, schedule.name, target, options);
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

function serializeSchedules(schedules) {
  if (schedules.length === 0) return "schedules: []\n";

  const lines = ["schedules:"];
  for (const schedule of schedules) {
    lines.push(`  - name: ${quote(schedule.name)}`);
    lines.push(`    cadence: ${quote(schedule.cadence || "manual")}`);
    lines.push(`    command: ${quote(schedule.command || "")}`);
    lines.push(`    enabled: ${schedule.enabled !== false}`);
    if (schedule.last_run) lines.push(`    last_run: ${quote(schedule.last_run)}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseCommand(command) {
  return command.match(/"[^"]+"|'[^']+'|\S+/g)?.map(unquote) || [];
}

function quote(value) {
  const string = String(value);
  return /[:#\s]/.test(string) ? JSON.stringify(string) : string;
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
