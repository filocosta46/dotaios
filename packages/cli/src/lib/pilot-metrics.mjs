import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { appendMetric } from "../../../core/src/metrics.mjs";

const PILOT_FILE = "pilot.jsonl";

export function pilotMetricsDir(aiosPath) {
  return path.join(aiosPath, "memory", "metrics");
}

export function pilotMetricsFile(aiosPath) {
  return path.join(pilotMetricsDir(aiosPath), PILOT_FILE);
}

export async function emitPilotMetric(aiosPath, payload) {
  try {
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
  try {
    const content = await fs.readFile(pilotMetricsFile(aiosPath), "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
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
