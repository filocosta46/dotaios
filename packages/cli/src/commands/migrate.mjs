import fs from "node:fs/promises";
import path from "node:path";
import {
  applyMigration,
  previewMigration,
  recoverMigration
} from "../../../core/src/migrations.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios migrate [--path <dir>]
  dotaios migrate --apply <plan-id> [--path <dir>]
  dotaios migrate --recover [plan-id] [--path <dir>]

Preview is the default and never writes. Apply accepts only the exact plan id
printed by the latest preview. Recovery rolls back an interrupted transaction.

Options:
  --path <dir>       Use an AIOS folder other than ~/aios
  --apply <plan-id>  Recompute and apply exactly this previewed plan
  --recover [id]     Recover the only interrupted plan, or the named plan
`;

export async function migrateCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));

  if (options.apply) {
    const result = await applyMigration({
      aiosPath: target,
      planId: options.apply,
      releaseVersion: await readReleaseVersion()
    });
    if (result.status === "already_applied") {
      console.log(`[ok] Plan ${result.plan_id} was already applied.`);
    } else {
      console.log(`[ok] Migrated schema ${result.from_schema_version} → ${result.to_schema_version}.`);
      console.log(`Receipt: ${result.receipt_path}`);
    }
    return;
  }

  if (options.recover !== null) {
    const result = await recoverMigration({
      aiosPath: target,
      planId: options.recover || null
    });
    if (result.status === "nothing_to_recover") {
      console.log(`[ok] No interrupted migration found. Schema ${result.schema_version} is unchanged.`);
    } else if (result.status === "already_applied") {
      console.log(`[ok] Plan ${result.plan_id} was already committed; stale transaction files were cleared.`);
    } else {
      console.log(`[ok] Recovered ${result.plan_id}; schema is ${result.schema_version}.`);
    }
    return;
  }

  const preview = await previewMigration({ aiosPath: target });
  printPreview(target, preview);
}

function parseOptions(args) {
  const options = { apply: null, path: null, recover: null };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--apply") {
      options.apply = readOptionValue(args, index, "--apply");
      index += 1;
    } else if (arg === "--recover") {
      const candidate = args[index + 1];
      options.recover = candidate && !candidate.startsWith("--") ? candidate : "";
      if (options.recover) index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.apply && options.recover !== null) {
    throw new Error("Choose either --apply or --recover, not both.");
  }
  return options;
}

function printPreview(target, preview) {
  console.log(`DotAIOS migration preview for ${target}`);
  if (preview.status === "current") {
    console.log(`[ok] Schema ${preview.schema_version} is current. No migration needed.`);
    return;
  }
  if (preview.status === "recovery_required") {
    console.log(`[blocked] Interrupted migration: ${preview.transaction_ids.join(", ")}`);
    console.log("Run `dotaios migrate --recover` before previewing or applying another plan.");
    process.exitCode = 1;
    return;
  }

  const { plan } = preview;
  console.log(`Schema: ${plan.from_schema_version} → ${plan.to_schema_version}`);
  console.log(`Plan ID: ${plan.plan_id}`);
  console.log("Changes:");
  for (const operation of plan.operations) {
    console.log(`  [${operation.action}] ${operation.path} — ${operation.summary}`);
  }
  console.log(`Protected: ${plan.protected_shelves.join(", ")} (not written)`);
  console.log("No files changed.");
  console.log(`Apply exactly this plan with: dotaios migrate --apply ${plan.plan_id}${pathOption(target)}`);
}

function pathOption(target) {
  const defaultPath = path.resolve(expandHome(defaultAiosPath()));
  return target === defaultPath ? "" : ` --path ${shellQuote(target)}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readReleaseVersion() {
  const packagePath = new URL("../../../../package.json", import.meta.url);
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version === "") {
    throw new Error("Root package.json does not contain a release version.");
  }
  return packageJson.version;
}
