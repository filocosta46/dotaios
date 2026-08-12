import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { collectSkills, planTriggerVisibility } from "../../../core/src/skills.mjs";
import { rankSkills, resolveIntent, renderBootContext } from "../../../core/src/skill-resolver.mjs";
import { inspectSkillHealth } from "../../../core/src/skill-health.mjs";
import { activateCommand } from "./activate.mjs";
import { formatProbeResult, runSkillInvocationProbe } from "../lib/skill-invocation-probe.mjs";
import { createManagedSkillStore } from "../../../core/src/managed-skill-store.mjs";

const HELP_TEXT = `Usage:
  dotaios skills [name]
  dotaios skills install [options]
  dotaios skills inventory [options]
  dotaios skills adopt <local-folder> [options]
  dotaios skills reconcile [options]
  dotaios skills remove <name> [options]
  dotaios skills doctor [options]
  dotaios skills probe [options]
  dotaios skills resolve "<intent>" [options]
  dotaios skills sync-triggers

List installed skills, show detail for one skill, or resolve a free-text intent
to the skill that handles it.

Examples:
  dotaios skills             List all installed skills
  dotaios skills install    Reconcile native agent skill directories
  dotaios skills doctor     Report source, bridge, native-link, and Hermes health
  dotaios skills probe      Run a disposable, bounded client skill invocation proof
  dotaios skills plan-today  Show full instructions for the plan-today skill
  dotaios skills resolve "plan my day"
  dotaios skills resolve "plan my day" --full
  dotaios skills resolve "plan my day" --json
  dotaios skills resolve --boot-context
  BOOT_CONTEXT="$(dotaios skills resolve --boot-context)"

Resolve options:
  --json          Print ranked matches as JSON (for fleet/MCP callers)
  --full          Also print the top match's SKILL.md body
  --all           Print the full ranked list, not just the top match
  --limit <n>     Cap the number of matches (default 1, ignored with --all)
  --boot-context  Print Markdown context to capture and append to an agent prompt
  --path <dir>    Use a non-default AIOS folder

Managed store options:
  --path <dir>             Use a non-default AIOS folder
  --home <dir>             Use a disposable/native home root
  --json                   Print the exact structured proof or result
  --source-kind <kind>     Bind an explicit reviewed/native/shelf source kind
  --apply <operation-id>   Apply only the exact displayed operation
  --fingerprint <sha256>   Require the displayed plan fingerprint

Probe options:
  --client <name>    Required: codex, gemini, claude-code, hermes, cursor, or antigravity
  --path <dir>      Use an AIOS folder whose skills source must be readable
  --receipt <file>  Save the JSON evidence receipt
  --dry-run         Build the disposable fixture but do not invoke a client (default)
  --run             Explicitly invoke the selected client
  --keep            Keep the disposable fixture for inspection
  --json            Print only the JSON receipt
  --timeout-ms <n>  Bound a client invocation (default 90000)

Boot context is Markdown, not shell code. Capture it in a quoted variable as
shown above, then interpolate that text into the agent prompt.

Exit codes (resolve): 0 on a match, 2 when nothing clears the bar.
`;

export async function skillsCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  if (args[0] === "resolve") {
    await resolveSkillCommand(args.slice(1));
    return;
  }

  if (["inventory", "adopt", "reconcile", "remove"].includes(args[0])) {
    await managedStoreCommand(args[0], args.slice(1));
    return;
  }

  if (args[0] === "install") {
    await activateCommand(args.slice(1));
    return;
  }

  if (args[0] === "doctor") {
    await doctorSkillCommand(args.slice(1));
    return;
  }

  if (args[0] === "probe") {
    await probeSkillCommand(args.slice(1));
    return;
  }

  if (args[0] === "sync-triggers") {
    await syncTriggersCommand(args.slice(1));
    return;
  }

  const aiosPath = path.resolve(expandHome(extractPath(args) || defaultAiosPath()));
  const skills = await collectSkills(aiosPath);

  const name = extractName(args);

  if (name) {
    await showSkill(aiosPath, skills, name);
  } else {
    listSkills(skills);
  }
}

async function managedStoreCommand(subcommand, args) {
  const options = parseManagedStoreOptions(args);
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const homePath = path.resolve(expandHome(options.home || os.homedir()));
  const store = createManagedSkillStore({ aiosPath, homePath });
  let result;

  if (subcommand === "inventory") {
    if (options.positionals.length > 0 || options.apply || options.fingerprint) {
      throw new Error("Usage: dotaios skills inventory [--path <aios>] [--home <home>] [--json]");
    }
    result = await store.inspect();
  } else if (subcommand === "adopt") {
    const [sourcePath] = options.positionals;
    if (!sourcePath || options.positionals.length !== 1) {
      throw new Error("Usage: dotaios skills adopt <local-folder> [--apply <operation-id> --fingerprint <sha256>]");
    }
    if (Boolean(options.apply) !== Boolean(options.fingerprint)) {
      throw new Error("--apply and --fingerprint are required together");
    }
    result = options.apply
      ? await store.applyAdoption({
          sourcePath: path.resolve(expandHome(sourcePath)),
          sourceKind: options.sourceKind,
          operationId: options.apply,
          planFingerprint: options.fingerprint
        })
      : await store.previewAdoption({
          sourcePath: path.resolve(expandHome(sourcePath)),
          sourceKind: options.sourceKind
        });
  } else if (subcommand === "reconcile") {
    if (options.positionals.length > 0 || Boolean(options.apply) !== Boolean(options.fingerprint)) {
      throw new Error("Usage: dotaios skills reconcile [--apply <operation-id> --fingerprint <sha256>]");
    }
    result = await store.reconcile(options.apply
      ? { apply: true, operationId: options.apply, planFingerprint: options.fingerprint }
      : {});
  } else {
    const [name] = options.positionals;
    if (!name || options.positionals.length !== 1 || Boolean(options.apply) !== Boolean(options.fingerprint)) {
      throw new Error("Usage: dotaios skills remove <name> [--apply <operation-id> --fingerprint <sha256>]");
    }
    result = await store.remove(options.apply
      ? { name, apply: true, operationId: options.apply, planFingerprint: options.fingerprint }
      : { name });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  printManagedStoreResult(subcommand, result);
}

function parseManagedStoreOptions(args) {
  const options = {
    path: null,
    home: null,
    json: false,
    apply: null,
    fingerprint: null,
    sourceKind: null,
    positionals: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--source-kind") {
      options.sourceKind = readOptionValue(args, index, "--source-kind");
      index += 1;
    } else if (arg === "--apply") {
      options.apply = readOptionValue(args, index, "--apply");
      index += 1;
    } else if (arg === "--fingerprint") {
      options.fingerprint = readOptionValue(args, index, "--fingerprint");
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown skills ${args[0] || "managed-store"} option: ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }
  return options;
}

function printManagedStoreResult(subcommand, result) {
  if (subcommand === "inventory") {
    console.log(`Owned skills: ${result.owned.length}`);
    console.log(`Discovered unmanaged: ${result.discovered_unmanaged.length}`);
    console.log(`Excluded unsafe: ${result.excluded_unsafe.length}`);
    console.log(`Retained recovery: ${(result.retained_recovery || []).length}`);
    for (const entry of result.discovered_unmanaged) {
      if (["discovered-native-directory", "discovered-canonical-link"].includes(entry.source_kind)) {
        console.log(`- candidate ${entry.name} (${entry.source_kind})`);
      } else {
        console.log(`- unmanaged ${entry.name} (${entry.source_kind}; not directly adoptable)`);
      }
    }
    for (const entry of result.excluded_unsafe) console.log(`- excluded ${entry.name}: ${entry.reason}`);
    for (const entry of result.retained_recovery || []) {
      console.log(`- retained ${entry.name} (${entry.operation_id})`);
    }
    return;
  }
  if (result.plan_fingerprint) {
    console.log(`${subcommand} preview: ${result.operation_id}`);
    console.log(`Plan fingerprint: ${result.plan_fingerprint}`);
    if (result.skill) {
      console.log(`Skill: ${result.skill.name} (${result.skill.bundle_digest})`);
      console.log(`Bundle: ${result.skill.files.length} regular file(s), ${result.skill.scripts.length} script(s), ${result.skill.executables.length} executable(s)`);
    }
    for (const collision of result.collisions || []) {
      console.log(`Collision: ${collision.coordinate} (${collision.classification})`);
    }
    for (const projection of result.projections || []) {
      console.log(`Projection: ${projection.relative_path} (${projection.classification}; ${projection.hosts.join(", ")})`);
    }
    for (const unresolved of result.unresolved || []) {
      console.log(`Needs attention: ${unresolved.relative_path || unresolved.name} (${unresolved.classification || unresolved.kind})`);
    }
    console.log("Preview only. Re-run with --apply <operation-id> --fingerprint <sha256>.");
    return;
  }
  console.log(`${subcommand}: ${result.status}${result.name ? ` (${result.name})` : ""}`);
  if (result.recovery_retained) {
    console.log("Recovery retained locally; inspect `dotaios skills inventory` before any future cleanup.");
  }
}

// This compatibility command is preview-only. Managed skill bodies have no
// mutation escape hatch; callers edit the owned source explicitly and then
// reconcile derived state.
async function syncTriggersCommand(args) {
  let apply = false;
  let pathOption = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") apply = true;
    else if (args[index] === "--path") {
      pathOption = readOptionValue(args, index, "--path");
      index += 1;
    } else throw new Error(`Unknown skills sync-triggers option: ${args[index]}`);
  }

  const aiosPath = path.resolve(expandHome(pathOption || defaultAiosPath()));
  const plan = await planTriggerVisibility(aiosPath);

  if (plan.length === 0) {
    console.log("Every skill with triggers already exposes them to your agents. Nothing to do.");
    return;
  }

  console.log(`${plan.length} skill(s) keep their routing phrases in \`triggers:\`, which no agent reads.`);
  console.log("An explicit edit can copy them into `when_to_use:`, which is the listing your agents route on.\n");
  for (const entry of plan) {
    console.log(`  ${entry.dir}`);
    console.log(`    when_to_use: ${entry.whenToUse}`);
  }

  if (!apply) {
    console.log("\nPreview only. Edit the owned SKILL.md files explicitly, then run `dotaios skills reconcile`.");
    return;
  }
  throw new Error(
    "Managed skills cannot be rewritten by sync-triggers. Edit the owned SKILL.md files explicitly, then run `dotaios skills reconcile`."
  );
}

async function probeSkillCommand(args) {
  const options = { client: null, path: null, receipt: null, keep: false, dryRun: false, run: false, json: false, timeoutMs: 90_000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--client") {
      options.client = readOptionValue(args, index, "--client");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--receipt") {
      options.receipt = readOptionValue(args, index, "--receipt");
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = readOptionValue(args, index, "--timeout-ms");
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error("--timeout-ms must be a positive whole number");
      options.timeoutMs = Number(value);
      index += 1;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--run") {
      options.run = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown skills probe option: ${arg}`);
    }
  }

  const result = await runSkillInvocationProbe({
    ...options,
    aiosPath: options.path,
    receiptPath: options.receipt
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
  } else {
    console.log(formatProbeResult(result));
  }

  // Unsupported or deliberately skipped clients are useful evidence, not a
  // command failure. A failed attempted invocation is a failure.
  if (result.receipt.evidence.invoked === "no") process.exitCode = 1;
  if (result.receipt.evidence.invoked === "yes" && result.receipt.evidence.produced !== "yes") process.exitCode = 1;
}

async function doctorSkillCommand(args) {
  const options = { json: false, path: null, home: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else {
      throw new Error(`Unknown skills doctor option: ${arg}`);
    }
  }

  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const homePath = path.resolve(expandHome(options.home || os.homedir()));
  const report = await inspectSkillHealth({ aiosPath, homePath });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`Skills health: ${report.healthy ? "healthy" : "needs attention"}`);
    console.log(`Source: ${report.source.count} skill(s) in ${report.source.path}`);
    console.log(`Catalogs: INDEX=${report.catalogs.index.current ? "fresh" : "stale"}, RESOLVER=${report.catalogs.resolver.current ? "fresh" : "stale"}`);
    for (const target of report.targets) {
      console.log(`${target.dir}: linked=${target.linked.length} missing=${target.missing.length} foreign=${target.foreign.length} broken=${target.broken.length}`);
    }
    for (const runtime of report.runtimes) {
      const capabilities = runtime.capabilities;
      console.log(`${runtime.name}: configured=${capabilities.configured} projected=${capabilities.projected} discoverable=${capabilities.discoverable} binary=${capabilities.binary} invocation=${capabilities.invocation} produced=${capabilities.produced}`);
    }
    console.log(`Verification scope: ${report.verification.scope}; invocation=${report.verification.invocation}`);
    for (const issue of report.issues) console.log(`- ${issue}`);
  }
  if (!report.healthy) process.exitCode = 1;
}

async function resolveSkillCommand(args) {
  const options = parseResolveOptions(args);
  const aiosPath = path.resolve(expandHome(options.path || defaultAiosPath()));
  const skillsDir = path.join(aiosPath, "skills");
  const skills = await collectSkills(aiosPath);

  if (options.bootContext) {
    process.stdout.write(`${renderBootContext(skills, { skillsDir })}\n`);
    return;
  }

  if (!options.intent) {
    console.error(`Pass an intent to resolve, e.g. dotaios skills resolve "plan my day".`);
    console.error(`Or print a boot block: dotaios skills resolve --boot-context.`);
    process.exitCode = 2;
    return;
  }

  const ranked = rankSkills(options.intent, skills, { skillsDir });

  if (ranked.length === 0) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ intent: options.intent, matches: [] }, null, 2)}\n`);
    } else {
      console.error(`No skill matched: ${options.intent}`);
      console.error(`Run "dotaios skills" to list installed skills.`);
    }
    process.exitCode = 2;
    return;
  }

  const limit = options.all ? ranked.length : Math.max(1, options.limit);
  const matches = ranked.slice(0, limit);

  if (options.json) {
    const payload = {
      intent: options.intent,
      matches: matches.map((entry) => ({
        name: entry.name,
        dir: entry.dir,
        description: entry.description,
        triggers: entry.triggers,
        score: round(entry.score),
        reason: entry.reason,
        skillPath: entry.skillPath
      }))
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (options.all) {
    for (const entry of matches) {
      printMatchHeader(entry);
    }
    return;
  }

  const top = matches[0];
  printMatchHeader(top);
  if (options.full) {
    let body;
    try {
      body = await fs.readFile(top.skillPath, "utf8");
    } catch {
      console.error(`Could not read skill file: ${top.skillPath}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`\n${body}`);
  }
}

function printMatchHeader(entry) {
  const confidence = entry.score >= 100 ? 1 : Math.min(1, entry.score);
  console.log(`${entry.name} — ${entry.description || "(no description)"}`);
  console.log(`  dir:       ${entry.dir}`);
  console.log(`  confidence: ${confidence.toFixed(2)} (${entry.reason})`);
  if (entry.triggers.length) {
    console.log(`  triggers:  ${entry.triggers.join(" · ")}`);
  }
  console.log(`  run:       ${entry.skillPath}`);
}

function parseResolveOptions(args) {
  const options = { intent: null, json: false, full: false, all: false, bootContext: false, limit: 1, path: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--full") {
      options.full = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--boot-context") {
      options.bootContext = true;
    } else if (arg === "--limit") {
      options.limit = parseLimit(readOptionValue(args, index, "--limit"));
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  options.intent = positional.join(" ").trim() || null;
  return options;
}

function parseLimit(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid --limit "${value}". Use a positive whole number.`);
  }
  return Number(value);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function listSkills(skills) {
  if (skills.length === 0) {
    console.log("No skills installed.");
    console.log("Add a reviewed local folder: dotaios skill add <local-folder>");
    return;
  }

  console.log(`${skills.length} skill${skills.length === 1 ? "" : "s"} installed:\n`);
  for (const skill of skills) {
    if (skill.description) {
      console.log(`  ${skill.name} — ${skill.description}`);
    } else {
      console.log(`  ${skill.name}`);
    }
  }
  console.log('\nAsk your agent: "use the <skill-name> skill"');
}

async function showSkill(aiosPath, skills, query) {
  const match = skills.find(
    (skill) =>
      skill.name.toLowerCase() === query.toLowerCase() ||
      skill.dir.toLowerCase() === query.toLowerCase()
  );

  if (!match) {
    console.error(`No skill found: ${query}`);
    console.error(`Run "dotaios skills" to list installed skills.`);
    process.exitCode = 1;
    return;
  }

  const skillFile = path.join(aiosPath, "skills", match.dir, "SKILL.md");
  let content;
  try {
    content = await fs.readFile(skillFile, "utf8");
  } catch {
    console.error(`Could not read skill file: ${skillFile}`);
    process.exitCode = 1;
    return;
  }

  console.log(content);
}

function extractPath(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

function extractName(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path") {
      i++;
    } else if (!args[i].startsWith("--")) {
      result.push(args[i]);
    }
  }
  return result.join(" ").trim();
}
