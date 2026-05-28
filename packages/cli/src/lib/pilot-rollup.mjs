import fs from "node:fs/promises";
import path from "node:path";
import { readJsonLines } from "../../../core/src/metrics.mjs";

// Pilot gate: minimum bar to continue a controlled pilot.
export const PILOT_GATES = {
  installSuccessRate: 0.9,
  medianFirstRecallMin: 15,
  pAt5Avg: 0.6,
  minScoreSample: 5,
  minScorers: 2,
};

// Public gate: stricter bar before a public launch. Pilot gates must also pass.
export const PUBLIC_GATES = {
  installSuccessRate: 0.95,
  minScoreSample: 10,
  minScorers: 3,
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidProvenance(row, nowMs) {
  const hasScorerId = isNonEmptyString(row.scorer_id);
  const scoredAtMs = isNonEmptyString(row.scored_at) ? Date.parse(row.scored_at) : NaN;
  // Reject missing, unparseable, or future-dated timestamps (anti-gaming).
  const hasScoredAt = Number.isFinite(scoredAtMs) && scoredAtMs <= nowMs;
  const hasMethodVersion = isNonEmptyString(row.scorer_method_version)
    || (isNonEmptyString(row.scorer_method) && isNonEmptyString(row.scorer_version));
  const hasValues = isFiniteNumber(row.first_recall_min) && isFiniteNumber(row.p_at_5);
  return hasScorerId && hasScoredAt && hasMethodVersion && hasValues;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function computeRollup(rows, options = {}) {
  const minScoreSample = options.minScoreSample ?? PILOT_GATES.minScoreSample;
  const minScorers = options.minScorers ?? PILOT_GATES.minScorers;
  const nowMs = options.nowMs ?? Date.now();

  const installEnd = rows.filter((row) => row.type === "install_end");
  const installOk = installEnd.filter((row) => row.outcome === "ok").length;
  const installSuccessRate = installEnd.length === 0 ? null : installOk / installEnd.length;

  const scoreRows = rows.filter((row) => row.type === "pilot_score");
  const validScoreRows = scoreRows.filter((row) => hasValidProvenance(row, nowMs));
  const invalidScoreRowsCount = scoreRows.length - validScoreRows.length;
  const distinctScorers = new Set(validScoreRows.map((row) => row.scorer_id)).size;

  const firstRecallValues = validScoreRows.map((row) => row.first_recall_min);
  const pAt5Values = validScoreRows.map((row) => row.p_at_5);
  const medianFirstRecallMin = median(firstRecallValues);
  const pAt5Avg = pAt5Values.length === 0
    ? null
    : pAt5Values.reduce((sum, value) => sum + value, 0) / pAt5Values.length;

  const blockReasons = [];
  if (installSuccessRate === null) {
    blockReasons.push("missing_install_data");
  } else if (installSuccessRate < PILOT_GATES.installSuccessRate) {
    blockReasons.push("install_success_below_threshold");
  }
  if (invalidScoreRowsCount > 0) {
    blockReasons.push("invalid_score_rows");
  }
  if (validScoreRows.length < minScoreSample) {
    blockReasons.push("insufficient_sample");
  }
  if (validScoreRows.length > 0 && distinctScorers < minScorers) {
    blockReasons.push("single_scorer");
  }
  if (medianFirstRecallMin === null) {
    blockReasons.push("missing_first_recall_data");
  } else if (medianFirstRecallMin > PILOT_GATES.medianFirstRecallMin) {
    blockReasons.push("first_recall_above_threshold");
  }
  if (pAt5Avg === null) {
    blockReasons.push("missing_p_at_5_data");
  } else if (pAt5Avg < PILOT_GATES.pAt5Avg) {
    blockReasons.push("p_at_5_below_threshold");
  }

  // Public bar: everything the pilot needs, plus stricter sample/scorer/install.
  const publicBlockReasons = [];
  if (installSuccessRate !== null && installSuccessRate < PUBLIC_GATES.installSuccessRate) {
    publicBlockReasons.push("install_success_below_public_threshold");
  }
  if (validScoreRows.length < PUBLIC_GATES.minScoreSample) {
    publicBlockReasons.push("insufficient_public_sample");
  }
  if (distinctScorers < PUBLIC_GATES.minScorers) {
    publicBlockReasons.push("insufficient_public_scorers");
  }

  const go = blockReasons.length === 0;
  const goPublic = go && publicBlockReasons.length === 0;
  const incomplete = blockReasons.includes("insufficient_sample")
    || blockReasons.includes("missing_install_data")
    || blockReasons.includes("invalid_score_rows")
    || blockReasons.includes("single_scorer");

  return {
    install_success_rate: installSuccessRate,
    median_first_recall_min: medianFirstRecallMin,
    p_at_5_avg: pAt5Avg,
    pilot_score_rows_total: scoreRows.length,
    pilot_score_rows_valid: validScoreRows.length,
    pilot_score_rows_invalid: invalidScoreRowsCount,
    pilot_score_provenance_valid: invalidScoreRowsCount === 0,
    distinct_scorers: distinctScorers,
    min_score_sample: minScoreSample,
    min_scorers: minScorers,
    incomplete,
    block_reasons: blockReasons,
    public_block_reasons: publicBlockReasons,
    go,
    go_public: goPublic,
  };
}

export async function runRollup(aiosPath, options = {}) {
  const metricsDir = path.join(aiosPath, "memory", "metrics");
  const rows = await readJsonLines(path.join(metricsDir, "pilot.jsonl"));
  const summary = computeRollup(rows, options);

  await fs.mkdir(metricsDir, { recursive: true });
  const outPath = path.join(metricsDir, "pilot-rollup.json");
  await fs.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
