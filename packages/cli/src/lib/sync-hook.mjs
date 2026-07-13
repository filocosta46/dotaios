import { spawn } from "node:child_process";
import { isSyncEnabled } from "../../../core/src/sync-config.mjs";

function defaultSpawn(cmd, args) {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

export async function fireSyncHook({
  command,
  dryRun = false,
  readOnly = false,
  testContext = process.env.NODE_TEST_CONTEXT,
  argv0 = process.argv0,
  spawnImpl = defaultSpawn,
  isSyncEnabled: isEnabledImpl = isSyncEnabled
} = {}) {
  try {
    if (command === "sync" || dryRun || readOnly || testContext) return;
    if (!(await isEnabledImpl())) return;
    spawnImpl(argv0, [process.argv[1], "sync", "tick"]);
  } catch {
    // best-effort. Never throw from hook.
  }
}
