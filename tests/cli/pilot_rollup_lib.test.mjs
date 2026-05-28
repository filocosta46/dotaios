import test from "node:test";
import assert from "node:assert/strict";
import { computeRollup } from "../../packages/cli/src/lib/pilot-rollup.mjs";

const NOW = Date.parse("2026-05-28T00:00:00.000Z");

function scoreRow(scorerId, overrides = {}) {
  return {
    type: "pilot_score",
    first_recall_min: 5,
    p_at_5: 0.8,
    scorer_id: scorerId,
    scorer_method_version: "v1",
    scored_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

test("single scorer blocks go even with perfect scores", () => {
  const rows = [
    { type: "install_end", outcome: "ok" },
    scoreRow("me"),
    scoreRow("me"),
    scoreRow("me"),
    scoreRow("me"),
    scoreRow("me"),
  ];
  const out = computeRollup(rows, { nowMs: NOW });
  assert.equal(out.distinct_scorers, 1);
  assert.equal(out.go, false);
  assert.ok(out.block_reasons.includes("single_scorer"));
  assert.equal(out.incomplete, true);
});

test("future-dated scored_at is rejected as invalid", () => {
  const rows = [
    { type: "install_end", outcome: "ok" },
    scoreRow("a", { scored_at: "3000-01-01T00:00:00.000Z" }),
    scoreRow("b"),
  ];
  const out = computeRollup(rows, { nowMs: NOW });
  assert.equal(out.pilot_score_rows_total, 2);
  assert.equal(out.pilot_score_rows_valid, 1);
  assert.equal(out.pilot_score_rows_invalid, 1);
  assert.ok(out.block_reasons.includes("invalid_score_rows"));
});

test("public gate passes with >=10 samples, >=3 scorers, install >=0.95", () => {
  const installRows = Array.from({ length: 20 }, () => ({ type: "install_end", outcome: "ok" }));
  const scorers = ["a", "b", "c"];
  const scoreRows = Array.from({ length: 12 }, (_, i) => scoreRow(scorers[i % 3]));
  const out = computeRollup([...installRows, ...scoreRows], { nowMs: NOW });
  assert.equal(out.go, true);
  assert.equal(out.go_public, true);
  assert.deepEqual(out.public_block_reasons, []);
});

test("public gate fails when install rate between pilot and public bar", () => {
  const installRows = [
    ...Array.from({ length: 9 }, () => ({ type: "install_end", outcome: "ok" })),
    { type: "install_end", outcome: "fail" },
  ]; // 0.90: passes pilot, fails public (needs 0.95)
  const scorers = ["a", "b", "c"];
  const scoreRows = Array.from({ length: 12 }, (_, i) => scoreRow(scorers[i % 3]));
  const out = computeRollup([...installRows, ...scoreRows], { nowMs: NOW });
  assert.equal(out.go, true);
  assert.equal(out.go_public, false);
  assert.ok(out.public_block_reasons.includes("install_success_below_public_threshold"));
});
