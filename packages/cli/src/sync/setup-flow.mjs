import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { syncConfigPath } from "../../../core/src/paths.mjs";
import { writeSyncConfig, readSyncConfig } from "../../../core/src/sync-config.mjs";
import { buildTokenCreateUrl, validateToken } from "./auth.mjs";
import {
  buildCreateRepoUrl,
  githubRepoIdentity,
  plainRemoteUrl,
  pollForRepoExists,
  initialMirrorPush,
  verifyRepoPrivate
} from "./repo.mjs";
import { createGit } from "./git.mjs";
import { readOptionValue } from "../lib/args.mjs";
import { readSecretInput } from "../lib/secret-input.mjs";
import { withOperationLock } from "./operation-lock.mjs";

const SETUP_RECEIPT_FORMAT = "dotaios-sync-setup-receipt/v1";
const SETUP_LOCK_FILENAME = "sync.lock";

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
  return readSecretInput();
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
  verifyInitialUpload,
  preflightLocalBranch = async () => {},
  preflightLocalOrigin = async () => {},
  log = console.log
}) {
  // A local branch mismatch is knowable before authentication. Refuse it before
  // asking the user for a token or opening any GitHub setup page.
  await preflightLocalBranch();

  log("Step 1/4 - Connect your GitHub account");
  const tokenUrl = buildTokenCreateUrl();
  log(`  -> Opening ${tokenUrl} in your browser...`);
  log(`  -> On that page, click "Generate token" at the bottom, then copy the token.`);
  await openInBrowser(tokenUrl);
  const accessToken = (await readToken()).trim();
  const username = await validateTokenImpl({ accessToken });
  const fullName = `${username}/${username}-aios`;
  // The expected identity is known only after GitHub returns the username. Do
  // this check immediately, before persisting the token or opening the repo page.
  await preflightLocalOrigin({ fullName });
  await writeConfig({
    access_token: accessToken,
    username,
    installed_at: new Date().toISOString()
  });
  log(`  Connected as @${username}`);

  log("");
  log("Step 2/4 - Create your memory repo");
  const createUrl = buildCreateRepoUrl(username);
  log(`  -> Opening ${createUrl} in your browser...`);
  log(`  -> Click "Create repository" on GitHub's page (we don't create it for you).`);
  log(`  -> Leave every "Initialize this repository" option OFF: no README, no .gitignore, no license.`);
  await openInBrowser(createUrl);
  const repoState = await pollForRepoExistsImpl({ accessToken, fullName });
  await writeConfig({
    repo_full_name: fullName,
    repo_url: `https://github.com/${fullName}.git`
  });
  log(`  Repo ready: ${fullName} (private)`);

  log("");
  log("Step 3/4 - Initial upload");
  const pushedSha = await initialMirrorPushImpl({
    aiosPath,
    accessToken,
    fullName,
    gitignoreContent,
    repoState: repoState?.state || "empty"
  });
  if (!/^[0-9a-f]{40}$/i.test(pushedSha || "")) {
    throw new Error("Initial upload did not produce a verifiable Git commit receipt.");
  }
  log("  Files pushed");

  log("");
  log("Step 4/4 - Verify sync setup");
  await verifyInitialUpload({ expectedSha: pushedSha, accessToken, fullName });
  await writeConfig({
    last_push_sha: pushedSha,
    setup_intended_push: null,
    setup_intended_push_sha: null,
    last_error: null
  });
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

async function hasGitMetadata(aiosPath, filesystem) {
  try {
    await filesystem.lstat(path.join(aiosPath, ".git"));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function preflightSetupBranch({
  aiosPath,
  filesystem = fs,
  createGitImpl = createGit
}) {
  if (!await hasGitMetadata(aiosPath, filesystem)) return;
  const branch = await createGitImpl({ cwd: aiosPath }).currentBranch();
  if (branch !== "main") {
    throw new Error(`Existing Git repository is on ${branch || "an unknown branch"}; sync setup requires main and changed nothing.`);
  }
}

export async function preflightSetupOrigin({
  aiosPath,
  fullName,
  filesystem = fs,
  createGitImpl = createGit
}) {
  if (!await hasGitMetadata(aiosPath, filesystem)) return;
  const git = createGitImpl({ cwd: aiosPath });
  try {
    const originIdentity = githubRepoIdentity(await git.originUrl());
    if (originIdentity !== githubRepoIdentity(plainRemoteUrl(fullName))) {
      throw new Error("Existing Git origin does not match the private sync repository; setup changed nothing.");
    }
  } catch (error) {
    // A fresh local repository may not have an origin yet. The populated-remote
    // adoption check later refuses that state once GitHub's state is known.
    if (!/could not read Git origin/i.test(error.message)) throw error;
  }
}

export async function withSetupLock(callback, {
  lockPath = path.join(path.dirname(syncConfigPath()), SETUP_LOCK_FILENAME),
  filesystem = fs
} = {}) {
  const result = await withOperationLock(lockPath, callback, { filesystem });
  if (!result.acquired) {
    throw new Error("Another sync operation is already running. Wait for it to finish, then retry.");
  }
  return result.value;
}

function validSetupReceipt(receipt, expected) {
  return receipt
    && typeof receipt === "object"
    && !Array.isArray(receipt)
    && receipt.format === SETUP_RECEIPT_FORMAT
    && /^[0-9a-f]{40}$/i.test(receipt.sha || "")
    && receipt.aios_path === expected.aiosPath
    && receipt.repo_identity === expected.repoIdentity
    && receipt.branch === "main";
}

// Finish a first mirror upload or adopt the exact upload from an interrupted
// setup. Every local-repository identity check happens before initialMirrorPush
// can touch .gitignore, Git metadata, or the remote.
export async function completeInitialMirror({
  aiosPath,
  accessToken,
  fullName,
  gitignoreContent,
  repoState,
  filesystem = fs,
  createGitImpl = createGit,
  readConfig = readSyncConfig,
  writeConfig = writeSyncConfig,
  initialMirrorPushImpl = initialMirrorPush
}) {
  const expectedIdentity = githubRepoIdentity(plainRemoteUrl(fullName));
  const canonicalAiosPath = await filesystem.realpath(aiosPath);
  const hasLocalGit = await hasGitMetadata(aiosPath, filesystem);
  let preserveExistingOrigin = false;

  const inspectionGit = createGitImpl({ cwd: aiosPath });
  if (hasLocalGit) {
    const branch = await inspectionGit.currentBranch();
    if (branch !== "main") {
      throw new Error(`Existing Git repository is on ${branch || "an unknown branch"}; sync setup requires main and changed nothing.`);
    }
    try {
      const originIdentity = githubRepoIdentity(await inspectionGit.originUrl());
      if (originIdentity !== expectedIdentity) {
        throw new Error("Existing Git origin does not match the private sync repository; setup changed nothing.");
      }
      preserveExistingOrigin = true;
    } catch (error) {
      if (!/could not read Git origin/i.test(error.message)) throw error;
      if (repoState === "populated") {
        throw new Error("Existing populated mirror has no matching local origin; setup changed nothing.");
      }
    }
  } else if (repoState === "populated") {
    throw new Error("The private repository is populated, but this folder has no matching local Git mirror to adopt.");
  }

  if (repoState === "populated") {
    const config = await readConfig();
    const receipt = config?.setup_intended_push;
    if (!validSetupReceipt(receipt, {
      aiosPath: canonicalAiosPath,
      repoIdentity: expectedIdentity
    })) {
      throw new Error("The private repository is populated without a matching unfinished-upload receipt; setup will not overwrite or adopt it.");
    }
    const credentialedGit = createGitImpl({
      cwd: aiosPath,
      accessToken,
      expectedRepoFullName: fullName
    });
    const remoteSha = await credentialedGit.remoteHead("main");
    if (remoteSha !== receipt.sha || !await inspectionGit.isAncestor(receipt.sha, "HEAD")) {
      throw new Error("The populated mirror does not match this setup's intended upload; setup changed nothing.");
    }
    return receipt.sha;
  }

  const git = createGitImpl({ cwd: aiosPath, accessToken, expectedRepoFullName: fullName });
  return initialMirrorPushImpl({
    aiosPath,
    fullName,
    gitignoreContent,
    git,
    preserveExistingOrigin,
    recordIntendedSha: (sha) => writeConfig({
      setup_intended_push: {
        format: SETUP_RECEIPT_FORMAT,
        sha,
        aios_path: canonicalAiosPath,
        repo_identity: expectedIdentity,
        branch: "main"
      }
    })
  });
}

export async function verifyInitialMirror({
  aiosPath,
  expectedSha,
  accessToken,
  fullName,
  verifyPrivate = verifyRepoPrivate,
  createGitImpl = createGit
}) {
  // Privacy can change after the repo page is polled and before the push ends.
  // Require a fresh authenticated privacy result before claiming success.
  await verifyPrivate({ accessToken, fullName });
  const remoteSha = await createGitImpl({
    cwd: aiosPath,
    accessToken,
    expectedRepoFullName: fullName
  }).remoteHead("main");
  if (remoteSha !== expectedSha) {
    throw new Error("Remote main does not match the uploaded commit; setup stopped without claiming success.");
  }
}

// Runs the setup flow. THROWS on failure — the caller owns the exit code.
// `dotaios sync setup` treats a failure as a non-zero exit; the optional sync
// step inside `dotaios setup` catches it and lets the wizard finish cleanly,
// so an optional sub-step can never fail the whole setup.
export async function runSetup(args = [], {
  orchestrate = orchestrateSetup,
  lock = withSetupLock
} = {}) {
  const aiosPath = path.resolve(expandHome(readPathOption(args) || defaultAiosPath()));
  const gitignoreContent = await loadGitignoreTemplate();

  await lock(() => orchestrate({
    aiosPath,
    gitignoreContent,
    readToken: defaultReadToken,
    validateToken: ({ accessToken }) => validateToken({ accessToken }),
    writeConfig: (patch) => writeSyncConfig(patch),
    openInBrowser: async (url) => defaultOpenInBrowser(url),
    preflightLocalBranch: () => preflightSetupBranch({ aiosPath }),
    preflightLocalOrigin: ({ fullName }) => preflightSetupOrigin({ aiosPath, fullName }),
    pollForRepoExists,
    initialMirrorPush: completeInitialMirror,
    verifyInitialUpload: (options) => verifyInitialMirror({ aiosPath, ...options })
  }));
}
