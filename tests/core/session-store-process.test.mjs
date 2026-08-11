import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionStore } from "../../packages/core/src/session-store.mjs";

const WORKER = path.resolve("tests/fixtures/session-store-writer.mjs");

function tmpAios() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-process-"));
  fs.writeFileSync(path.join(root, "aios.json"), '{}\n');
  return root;
}

function sourceSession(count, overrides = {}) {
  return {
    agent: "claude-code",
    session_id: "source01",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "claude-code",
    title: "turn-1",
    turns: Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index + 1}`,
    })),
    ...overrides,
  };
}

function runWriter(aiosPath, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, "write", aiosPath, String(count)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) reject(new Error(`writer failed (${code || signal}): ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

for (const writers of [2, 16, 32]) {
  test(`${writers} cross-process same-source continuations converge exactly once`, { timeout: 60_000 }, async () => {
    const aiosPath = tmpAios();
    fs.writeFileSync(path.join(aiosPath, "shared-transcript.jsonl"), JSON.stringify(sourceSession(writers)));
    const results = await Promise.all(
      Array.from({ length: writers }, (_, index) => runWriter(aiosPath, index + 1)),
    );
    assert.ok(results.every((result) => ["created", "grown", "idempotent"].includes(result.outcome)));
    assert.equal(results.filter((result) => result.outcome === "created").length, 1);
    const grownTurnCounts = results
      .filter((result) => result.outcome === "grown")
      .map((result) => result.session.turns.length);
    assert.equal(
      new Set(grownTurnCounts).size,
      grownTurnCounts.length,
      "only one process may report each committed growth",
    );

    const store = createSessionStore({ aiosPath });
    const catalog = await store.search({ purpose: "exact", sessionId: results[0].session.session_id });
    const all = await store.search({ purpose: "catalog", query: "" });
    assert.equal(all.rows.length, 1);
    assert.equal(all.rows[0].turns, writers);
    assert.equal(catalog.rows.length, 1);
    const body = catalog.rows[0].body;
    const lines = body.split("\n");
    for (let index = 1; index <= writers; index += 1) {
      assert.equal(lines.filter((line) => line === `turn-${index}`).length, 1, `turn-${index} occurs exactly once`);
    }
  });
}

for (const phase of ["before_pending", "after_pending", "after_canonical", "after_projection", "before_cleanup", "after_cleanup_detach", "after_cleanup"]) {
  test(`SIGKILL at ${phase} recovers forward without false success`, { timeout: 30_000 }, async () => {
    const aiosPath = tmpAios();
    fs.writeFileSync(path.join(aiosPath, "shared-transcript.jsonl"), JSON.stringify(sourceSession(4)));
    const marker = path.join(aiosPath, `marker-${phase}`);
    const child = spawn(process.execPath, [WORKER, "crash", aiosPath, phase, marker], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitForFile(marker, child, stderr);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await exited;

    const store = createSessionStore({ aiosPath });
    const recovered = await store.capture({
      source: {
        path: path.join(aiosPath, "shared-transcript.jsonl"),
        policy: "manual-exact",
        parser: (text) => JSON.parse(text),
      },
    });
    assert.ok(["created", "grown", "idempotent"].includes(recovered.outcome));
    const catalog = await store.search({ purpose: "catalog", query: "" });
    assert.equal(catalog.rows.length, 1);
    assert.equal(catalog.rows[0].turns, 4);
    assert.equal(fs.existsSync(path.join(aiosPath, ".dotaios", "session-store", "pending")), false);
    assert.deepEqual(await store.reconcile({ apply: false }), {
      orphan_markdown: [], stale_rows: [], malformed_rows: 0, unsafe_rows: 0,
      invalid_markdown: [], duplicate_ids: [], duplicate_paths: [],
      duplicate_sources: [], conflicting_sources: [], projection_missing: false,
      operational_state: "clean",
    });
  });
}

for (const phase of [
  "before_pending",
  "after_pending",
  "after_canonical",
  "after_projection_move",
  "after_projection",
  "before_cleanup",
  "after_cleanup_detach",
  "after_cleanup",
]) {
  test(`SIGKILL conflict at ${phase} preserves both branches without false success`, { timeout: 30_000 }, async () => {
    const aiosPath = tmpAios();
    const sourcePath = path.join(aiosPath, "shared-transcript.jsonl");
    fs.writeFileSync(sourcePath, JSON.stringify(sourceSession(2)));
    const baseline = createSessionStore({ aiosPath });
    await baseline.capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    });
    fs.writeFileSync(sourcePath, JSON.stringify(sourceSession(1, {
      turns: [{ role: "user", content: "divergent-branch" }],
    })));
    const marker = path.join(aiosPath, `marker-conflict-${phase}`);
    const child = spawn(process.execPath, [WORKER, "crash-conflict", aiosPath, phase, marker], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitForFile(marker, child, stderr);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await exited;

    const store = createSessionStore({ aiosPath });
    const recovered = await store.capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    });
    assert.ok(["conflict_preserved", "reconciliation_required"].includes(recovered.outcome));
    const catalog = await store.search({ purpose: "catalog" });
    assert.equal(catalog.rows.length, 2);
    assert.ok(catalog.rows.every((row) => row.conflict_group));
  });
}

async function waitForFile(filePath, child, stderr) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`worker exited before fault phase: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker did not reach injected phase");
}
