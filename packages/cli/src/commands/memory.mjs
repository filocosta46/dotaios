import path from "node:path";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { applySkillPatchCandidates, auditMemory, renderMemoryAudit, writeSkillPatchQueue } from "../../../core/src/memory-audit.mjs";
import { applyPromotion, planPromotion, renderPromotionPreview } from "../../../core/src/promotion.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios memory audit [options]
  dotaios memory promote <session-id> --to <destination> --summary <text> [options]

Subcommands:
  audit     Review hot memory against the skills-over-memory rule
  promote   Preview or apply one captured session fact to one destination

Promotion destinations:
  signal | context | project | vault | skill | session-only

Options:
  --path <dir>       Use an AIOS folder other than ~/aios

Audit options:
  --line-budget <n>  Warn when hot files exceed n lines (default 200)
  --max-candidates <n>  Maximum skill candidates to show/write (default 25)
  --all-memory       Scan all events/signals instead of routed hot memory
  --write-queue      Write memory/skill-patches/queue.md
  --apply-skills     Append explicit lessons to existing skills/<name>/SKILL.md
  --json             Print the raw report as JSON

Promotion options:
  --to <type>           Choose exactly one destination type
  --destination <path>  Relative Markdown path for context/project/vault/skill
  --project <name>      Add project provenance; defaults project to README.md
  --summary <text>      Exact fact, state, or procedure to append
  --apply               Write after showing the preview (default: preview only)

Examples:
  dotaios memory promote a1b2c3d4 --to signal --summary "Waiting for design review"
  dotaios memory promote a1b2c3d4 --to context --destination context/work.md \\
    --summary "Prefers written handoffs" --apply
  dotaios memory promote a1b2c3d4 --to project --project atlas \\
    --summary "The beta ships Friday" --apply
`;

export async function memoryCommand(args) {
  if (args.length === 0 || (hasHelpFlag(args) && !args[0]?.match(/^(audit|promote)$/))) {
    console.log(HELP_TEXT);
    return;
  }

  const [subcommand, ...subcommandArgs] = args;
  if (hasHelpFlag(subcommandArgs)) {
    console.log(HELP_TEXT);
    return;
  }

  if (subcommand === "audit") return runAudit(subcommandArgs);
  if (subcommand === "promote") return runPromotion(subcommandArgs);
  throw new Error(`Unknown memory subcommand: ${subcommand}. Try \`dotaios memory --help\`.`);
}

async function runAudit(args) {
  const options = parseAuditOptions(args);

  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const report = await auditMemory(target, {
    lineBudget: options.lineBudget,
    maxQueueCandidates: options.maxCandidates,
    memoryScope: options.allMemory ? "all" : "hot"
  });
  let queueResult = null;
  if (options.writeQueue) {
    queueResult = await writeSkillPatchQueue(target, report);
  }
  let applyResult = null;
  if (options.applySkills) {
    applyResult = await applySkillPatchCandidates(target, report);
  }

  if (options.json) {
    console.log(JSON.stringify({
      ...report,
      ...(queueResult && { queue: queueResult }),
      ...(applyResult && { applied: applyResult })
    }, null, 2));
  } else {
    console.log(renderMemoryAudit(report));
    if (queueResult) {
      console.log("");
      console.log(`Wrote ${queueResult.count} candidate(s) to ${queueResult.path}`);
    }
    if (applyResult) {
      console.log("");
      console.log(`Applied ${applyResult.applied} candidate(s) to existing skills (${applyResult.unchanged} unchanged, ${applyResult.skipped} skipped).`);
    }
  }
}

async function runPromotion(args) {
  const options = parsePromotionOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const plan = await planPromotion(target, {
    source: options.source,
    destinationType: options.destinationType,
    destinationPath: options.destinationPath,
    project: options.project,
    summary: options.summary
  });

  console.log(renderPromotionPreview(plan));
  if (!options.apply) {
    console.log("\nPreview only. No files changed. Re-run with --apply when this looks right.");
    return;
  }

  const result = await applyPromotion(plan);
  if (result.destinationType === "session-only") {
    console.log("\nRecorded as session-only evidence. No durable knowledge file was created.");
  } else {
    console.log(`\nApplied promotion to ${result.destinationPath}.`);
  }
  console.log(`Receipt appended to ${result.receiptPath}.`);
}

function parseAuditOptions(args = []) {
  const options = { path: null, lineBudget: 200, maxCandidates: 25, allMemory: false, writeQueue: false, applySkills: false, json: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--line-budget") {
      const value = Number(readOptionValue(args, index, "--line-budget"));
      if (!Number.isInteger(value) || value <= 0) throw new Error("--line-budget requires a positive integer");
      options.lineBudget = value;
      index += 1;
    } else if (arg === "--max-candidates") {
      const value = Number(readOptionValue(args, index, "--max-candidates"));
      if (!Number.isInteger(value) || value <= 0) throw new Error("--max-candidates requires a positive integer");
      options.maxCandidates = value;
      index += 1;
    } else if (arg === "--all-memory") {
      options.allMemory = true;
    } else if (arg === "--write-queue") {
      options.writeQueue = true;
    } else if (arg === "--apply-skills") {
      options.applySkills = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parsePromotionOptions(args = []) {
  const options = {
    apply: false,
    destinationPath: null,
    destinationType: null,
    path: null,
    positionals: [],
    project: null,
    source: null,
    summary: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--source") {
      options.source = readOptionValue(args, index, "--source");
      index += 1;
    } else if (arg === "--to") {
      if (options.destinationType) throw new Error("Choose one destination with --to.");
      options.destinationType = readOptionValue(args, index, "--to");
      index += 1;
    } else if (arg === "--destination" || arg === "--target") {
      options.destinationPath = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--project") {
      options.project = readOptionValue(args, index, "--project");
      index += 1;
    } else if (arg === "--summary") {
      options.summary = readOptionValue(args, index, "--summary");
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }

  if (options.source && options.positionals.length > 0) {
    throw new Error("Choose the source once: use a session ID or --source, not both.");
  }
  if (options.positionals.length > 1) {
    throw new Error("memory promote accepts one captured session ID.");
  }
  options.source ||= options.positionals[0] || null;
  return options;
}
