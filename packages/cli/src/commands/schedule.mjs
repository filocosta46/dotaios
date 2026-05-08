import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
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

  if (subcommand === "run") {
    if (!name) throw new Error("Usage: dotaios schedule run <name>");
    await runSchedule(schedules, schedulesPath, name, target, options);
    return;
  }

  throw new Error(`Unknown schedule command: ${subcommand}`);
}

function parseOptions(args = []) {
  const options = { dryRun: false, path: null, positionals: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
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
  run <name>    Run one configured DotAIOS command

Options:
  --path <dir>  Use an AIOS folder other than ~/.aios
  --dry-run     Show the command without running it
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

async function ensureAiosFolder(target) {
  if (!await pathExists(path.join(target, "aios.json"))) {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
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

function pad(value, size) {
  return value.padEnd(size, " ");
}
