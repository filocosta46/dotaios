import fs from "node:fs/promises";
import { syncConfigPath } from "../../../core/src/paths.mjs";

export async function runLogout() {
  await fs.rm(syncConfigPath(), { force: true });
  console.log("Signed out. Your repo on GitHub is intact.");
}
