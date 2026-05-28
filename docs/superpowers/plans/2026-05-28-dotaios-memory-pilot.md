# DotAIOS Memory Pilot (Adapter + Fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a strong day-1 memory path with adapter-primary + local fallback, plus minimal pilot instrumentation and go/kill rollup.

**Architecture:** Add a backend router that resolves memory operations to adapter backend first and internal SQLite-lite fallback second. Keep `~/aios` contract unchanged and add minimal, auditable metrics emitted from setup/doctor/search/capture paths. Build a small rollup script for weekly gates.

**Tech Stack:** Node.js ESM, existing DotAIOS CLI/core modules, JSONL metrics files, `node:test`.

---

### Task 1: Backend Router Contract (core, no behavior changes yet)

**Files:**
- Create: `packages/core/src/memory-backend.mjs`
- Modify: `packages/core/src/adapter-contract.mjs`
- Test: `tests/core/memory_backend_router.test.mjs`

- [ ] **Step 1: Write failing tests for resolver behavior**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveMemoryBackend } from "../../packages/core/src/memory-backend.mjs";

test("returns adapter when healthy", async () => {
  const backend = await resolveMemoryBackend({
    adapter: { health: async () => ({ ok: true }) },
    fallback: { health: async () => ({ ok: true }) },
  });
  assert.equal(backend.kind, "adapter");
});

test("falls back when adapter unhealthy", async () => {
  const backend = await resolveMemoryBackend({
    adapter: { health: async () => ({ ok: false, reason: "down" }) },
    fallback: { health: async () => ({ ok: true }) },
  });
  assert.equal(backend.kind, "fallback");
});
```

- [ ] **Step 2: Run test to verify it fails**  
Run: `node --test tests/core/memory_backend_router.test.mjs`  
Expected: FAIL with module/function not found.

- [ ] **Step 3: Write minimal implementation**

```js
export async function resolveMemoryBackend({ adapter, fallback }) {
  const a = await adapter.health();
  if (a?.ok) return { kind: "adapter", backend: adapter, health: a };
  const f = await fallback.health();
  if (f?.ok) return { kind: "fallback", backend: fallback, health: f, degraded: true };
  return { kind: "none", backend: null, health: { ok: false, reason: "no-backend" }, degraded: true };
}
```

- [ ] **Step 4: Add contract enum**

```js
export const MEMORY_BACKEND_KIND = {
  ADAPTER: "adapter",
  FALLBACK: "fallback",
  NONE: "none",
};
```

- [ ] **Step 5: Run tests**  
Run: `node --test tests/core/memory_backend_router.test.mjs`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/memory-backend.mjs packages/core/src/adapter-contract.mjs tests/core/memory_backend_router.test.mjs
git commit -m "feat(memory): add adapter-first backend resolver with fallback"
```

### Task 2: Minimal Metrics Writer (canonical JSONL schema)

**Files:**
- Create: `packages/core/src/metrics.mjs`
- Test: `tests/core/metrics.test.mjs`

- [ ] **Step 1: Write failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendMetric } from "../../packages/core/src/metrics.mjs";

test("writes onboarding metric line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-metrics-"));
  const file = path.join(dir, "onboarding.jsonl");
  await appendMetric(file, { type: "install_end", outcome: "ok" });
  const content = await fs.readFile(file, "utf8");
  assert.match(content, /"type":"install_end"/);
});
```

- [ ] **Step 2: Verify fail**  
Run: `node --test tests/core/metrics.test.mjs`  
Expected: FAIL.

- [ ] **Step 3: Implement helper**

```js
import fs from "node:fs/promises";
import path from "node:path";

export async function appendMetric(filePath, payload) {
  const entry = { ts: new Date().toISOString(), ...payload };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
  return entry;
}
```

- [ ] **Step 4: Re-run tests**  
Run: `node --test tests/core/metrics.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metrics.mjs tests/core/metrics.test.mjs
git commit -m "feat(metrics): add local JSONL pilot metrics writer"
```

### Task 3: Wire Setup + Search + Capture Metrics (minimal surface)

**Files:**
- Create: `packages/cli/src/lib/pilot-metrics.mjs`
- Modify: `packages/cli/src/commands/setup.mjs`
- Modify: `packages/cli/src/commands/search.mjs`
- Modify: `packages/cli/src/commands/capture.mjs`
- Test: `tests/cli/pilot_metrics.test.mjs`

- [ ] **Step 1: Write failing integration test skeleton**
- [ ] **Step 2: Run and verify fail**
- [ ] **Step 3: Add `pilot-metrics.mjs` helper for `memory/metrics/*.jsonl` paths**
- [ ] **Step 4: Add setup start/end instrumentation (`install_start`, `install_end`, duration, outcome)**
- [ ] **Step 5: Add search retrieval metric emission**
- [ ] **Step 6: Add capture saved/deleted metric emission**
- [ ] **Step 7: Re-run tests and pass**
- [ ] **Step 8: Commit**  
Commit message: `feat(pilot): instrument setup/search/capture metrics`

### Task 4: Doctor/Status Health Visibility for Pilot

**Files:**
- Modify: `packages/cli/src/commands/doctor.mjs`
- Modify: `packages/cli/src/commands/status.mjs`
- Test: `tests/cli/doctor_pilot_status.test.mjs`

- [ ] **Step 1: Add failing tests**
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Add doctor check for metrics presence and backend state**
- [ ] **Step 4: Add status block with metrics counts**
- [ ] **Step 5: Re-run tests**
- [ ] **Step 6: Commit**  
Commit message: `feat(pilot): expose backend and metrics health in doctor/status`

### Task 5: Weekly Rollup + Go/Kill Evaluator

**Files:**
- Create: `scripts/pilot-rollup.mjs`
- Create: `docs/pilot/README.md`
- Create: `docs/pilot/pilot-sheet-template.md`
- Create: `docs/pilot/scoring-rubric.md`
- Test: `tests/cli/pilot_rollup.test.mjs`

- [ ] **Step 1: Write failing rollup test**
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement rollup (`install_success_rate`, `median_first_recall_min`, `p_at_5_avg`, `go` boolean)**
- [ ] **Step 4: Document usage and artifact path**
- [ ] **Step 5: Re-run tests**
- [ ] **Step 6: Commit**  
Commit message: `feat(pilot): add weekly go-kill rollup and operator docs`

## Final Verification

- [ ] Run targeted tests:

```bash
node --test tests/core/memory_backend_router.test.mjs tests/core/metrics.test.mjs tests/cli/pilot_metrics.test.mjs tests/cli/doctor_pilot_status.test.mjs tests/cli/pilot_rollup.test.mjs
```

- [ ] Run:

```bash
npm run check
```

- [ ] Manual smoke:

```bash
node packages/cli/src/index.mjs setup --path /tmp/aios-pilot --yes --skip-reveal
node packages/cli/src/index.mjs search "test" --path /tmp/aios-pilot
node scripts/pilot-rollup.mjs --path /tmp/aios-pilot
```

Expected: metrics files created and weekly summary generated.
