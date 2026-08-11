import { spawn } from "node:child_process";
import { isSyncEnabled } from "../../../core/src/sync-config.mjs";

export function skipsPortableMirrorSync(command, args = []) {
  if (command === "brief" && (args.includes("--compact") || args.includes("--lean"))) return true;
  if (command === "search") return true;
  if (command === "capture") {
    const subcommand = args[0];
    if (["list", "status", "enable", "disable"].includes(subcommand)) return true;
    if (subcommand === "reconcile" && !args.includes("--apply")) return true;
    return false;
  }
  if (command === "skills") {
    if (args[0] === "install") return false;
    if (args[0] === "sync-triggers" && args.includes("--apply")) return false;
    return true;
  }
  if (command === "skill" && args[0] === "list") return true;
  if (command === "migrate" && !args.includes("--apply") && !args.includes("--recover")) return true;
  if (command === "project") {
    if (args[0] === "source") {
      if (args[1] === "connect" && args.includes("--yes")) return false;
      return !(args[1] === "add" && args.includes("--apply"));
    }
    return !(args[0] === "add" && (args.includes("--apply") || args.includes("--yes")));
  }
  return false;
}

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
  isSyncEnabled: isEnabledImpl = isSyncEnabled,
  allowAutoSync = process.env.DOTAIOS_ALLOW_AUTO_SYNC_HOOK === "1"
} = {}) {
  try {
    // The detached hook is unsafe on feature checkouts: it can commit, rebase,
    // or push the caller's worktree. The dedicated scoped-sync writer
    // remains the default. Opt in only from a deliberately controlled worktree.
    if (!allowAutoSync || command === "sync" || dryRun || readOnly || testContext) return;
    if (!(await isEnabledImpl())) return;
    spawnImpl(argv0, [process.argv[1], "sync", "tick"]);
  } catch {
    // best-effort. Never throw from hook.
  }
}
