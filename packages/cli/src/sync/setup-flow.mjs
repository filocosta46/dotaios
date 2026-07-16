import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { defaultAiosPath, expandHome, syncConfigPath } from "../../../core/src/paths.mjs";
import { writeSyncConfig, readSyncConfig } from "../../../core/src/sync-config.mjs";
import { buildTokenCreateUrl, validateToken } from "./auth.mjs";
import { buildCreateRepoUrl, pollForRepoExists, initialMirrorPush } from "./repo.mjs";
import { createGit } from "./git.mjs";
import { runTick } from "./tick.mjs";
import { readOptionValue } from "../lib/args.mjs";

// Parse `--path <dir>` from args; undefined when absent.
function readPathOption(args) {
  const index = args.indexOf("--path");
  if (index === -1) return undefined;
  return readOptionValue(args, index, "--path");
}

function defaultOpenInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "cmd"  :
                                    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort — the URL is also printed to the console
  }
}

async function defaultReadToken() {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question("  Paste your token here, then press Enter: ");
  } finally {
    rl.close();
  }
}

async function loadGitignoreTemplate() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // packages/cli/src/sync/ -> repo-root/templates/sync-gitignore.template
  const tplPath = path.resolve(here, "../../../../templates/sync-gitignore.template");
  return fs.readFile(tplPath, "utf8");
}

export async function orchestrateSetup({
  aiosPath,
  gitignoreContent,
  readToken,
  validateToken: validateTokenImpl,
  writeConfig,
  openInBrowser,
  pollForRepoExists: pollForRepoExistsImpl,
  initialMirrorPush: initialMirrorPushImpl,
  runFirstTick,
  log = console.log
}) {
  log("Step 1/4 - Connect your GitHub account");
  const tokenUrl = buildTokenCreateUrl();
  log(`  -> Opening ${tokenUrl} in your browser...`);
  log(`  -> On that page, click "Generate token" at the bottom, then copy the token.`);
  await openInBrowser(tokenUrl);
  const accessToken = (await readToken()).trim();
  const username = await validateTokenImpl({ accessToken });
  await writeConfig({
    access_token: accessToken,
    username,
    installed_at: new Date().toISOString()
  });
  log(`  Connected as @${username}`);

  log("");
  log("Step 2/4 - Create your memory repo");
  const fullName = `${username}/${username}-aios`;
  const createUrl = buildCreateRepoUrl(username);
  log(`  -> Opening ${createUrl} in your browser...`);
  log(`  -> Click "Create repository" on GitHub's page (we don't create it for you).`);
  log(`  -> Leave every "Initialize this repository" option OFF: no README, no .gitignore, no license.`);
  await openInBrowser(createUrl);
  await pollForRepoExistsImpl({ accessToken, fullName });
  await writeConfig({
    repo_full_name: fullName,
    repo_url: `https://github.com/${fullName}.git`
  });
  log(`  Repo ready: ${fullName} (private)`);

  log("");
  log("Step 3/4 - Initial upload");
  await initialMirrorPushImpl({ aiosPath, accessToken, fullName, gitignoreContent });
  log("  Files pushed");

  log("");
  log("Step 4/4 - Verify sync setup");
  await runFirstTick();
  log("  Setup verified. Sync is manual by default.");

  log("");
  log("Your private memory repo is ready. Sync is optional and manual by default.");
  log("A legacy automatic hook exists only through an explicit opt-in in a controlled main worktree.");
  log("Run `dotaios sync now` whenever you want to pull and push changes.");
  log("To read the repo from your phone:");
  log("");
  log("  Recommended (free): claude.ai -> Projects -> New -> link your repo. Tap \"Sync now\" before asking.");
  log("  Also free, when your computer is awake: ChatGPT mobile linked to Codex.");
  log("  No-AI fallback: install GitHub Mobile to browse and edit the repo by hand.");
}

// Runs the setup flow. THROWS on failure — the caller owns the exit code.
// `dotaios sync setup` treats a failure as a non-zero exit; the optional sync
// step inside `dotaios setup` catches it and lets the wizard finish cleanly,
// so an optional sub-step can never fail the whole setup.
export async function runSetup(args = [], { orchestrate = orchestrateSetup } = {}) {
  const aiosPath = path.resolve(expandHome(readPathOption(args) || defaultAiosPath()));
  const gitignoreContent = await loadGitignoreTemplate();

  await orchestrate({
    aiosPath,
    gitignoreContent,
    readToken: defaultReadToken,
    validateToken: ({ accessToken }) => validateToken({ accessToken }),
    writeConfig: (patch) => writeSyncConfig(patch),
    openInBrowser: async (url) => defaultOpenInBrowser(url),
    pollForRepoExists,
    initialMirrorPush: async ({ aiosPath: p, accessToken, fullName, gitignoreContent: g }) => {
      const git = createGit({ cwd: p });
      const sha = await initialMirrorPush({ aiosPath: p, accessToken, fullName, gitignoreContent: g, git });
      // Record the first push so `sync status` is accurate before any tick.
      if (sha) await writeSyncConfig({ last_push_sha: sha });
    },
    runFirstTick: async () => {
      const git = createGit({ cwd: aiosPath });
      const lockPath = path.join(path.dirname(syncConfigPath()), "sync.lock");
      await runTick({
        lockPath,
        readConfig: () => readSyncConfig(),
        writeConfig: (patch) => writeSyncConfig(patch),
        makeGit: () => git,
        appendEvent: async () => {},
        now: () => Date.now()
      });
    }
  });
}
