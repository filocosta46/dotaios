import { readSyncConfig } from "../../../core/src/sync-config.mjs";

export function renderStatus(cfg) {
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
  return lines.join("\n");
}

export async function runStatus() {
  const cfg = await readSyncConfig();
  console.log(renderStatus(cfg));
}
