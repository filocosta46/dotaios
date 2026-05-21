import { hasHelpFlag } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios sync <subcommand> [options]

Cross-device sync of your ~/aios/ folder to a private GitHub repo.

Subcommands:
  setup       One-time: connect GitHub, create your repo, push the first mirror
  tick        Run one commit+pull+push cycle (runs automatically; safe to run manually)
  status      Show last tick time, repo URL, errors
  logout      Sign out of GitHub (keeps your repo on GitHub)
  repo        Print the URL of your DotAIOS repo

Options:
  --path <dir>   Use a non-default AIOS folder
`;

export async function syncCommand(args = []) {
  if (!args.length || hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const [sub, ...rest] = args;

  if (sub === "setup") {
    const { runSetup } = await import("../sync/setup-flow.mjs");
    return runSetup();
  }
  if (sub === "tick") {
    const { runTickCommand } = await import("../sync/tick-cmd.mjs");
    return runTickCommand(rest);
  }
  if (sub === "status") {
    const { runStatus } = await import("../sync/status-cmd.mjs");
    return runStatus(rest);
  }
  if (sub === "logout") {
    const { runLogout } = await import("../sync/logout-cmd.mjs");
    return runLogout(rest);
  }
  if (sub === "repo") {
    const { runRepo } = await import("../sync/repo-cmd.mjs");
    return runRepo(rest);
  }

  console.error(`Unknown sync subcommand: ${sub}`);
  console.log(HELP_TEXT);
  process.exitCode = 1;
}
