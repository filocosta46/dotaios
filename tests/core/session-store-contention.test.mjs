import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionStore } from "../../packages/core/src/session-store.mjs";

// mutate() retries the codes a lost lock race raises instead of failing the
// caller. That retry must never become a place where tampering goes to be
// forgotten: ownership, permissions and symlink checks run in
// prepareOperationalRoot(), before the retry loop exists. These tests pin that
// boundary down by asserting the refusal lands far inside the lock budget --
// a swallowed signal would instead surface only once the budget expired.
const STORE_RELATIVE = ".dotaios/session-store";
const LOCK_TIMEOUT_MS = 5_000;
const REFUSAL_MUST_LAND_WITHIN_MS = 1_000;

const skip = process.platform === "win32"
  ? "owned-state permission checks do not apply on Windows"
  : (typeof process.getuid === "function" && process.getuid() === 0)
    ? "running as root makes every ownership check pass"
    : false;

async function fixture(t) {
  const aiosPath = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-session-contention-"));
  t.after(() => fs.rm(aiosPath, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(aiosPath, "aios.json"), "{}\n");
  await fs.writeFile(path.join(aiosPath, "transcript.jsonl"), JSON.stringify({
    agent: "claude-code",
    session_id: "s1",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "claude-code",
    title: "t",
    turns: [{ role: "user", content: "hello" }]
  }));
  return aiosPath;
}

function capture(aiosPath) {
  const store = createSessionStore({ aiosPath, lockTimeoutMs: LOCK_TIMEOUT_MS });
  return store.capture({
    source: {
      path: path.join(aiosPath, "transcript.jsonl"),
      policy: "manual-exact",
      parser: (text) => JSON.parse(text)
    }
  });
}

async function refusalAfterTampering(aiosPath, tamper) {
  await capture(aiosPath);
  await tamper(aiosPath);
  const startedAt = Date.now();
  try {
    await capture(aiosPath);
    return { refused: false, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { refused: true, code: error.code, elapsedMs: Date.now() - startedAt };
  }
}

test("a world-writable store is refused immediately, not after the lock budget", { skip }, async (t) => {
  const aiosPath = await fixture(t);
  const outcome = await refusalAfterTampering(aiosPath, (root) =>
    fs.chmod(path.join(root, STORE_RELATIVE), 0o777));

  assert.equal(outcome.refused, true, "a world-writable store must be refused");
  assert.equal(outcome.code, "DOTAIOS_OWNED_STATE_INVALID");
  assert.ok(
    outcome.elapsedMs < REFUSAL_MUST_LAND_WITHIN_MS,
    `refusal took ${outcome.elapsedMs}ms; the retry loop swallowed it`
  );
});

test("a world-readable store is refused immediately", { skip }, async (t) => {
  const aiosPath = await fixture(t);
  const outcome = await refusalAfterTampering(aiosPath, (root) =>
    fs.chmod(path.join(root, STORE_RELATIVE), 0o755));

  assert.equal(outcome.refused, true);
  assert.equal(outcome.code, "DOTAIOS_OWNED_STATE_INVALID");
  assert.ok(outcome.elapsedMs < REFUSAL_MUST_LAND_WITHIN_MS, `refusal took ${outcome.elapsedMs}ms`);
});

test("a store swapped for a symlink is refused immediately", { skip }, async (t) => {
  const aiosPath = await fixture(t);
  const outcome = await refusalAfterTampering(aiosPath, async (root) => {
    const store = path.join(root, STORE_RELATIVE);
    const elsewhere = path.join(root, "elsewhere");
    await fs.rename(store, elsewhere);
    await fs.symlink(elsewhere, store);
  });

  assert.equal(outcome.refused, true, "a symlinked store must be refused");
  assert.equal(outcome.code, "DOTAIOS_OWNED_STATE_INVALID");
  assert.ok(outcome.elapsedMs < REFUSAL_MUST_LAND_WITHIN_MS, `refusal took ${outcome.elapsedMs}ms`);
});

test("a group-writable .dotaios is refused immediately", { skip }, async (t) => {
  const aiosPath = await fixture(t);
  const outcome = await refusalAfterTampering(aiosPath, (root) =>
    fs.chmod(path.join(root, ".dotaios"), 0o770));

  assert.equal(outcome.refused, true);
  assert.equal(outcome.code, "DOTAIOS_SESSION_OPERATIONAL_PATH_UNSAFE");
  assert.ok(outcome.elapsedMs < REFUSAL_MUST_LAND_WITHIN_MS, `refusal took ${outcome.elapsedMs}ms`);
});

test("an untampered store still captures", async (t) => {
  const aiosPath = await fixture(t);
  const first = await capture(aiosPath);
  assert.equal(first.outcome, "created");
  const second = await capture(aiosPath);
  assert.equal(second.outcome, "idempotent");
});
