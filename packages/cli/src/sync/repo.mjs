import fs from "node:fs/promises";
import path from "node:path";

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

// A body we cannot parse must not be read as consent. Callers treat null as
// "unknown", which fails closed.
async function readJsonSafe(res) {
  try {
    return typeof res.json === "function" ? await res.json() : null;
  } catch {
    return null;
  }
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
      if (repo?.private !== true) {
        throw new Error(
          `the repo ${fullName} is public. DotAIOS will not sync your personal ` +
          `context to a public repository. On github.com open the repo, go to ` +
          `Settings, and change its visibility to Private — then re-run ` +
          `"dotaios sync setup".`
        );
      }
      // Repo exists. Confirm it is EMPTY — pushing the initial mirror to a repo
      // that already has commits (the user ticked "Add a README" etc. on the
      // create page) is rejected non-fast-forward, and setup would die with a
      // cryptic git error. GitHub returns 409 for the commits of an empty repo.
      const commits = await fetchImpl(
        `https://api.github.com/repos/${fullName}/commits`,
        { headers }
      );
      if (commits.status === 409) return true; // empty — as expected
      if (commits.ok) {
        throw new Error(
          `the repo ${fullName} was created with files already in it. On github.com, ` +
          `delete that repo, then re-run "dotaios sync setup" — and this time leave ` +
          `every "Initialize this repository" option (README, .gitignore, license) unchecked.`
        );
      }
      return true; // any other status — proceed; the push will surface real errors
    }
    await sleep(intervalSec);
  }
  throw new Error(`timed out waiting for repo ${fullName} to be created on GitHub`);
}

export async function initialMirrorPush({
  aiosPath,
  accessToken,
  fullName,
  gitignoreContent,
  git,
  filesystem = fs
}) {
  // 1. Write the .gitignore (overwriting if exists).
  await filesystem.writeFile(path.join(aiosPath, ".gitignore"), gitignoreContent);

  // 2. Init git repo on default branch "main" if not already.
  await git.init();

  // 3. Set the plain remote — the token authenticates via git's credential
  //    helper (git was constructed with accessToken), never via the URL.
  await git.addRemote(plainRemoteUrl(fullName));

  // 4. Add + commit everything.
  const sha = await git.commitAll("Initial DotAIOS mirror");

  // 5. Push.
  await git.push("main");

  return sha;
}
