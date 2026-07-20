import path from "node:path";
import { defaultAiosPath, ensureAiosFolder, expandHome } from "../../../core/src/paths.mjs";
import { compactEvents, trimSignals, signalFileDate, RECENT_EVENT_LIMIT, SIGNAL_RETENTION_DAYS, isoDate } from "../../../core/src/memory.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

export async function cleanupCommand(args) {
  if (hasHelpFlag(args)) {
    printCleanupHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const eventsPath = path.join(target, "memory", "events.jsonl");
  const signalsDir = path.join(target, "memory", "signals");

  if (options.dryRun) {
    console.log("DotAIOS cleanup (dry run)\n");
  } else {
    console.log("DotAIOS cleanup\n");
  }

  // Compact events
  if (options.dryRun) {
    const { readJsonl } = await import("../../../core/src/memory.mjs");
    const events = await readJsonl(eventsPath);
    if (events.length > RECENT_EVENT_LIMIT) {
      console.log(`[events] Would archive ${events.length - RECENT_EVENT_LIMIT} events, keeping ${RECENT_EVENT_LIMIT}`);
    } else {
      console.log(`[events] ${events.length} entries — nothing to compact`);
    }
  } else {
    const result = await compactEvents(eventsPath);
    if (result.archived > 0) {
      console.log(`[events] Archived ${result.archived} entries, kept ${result.kept}`);
    } else {
      console.log(`[events] ${result.kept} entries — nothing to compact`);
    }
  }

  // Trim signals
  if (options.dryRun) {
    const fs = await import("node:fs/promises");
    let signalFiles;
    try {
      signalFiles = (await fs.readdir(signalsDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      signalFiles = [];
    }
    const cutoff = isoDate(new Date(Date.now() - SIGNAL_RETENTION_DAYS * 86400000));
    const stale = signalFiles.filter((f) => {
      const date = signalFileDate(f);
      return date && date < cutoff;
    });
    if (stale.length > 0) {
      console.log(`[signals] Would remove ${stale.length} signal file(s) older than ${SIGNAL_RETENTION_DAYS} days`);
    } else {
      console.log(`[signals] ${signalFiles.length} file(s) — none older than ${SIGNAL_RETENTION_DAYS} days`);
    }
  } else {
    const result = await trimSignals(signalsDir);
    if (result.removed > 0) {
      console.log(`[signals] Removed ${result.removed} file(s), freed ${formatBytes(result.freedBytes)}`);
    } else {
      console.log(`[signals] Nothing to trim`);
    }
  }
}

function parseOptions(args = []) {
  const options = { dryRun: false, path: null };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    }
  }

  return options;
}

function printCleanupHelp() {
  console.log(`Usage:
  dotaios cleanup [options]

Trims stale signals (>30 days) and compacts events.jsonl (archives entries
beyond the most recent 50).

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --dry-run     Show what would be cleaned without making changes
`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
