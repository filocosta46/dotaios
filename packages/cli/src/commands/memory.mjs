import path from "node:path";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { applySkillPatchCandidates, auditMemory, renderMemoryAudit, writeSkillPatchQueue } from "../../../core/src/memory-audit.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios memory audit [options]

Audits hot memory against the skills-over-memory rule. It is local and
deterministic: no AI calls, no deletion, no skill rewriting.

Options:
  --path <dir>       Use an AIOS folder other than ~/aios
  --line-budget <n>  Warn when hot files exceed n lines (default 200)
  --max-candidates <n>  Maximum skill candidates to show/write (default 25)
  --all-memory       Scan all events/signals instead of routed hot memory
  --write-queue      Write memory/skill-patches/queue.md
  --apply-skills     Append explicit lessons to existing skills/<name>/SKILL.md
  --json             Print the raw report as JSON
`;

export async function memoryCommand(args) {
  if (hasHelpFlag(args) || args.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  const { subcommand, options } = parseOptions(args);
  if (subcommand !== "audit") {
    throw new Error(`Unknown memory subcommand: ${subcommand}. Try \`dotaios memory --help\`.`);
  }

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

function parseOptions(args = []) {
  const options = { path: null, lineBudget: 200, maxCandidates: 25, allMemory: false, writeQueue: false, applySkills: false, json: false };
  let subcommand = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--") && !subcommand) {
      subcommand = arg;
    } else if (arg === "--path") {
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

  return { subcommand, options };
}
