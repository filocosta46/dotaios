import fs from "node:fs/promises";
import { syncConfigPath } from "../../../core/src/paths.mjs";
import { removeHeartbeat } from "./heartbeat.mjs";

export async function runLogout() {
  try {
    await removeHeartbeat();
  } catch (e) {
    console.error(`(heartbeat remove failed: ${e.message})`);
  }
  await fs.rm(syncConfigPath(), { force: true });
  console.log("Signed out. Your repo on GitHub is intact.");
}
