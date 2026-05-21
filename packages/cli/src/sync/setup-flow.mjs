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
  log(`  -> Opening github.com/new (pre-filled) in your browser...`);
  log(`  -> Click "Create repository" on GitHub's page (we don't create it for you).`);
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
  log("Step 4/4 - Keep it in sync");
  await runFirstTick();
  log("  Sync runs after every dotaios command and at the start/end of every agent session.");

  log("");
  log("Your memory now syncs automatically. To read it from your phone:");
  log("");
  log("  Recommended (free): claude.ai -> Projects -> New -> link your repo. Tap \"Sync now\" before asking.");
  log("  Also free, when your computer is awake: ChatGPT mobile linked to Codex.");
  log("  No-AI fallback: install GitHub Mobile to browse and edit the repo by hand.");
}

export async function runSetup() {
  const aiosPath = path.resolve(expandHome(defaultAiosPath()));
  const gitignoreContent = await loadGitignoreTemplate();

  try {
    await orchestrateSetup({
      aiosPath,
      gitignoreContent,
      readToken: defaultReadToken,
      validateToken: ({ accessToken }) => validateToken({ accessToken }),
      writeConfig: (patch) => writeSyncConfig(patch),
      openInBrowser: async (url) => defaultOpenInBrowser(url),
      pollForRepoExists,
      initialMirrorPush: async ({ aiosPath: p, accessToken, fullName, gitignoreContent: g }) => {
        const git = createGit({ cwd: p });
        await initialMirrorPush({ aiosPath: p, accessToken, fullName, gitignoreContent: g, git });
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
  } catch (err) {
    console.error(`Sync setup failed: ${err.message}`);
    console.error("You can retry with: dotaios sync setup");
    process.exitCode = 1;
  }
}
