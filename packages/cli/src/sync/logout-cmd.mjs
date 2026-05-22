import fs from "node:fs/promises";
import path from "node:path";
import { syncConfigPath, defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { createGit } from "./git.mjs";
import { readOptionValue } from "../lib/args.mjs";

function readPathOption(args) {
  const index = args.indexOf("--path");
  if (index === -1) return undefined;
  return readOptionValue(args, index, "--path");
}

export async function runLogout(args = [], { configPath = syncConfigPath() } = {}) {
  const aiosPath = path.resolve(expandHome(readPathOption(args) || defaultAiosPath()));

  // The PAT is embedded in the `origin` remote URL, so it also lives in
  // <aios>/.git/config. Removing the remote strips it — otherwise a valid
  // token stays on disk after the user has been told "Signed out".
  try {
    const git = createGit({ cwd: aiosPath });
    await git.raw(["remote", "remove", "origin"]);
  } catch {
    // best-effort — no repo or no remote is fine
  }

  await fs.rm(configPath, { force: true });

  console.log("Signed out. The sync token has been removed from this computer.");
  console.log("Your repo on GitHub is intact.");
  console.log("To fully revoke the token, delete it at https://github.com/settings/tokens");
}
