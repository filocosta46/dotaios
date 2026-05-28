import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendMetric } from "../../packages/core/src/metrics.mjs";

test("writes onboarding metric line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-metrics-"));
  const file = path.join(dir, "onboarding.jsonl");
  await appendMetric(file, { type: "install_end", outcome: "ok" });
  const content = await fs.readFile(file, "utf8");
  assert.match(content, /"type":"install_end"/);
});
