import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultAiosPath, expandHome, syncConfigPath } from "../../../core/src/paths.mjs";
import { writeSyncConfig, readSyncConfig } from "../../../core/src/sync-config.mjs";
import { requestDeviceCode, pollForToken, fetchUsername } from "./auth.mjs";
import { buildCreateRepoUrl, pollForRepoExists, initialMirrorPush } from "./repo.mjs";
import { createGit } from "./git.mjs";
import { installHeartbeat } from "./heartbeat.mjs";
import { runTick } from "./tick.mjs";

const PLACEHOLDER_CLIENT_ID = "Iv23liUNREGISTERED_PLACEHOLDER";
const CLIENT_ID = process.env.DOTAIOS_GH_CLIENT_ID || PLACEHOLDER_CLIENT_ID;

export function isPlaceholderClientId(id) {
  return !id || id === PLACEHOLDER_CLIENT_ID;
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

async function loadGitignoreTemplate() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // packages/cli/src/sync/ -> repo-root/templates/sync-gitignore.template
  const tplPath = path.resolve(here, "../../../../templates/sync-gitignore.template");
  return fs.readFile(tplPath, "utf8");
}

export async function orchestrateSetup({
  clientId,
  aiosPath,
  gitignoreContent,
  requestDeviceCode: requestDeviceCodeImpl,
  pollForToken: pollForTokenImpl,
  fetchUsername: fetchUsernameImpl,
  writeConfig,
  openInBrowser,
  pollForRepoExists: pollForRepoExistsImpl,
  initialMirrorPush: initialMirrorPushImpl,
  installHeartbeat: installHeartbeatImpl,
  runFirstTick,
  log = console.log
}) {
  log("Step 1/4 - Sign in to GitHub");
  const dc = await requestDeviceCodeImpl({ clientId });
  log(`  -> Opening ${dc.verificationUri} in your browser...`);
  log(`  -> Enter this code: ${dc.userCode}`);
  await openInBrowser(dc.verificationUri);
  const tok = await pollForTokenImpl({ clientId, deviceCode: dc.deviceCode, intervalSec: dc.intervalSec });
  const username = await fetchUsernameImpl({ accessToken: tok.accessToken });
  await writeConfig({ client_id: clientId, access_token: tok.accessToken, username, installed_at: new Date().toISOString() });
  log(`  Signed in as @${username}`);

  log("");
  log("Step 2/4 - Create your memory repo");
  const fullName = `${username}/${username}-aios`;
  const createUrl = buildCreateRepoUrl(username);
  log(`  -> Opening github.com/new (pre-filled) in your browser...`);
  log(`  -> Click "Create repository" on GitHub's page (we don't have permission to do it for you).`);
  await openInBrowser(createUrl);
  await pollForRepoExistsImpl({ accessToken: tok.accessToken, fullName });
  await writeConfig({
    repo_full_name: fullName,
    repo_url: `https://github.com/${fullName}.git`
  });
  log(`  Repo ready: ${fullName} (private)`);

  log("");
  log("Step 3/4 - Initial upload");
  await initialMirrorPushImpl({ aiosPath, accessToken: tok.accessToken, fullName, gitignoreContent });
  log("  Files pushed");

  log("");
  log("Step 4/4 - Background sync");
  await installHeartbeatImpl();
  await runFirstTick();
  log("  Installed sync schedule (every 5 minutes + on every dotaios command)");

  log("");
  log("Your memory now syncs automatically. To access it from your phone:");
  log("");
  log("  Recommended (free): claude.ai -> Projects -> New -> link your repo. Tap \"Sync now\" before asking.");
  log("  Also free, when your Mac is awake: install ChatGPT mobile, scan the QR from Codex desktop.");
  log("  No-AI fallback: install GitHub Mobile to browse and edit the repo manually.");
}

export async function runSetup(args = []) {
  // HARD-FAIL: never let the unregistered placeholder client_id reach GitHub.
  if (isPlaceholderClientId(CLIENT_ID)) {
    console.error("GitHub App not registered yet, contact maintainer.");
    console.error("Cross-device sync needs a registered DotAIOS GitHub App. This build does not have one configured.");
    process.exitCode = 1;
    return;
  }

  const aiosPath = path.resolve(expandHome(defaultAiosPath()));
  const gitignoreContent = await loadGitignoreTemplate();

  try {
    await orchestrateSetup({
      clientId: CLIENT_ID,
      aiosPath,
      gitignoreContent,
      requestDeviceCode,
      pollForToken,
      fetchUsername,
      writeConfig: (patch) => writeSyncConfig(patch),
      openInBrowser: async (url) => defaultOpenInBrowser(url),
      pollForRepoExists,
      initialMirrorPush: async ({ aiosPath: p, accessToken, fullName, gitignoreContent: g }) => {
        const git = createGit({ cwd: p });
        await initialMirrorPush({ aiosPath: p, accessToken, fullName, gitignoreContent: g, git });
      },
      installHeartbeat: async () => installHeartbeat({ binary: process.argv0 }),
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
