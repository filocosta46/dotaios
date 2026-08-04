import fs from "node:fs/promises";
import path from "node:path";
import { nestedRepoMessage } from "./mirror-content-policy.mjs";

const REPO_DESCRIPTION = "DotAIOS personal memory mirror — synced from local ~/aios/. Auto-managed by dotaios.";

export function buildCreateRepoUrl(username) {
  const params = new URLSearchParams({
    name: `${username}-aios`,
    visibility: "private",
    description: REPO_DESCRIPTION
  });
  return `https://github.com/new?${params.toString()}`;
}

// The remote URL stored in .git/config: plain, credential-free. Authentication
// is handled by the inline credential helper in git.mjs (token via env), so no
// PAT is ever written to disk in the git config.
export function plainRemoteUrl(fullName) {
  return `https://github.com/${fullName}.git`;
}

export function githubRepoIdentity(remoteUrl) {
  let parsed;
  try {
    parsed = new URL(String(remoteUrl));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port) {
    return null;
  }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match || parsed.search || parsed.hash) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

// A body we cannot parse must not be read as consent. Callers treat null as
// "unknown", which fails closed.
async function readJsonSafe(res) {
  try {
    return typeof res.json === "function" ? await res.json() : null;
  } catch {
    return null;
  }
}

function publicRepoMessage(fullName, command) {
  return (
    `the repo ${fullName} is public. DotAIOS will not sync your personal ` +
    `context to a public repository. On github.com open the repo, go to ` +
    `Settings, and change its visibility to Private — then re-run ` +
    `"${command}".`
  );
}

function unverifiableSetupPrivacyMessage(fullName) {
  return (
    `could not verify that ${fullName} is private. DotAIOS will not upload your ` +
    `personal context until GitHub explicitly confirms the repository is private. ` +
    `Re-run "dotaios sync setup".`
  );
}

async function findNestedRepositories(root, filesystem) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await filesystem.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.name === ".git") {
        const relativeParent = path.relative(root, current);
        if (relativeParent) found.push(relativeParent.split(path.sep).join("/"));
        continue;
      }
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return found.sort();
}

async function readExistingFile(filePath, filesystem) {
  try {
    return await filesystem.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function mergeGitignore(existing, template) {
  if (existing === null) return template;
  if (!template || existing.includes(template)) return existing;
  return `${existing}${existing.endsWith("\n") ? "" : "\n"}${template}`;
}

/**
 * Verify the configured mirror's current privacy before a sync mutates Git.
 * Any response other than an explicit `private: true` is unknown and therefore
 * refused. Setup polling remains separate because a 404 there means "keep
 * waiting for the user to create the repo", not a completed sync check.
 */
export async function verifyRepoPrivate({ accessToken, fullName, fetchImpl = fetch }) {
  if (!accessToken || !fullName) {
    throw new Error("could not verify that the sync repository is private because the sync configuration is incomplete");
  }

  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dotaios-sync"
      }
    });
  } catch {
    throw new Error(`could not verify that ${fullName} is private. Sync stopped before changing Git.`);
  }

  if (!res?.ok) {
    throw new Error(`could not verify that ${fullName} is private (GitHub returned ${res?.status ?? "an unknown response"}). Sync stopped before changing Git.`);
  }

  const repo = await readJsonSafe(res);
  if (repo?.private === false) {
    throw new Error(publicRepoMessage(fullName, "dotaios sync now"));
  }
  if (repo?.private !== true) {
    throw new Error(`could not verify that ${fullName} is private. Sync stopped before changing Git.`);
  }
  return true;
}

export async function pollForRepoExists({
  accessToken,
  fullName,
  fetchImpl = fetch,
  sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000)),
  now = () => Date.now(),
  intervalSec = 3,
  timeoutMs = 5 * 60 * 1000
}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "dotaios-sync"
  };
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}`, { headers });
    if (res.ok) {
      // `visibility=private` in the create URL is only a prefill on a page the
      // user drives, and a repo can be flipped public later. Everything sync
      // carries — identity, clients, decisions, session transcripts — is
      // confidential only if this is true, so read it rather than assume it.
      // A response that does not say is treated as not-private on purpose:
      // silence must never be read as a privacy guarantee.
      const repo = await readJsonSafe(res);
      if (repo?.private === false) {
        throw new Error(publicRepoMessage(fullName, "dotaios sync setup"));
      }
      if (repo?.private !== true) {
        throw new Error(unverifiableSetupPrivacyMessage(fullName));
      }
      // Repo exists. Confirm it is EMPTY — pushing the initial mirror to a repo
      // that already has commits (the user ticked "Add a README" etc. on the
      // create page) is rejected non-fast-forward, and setup would die with a
      // cryptic git error. GitHub returns 409 for the commits of an empty repo.
      const commits = await fetchImpl(
        `https://api.github.com/repos/${fullName}/commits`,
        { headers }
      );
      if (commits.status === 409) return { state: "empty" };
      if (commits.ok) {
        return { state: "populated" };
      }
      throw new Error(`could not determine whether ${fullName} is empty; GitHub returned ${commits.status}`);
    }
    await sleep(intervalSec);
  }
  throw new Error(`timed out waiting for repo ${fullName} to be created on GitHub`);
}

export async function initialMirrorPush({
  aiosPath,
  fullName,
  gitignoreContent,
  git,
  filesystem = fs,
  recordIntendedSha = async () => {},
  preserveExistingOrigin = false
}) {
  // Refuse before touching .gitignore or Git metadata. Once Git stages a
  // nested repository it records only a gitlink pointer, never its files.
  const nestedRepositories = await findNestedRepositories(aiosPath, filesystem);
  if (nestedRepositories.length > 0) {
    throw new Error(nestedRepoMessage(nestedRepositories));
  }

  // Preserve custom rules while adding DotAIOS' sync exclusions.
  const gitignorePath = path.join(aiosPath, ".gitignore");
  const existingGitignore = await readExistingFile(gitignorePath, filesystem);
  await filesystem.writeFile(
    gitignorePath,
    mergeGitignore(existingGitignore, gitignoreContent)
  );

  // 2. Init git repo on default branch "main" if not already.
  await git.init();

  // 3. Set the plain remote — the token authenticates via git's credential
  //    helper (git was constructed with accessToken), never via the URL.
  if (!preserveExistingOrigin) {
    await git.addRemote(plainRemoteUrl(fullName));
  }

  // 4. Add + commit everything.
  const sha = await git.commitAll("Initial DotAIOS mirror") || await git.currentSha();

  // Persist the exact commit receipt before the network call. If the process
  // stops after GitHub accepts the push, an identical retry can prove and
  // adopt that upload without asking the user to delete the repository.
  await recordIntendedSha(sha);

  // 5. Push.
  await git.push("main");

  return sha;
}
