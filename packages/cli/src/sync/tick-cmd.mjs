import path from "node:path";
import { appendEventRecord } from "../../../core/src/memory.mjs";
import { defaultAiosPath, expandHome, syncConfigPath } from "../../../core/src/paths.mjs";
import { readSyncConfig, writeSyncConfig } from "../../../core/src/sync-config.mjs";
import { createGit } from "./git.mjs";
import { runTick, SYNC_STALLED_SUMMARY } from "./tick.mjs";
import { readOptionValue } from "../lib/args.mjs";

const LOCK_FILENAME = "sync.lock";

// Parse `--path <dir>` from args. Returns the value, or undefined if absent.
// readOptionValue(args, index, optionName) reads the value at index+1 and
// throws if it is missing — so a typed `--path` with no value surfaces loudly.
function readPathOption(args) {
  const index = args.indexOf("--path");
  if (index === -1) return undefined;
  return readOptionValue(args, index, "--path");
}

export async function appendSyncEvent(aiosPath, evt) {
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  return appendEventRecord(eventsPath, {
    ...evt,
    at: evt.at ?? new Date().toISOString()
  });
}

export async function runTickCommand(args = []) {
  const aiosPath = path.resolve(
    expandHome(readPathOption(args) || defaultAiosPath())
  );
  // Lock file lives alongside sync.json in ~/.dotaios/
  const lockPath = path.join(path.dirname(syncConfigPath()), LOCK_FILENAME);
  const result = await runTick({
    lockPath,
    readConfig: () => readSyncConfig(),
    writeConfig: (patch) => writeSyncConfig(patch),
    makeGit: (options) => createGit({ cwd: aiosPath, ...options }),
    appendEvent: (evt) => appendSyncEvent(aiosPath, evt),
    now: () => Date.now()
  });

  reportTickResult(result, args);
  return result;
}

export function reportTickResult(result, args = []) {
  const succeeded = result.outcome === "success";
  const informationalNoToken = result.skipped === "no-token";
  if (!succeeded && !informationalNoToken) {
    process.exitCode = 1;
  }

  if (args.includes("--json") || args.includes("--verbose")) {
    console.log(JSON.stringify(result));
    return;
  }

  if (succeeded && result.pushed) {
    console.log("DotAIOS is synced.");
  } else if (result.conflict || result.error || result.stalled) {
    console.log("Sync stopped safely. Your pre-existing edits were preserved.");
    console.log(`Reason: ${result.error || (result.stalled ? SYNC_STALLED_SUMMARY : "local and remote changes overlap")}`);
    if (result.event_log_error) {
      console.log(`Event log warning: ${result.event_log_error}`);
    }
    if (result.config_error) {
      console.log(`Sync state warning: ${result.config_error}`);
    }
    console.log("Fix the issue above, then run `dotaios sync now` again.");
  } else if (result.skipped === "locked") {
    console.log("Sync did not run because another sync is already running.");
    console.log("Wait for it to finish, then run `dotaios sync now` again.");
  } else if (result.skipped === "no-token") {
    console.log("Sync is not set up. Run `dotaios sync setup` when you want it.");
  } else if (result.skipped === "not-main-branch") {
    console.log("Sync did not run because this AIOS checkout is not on main.");
    console.log("Switch to the main checkout, then run `dotaios sync now` again.");
  } else if (result.skipped === "rate-limit-gap") {
    console.log("Sync did not run because it ran less than 10 seconds ago.");
    console.log("Wait a few seconds, then run `dotaios sync now` again.");
  } else if (result.skipped) {
    console.log(`Sync did not run (${result.skipped}).`);
  } else if (succeeded) {
    console.log("DotAIOS is already up to date.");
  } else {
    console.log("Sync did not complete.");
    console.log("Run `dotaios sync now` again. If it still fails, run `dotaios sync status`.");
  }
}
