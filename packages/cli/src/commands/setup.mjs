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
import { collectSkills } from "../../../core/src/skills.mjs";
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
  emitPilotMetric,
  pilotMetricsDir,
  pilotMetricsFile
} from "../lib/pilot-metrics.mjs";

const HELP_TEXT = `Usage:
  dotaios setup [options]

The fastest path from zero to a working DotAIOS. Runs init, activate, and
reveal in sequence and prints what to do next.

Options:
  --path <dir>        Create AIOS somewhere other than ~/aios
  --vault-path <dir>  Use an external vault for long-term knowledge
  --yes, -y           Use placeholder answers for non-interactive setup
  --skip-reveal       Do not open the folder when finished
  --install-lightpanda
                      Install the optional verified browser helper
  --force             Add missing files, preserving existing files
  --overwrite         Replace generated files in the target folder
`;

const SETUP_TRANSACTION_FILE = ".dotaios-setup-transaction.json";
const SETUP_TRANSACTION_FORMAT = "dotaios-setup-transaction/v1";

export async function setupCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  assertUniqueOptions(args, ["--path", "--vault-path"]);

  const passthrough = args.filter((arg) => !["--skip-reveal", "--install-lightpanda"].includes(arg));
  const skipReveal = args.includes("--skip-reveal");
  const installLightpandaRequested = args.includes("--install-lightpanda");
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const aiosPath = path.resolve(expandHome(extractPath(args) || defaultAiosPath()));
  const startedAt = Date.now();
  const runId = randomUUID();
  let setupTransactionActive = false;

  console.log("DotAIOS setup — step 1 of 3: create your folder");
  console.log("");
  try {
    // init creates the ~/aios folder that holds the metrics store, so the
    // init phase markers can only be written once init has succeeded.
    setupTransactionActive = await runInitWithRecovery(passthrough, aiosPath);
    await emitPilotMetric(aiosPath, { type: "setup_phase_start", phase: "init", run_id: runId });
    await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "init", run_id: runId, outcome: "ok" });
    await emitPilotMetric(aiosPath, { type: "install_start", command: "setup", run_id: runId });
    if (setupTransactionActive && process.env.DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT === "1") {
      process.kill(process.pid, "SIGKILL");
    }
  } catch (err) {
    // createAios: false — a metric must never be the thing that creates the
    // folder a failed install did not. Otherwise the retry this very message
    // recommends trips over the wreckage of the attempt that printed it.
    if (!(await hasSetupTransaction(aiosPath))) {
      const dropIfMissing = { createAios: false };
      await emitPilotMetric(aiosPath, { type: "setup_phase_start", phase: "init", run_id: runId }, dropIfMissing);
      await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "init", run_id: runId, outcome: "fail" }, dropIfMissing);
      await emitPilotMetric(aiosPath, {
        type: "install_end",
        command: "setup",
        outcome: "fail",
        phase: "init",
        run_id: runId,
        duration_ms: Date.now() - startedAt
      }, dropIfMissing);
    }
    console.error(`Step 1 failed: ${err.message}`);
    console.error("Re-run: dotaios init to retry this step.");
    console.error("");
    console.error("Setup could not complete. Fix the error above, then re-run: dotaios setup");
    process.exitCode = 1;
    return;
  }

  // Step 2: activate (requires aios.json from init)
  let activateOk = true;
  let configuredContextCount = 0;
  console.log("");
  console.log("DotAIOS setup — step 2 of 3: connect your AI tools");
  console.log("");
  await emitPilotMetric(aiosPath, { type: "setup_phase_start", phase: "activate", run_id: runId });
  try {
    const activation = await activateCommand(passthrough);
    configuredContextCount = activation.configuredContextCount;
    const outcome = configuredContextCount > 0 ? "ok" : "warn";
    await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "activate", run_id: runId, outcome });
  } catch (err) {
    activateOk = false;
    process.exitCode = 1;
    await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "activate", run_id: runId, outcome: "fail" });
    console.error(`Step 2 failed: ${err.message}`);
    console.error("Re-run: dotaios activate to retry connecting your tools.");
    console.error("");
  }
  if (setupTransactionActive) {
    await fs.unlink(setupTransactionPath(aiosPath));
  }

  // Step 3: reveal (best-effort, never blocks)
  await emitPilotMetric(aiosPath, { type: "setup_phase_start", phase: "reveal", run_id: runId });
  if (!skipReveal) {
    console.log("");
    console.log("DotAIOS setup — step 3 of 3: open the folder");
    console.log("");
    try {
      await revealCommand(passthrough);
      await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "reveal", run_id: runId, outcome: "ok" });
    } catch (error) {
      await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "reveal", run_id: runId, outcome: "fail" });
      console.error(`(skipped reveal: ${error.message})`);
    }
  } else {
    await emitPilotMetric(aiosPath, { type: "setup_phase_end", phase: "reveal", run_id: runId, outcome: "skipped" });
  }

  // GitHub cross-device sync prompt — skip in non-interactive or non-TTY mode
  if (!nonInteractive && process.stdin.isTTY) {
    let wantsSync = false;
    const rl = readline.createInterface({ input, output });
    try {
      const answer = (await rl.question("\nConnect to GitHub for cross-device access? This is optional. (y/N): "))
        .trim()
        .toLowerCase();
      wantsSync = answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
    // Close this prompt's readline BEFORE runSetup — its token-paste step
    // opens its own readline, and two interfaces on one stdin clash.
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
        "Set up a daily brief? It runs every morning and shows your priorities and active work. (Y/n): "
      );
      if (!briefAnswer.trim() || briefAnswer.trim().toLowerCase() === "y") {
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
  if (!activateOk) {
    console.log("Folder created. Tool connection needs attention — run `dotaios activate` to finish.");
    console.log("Once connected, to get started:");
  } else if (configuredContextCount === 0) {
    console.log("Folder ready. No supported local AI app was connected yet.");
    console.log("Install Claude Code, Codex, or Gemini CLI, then run `dotaios activate`.");
    console.log("To explore the folder now:");
  } else {
    console.log(`Folder ready. Connected context for ${configuredContextCount} local AI app${configuredContextCount === 1 ? "" : "s"}.`);
    console.log("To get started:");
  }
  console.log("  1. Open your AI agent — Claude Code, Codex, Gemini CLI, Cursor, or any other.");
  console.log("  2. Open the ~/aios folder or make it your working directory.");
  console.log('  3. Ask: "Read my context and tell me what I am working on."');
  console.log("  4. Update context any time: dotaios interview --review");
  await emitPilotMetric(aiosPath, {
    type: "install_end",
    command: "setup",
    outcome: activateOk ? (configuredContextCount > 0 ? "ok" : "warn") : "fail",
    run_id: runId,
    duration_ms: Date.now() - startedAt
  });
}

// Setup owns a partial scaffold only when it started from an empty target,
// recorded the complete expected tree before createBaseTree, and every path
// left behind still matches that record. Only that narrow case gets an internal
// --force retry. The metrics-only recognizer below remains for 1.27.1 upgrades.
async function runInitWithRecovery(passthrough, aiosPath) {
  let transactionStarted = false;
  try {
    await initCommand(passthrough, {
      beforeScaffold: async (plan) => {
        transactionStarted = await beginSetupTransaction(aiosPath, passthrough, plan);
      },
      afterCreateBaseTree: async () => {
        if (transactionStarted && process.env.DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE === "1") {
          throw new Error("injected setup interruption after createBaseTree");
        }
      }
    });
    return transactionStarted;
  } catch (error) {
    if (!/exists and is not empty/i.test(error.message)) throw error;
    const transaction = await readRecoverableSetupTransaction(aiosPath, passthrough);
    if (transaction) {
      await initCommand([...passthrough, "--force"], { plan: transaction.plan });
      console.log("Recovered an unfinished folder from an earlier run and completed it in place.");
      return true;
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

async function beginSetupTransaction(aiosPath, passthrough, plan) {
  // A caller already using --force/--overwrite has explicitly chosen init's
  // preserve/replace semantics. It is not an empty first install whose residue
  // setup can later claim as its own.
  if (passthrough.includes("--force") || passthrough.includes("--overwrite")) return false;

  const existed = await pathExists(aiosPath);
  if (existed && (await fs.readdir(aiosPath)).length !== 0) {
    throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
  }

  const manifest = await expectedSetupManifest(plan);
  const transaction = {
    format: SETUP_TRANSACTION_FORMAT,
    target: aiosPath,
    args: passthrough,
    plan,
    manifest
  };

  await fs.mkdir(aiosPath, { recursive: true });
  if ((await fs.readdir(aiosPath)).length !== 0) {
    throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
  }

  const temporaryMarker = path.join(aiosPath, `.dotaios-setup-${randomUUID()}.tmp`);
  const markerPath = setupTransactionPath(aiosPath);
  await fs.writeFile(temporaryMarker, `${JSON.stringify(transaction, null, 2)}\n`, { flag: "wx" });
  try {
    if (process.env.DOTAIOS_TEST_RACE_SETUP_MARKER === "1") {
      await fs.writeFile(markerPath, "foreign marker bytes\n", { flag: "wx" });
    }
    try {
      await fs.link(temporaryMarker, markerPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
      }
      throw error;
    }
  } finally {
    await fs.unlink(temporaryMarker).catch(() => {});
  }

  const entries = await fs.readdir(aiosPath);
  if (entries.length !== 1 || entries[0] !== SETUP_TRANSACTION_FILE) {
    throw new Error(`Target changed while setup was preparing it: ${aiosPath}`);
  }
  return true;
}

async function readRecoverableSetupTransaction(aiosPath, passthrough) {
  const markerPath = setupTransactionPath(aiosPath);
  let transaction;
  try {
    const stats = await fs.lstat(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    transaction = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    return null;
  }

  if (!isSetupTransaction(transaction, aiosPath, passthrough)) return null;

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
    const configPatch = plannedActivationConfigPatch(passthrough);
    if (configPatch) {
      const content = `${JSON.stringify({ ...transaction.plan.config, ...configPatch }, null, 2)}\n`;
      activationConfigEntry = {
        path: "aios.json",
        type: "file",
        sha256: createHash("sha256").update(content).digest("hex")
      };
    }
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

  return transaction;
}

async function isRecoverableSetupMetrics(aiosPath, extraEntries) {
  if (extraEntries.length === 0) return true;
  const allowed = new Set(["memory/metrics", "memory/metrics/pilot.jsonl"]);
  if (extraEntries.some((entry) => !allowed.has(entry.path))) return false;
  if (!extraEntries.some((entry) => entry.path === "memory/metrics/pilot.jsonl" && entry.type === "file")) return false;

  let lines;
  try {
    lines = (await fs.readFile(pilotMetricsFile(aiosPath), "utf8")).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return false;
  }
  if (lines.length === 0) return false;

  try {
    return lines.map(parseJsonlLine).every((metric) => {
      if (!metric || typeof metric !== "object" || Array.isArray(metric)) return false;
      if (metric.type === "setup_phase_start") return ["init", "activate"].includes(metric.phase);
      if (metric.type === "setup_phase_end") {
        if (metric.phase === "init") return metric.outcome === "ok";
        return metric.phase === "activate" && ["ok", "warn", "fail"].includes(metric.outcome);
      }
      return metric.type === "install_start" && metric.command === "setup";
    });
  } catch {
    return false;
  }
}

function isSetupTransaction(transaction, aiosPath, passthrough) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) return false;
  if (transaction.format !== SETUP_TRANSACTION_FORMAT || transaction.target !== aiosPath) return false;
  if (!Array.isArray(transaction.args) || transaction.args.some((arg) => typeof arg !== "string")) return false;
  if (JSON.stringify(transaction.args) !== JSON.stringify(passthrough)) return false;
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
  const metricsPath = pilotMetricsDir(aiosPath);
  const pilotPath = pilotMetricsFile(aiosPath);

  let contents;
  try {
    const rootEntries = await fs.readdir(aiosPath, { withFileTypes: true });
    if (rootEntries.length !== 1 || rootEntries[0].name !== "memory" || !rootEntries[0].isDirectory()) return false;

    const memoryEntries = await fs.readdir(memoryPath, { withFileTypes: true });
    if (memoryEntries.length !== 1 || memoryEntries[0].name !== "metrics" || !memoryEntries[0].isDirectory()) return false;

    const metricsEntries = await fs.readdir(metricsPath, { withFileTypes: true });
    if (metricsEntries.length !== 1 || metricsEntries[0].name !== "pilot.jsonl" || !metricsEntries[0].isFile()) return false;

    contents = await fs.readFile(pilotPath, "utf8");
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

  const isFailedInitEnd = (metric) =>
    metric.type === "setup_phase_end"
      && metric.phase === "init"
      && metric.outcome === "fail";
  const isKnownFailedInitMetric = (metric) => {
    if (!metric || typeof metric !== "object" || Array.isArray(metric)) return false;
    if (metric.type === "setup_phase_start") return metric.phase === "init";
    if (isFailedInitEnd(metric)) return true;
    return metric.type === "install_end"
      && metric.command === "setup"
      && metric.phase === "init"
      && metric.outcome === "fail";
  };

  return metrics.every(isKnownFailedInitMetric) && metrics.some(isFailedInitEnd);
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
      approved = ["y", "yes"].includes(answer.trim().toLowerCase());
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

  const answer = await rl.question("  Enable conversation saving? (Y/n): ");
  if (answer.trim() && answer.trim().toLowerCase() !== "y") return;

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
    if (backfillAnswer.trim().toLowerCase() === "y") {
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
