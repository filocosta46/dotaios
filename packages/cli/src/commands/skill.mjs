import os from "node:os";
import path from "node:path";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { installCommand } from "./install.mjs";
import { createManagedSkillStore } from "../../../core/src/managed-skill-store.mjs";

const HELP_TEXT = `Usage:
  dotaios skill <subcommand> [options]

Subcommands:
  add <local-folder>  Preview adoption of a reviewed local skill or plugin folder.
  list                Show owned, discovered-unmanaged, and unsafe skills.
  remove <name>       Preview or exactly remove one managed skill.

This is the friendly alias for reviewed local Agent Skill adoption and managed
removal. A manifest may identify one skill bundle; its executable code is not installed.

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --home <dir>  Write native agent bridges and skills under this home directory
  --apply <id>  Apply only the exact displayed plan
  --fingerprint <sha256>  Require the displayed plan fingerprint
  --json        Print structured inventory/proof/result output
`;

export async function skillCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const { subcommand, positionals, options } = parseOptions(args);
  if (!subcommand) {
    console.log(HELP_TEXT);
    return;
  }

  if (subcommand === "add") {
    if (positionals.length === 0) {
      throw new Error("Usage: dotaios skill add <local-folder>");
    }
    const installArgs = [...positionals];
    if (options.path) installArgs.push("--path", options.path);
    if (options.home) installArgs.push("--home", options.home);
    if (options.apply) installArgs.push("--apply", options.apply);
    if (options.fingerprint) installArgs.push("--fingerprint", options.fingerprint);
    if (options.json) installArgs.push("--json");
    await installCommand(installArgs);
    return;
  }

  if (subcommand === "list") {
    await listSkills(options);
    return;
  }

  if (subcommand === "remove" || subcommand === "rm") {
    if (positionals.length === 0) {
      throw new Error("Usage: dotaios skill remove <name>");
    }
    await removeSkill(positionals[0], options);
    return;
  }

  throw new Error(`Unknown skill subcommand: ${subcommand}. Try \`dotaios skill --help\`.`);
}

function parseOptions(args = []) {
  const options = { home: null, path: null, apply: null, fingerprint: null, json: false };
  const positionals = [];
  let subcommand = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--apply") {
      options.apply = readOptionValue(args, index, "--apply");
      index += 1;
    } else if (arg === "--fingerprint") {
      options.fingerprint = readOptionValue(args, index, "--fingerprint");
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (!arg.startsWith("--") && !subcommand) {
      subcommand = arg;
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { subcommand, positionals, options };
}

async function listSkills(options) {
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const store = createManagedSkillStore({
    aiosPath: target,
    homePath: path.resolve(expandHome(options.home || os.homedir()))
  });
  const inventory = await store.inspect();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  console.log(`Owned skills in ${target}/skills/:`);
  for (const entry of inventory.owned) console.log(`  - ${entry.name}`);
  if (inventory.owned.length === 0) console.log("  (no owned skills yet)");
  console.log(`Discovered unmanaged: ${inventory.discovered_unmanaged.length}`);
  console.log(`Excluded unsafe: ${inventory.excluded_unsafe.length}`);
  console.log(`Retained recovery: ${(inventory.retained_recovery || []).length}`);
}

async function removeSkill(name, options) {
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  if (Boolean(options.apply) !== Boolean(options.fingerprint)) {
    throw new Error("--apply and --fingerprint are required together");
  }
  const store = createManagedSkillStore({
    aiosPath: target,
    homePath: path.resolve(expandHome(options.home || os.homedir()))
  });
  const result = options.apply
    ? await store.remove({
        name,
        apply: true,
        operationId: options.apply,
        planFingerprint: options.fingerprint
      })
    : await store.remove({ name });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.plan_fingerprint) {
    console.log(`Removal preview: ${result.operation_id}`);
    console.log(`Plan fingerprint: ${result.plan_fingerprint}`);
    console.log("No files changed. Re-run with --apply <id> --fingerprint <sha256>.");
  } else {
    console.log(`Removed ${name}.`);
    if (result.recovery_retained) {
      console.log("Recovery retained locally; inspect `dotaios skill list` before any future cleanup.");
    }
  }
}
