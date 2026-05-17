import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { hasHelpFlag } from "../lib/args.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { pathExists } from "../../../core/src/files.mjs";
import { collectSkills } from "../../../core/src/skills.mjs";
import { initCommand } from "./init.mjs";
import { activateCommand } from "./activate.mjs";
import { revealCommand } from "./reveal.mjs";

const HELP_TEXT = `Usage:
  dotaios setup [options]

The fastest path from zero to a working DotAIOS. Runs init, activate, and
reveal in sequence and prints what to do next.

Options:
  --path <dir>        Create AIOS somewhere other than ~/aios
  --vault-path <dir>  Use an external vault for long-term knowledge
  --yes, -y           Use placeholder answers for non-interactive setup
  --skip-reveal       Do not open the folder when finished
  --force             Add missing files, preserving existing files
  --overwrite         Replace generated files in the target folder
`;

export async function setupCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const passthrough = args.filter((arg) => arg !== "--skip-reveal");
  const skipReveal = args.includes("--skip-reveal");
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  const aiosPath = path.resolve(expandHome(extractPath(args) || defaultAiosPath()));

  console.log("DotAIOS setup — step 1 of 3: create your folder");
  console.log("");
  try {
    await initCommand(passthrough);
  } catch (err) {
    console.error(`Step 1 failed: ${err.message}`);
    console.error("Re-run: dotaios init to retry this step.");
    console.error("");
    console.error("Setup could not complete. Fix the error above, then re-run: dotaios setup");
    return;
  }

  // Step 2: activate (requires aios.json from init)
  console.log("");
  console.log("DotAIOS setup — step 2 of 3: connect your AI tools");
  console.log("");
  try {
    await activateCommand(passthrough);
  } catch (err) {
    console.error(`Step 2 failed: ${err.message}`);
    console.error("Re-run: dotaios activate to retry connecting your tools.");
    console.error("");
  }

  // Step 3: reveal (best-effort, never blocks)
  if (!skipReveal) {
    console.log("");
    console.log("DotAIOS setup — step 3 of 3: open the folder");
    console.log("");
    try {
      await revealCommand(passthrough);
    } catch (error) {
      console.error(`(skipped reveal: ${error.message})`);
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
  console.log("All set. To get started:");
  console.log("  1. Open your AI agent — Claude Code, Codex, Gemini CLI, Cursor, or any other.");
  console.log("  2. Open the ~/aios folder or make it your working directory.");
  console.log('  3. Ask: "Read my context and tell me what I am working on."');
  console.log("  4. Update context any time: dotaios interview --review");
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
