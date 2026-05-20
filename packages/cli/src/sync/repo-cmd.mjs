import { readSyncConfig } from "../../../core/src/sync-config.mjs";

export async function runRepo() {
  const cfg = await readSyncConfig();
  if (!cfg?.repo_full_name) {
    console.error("Sync not set up. Run: dotaios sync setup");
    process.exitCode = 1;
    return;
  }
  console.log(`https://github.com/${cfg.repo_full_name}`);
}
