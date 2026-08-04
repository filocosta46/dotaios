import path from "node:path";
import { createHash } from "node:crypto";
import { appendMetric, readJsonLines } from "../../../core/src/metrics.mjs";
import { pathExists } from "../../../core/src/files.mjs";

const PILOT_FILE = "pilot.jsonl";

export function pilotMetricsDir(aiosPath) {
  return path.join(aiosPath, "memory", "metrics");
}

export function pilotMetricsFile(aiosPath) {
  return path.join(pilotMetricsDir(aiosPath), PILOT_FILE);
}

// `createAios: false` drops the metric instead of writing it when the AIOS
// folder does not exist yet. `appendMetric` mkdir -p's the metrics directory,
// which means an unguarded emit can bring the whole folder into being — and a
// folder conjured by a *failed* install is worse than a lost metric: the
// documented retry then dies on "Target already exists and is not empty".
// Callers that run after a successful init leave the default alone.
export async function emitPilotMetric(aiosPath, payload, { createAios = true } = {}) {
  try {
    if (!createAios && !(await pathExists(aiosPath))) return false;
    await appendMetric(pilotMetricsFile(aiosPath), payload);
    return true;
  } catch {
    // Metrics are best-effort and must never block CLI flows.
    return false;
  }
}

export function hashMetricValue(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export async function readPilotMetrics(aiosPath) {
  return readJsonLines(pilotMetricsFile(aiosPath));
}

export async function pilotMetricsSummary(aiosPath) {
  const rows = await readPilotMetrics(aiosPath);
  const installEnd = rows.filter((row) => row.type === "install_end");
  const installOk = installEnd.filter((row) => row.outcome === "ok").length;
  const searchRows = rows.filter((row) => row.type === "search_run");
  return {
    total: rows.length,
    installRuns: installEnd.length,
    installSuccessRate: installEnd.length === 0 ? null : installOk / installEnd.length,
    searches: searchRows.length,
  };
}
