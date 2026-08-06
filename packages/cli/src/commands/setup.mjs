import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assertUniqueOptions, hasHelpFlag } from "../lib/args.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { pathExists } from "../../../core/src/files.mjs";
import { parseJsonlLine } from "../../../core/src/jsonl.mjs";
import { schemaVersion } from "../../../core/src/schema.mjs";
import { processBirthToken, processRecordIsAlive } from "../../../core/src/process-identity.mjs";
import { collectSkills } from "../../../core/src/skills.mjs";
import {
  MANAGED_END,
  MANAGED_START,
  bridgePath,
  findManagedBlock,
  isAgentInstalled,
  loadAgentRegistry
} from "../../../core/src/bridges.mjs";
import { wellKnownSymlinkTargets } from "../../../core/src/skill-targets.mjs";
import {
  LIGHTPANDA_VERSION,
  downloadLightpanda,
  lightpandaPlatformBinary,
  resolveLightpanda
} from "../../../core/src/lightpanda.mjs";
import { initCommand } from "./init.mjs";
import { activateCommand, plannedActivationConfigPatch } from "./activate.mjs";
import { revealCommand } from "./reveal.mjs";
import {
  emitReliabilityMetric,
  reliabilityMetricsDir,
  reliabilityMetricsFile
} from "../lib/reliability-metrics.mjs";

const HELP_TEXT = `Usage:
  dotaios setup [options]

The fastest path from zero to a working DotAIOS. Runs init, activate, and
reveal in sequence and prints what to do next.

Options:
  --path <dir>        Create AIOS somewhere other than ~/aios
  --vault-path <dir>  Use an external vault for long-term knowledge
  --yes, -y           Use placeholder answers for non-interactive setup
  --dry-run           Preview files, trust boundaries, and removal without changes
  --skip-reveal       Do not open the folder when finished
  --install-lightpanda
                      Install the optional verified browser helper
  --force             Add missing files, preserving existing files
  --overwrite         Replace generated files in the target folder
`;

const SETUP_TRANSACTION_FILE = ".dotaios-setup-transaction.json";
const SETUP_TRANSACTION_FORMAT = "dotaios-setup-transaction/v1";

export async function setupCommand(args, { lifecycle = {} } = {}) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  assertUniqueOptions(args, ["--path", "--vault-path"]);

  const passthrough = args.filter((arg) => !["--dry-run", "--skip-reveal", "--install-lightpanda"].includes(arg));
  const skipReveal = args.includes("--skip-reveal");
  const installLightpandaRequested = args.includes("--install-lightpanda");
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const aiosPath = path.resolve(expandHome(extractPath(args) || defaultAiosPath()));
  if (args.includes("--dry-run")) {
    await printSetupPreview(aiosPath, args);
    return;
  }
  const startedAt = Date.now();
  const runId = randomUUID();
  let setupTransactionActive = false;

  console.log("DotAIOS setup — step 1 of 3: create your folder");
  console.log("");
  try {
    // init creates the ~/aios folder that holds the metrics store, so the
    // init phase markers can only be written once init has succeeded.
    setupTransactionActive = await runInitWithRecovery(passthrough, aiosPath, lifecycle);
    await lifecycle.afterInit?.({ aiosPath, setupTransactionActive });
    if (setupTransactionActive) {
      await assertCompletedSetupTransactionTree(aiosPath, setupTransactionActive.transaction, passthrough);
    }
    await emitReliabilityMetric(aiosPath, { type: "setup_phase_start", phase: "init", run_id: runId });
    await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "init", run_id: runId, outcome: "ok" });
    await emitReliabilityMetric(aiosPath, { type: "install_start", command: "setup", run_id: runId });
  } catch (err) {
    // createAios: false — a metric must never be the thing that creates the
    // folder a failed install did not. Otherwise the retry this very message
    // recommends trips over the wreckage of the attempt that printed it.
    if (err.code !== "SETUP_ACTIVE") {
      const dropIfMissing = { createAios: false };
      await emitReliabilityMetric(aiosPath, { type: "setup_phase_start", phase: "init", run_id: runId }, dropIfMissing);
      await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "init", run_id: runId, outcome: "fail" }, dropIfMissing);
      await emitReliabilityMetric(aiosPath, {
        type: "install_end",
        command: "setup",
        outcome: "fail",
        phase: "init",
        run_id: runId,
        duration_ms: Date.now() - startedAt
      }, dropIfMissing);
    }
    console.error(`Step 1 failed: ${err.message}`);
    console.error("");
    console.error("Setup could not complete. Fix the error above, then re-run the identical `dotaios setup` command.");
    process.exitCode = 1;
    return;
  }

  // Step 2: activate (requires aios.json from init)
  let activateOk = true;
  let configuredContextCount = 0;
  let detectedClientCount = 0;
  let blockedContextCount = 0;
  let blockedCatalogCount = 0;
  console.log("");
  console.log("DotAIOS setup — step 2 of 3: connect your AI tools");
  console.log("");
  await emitReliabilityMetric(aiosPath, { type: "setup_phase_start", phase: "activate", run_id: runId });
  try {
    const activation = await activateCommand(passthrough, {
      lifecycle: {
        ...lifecycle.activation,
        skillsIndexWriteMode: passthrough.includes("--overwrite") ? "overwrite" : "preserve"
      }
    });
    detectedClientCount = activation.detectedClientCount;
    configuredContextCount = activation.configuredContextCount;
    blockedContextCount = activation.blockedContextCount;
    blockedCatalogCount = activation.blockedCatalogCount;
    if (blockedContextCount > 0 || blockedCatalogCount > 0) {
      activateOk = false;
      process.exitCode = 1;
    }
    const outcome = activateOk ? (configuredContextCount > 0 ? "ok" : "warn") : "fail";
    await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "activate", run_id: runId, outcome });
  } catch (err) {
    activateOk = false;
    process.exitCode = 1;
    await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "activate", run_id: runId, outcome: "fail" });
    console.error(`Step 2 failed: ${err.message}`);
    console.error("Fix the reported problem, then re-run the identical `dotaios setup` command.");
    console.error("");
  }
  if (!activateOk) {
    console.log("");
    console.log("Folder created. Tool connection needs attention; setup stopped before optional features.");
    if (blockedContextCount > 0 || blockedCatalogCount > 0) {
      console.log(`Preserved ${blockedContextCount} client bridge collision(s) and ${blockedCatalogCount} skill catalog collision(s).`);
    }
    console.log("Fix the reported collision, then re-run the identical `dotaios setup` command.");
    await emitReliabilityMetric(aiosPath, {
      type: "install_end",
      command: "setup",
      outcome: "fail",
      phase: "activate",
      run_id: runId,
      duration_ms: Date.now() - startedAt
    });
    return;
  }

  if (setupTransactionActive) {
    if (!await unlinkSetupMarkerTempIfSameFile(
      setupTransactionPath(aiosPath),
      setupTransactionActive.markerStats
    )) {
      throw new Error("Setup recovery marker changed before completion; refusing to remove it.");
    }
  }

  // Step 3: reveal (best-effort, never blocks)
  await emitReliabilityMetric(aiosPath, { type: "setup_phase_start", phase: "reveal", run_id: runId });
  if (!skipReveal) {
    console.log("");
    console.log("DotAIOS setup — step 3 of 3: open the folder");
    console.log("");
    try {
      await revealCommand(passthrough);
      await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "reveal", run_id: runId, outcome: "ok" });
    } catch (error) {
      await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "reveal", run_id: runId, outcome: "fail" });
      console.error(`(skipped reveal: ${error.message})`);
    }
  } else {
    await emitReliabilityMetric(aiosPath, { type: "setup_phase_end", phase: "reveal", run_id: runId, outcome: "skipped" });
  }

  // GitHub cross-device sync prompt — skip in non-interactive or non-TTY mode
  if (!nonInteractive && process.stdin.isTTY) {
    let wantsSync = false;
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question("\nConnect to GitHub for cross-device access? This is optional. (y/N): ");
      wantsSync = explicitOptIn(answer);
    } finally {
      rl.close();
    }
    // Close this prompt's readline BEFORE runSetup — its token-paste step
    // temporarily owns the terminal in raw mode.
    if (wantsSync) {
      const { runSetup } = await import("../sync/setup-flow.mjs");
      try {
        // Mirror the same folder the wizard set up — honor --path.
        await runSetup(["--path", aiosPath]);
      } catch (err) {
        console.error(`Sync setup could not finish: ${err.message}`);
        console.error("You can retry later with: dotaios sync setup");
      }
    }
  }

  // Brief schedule prompt — skip in non-interactive or non-TTY mode
  if (!nonInteractive && process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      console.log("");
      const briefAnswer = await rl.question(
        "Set up a daily brief? It runs every morning and shows your priorities and active work. (y/N): "
      );
      if (explicitOptIn(briefAnswer)) {
        const enabled = await enableSchedule(aiosPath, "daily-brief");
        if (enabled) {
          console.log("Daily brief enabled. Your agent will find it in memory/daily/ each morning.");
          console.log("To have it run fully automatically: dotaios schedule install");
        }
      }

      // Session memory prompt
      console.log("");
      await promptSessionMemory(rl, aiosPath, nonInteractive);
    } finally {
      rl.close();
    }
  }

  await setupLightpanda({ nonInteractive, installRequested: installLightpandaRequested });

  // Skills summary
  const skills = await collectSkills(aiosPath);
  if (skills.length > 0) {
    console.log("");
    console.log("Installed skills:");
    const preview = skills.slice(0, 3);
    for (const skill of preview) {
      console.log(`  ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`);
    }
    if (skills.length > 3) {
      console.log(`  ...and ${skills.length - 3} more. Ask your agent: "what skills do I have?"`);
    }
  }

  console.log("");
  if (configuredContextCount === 0) {
    console.log("Folder ready. No supported local AI app was connected yet.");
    if (detectedClientCount === 0) {
      console.log("Install Claude Code, Codex, or Gemini CLI, then run `dotaios activate`.");
    } else {
      console.log("Detected tools use native or project-specific configuration; review `dotaios skills doctor`.");
    }
    console.log("To explore the folder now:");
  } else {
    console.log(`Folder ready. Connected context for ${configuredContextCount} local AI app${configuredContextCount === 1 ? "" : "s"}.`);
    console.log("To get started:");
  }
  console.log("  1. Open your AI agent — Claude Code, Codex, Gemini CLI, Cursor, or any other.");
  console.log("  2. Open the ~/aios folder or make it your working directory.");
  console.log('  3. Ask: "Read my context and tell me what I am working on."');
  console.log("  4. Update context any time: dotaios interview --review");
  await emitReliabilityMetric(aiosPath, {
    type: "install_end",
    command: "setup",
    outcome: activateOk ? (configuredContextCount > 0 ? "ok" : "warn") : "fail",
    run_id: runId,
    duration_ms: Date.now() - startedAt
  });
}

async function printSetupPreview(aiosPath, args) {
  const unsupported = [
    "--all",
    "--force",
    "--install-lightpanda",
    "--no-skills-first",
    "--overwrite",
    "--project",
    "--prune-aliases",
    "--skills-first",
    "--vault-path"
  ].find((option) => args.includes(option));
  if (unsupported) {
    console.error(`Setup --dry-run cannot safely preview the ${unsupported} option.`);
    console.error("Preview the default first-time setup with only --path and --home, or run the relevant advanced command's own preview.");
    process.exitCode = 1;
    return;
  }

  const homePath = path.resolve(expandHome(extractOption(args, "--home") || os.homedir()));
  const target = await previewSetupTarget(aiosPath);

  console.log("DotAIOS Setup preview - no DotAIOS-managed changes made");
  console.log("Scope: AIOS target, detected global bridge files, and managed skill-link directories.");
  console.log("");
  console.log("Target:");
  console.log(`${target.action} ${aiosPath}${target.note ? ` (${target.note})` : ""}`);

  console.log("");
  console.log("Detected client actions:");
  if (target.blocked) {
    console.log("[would skip] activation because setup would stop at the target check above");
    process.exitCode = 1;
  } else {
    await printClientPreview(aiosPath, homePath);
  }

  console.log("");
  console.log("Safety boundaries:");
  console.log("- Setup preserves unmanaged files; bridge collisions are reported instead of replaced.");
  console.log("- Private GitHub sync stays off unless you explicitly run `dotaios sync setup` later.");
  console.log("- DotAIOS does not copy credentials into the AIOS folder or a Git remote URL.");
  console.log("- DotAIOS does not start a hosted account or upload context to a DotAIOS service.");
  console.log("- This command does not create the AIOS folder or change client configuration or sync.");
  console.log("- When invoked through npx, npm may download and cache the named package.");
  console.log("");
  console.log("Optional prompts after core setup (all default No):");
  console.log("- Private GitHub sync: creates and connects a private mirror you control.");
  console.log("- Daily brief: enables the bundled local schedule entry.");
  console.log("- Conversation saving: may add a managed client hook; 30-day backfill reads local history into ~/aios.");
  console.log(`- Lightpanda ${LIGHTPANDA_VERSION}: downloads an optional SHA-256-verified local browser binary.`);
  console.log("");
  console.log("After setup, verify with: dotaios doctor");
  console.log("To remove it, first disable capture and sync, then remove only DotAIOS-managed bridges and archive or delete the AIOS folder. Unmanaged client configuration is left alone.");
}

async function previewSetupTarget(aiosPath) {
  let stats;
  try {
    stats = await fs.lstat(aiosPath);
  } catch (error) {
    if (error.code === "ENOENT") return { action: "[would create]" };
    return { action: "[would stop]", note: error.message, blocked: true };
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { action: "[would stop]", note: "target is not a safe directory", blocked: true };
  }

  const entries = await fs.readdir(aiosPath);
  if (entries.length === 0) return { action: "[would populate]", note: "existing empty directory" };

  return {
    action: "[would stop]",
    note: "target already exists and is not empty; inspect it with `dotaios doctor`",
    blocked: true
  };
}

async function printClientPreview(aiosPath, homePath) {
  const registry = await loadAgentRegistry(null);
  const activeSkillDirs = new Set(wellKnownSymlinkTargets().map((target) => target.dir));

  for (const agent of registry) {
    const destination = bridgePath(homePath, agent) || path.join(homePath, agent.detect);
    const installed = await isAgentInstalled(homePath, agent);
    if (!installed) {
      console.log(`[would skip] ${destination} (${agent.name} not detected)`);
      continue;
    }

    if (agent.skills?.mode === "symlink" && agent.skills.dir) {
      activeSkillDirs.add(agent.skills.dir);
    }

    if (!agent.bridge) {
      console.log(`[detected] ${destination} (${agent.name} uses native or project-specific configuration; external config is outside this preview)`);
      continue;
    }

    console.log(await previewManagedBridge(destination));
  }

  for (const relativeDir of activeSkillDirs) {
    const targetDir = path.join(homePath, relativeDir);
    const stats = await lstatIfPresent(targetDir);
    if (!stats) {
      console.log(`[would create managed skill links] ${targetDir}`);
    } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
      console.log(`[would preserve collision] ${targetDir} (not a regular directory)`);
    } else {
      console.log(`[would add missing managed skill links] ${targetDir} (existing unmanaged entries preserved)`);
    }
  }
}

async function previewManagedBridge(destination) {
  const stats = await lstatIfPresent(destination);
  if (!stats) return `[would create managed bridge] ${destination}`;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return `[would preserve collision] ${destination} (not a regular file)`;
  }

  const current = await fs.readFile(destination, "utf8");
  if (findManagedBlock(current)) {
    return `[would update managed block] ${destination} (content outside the block preserved)`;
  }
  if (current.includes(MANAGED_START) || current.includes(MANAGED_END)) {
    return `[would preserve collision] ${destination} (managed markers are malformed; no overwrite)`;
  }
  return `[would preserve collision] ${destination} (existing unmanaged file; no overwrite)`;
}

async function lstatIfPresent(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Setup owns a partial scaffold only when it started from an empty target,
// recorded the complete expected tree before createBaseTree, and every path
// left behind still matches that record. Only that narrow case gets an internal
// --force retry. The metrics-only recognizer below remains for 1.27.1 upgrades.
async function runInitWithRecovery(passthrough, aiosPath, lifecycle = {}) {
  if (await hasSetupTransaction(aiosPath)) {
    if (passthrough.includes("--force") || passthrough.includes("--overwrite")) {
      throw new Error(
        "An unfinished setup marker is present. Re-run the identical setup command without --force or --overwrite."
      );
    }
  }
  let transactionStarted = null;
  try {
    await initCommand(passthrough, {
      beforeScaffold: async (plan) => {
        transactionStarted = await beginSetupTransaction(aiosPath, passthrough, plan, lifecycle);
      },
      afterCreateBaseTree: async () => {
        if (transactionStarted) await lifecycle.afterCreateBaseTree?.({ aiosPath });
      }
    });
    if (transactionStarted) {
      await assertCompletedSetupTransactionTree(aiosPath, transactionStarted.transaction, passthrough);
    }
    return transactionStarted;
  } catch (error) {
    if (!/exists and is not empty/i.test(error.message)) throw error;
    const transaction = await readRecoverableSetupTransaction(aiosPath, passthrough);
    if (transaction) {
      await initCommand([...passthrough, "--force"], {
        plan: transaction.transaction.plan,
        allowSetupTransactionRecovery: true
      });
      await assertCompletedSetupTransactionTree(aiosPath, transaction.transaction, passthrough);
      console.log("Recovered an unfinished folder from an earlier run and completed it in place.");
      return { markerStats: transaction.markerStats, transaction: transaction.transaction };
    }
    if (!(await isFailedSetupResidue(aiosPath))) throw error;
    await initCommand([...passthrough, "--force"]);
    console.log("Recovered an unfinished folder from an earlier run and completed it in place.");
    return false;
  }
}

function setupTransactionPath(aiosPath) {
  return path.join(aiosPath, SETUP_TRANSACTION_FILE);
}

async function hasSetupTransaction(aiosPath) {
  try {
    await fs.lstat(setupTransactionPath(aiosPath));
    return true;
  } catch {
    return false;
  }
}

async function beginSetupTransaction(aiosPath, passthrough, plan, lifecycle = {}) {
  // A caller already using --force/--overwrite has explicitly chosen init's
  // preserve/replace semantics. It is not an empty first install whose residue
  // setup can later claim as its own.
  if (passthrough.includes("--force") || passthrough.includes("--overwrite")) return false;

  const existed = await pathExists(aiosPath);
  if (existed && (await fs.readdir(aiosPath)).length !== 0) {
    throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
  }

  const manifest = await expectedSetupManifest(plan);
  const processStartedAt = processBirthToken(process.pid);
  const transaction = {
    format: SETUP_TRANSACTION_FORMAT,
    target: aiosPath,
    args: passthrough,
    owner: {
      pid: process.pid,
      nonce: randomUUID(),
      created_at: new Date().toISOString(),
      ...(processStartedAt && { process_started_at: processStartedAt })
    },
    plan,
    manifest
  };

  await fs.mkdir(aiosPath, { recursive: true });
  if ((await fs.readdir(aiosPath)).length !== 0) {
    throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
  }
  if (!await cleanupPrepublicationSetupMarkerTemps(aiosPath, passthrough)) {
    throw new Error(`Setup could not safely clean its interrupted staging marker: ${aiosPath}`);
  }

  // Stage beside the target directory, not inside it. A hard interruption
  // before the exclusive link must leave the new target empty so the same
  // setup command can safely retry.
  const temporaryMarker = setupTransactionTemporaryPath(aiosPath);
  const markerPath = setupTransactionPath(aiosPath);
  await fs.writeFile(temporaryMarker, `${JSON.stringify(transaction, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  const temporaryMarkerStats = await fs.lstat(temporaryMarker);
  try {
    await lifecycle.beforePublishMarker?.({ aiosPath, markerPath });
    try {
      await fs.link(temporaryMarker, markerPath);
      await lifecycle.afterPublishMarker?.({ aiosPath, markerPath, temporaryMarker });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
      }
      throw error;
    }
  } finally {
    await unlinkSetupMarkerTempIfSameFile(temporaryMarker, temporaryMarkerStats);
  }

  const entries = await fs.readdir(aiosPath);
  if (entries.length !== 1 || entries[0] !== SETUP_TRANSACTION_FILE) {
    throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
  }
  return { markerStats: temporaryMarkerStats, transaction };
}

async function cleanupPrepublicationSetupMarkerTemps(aiosPath, passthrough) {
  const parentPath = path.dirname(aiosPath);
  let entries;
  try {
    entries = await fs.readdir(parentPath, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!isSetupTransactionTemporaryName(aiosPath, entry.name)) continue;
    const candidate = path.join(parentPath, entry.name);
    let stats;
    let transaction;
    try {
      stats = await fs.lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) continue;
      if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) continue;
      transaction = JSON.parse(await fs.readFile(candidate, "utf8"));
    } catch {
      continue;
    }
    if (!isSetupTransaction(transaction, aiosPath, passthrough)) continue;

    let expected;
    try {
      expected = await expectedSetupManifest(transaction.plan);
    } catch {
      continue;
    }
    if (JSON.stringify(expected) !== JSON.stringify(transaction.manifest)) continue;
    if (setupTransactionOwnerIsAlive(transaction.owner)) {
      throw setupActiveError(aiosPath);
    }
    if (!await unlinkSetupMarkerTempIfSameFile(candidate, stats)) return false;
  }
  return true;
}

async function readRecoverableSetupTransaction(aiosPath, passthrough) {
  const markerPath = setupTransactionPath(aiosPath);
  let transaction;
  let markerStats;
  try {
    markerStats = await fs.lstat(markerPath);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) return null;
    transaction = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    return null;
  }

  if (!isSetupTransaction(transaction, aiosPath, passthrough)) return null;
  if (setupTransactionOwnerIsAlive(transaction.owner)) {
    throw setupActiveError(aiosPath);
  }
  if (!await cleanupLinkedSetupMarkerTemps(aiosPath, markerStats)) return null;

  let expected;
  try {
    expected = await expectedSetupManifest(transaction.plan);
  } catch {
    return null;
  }
  if (JSON.stringify(expected) !== JSON.stringify(transaction.manifest)) return null;

  let actual;
  try {
    actual = await treeManifest(aiosPath, { ignoreRoot: SETUP_TRANSACTION_FILE });
  } catch {
    return null;
  }
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const extra = actual.filter((entry) => !expectedByPath.has(entry.path));
  let activationConfigEntry = null;
  try {
    activationConfigEntry = plannedActivationManifestEntry(transaction, passthrough);
  } catch {
    return null;
  }
  if (actual.some((entry) => {
    if (!expectedByPath.has(entry.path)) return false;
    if (JSON.stringify(entry) === JSON.stringify(expectedByPath.get(entry.path))) return false;
    return !activationConfigEntry || JSON.stringify(entry) !== JSON.stringify(activationConfigEntry);
  })) {
    return null;
  }
  if (!(await isRecoverableSetupMetrics(aiosPath, extra))) return null;

  return { transaction, markerStats };
}

async function assertCompletedSetupTransactionTree(aiosPath, transaction, passthrough) {
  const actual = await treeManifest(aiosPath, { ignoreRoot: SETUP_TRANSACTION_FILE });
  const expectedByPath = new Map(transaction.manifest.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const activationConfigEntry = plannedActivationManifestEntry(transaction, passthrough);

  for (const expected of transaction.manifest) {
    const observed = actualByPath.get(expected.path);
    const matchesExpected = JSON.stringify(observed) === JSON.stringify(expected);
    const matchesActivationConfig = expected.path === "aios.json"
      && activationConfigEntry
      && JSON.stringify(observed) === JSON.stringify(activationConfigEntry);
    if (!matchesExpected && !matchesActivationConfig) {
      throw new Error(`Setup-owned path changed while setup was running; preserved: ${path.join(aiosPath, expected.path)}`);
    }
  }

  const extra = actual.filter((entry) => !expectedByPath.has(entry.path));
  if (!await isRecoverableSetupMetrics(aiosPath, extra)) {
    const firstExtra = extra[0]?.path || "unknown path";
    throw new Error(`Unexpected path appeared while setup was running; preserved: ${path.join(aiosPath, firstExtra)}`);
  }
}

function plannedActivationManifestEntry(transaction, passthrough) {
  const configPatch = plannedActivationConfigPatch(passthrough);
  if (!configPatch) return null;
  const content = `${JSON.stringify({ ...transaction.plan.config, ...configPatch }, null, 2)}\n`;
  return {
    path: "aios.json",
    type: "file",
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

async function cleanupLinkedSetupMarkerTemps(aiosPath, markerStats) {
  const parentPath = path.dirname(aiosPath);
  let entries;
  try {
    entries = await fs.readdir(parentPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!isSetupTransactionTemporaryName(aiosPath, entry.name)) continue;
    const candidate = path.join(parentPath, entry.name);
    let stats;
    try {
      stats = await fs.lstat(candidate);
    } catch {
      return false;
    }
    // A pre-publication crash can leave a different private staging inode
    // beside the target. It proves no ownership and must stay untouched.
    if (stats.dev !== markerStats.dev || stats.ino !== markerStats.ino) continue;
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    if (!await unlinkSetupMarkerTempIfSameFile(candidate, markerStats)) return false;
  }
  return true;
}

function setupTransactionTemporaryPrefix(aiosPath) {
  return `.${path.basename(aiosPath)}.dotaios-setup-`;
}

function setupTransactionTemporaryPath(aiosPath) {
  return path.join(
    path.dirname(aiosPath),
    `${setupTransactionTemporaryPrefix(aiosPath)}${randomUUID()}.tmp`
  );
}

function isSetupTransactionTemporaryName(aiosPath, name) {
  const prefix = setupTransactionTemporaryPrefix(aiosPath);
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
  const id = name.slice(prefix.length, -".tmp".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function unlinkSetupMarkerTempIfSameFile(candidate, expectedStats) {
  let stats;
  try {
    stats = await fs.lstat(candidate);
  } catch {
    return false;
  }
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.dev !== expectedStats.dev
    || stats.ino !== expectedStats.ino
  ) {
    return false;
  }
  try {
    await fs.unlink(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isRecoverableSetupMetrics(aiosPath, extraEntries) {
  if (extraEntries.length === 0) return true;
  const allowed = new Set(["memory/metrics", "memory/metrics/reliability.jsonl"]);
  if (extraEntries.some((entry) => !allowed.has(entry.path))) return false;
  if (!extraEntries.some((entry) => entry.path === "memory/metrics/reliability.jsonl" && entry.type === "file")) return false;

  let lines;
  try {
    lines = (await fs.readFile(reliabilityMetricsFile(aiosPath), "utf8")).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return false;
  }
  if (lines.length === 0) return false;

  try {
    return isRecoverableTransactionMetricSequence(lines.map(parseJsonlLine));
  } catch {
    return false;
  }
}

function hasMetricKeys(metric, keys) {
  return metric
    && typeof metric === "object"
    && !Array.isArray(metric)
    && JSON.stringify(Object.keys(metric).sort()) === JSON.stringify([...keys].sort())
    && typeof metric.ts === "string"
    && !Number.isNaN(Date.parse(metric.ts))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metric.run_id || "");
}

function isRecoverableTransactionMetricSequence(metrics) {
  const groups = [];
  const seen = new Set();
  for (const metric of metrics) {
    const current = groups.at(-1);
    if (!current || current[0].run_id !== metric?.run_id) {
      if (seen.has(metric?.run_id)) return false;
      seen.add(metric?.run_id);
      groups.push([metric]);
    } else {
      current.push(metric);
    }
  }

  return groups.every((group) => {
    const [start, initEnd, install, activateStart, activateEnd, installEnd] = group;
    if (group.length > 6) return false;
    if (!hasMetricKeys(start, ["ts", "type", "phase", "run_id"])) return false;
    if (start.type !== "setup_phase_start" || start.phase !== "init") return false;
    if (!initEnd) return true;
    if (!hasMetricKeys(initEnd, ["ts", "type", "phase", "run_id", "outcome"])) return false;
    if (initEnd.type !== "setup_phase_end" || initEnd.phase !== "init" || !["ok", "fail"].includes(initEnd.outcome)) return false;

    if (initEnd.outcome === "fail") {
      if (!install) return true;
      return group.length === 3
        && hasMetricKeys(install, ["ts", "type", "command", "outcome", "phase", "run_id", "duration_ms"])
        && install.type === "install_end"
        && install.command === "setup"
        && install.phase === "init"
        && install.outcome === "fail"
        && Number.isFinite(install.duration_ms)
        && install.duration_ms >= 0;
    }

    if (!install) return true;
    if (!hasMetricKeys(install, ["ts", "type", "command", "run_id"])) return false;
    if (install.type !== "install_start" || install.command !== "setup") return false;
    if (!activateStart) return true;
    if (!hasMetricKeys(activateStart, ["ts", "type", "phase", "run_id"])) return false;
    if (activateStart.type !== "setup_phase_start" || activateStart.phase !== "activate") return false;
    if (!activateEnd) return true;
    const validActivateEnd = hasMetricKeys(activateEnd, ["ts", "type", "phase", "run_id", "outcome"])
      && activateEnd.type === "setup_phase_end"
      && activateEnd.phase === "activate"
      && ["ok", "warn", "fail"].includes(activateEnd.outcome);
    if (!validActivateEnd) return false;
    if (!installEnd) return true;
    return activateEnd.outcome === "fail"
      && hasMetricKeys(installEnd, ["ts", "type", "command", "outcome", "phase", "run_id", "duration_ms"])
      && installEnd.type === "install_end"
      && installEnd.command === "setup"
      && installEnd.outcome === "fail"
      && installEnd.phase === "activate"
      && Number.isFinite(installEnd.duration_ms)
      && installEnd.duration_ms >= 0;
  });
}

function isSetupTransaction(transaction, aiosPath, passthrough) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) return false;
  if (transaction.format !== SETUP_TRANSACTION_FORMAT || transaction.target !== aiosPath) return false;
  if (!Array.isArray(transaction.args) || transaction.args.some((arg) => typeof arg !== "string")) return false;
  if (JSON.stringify(transaction.args) !== JSON.stringify(passthrough)) return false;
  const ownerKeys = Object.keys(transaction.owner || {}).sort();
  const legacyOwnerKeys = ["created_at", "nonce", "pid"];
  const currentOwnerKeys = [...legacyOwnerKeys, "process_started_at"].sort();
  if (
    JSON.stringify(ownerKeys) !== JSON.stringify(legacyOwnerKeys)
    && JSON.stringify(ownerKeys) !== JSON.stringify(currentOwnerKeys)
  ) return false;
  if (!Number.isSafeInteger(transaction.owner.pid) || transaction.owner.pid <= 0) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transaction.owner.nonce)) return false;
  if (typeof transaction.owner.created_at !== "string" || Number.isNaN(Date.parse(transaction.owner.created_at))) return false;
  if (
    transaction.owner.process_started_at !== undefined
    && (typeof transaction.owner.process_started_at !== "string"
      || !transaction.owner.process_started_at
      || transaction.owner.process_started_at.length > 256)
  ) return false;
  if (!transaction.plan || typeof transaction.plan !== "object" || Array.isArray(transaction.plan)) return false;
  if (!isSetupPlan(transaction.plan, passthrough)) return false;
  if (!Array.isArray(transaction.manifest)) return false;
  return transaction.manifest.every((entry) =>
    entry
      && typeof entry === "object"
      && typeof entry.path === "string"
      && (entry.type === "directory" || (entry.type === "file" && typeof entry.sha256 === "string"))
  );
}

function setupTransactionOwnerIsAlive(owner, kill = process.kill.bind(process)) {
  return processRecordIsAlive(owner, { kill });
}

function setupActiveError(aiosPath) {
  const error = new Error(`Another setup is already running for ${aiosPath}.`);
  error.code = "SETUP_ACTIVE";
  return error;
}

function isSetupPlan(plan, passthrough) {
  const { config, data } = plan;
  if (!hasExactKeys(config, ["schema_version", "created_at", "ai_tools", "vault_path"])) return false;
  if (!hasExactKeys(data, [
    "user_name",
    "user_role",
    "current_work",
    "priorities",
    "ai_tools",
    "created_at",
    "vault_path"
  ])) return false;
  if (config.schema_version !== schemaVersion) return false;
  if (typeof config.created_at !== "string" || Number.isNaN(Date.parse(config.created_at))) return false;
  if (!Array.isArray(config.ai_tools) || config.ai_tools.some((tool) => typeof tool !== "string")) return false;
  if (config.vault_path !== null && typeof config.vault_path !== "string") return false;
  if (data.created_at !== config.created_at || data.vault_path !== config.vault_path) return false;
  if (JSON.stringify(data.ai_tools) !== JSON.stringify(config.ai_tools)) return false;
  if ([data.user_name, data.user_role, data.current_work, data.priorities].some((value) => typeof value !== "string")) return false;

  const vaultOption = extractOption(passthrough, "--vault-path");
  const expectedVault = vaultOption === null ? null : expandHome(vaultOption);
  return config.vault_path === expectedVault;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function extractOption(args, option) {
  let value = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && index + 1 < args.length) value = args[index + 1];
  }
  return value;
}

async function expectedSetupManifest(plan) {
  const referenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-reference-"));
  const referenceAios = path.join(referenceRoot, "aios");
  try {
    await initCommand(["--path", referenceAios, "--yes"], {
      plan,
      quiet: true,
      skipVaultTree: true
    });
    return await treeManifest(referenceAios);
  } finally {
    await fs.rm(referenceRoot, { recursive: true, force: true });
  }
}

async function treeManifest(root, { ignoreRoot = null } = {}) {
  const manifest = [];

  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!prefix && entry.name === ignoreRoot) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        manifest.push({ path: relative, type: "directory" });
        await visit(resolved, relative);
      } else if (entry.isFile()) {
        const content = await fs.readFile(resolved);
        manifest.push({ path: relative, type: "file", sha256: createHash("sha256").update(content).digest("hex") });
      } else {
        throw new Error(`Unsupported setup residue: ${relative}`);
      }
    }
  }

  await visit(root);
  return manifest;
}

async function isFailedSetupResidue(aiosPath) {
  const memoryPath = path.join(aiosPath, "memory");
  const metricsPath = reliabilityMetricsDir(aiosPath);
  const legacyMetricsPath = path.join(metricsPath, "pilot.jsonl");

  let contents;
  try {
    const rootEntries = await fs.readdir(aiosPath, { withFileTypes: true });
    if (rootEntries.length !== 1 || rootEntries[0].name !== "memory" || !rootEntries[0].isDirectory()) return false;

    const memoryEntries = await fs.readdir(memoryPath, { withFileTypes: true });
    if (memoryEntries.length !== 1 || memoryEntries[0].name !== "metrics" || !memoryEntries[0].isDirectory()) return false;

    const metricsEntries = await fs.readdir(metricsPath, { withFileTypes: true });
    if (metricsEntries.length !== 1 || metricsEntries[0].name !== "pilot.jsonl" || !metricsEntries[0].isFile()) return false;

    contents = await fs.readFile(legacyMetricsPath, "utf8");
  } catch {
    return false;
  }

  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim() === "")) return false;

  let metrics;
  try {
    metrics = lines.map(parseJsonlLine);
  } catch {
    return false;
  }

  // Compatibility for the exact 1.27.1 wreckage, verified from the tagged
  // source: one failed setup wrote these three ordered rows under one run id.
  if (metrics.length !== 3) return false;
  const [start, end, installEnd] = metrics;
  if (!hasMetricKeys(start, ["ts", "type", "phase", "run_id"])) return false;
  if (!hasMetricKeys(end, ["ts", "type", "phase", "run_id", "outcome"])) return false;
  if (!hasMetricKeys(installEnd, [
    "ts", "type", "command", "outcome", "phase", "run_id", "duration_ms"
  ])) return false;
  if (start.run_id !== end.run_id || start.run_id !== installEnd.run_id) return false;
  if (Date.parse(start.ts) > Date.parse(end.ts) || Date.parse(end.ts) > Date.parse(installEnd.ts)) return false;
  return start.type === "setup_phase_start"
    && start.phase === "init"
    && end.type === "setup_phase_end"
    && end.phase === "init"
    && end.outcome === "fail"
    && installEnd.type === "install_end"
    && installEnd.command === "setup"
    && installEnd.phase === "init"
    && installEnd.outcome === "fail"
    && Number.isFinite(installEnd.duration_ms)
    && installEnd.duration_ms >= 0;
}

async function setupLightpanda({ nonInteractive, installRequested }) {
  const existingBinary = await resolveLightpanda();
  if (existingBinary) {
    console.log("");
    console.log("✓  Web browsing engine already ready (renders JavaScript pages)");
    return;
  }

  const platformBinary = lightpandaPlatformBinary();
  if (!platformBinary) return;

  let approved = installRequested;
  if (!approved && !nonInteractive && process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      console.log("");
      const answer = await rl.question(
        `Install optional Lightpanda ${LIGHTPANDA_VERSION} for JavaScript-rendered pages? The download is SHA-256 verified. (y/N): `
      );
      approved = explicitOptIn(answer);
    } finally {
      rl.close();
    }
  }

  if (!approved) {
    console.log("");
    console.log("   Web browsing engine: not installed (optional; plain fetch remains available)");
    return;
  }

  console.log("");
  const result = await downloadLightpanda({ platformBinary, confirmed: true });
  if (result.ok) {
    console.log("✓  Web browsing engine ready (renders JavaScript pages)");
    return;
  }

  console.log(`   Web browsing engine install failed (${result.reason}). Plain fetch remains available.`);
}

async function promptSessionMemory(rl, aiosPath, nonInteractive) {
  if (nonInteractive) return;

  let detected;
  try {
    const { detectAdapters } = await import("../adapters/detect.mjs");
    detected = await detectAdapters();
  } catch {
    return;
  }

  const capable = Object.entries(detected).filter(([, info]) => info.detected);
  if (capable.length === 0) {
    console.log("Tip: save any AI conversation manually any time: dotaios capture import paste");
    return;
  }

  const autoSave = capable.filter(([, info]) => info.level === "full-auto").map(([n]) => n);
  const importOnly = capable.filter(([, info]) => info.level === "backfill-only").map(([n]) => n);
  const manualOnly = capable.filter(([, info]) => info.level === "manual-assist").map(([n]) => n);

  const foundParts = [];
  if (autoSave.length) foundParts.push(`${autoSave.join(", ")} (auto-save)`);
  if (importOnly.length) foundParts.push(`${importOnly.join(", ")} (import only)`);
  if (manualOnly.length) foundParts.push(`${manualOnly.join(", ")} (paste/import only)`);

  console.log(`Save AI conversations locally so other agents can remember them?`);
  console.log(`  Found on this machine: ${foundParts.join(", ")}`);

  const answer = await rl.question("  Enable conversation saving? (y/N): ");
  if (!explicitOptIn(answer)) return;

  for (const name of autoSave) {
    try {
      const { enableAdapter } = await import("../adapters/detect.mjs");
      await enableAdapter(name, aiosPath);
    } catch (err) {
      console.log(`  (could not enable ${name}: ${err.message})`);
    }
  }

  if (autoSave.length > 0) {
    const backfillAnswer = await rl.question("  Import past conversations from the last 30 days? (y/N): ");
    if (explicitOptIn(backfillAnswer)) {
      for (const name of autoSave) {
        try {
          if (name === "claude-code") {
            const { importClaudeCode } = await import("../adapters/claude-code.mjs");
            await importClaudeCode(aiosPath);
          }
        } catch (err) {
          console.log(`  (could not import ${name}: ${err.message})`);
        }
      }
    }
  }

  if (importOnly.length > 0 || manualOnly.length > 0) {
    console.log("  Tip: save any conversation manually: dotaios capture import paste");
  }
}

// Find the value of --path in the args array.
function extractPath(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

// Set enabled: true for a named schedule entry in schedules.yml.
async function enableSchedule(aiosPath, scheduleName) {
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  if (!await pathExists(schedulesPath)) return false;

  const content = await fs.readFile(schedulesPath, "utf8");
  const lines = content.split("\n");
  let inTarget = false;
  let changed = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === `- name: ${scheduleName}` || trimmed === `name: ${scheduleName}`) {
      inTarget = true;
    } else if (inTarget && trimmed.startsWith("- name:")) {
      inTarget = false;
    }
    if (inTarget && trimmed === "enabled: false") {
      changed = true;
      return line.replace("enabled: false", "enabled: true");
    }
    return line;
  });

  if (!changed) {
    console.log(`  (could not enable ${scheduleName} automatically — edit schedules.yml and set enabled: true under the "${scheduleName}" entry)`);
    return false;
  }

  await fs.writeFile(schedulesPath, updated.join("\n"));
  return true;
}

export { enableSchedule };

export function explicitOptIn(answer) {
  return ["y", "yes"].includes(String(answer || "").trim().toLowerCase());
}
