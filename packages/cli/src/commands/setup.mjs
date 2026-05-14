import { hasHelpFlag } from "../lib/args.mjs";
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

  // Every flag except --skip-reveal is forwarded to all three sub-commands.
  // init/activate/reveal each ignore flags they do not recognize, so a
  // shared flag like --path reaches all of them and --vault-path reaches
  // only init without erroring elsewhere.
  const passthrough = args.filter((arg) => arg !== "--skip-reveal");
  const skipReveal = args.includes("--skip-reveal");

  console.log("DotAIOS setup — step 1 of 3: create your folder");
  console.log("");
  await initCommand(passthrough);

  console.log("");
  console.log("DotAIOS setup — step 2 of 3: connect your AI tools");
  console.log("");
  await activateCommand(passthrough);

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

  console.log("");
  console.log("All set. Next:");
  console.log("  1. Restart Claude Code / Cursor / Codex / Gemini so it picks up the new context.");
  console.log("  2. Ask your AI tool: \"What am I working on?\" — it should answer from your work.md.");
  console.log("  3. Anytime you want to update your context, run `dotaios interview --review`.");
  console.log("  4. To browse the folder again later: `dotaios reveal`.");
}
