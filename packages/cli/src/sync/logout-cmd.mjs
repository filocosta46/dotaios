import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { syncConfigPath, defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { createGit } from "./git.mjs";
import { readOptionValue } from "../lib/args.mjs";
import { withOperationLock } from "./operation-lock.mjs";
import { githubRepoIdentity, plainRemoteUrl } from "./repo.mjs";
import { assertRepositoryBinding } from "./repository-binding.mjs";

const SYNC_LOCK_FILENAME = "sync.lock";

async function readValidatedLogoutConfig(configPath, filesystem) {
  let expectedStats;
  try {
    expectedStats = await filesystem.lstat(configPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Sync config is not a private regular file; sync config was kept.");
  }
  if (
    !expectedStats.isFile()
    || expectedStats.isSymbolicLink()
    || expectedStats.nlink !== 1
    || expectedStats.size > 1024 * 1024
  ) {
    throw new Error("Sync config is not a private regular file; sync config was kept.");
  }
  let handle;
  try {
    handle = await filesystem.open(
      configPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Sync config is not a private regular file; sync config was kept.");
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.size > 1024 * 1024
      || stats.dev !== expectedStats.dev
      || stats.ino !== expectedStats.ino
    ) {
      throw new Error("Sync config is not a private regular file; sync config was kept.");
    }
    const parsed = JSON.parse(await handle.readFile("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Sync config is malformed; sync config was kept.");
    }
    return parsed;
  } catch (error) {
    if (/sync config was kept/i.test(error.message)) throw error;
    throw new Error("Sync config is malformed; sync config was kept.");
  } finally {
    await handle.close().catch(() => {});
  }
}

function originBelongsToConfig(originUrl, config) {
  const expectedIdentity = githubRepoIdentity(plainRemoteUrl(config?.repo_full_name || ""));
  if (!expectedIdentity || githubRepoIdentity(originUrl) !== expectedIdentity) return false;
  let parsed;
  try {
    parsed = new URL(originUrl);
  } catch {
    return false;
  }
  if (!parsed.username && !parsed.password) return true;
  let username;
  let password;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    return false;
  }
  return username === "x-access-token"
    && typeof config.access_token === "string"
    && config.access_token.length > 0
    && password === config.access_token;
}

function readPathOption(args) {
  const index = args.indexOf("--path");
  if (index === -1) return undefined;
  return readOptionValue(args, index, "--path");
}

export async function runLogout(args = [], {
  configPath = syncConfigPath(),
  filesystem = fs,
  createGitImpl = createGit,
  assertBindingImpl = assertRepositoryBinding,
  lock = withOperationLock
} = {}) {
  const aiosPath = path.resolve(expandHome(readPathOption(args) || defaultAiosPath()));
  const lockPath = path.join(path.dirname(configPath), SYNC_LOCK_FILENAME);

  const result = await lock(lockPath, async () => {
    const config = await readValidatedLogoutConfig(configPath, filesystem);
    // Remove the local mirror connection before deleting its sync config. Old
    // installs may also still have a credential embedded in this remote.
    const git = createGitImpl({ cwd: aiosPath });
    let binding;
    try {
      binding = await assertBindingImpl({
        aiosPath,
        git,
        filesystem,
        allowMissing: true
      });
    } catch (error) {
      throw new Error(`${error.message} Sync config was kept.`);
    }
    if (binding) {
      const origin = await git.raw(["remote", "get-url", "origin"]);
      if (origin.code === 0) {
        if (binding.kind === "linked-worktree") {
          throw new Error("Logout refused to remove a shared linked-worktree origin; sync config was kept.");
        }
        if (!originBelongsToConfig(origin.stdout.trim(), config)) {
          throw new Error("Local Git origin does not match the configured private sync repository; sync config was kept.");
        }
        const removed = await git.raw(["remote", "remove", "origin"]);
        if (removed.code !== 0) {
          throw new Error("Could not remove the local Git origin; sync config was kept.");
        }
      } else {
        const remotes = await git.raw(["remote"]);
        if (remotes.code !== 0) {
          throw new Error("Could not inspect the local Git repository; sync config was kept.");
        }
        if (remotes.stdout.split(/\r?\n/).includes("origin")) {
          throw new Error("Could not verify the local Git origin; sync config was kept.");
        }
      }
    }

    await filesystem.rm(configPath, { force: true });
  }, { filesystem });

  if (!result.acquired) {
    throw new Error("Another sync operation is already running. Wait for it to finish, then retry logout.");
  }

  console.log("Signed out. The sync token has been removed from this computer.");
  console.log("Your repo on GitHub is intact.");
  console.log("To fully revoke the token, delete it at https://github.com/settings/tokens");
}
