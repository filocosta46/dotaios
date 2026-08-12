import path from "node:path";
import { createHash } from "node:crypto";
import { appendMetric, readJsonLines } from "../../../core/src/metrics.mjs";
import { pathExists } from "../../../core/src/files.mjs";

const RELIABILITY_FILE = "reliability.jsonl";
const LEGACY_METRICS_FILE = "pilot.jsonl";

export function reliabilityMetricsDir(aiosPath) {
  return path.join(aiosPath, "memory", "metrics");
}

export function reliabilityMetricsFile(aiosPath) {
  return path.join(reliabilityMetricsDir(aiosPath), RELIABILITY_FILE);
}

function legacyMetricsFile(aiosPath) {
  return path.join(reliabilityMetricsDir(aiosPath), LEGACY_METRICS_FILE);
}

// `createAios: false` drops the metric instead of writing it when the AIOS
// folder does not exist yet. `appendMetric` creates the metrics directory, so
// an unguarded emit after a failed install could leave setup-blocking residue.
export async function emitReliabilityMetric(aiosPath, payload, { createAios = true } = {}) {
  try {
    if (!createAios && !(await pathExists(aiosPath))) return false;
    await appendMetric(reliabilityMetricsFile(aiosPath), payload);
    return true;
  } catch {
    // Metrics are best-effort and must never block CLI flows.
    return false;
  }
}

export function hashMetricValue(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export async function readReliabilityMetrics(aiosPath) {
  const [legacyRows, currentRows] = await Promise.all([
    readJsonLines(legacyMetricsFile(aiosPath)),
    readJsonLines(reliabilityMetricsFile(aiosPath)),
  ]);
  return [...legacyRows, ...currentRows];
}

export async function reliabilityMetricsSummary(aiosPath) {
  const rows = await readReliabilityMetrics(aiosPath);
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
