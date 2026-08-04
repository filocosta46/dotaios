import path from "node:path";
import { readSyncConfig } from "../../../core/src/sync-config.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { readOptionValue } from "../lib/args.mjs";
import { createGit } from "./git.mjs";

function readPathOption(args = []) {
  const index = args.indexOf("--path");
  if (index === -1) return undefined;
  return readOptionValue(args, index, "--path");
}

export function renderStatus(cfg, remote = null) {
  if (!cfg?.access_token) {
    return [
      "Sync is OFF.",
      "",
      "Run: dotaios sync setup"
    ].join("\n");
  }
  const lines = [
    "Sync is ON.",
    `  GitHub user:    @${cfg.username}`,
    `  Repo:           ${cfg.repo_full_name}`,
    `  Last tick:      ${cfg.last_tick_at || "(never)"}`,
    `  Last push sha:  ${cfg.last_push_sha ? cfg.last_push_sha.slice(0, 7) : "(none)"}`
  ];
  if (cfg.last_error) lines.push(`  Last error:     ${cfg.last_error}`);
  if (remote?.sha) {
    lines.push(`  Remote main sha: ${remote.sha.slice(0, 7)}`);
    if (cfg.last_error) {
      lines.push("  Remote parity: UNKNOWN (last sync failed)");
    } else if (!cfg.last_push_sha) {
      lines.push("  Remote parity: UNKNOWN (no recorded push sha)");
    } else if (cfg.last_push_sha === remote.sha) {
      lines.push("  Remote parity: MATCH");
    } else {
      lines.push(`  Remote parity: MISMATCH (cached ${cfg.last_push_sha.slice(0, 7)}, remote ${remote.sha.slice(0, 7)})`);
    }
  } else if (remote?.error) {
    lines.push(`  Remote parity: UNKNOWN (${remote.error})`);
  }
  return lines.join("\n");
}

export async function runStatus(args = [], dependencies = {}) {
  const readConfig = dependencies.readSyncConfig || readSyncConfig;
  const gitFactory = dependencies.createGit || createGit;
  const cfg = await readConfig();
  let remote = null;
  if (cfg?.access_token) {
    const aiosPath = path.resolve(expandHome(readPathOption(args) || defaultAiosPath()));
    try {
      // Plain remotes (no token in URL) need the credential helper — same as
      // tick/setup. Passing the token here is what keeps `sync status` parity
      // checks working after credential-hygiene removed embedded PATs.
      remote = {
        sha: await gitFactory({
          cwd: aiosPath,
          accessToken: cfg.access_token,
          expectedRepoFullName: cfg.repo_full_name
        }).remoteHead("main")
      };
    } catch (error) {
      remote = { error: error.message };
    }
  }
  console.log(renderStatus(cfg, remote));
}
