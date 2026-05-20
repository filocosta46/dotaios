import path from "node:path";
import fs from "node:fs/promises";
import { defaultAiosPath, expandHome, syncConfigPath } from "../../../core/src/paths.mjs";
import { readSyncConfig, writeSyncConfig } from "../../../core/src/sync-config.mjs";
import { createGit } from "./git.mjs";
import { runTick } from "./tick.mjs";
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

async function appendEvent(aiosPath, evt) {
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  try {
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.appendFile(
      eventsPath,
      JSON.stringify({ ...evt, at: evt.at ?? new Date().toISOString() }) + "\n"
    );
  } catch {
    // events log is best-effort — never let it break a tick
  }
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
    makeGit: () => createGit({ cwd: aiosPath }),
    appendEvent: (evt) => appendEvent(aiosPath, evt),
    now: () => Date.now()
  });

  // Quiet by default (this runs from the heartbeat + CLI hook constantly).
  // Verbose only with --verbose, for manual `dotaios sync tick --verbose`.
  if (args.includes("--verbose")) {
    console.log(JSON.stringify(result));
  }
}
