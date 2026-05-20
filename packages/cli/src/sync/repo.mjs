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

export function remoteUrlWithToken(accessToken, fullName) {
  return `https://x-access-token:${accessToken}@github.com/${fullName}.git`;
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
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dotaios-sync"
      }
    });
    if (res.ok) return true;
    await sleep(intervalSec);
  }
  throw new Error(`timed out waiting for repo ${fullName} to be created on GitHub`);
}

export async function initialMirrorPush({
  aiosPath,
  accessToken,
  fullName,
  gitignoreContent,
  git
}) {
  // 1. Write the .gitignore (overwriting if exists).
  await fs.writeFile(path.join(aiosPath, ".gitignore"), gitignoreContent);

  // 2. Init git repo on default branch "main" if not already.
  await git.init();

  // 3. Set remote with token-embedded URL.
  await git.addRemote(remoteUrlWithToken(accessToken, fullName));

  // 4. Add + commit everything.
  await git.commitAll("Initial DotAIOS mirror");

  // 5. Push.
  await git.push("main");
}
