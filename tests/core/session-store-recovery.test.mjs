import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionStore } from "../../packages/core/src/session-store.mjs";

const WORKER = path.resolve("tests/fixtures/session-store-worker.mjs");

function tmpAios() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-recovery-"));
  fs.writeFileSync(path.join(root, "aios.json"), "{\"version\":\"1\"}\n");
  fs.mkdirSync(path.join(root, "unrelated"));
  fs.writeFileSync(path.join(root, "unrelated", "canary.txt"), "UNRELATED_TREE_CANARY\n");
  return root;
}

function sourcedSession(aiosPath, turnCount = 1) {
  return {
    agent: "manual",
    session_id: "11111111",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "import",
    source_path: `${aiosPath}/shared-source.json`,
    title: "turn-1",
    turns: Array.from({ length: turnCount }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index + 1}`,
    })),
  };
}

const MATRICES = [
  ["grow", ["before_pending", "after_pending", "after_canonical_move", "after_canonical", "after_projection_move", "after_projection", "before_cleanup", "after_cleanup_detach", "after_cleanup"]],
  ["delete", ["before_pending", "after_pending", "after_canonical_move", "after_canonical", "after_projection_move", "after_projection", "before_cleanup", "after_cleanup_detach", "after_cleanup"]],
  ["reconcile", ["before_pending", "after_pending", "after_projection_move", "after_projection", "before_cleanup", "after_cleanup_detach", "after_cleanup"]],
];

const BOOTSTRAP_PHASES = {
  create: [
    "after_bootstrap_directory",
    "during_bootstrap_manifest",
    "after_bootstrap_manifest",
    "after_bootstrap_canonical",
    "after_bootstrap_projection",
    "after_private",
    "after_sessions_root_creation",
    "after_session_date_creation",
  ],
  grow: [
    "after_bootstrap_directory",
    "during_bootstrap_manifest",
    "after_bootstrap_manifest",
    "after_bootstrap_canonical",
    "after_bootstrap_projection",
    "after_private",
  ],
  delete: [
    "after_bootstrap_directory",
    "during_bootstrap_manifest",
    "after_bootstrap_manifest",
    "after_bootstrap_projection",
    "after_private",
  ],
  reconcile: [
    "after_bootstrap_directory",
    "during_bootstrap_manifest",
    "after_bootstrap_manifest",
    "after_bootstrap_projection",
    "after_private",
  ],
};
const PUBLISHED_PARENT_PHASES = new Set([
  "after_sessions_root_creation",
  "after_session_date_creation",
]);

test("the mutation deadline includes recovery before new capture work begins", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_pending") throw new Error("interrupt after durable publication");
    },
  });
  await assert.rejects(() => interrupted.capture({
    session: { ...sourcedSession(aiosPath), source_path: undefined },
  }));

  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  const delayedFilesystem = Object.create(fsp);
  let delayed = false;
  delayedFilesystem.readdir = async (candidate, options) => {
    if (!delayed && path.resolve(String(candidate)) === storeRoot) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return fsp.readdir(candidate, options);
  };
  const bounded = createSessionStore({
    aiosPath,
    filesystem: delayedFilesystem,
    lockTimeoutMs: 5,
  });
  const refused = await bounded.capture({
    session: { ...sourcedSession(aiosPath, 2), source_path: undefined },
  });
  assert.deepEqual(refused, { outcome: "refused", committed: false, reason: "contention" });

  const recovery = createSessionStore({ aiosPath });
  await recovery.reconcile({ apply: true });
  const catalog = await recovery.search({ purpose: "catalog" });
  assert.equal(catalog.rows.length, 1);
  assert.equal(catalog.rows[0].turns, 1, "expired work must not start a second capture");
});

for (const [action, phases] of Object.entries(BOOTSTRAP_PHASES)) {
  for (const phase of phases) {
    const expectedRecovery = PUBLISHED_PARENT_PHASES.has(phase)
      ? "recovers the published transaction forward exactly once"
      : "restores the exact unpublished state before retry";
    test(`SIGKILL ${action} at ${phase} ${expectedRecovery}`, { timeout: 45_000 }, (t) => (
      runBootstrapRecoveryCase(t, action, phase)
    ));
  }
}

async function runBootstrapRecoveryCase(t, action, phase) {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const sourcePath = path.join(aiosPath, "shared-source.json");
  await fsp.writeFile(sourcePath, JSON.stringify(sourcedSession(aiosPath, 1)), { mode: 0o600 });
  let existing = null;
  if (action !== "create") {
    const baseline = createSessionStore({ aiosPath });
    existing = await baseline.capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    });
    if (action === "grow") {
      await fsp.writeFile(sourcePath, JSON.stringify(sourcedSession(aiosPath, 3)), { mode: 0o600 });
    } else if (action === "reconcile") {
      await fsp.writeFile(
        path.join(aiosPath, "memory", "sessions", "index.jsonl"),
        "{malformed-row}\n",
        { mode: 0o600 },
      );
    }
  }
  const publishedBefore = await treeBytes(path.join(aiosPath, "memory"));
  const unrelatedBefore = await treeBytes(path.join(aiosPath, "unrelated"));
  const marker = path.join(aiosPath, `.fault-${action}-${phase}`);
  const child = spawn(process.execPath, [WORKER, action, aiosPath, phase, marker], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await waitForMarker(marker, child, () => stderr);
  child.kill("SIGKILL");
  const termination = await exited;
  assert.equal(termination.signal, "SIGKILL");
  assert.equal(stdout, "", "a killed bootstrap must not publish a success response");
  await fsp.unlink(marker);

  const recovery = createSessionStore({ aiosPath });
  await assert.rejects(
    () => recovery.delete({ sessionId: "missing-recovery-probe" }),
    isExpectedRecoveryProbeRefusal,
  );
  const firstRecoveryState = await treeBytes(path.join(aiosPath, "memory"));
  if (PUBLISHED_PARENT_PHASES.has(phase)) {
    assert.notDeepEqual(
      firstRecoveryState,
      publishedBefore,
      "canonical-parent creation follows pending publication and must recover forward",
    );
  } else {
    assert.deepEqual(
      firstRecoveryState,
      publishedBefore,
      "unpublished bootstrap recovery must first restore the exact published before-state",
    );
  }
  await assert.rejects(
    () => recovery.delete({ sessionId: "missing-recovery-probe" }),
    isExpectedRecoveryProbeRefusal,
  );
  assert.deepEqual(await treeBytes(path.join(aiosPath, "memory")), firstRecoveryState);

  let outcome;
  if (action === "create" || action === "grow") {
    outcome = await recovery.capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    });
    assert.ok(action === "create"
      ? ["created", "idempotent"].includes(outcome.outcome)
      : ["grown", "idempotent"].includes(outcome.outcome));
  } else if (action === "delete") {
    outcome = await recovery.delete({ sessionId: existing.session.session_id });
    assert.equal(outcome.outcome, "deleted");
  } else {
    outcome = await recovery.reconcile({ apply: true });
    assert.ok(["rebuilt", "rebuilt_with_conflicts"].includes(outcome.outcome));
  }
  const firstRecoveredTree = await treeBytes(aiosPath, { ignoreLock: true });
  await recovery.reconcile({ apply: true });
  assert.deepEqual(await treeBytes(aiosPath, { ignoreLock: true }), firstRecoveredTree);
  assert.deepEqual(await treeBytes(path.join(aiosPath, "unrelated")), unrelatedBefore);

  const storeEntries = await fsp.readdir(path.join(aiosPath, ".dotaios", "session-store"));
  assert.deepEqual(
    storeEntries.filter((entry) => /^\.(?:bootstrap|private|discard|cleanup)-/.test(entry) || entry === "pending"),
    [],
  );
  const catalog = await recovery.search({ purpose: "catalog", query: "" });
  assert.equal(catalog.rows.length, action === "delete" ? 0 : 1);
  if (action !== "delete") {
    assert.equal(catalog.rows[0].turns, action === "grow" ? 3 : 1);
  }
}

function isExpectedRecoveryProbeRefusal(error) {
  return error?.code === "DOTAIOS_SESSION_NOT_FOUND"
    || error?.code === "DOTAIOS_SESSION_RECONCILIATION_REQUIRED";
}

for (const [action, phases] of MATRICES) {
  for (const phase of phases) {
    test(`SIGKILL ${action} at ${phase} converges repeatedly without false success or unrelated mutation`, { timeout: 45_000 }, async (t) => {
      const aiosPath = tmpAios();
      t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
      const sourcePath = path.join(aiosPath, "shared-source.json");
      await fsp.writeFile(sourcePath, JSON.stringify(sourcedSession(aiosPath, 1)), { mode: 0o600 });
      const baseline = createSessionStore({ aiosPath });
      await baseline.capture({ source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse } });
      if (action === "reconcile") {
        await fsp.writeFile(path.join(aiosPath, "memory", "sessions", "index.jsonl"), "{malformed-row}\n", { mode: 0o600 });
      }
      if (action === "grow") {
        await fsp.writeFile(sourcePath, JSON.stringify(sourcedSession(aiosPath, 3)), { mode: 0o600 });
      }
      const unrelatedBefore = await treeBytes(path.join(aiosPath, "unrelated"));
      const marker = path.join(aiosPath, `.fault-${action}-${phase}`);
      const child = spawn(process.execPath, [WORKER, action, aiosPath, phase, marker], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      await waitForMarker(marker, child, () => stderr);
      child.kill("SIGKILL");
      const termination = await exited;
      assert.equal(termination.signal, "SIGKILL");
      assert.equal(stdout, "", "a killed mutation must not publish a success response");
      await fsp.unlink(marker);
      if (phase === "after_projection_move" && process.platform !== "win32") {
        assert.equal(
          (await fsp.stat(path.join(aiosPath, ".dotaios", "session-store", "pending", "previous-index.jsonl"))).mode & 0o777,
          0o600,
          "parked projection evidence is private before recovery",
        );
      }

      const recovery = createSessionStore({ aiosPath });
      if (action === "grow") {
        const outcome = await recovery.capture({ source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse } });
        assert.ok(["grown", "idempotent"].includes(outcome.outcome));
      } else {
        const outcome = await recovery.reconcile({ apply: true });
        assert.ok(["rebuilt", "rebuilt_with_conflicts"].includes(outcome.outcome));
      }

      const firstRecoveredTree = await treeBytes(aiosPath, { ignoreLock: true });
      const repeated = await recovery.reconcile({ apply: true });
      assert.ok(["rebuilt", "rebuilt_with_conflicts"].includes(repeated.outcome));
      assert.deepEqual(await treeBytes(aiosPath, { ignoreLock: true }), firstRecoveredTree);
      assert.deepEqual(await treeBytes(path.join(aiosPath, "unrelated")), unrelatedBefore);
      assert.equal(fs.existsSync(path.join(aiosPath, ".dotaios", "session-store", "pending")), false);
      assert.deepEqual(
        (await fsp.readdir(path.join(aiosPath, ".dotaios", "session-store")))
          .filter((entry) => entry.startsWith(".cleanup-")),
        [],
        "proved-closed cleanup tombstones must converge away after recovery",
      );

      const catalog = await recovery.search({ purpose: "catalog", query: "" });
      if (action === "delete") {
        assert.equal(
          catalog.rows.length,
          phase === "before_pending" ? 1 : 0,
          "an unpublished delete stays at the exact before-state; a published delete recovers forward",
        );
      } else {
        assert.equal(catalog.rows.length, 1);
        assert.equal(catalog.rows[0].turns, action === "grow" ? 3 : 1);
      }
    });
  }
}

async function waitForMarker(marker, child, stderr) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (fs.existsSync(marker)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before fault marker: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGKILL");
  throw new Error(`worker did not reach fault phase: ${stderr()}`);
}

async function treeBytes(root, { ignoreLock = false } = {}) {
  const result = {};
  async function walk(current, relative = "") {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const rel = path.posix.join(relative, entry.name);
      if (ignoreLock && rel.includes(".dotaios/session-store/store.lock")) continue;
      const absolute = path.join(current, entry.name);
      const stats = await fsp.lstat(absolute);
      const identity = `${stats.dev}:${stats.ino}:${stats.mode}:${stats.uid}:${stats.nlink}`;
      if (entry.isSymbolicLink()) result[rel] = `${identity}:link:${await fsp.readlink(absolute)}`;
      else if (entry.isDirectory()) {
        result[`${rel}/`] = `${identity}:directory`;
        await walk(absolute, rel);
      } else result[rel] = `${identity}:file:${(await fsp.readFile(absolute)).toString("base64")}`;
    }
  }
  await walk(root);
  return result;
}
