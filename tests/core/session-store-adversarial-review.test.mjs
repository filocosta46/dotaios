import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionStore } from "../../packages/core/src/session-store.mjs";
import { parseSessionRelativePath } from "../../packages/core/src/session-paths.mjs";

function tmpAios() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-adversarial-"));
  fs.writeFileSync(path.join(root, "aios.json"), "{\"version\":\"1\"}\n");
  fs.mkdirSync(path.join(root, "unrelated"));
  fs.writeFileSync(path.join(root, "unrelated", "canary.txt"), "UNRELATED_CANARY\n");
  return root;
}

function session(overrides = {}) {
  return {
    agent: "manual",
    session_id: "11111111",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "manual",
    title: "Adversarial ownership fixture",
    turns: [{ role: "user", content: "ORIGINAL_CANONICAL_CANARY" }],
    ...overrides,
  };
}

async function pendingManifest(aiosPath) {
  const manifestPath = path.join(aiosPath, ".dotaios", "session-store", "pending", "manifest.json");
  return { manifestPath, manifest: JSON.parse(await fsp.readFile(manifestPath, "utf8")) };
}

async function replaceManifestTarget(aiosPath, target) {
  const { manifestPath, manifest } = await pendingManifest(aiosPath);
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, target })}\n`, { mode: 0o600 });
}

async function settle(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

test("canonical manifest grammar rejects impossible and cross-date timestamps", () => {
  for (const relativePath of [
    "memory/sessions/2026-02-30/2026-02-30T10-00-00_manual_abcdef.md",
    "memory/sessions/2026-08-11/2026-08-12T10-00-00_manual_abcdef.md",
    "memory/sessions/2026-08-11/2026-08-11T99-00-00_manual_abcdef.md",
    "memory/sessions/2026-08-11/2026-08-11T10-61-00_manual_abcdef.md",
  ]) {
    assert.equal(
      parseSessionRelativePath(relativePath, { requireCanonicalFilename: true }),
      null,
      relativePath,
    );
  }
});

test("recovery rejects a pending delete whose target is index-adjacent rather than exact canonical grammar", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const baseline = createSessionStore({ aiosPath });
  const created = await baseline.capture({ session: session() });
  const canonical = path.join(aiosPath, created.relativePath);
  const maliciousRelative = "memory/sessions/index.jsonl.backup";
  const maliciousTarget = path.join(aiosPath, maliciousRelative);
  const canaryBytes = await fsp.readFile(canonical);

  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_pending") throw new Error("leave-delete-pending");
    },
  });
  await assert.rejects(() => interrupted.delete({ sessionId: created.session.session_id }));
  await fsp.rename(canonical, maliciousTarget);
  await replaceManifestTarget(aiosPath, maliciousRelative);

  const recovery = await settle(createSessionStore({ aiosPath }).capture({
    session: session({
      session_id: "22222222",
      captured_at: "2026-08-11T11:00:00.000Z",
      turns: [{ role: "user", content: "UNRELATED_NEW_SESSION" }],
    }),
  }));

  assert.equal(recovery.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
  assert.deepEqual(await fsp.readFile(maliciousTarget).catch(() => null), canaryBytes);
  assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
});

test("recovery rejects a pending grow whose target is outside a dated canonical subtree", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const sourcePath = path.join(aiosPath, "source.json");
  await fsp.writeFile(sourcePath, JSON.stringify(session()), { mode: 0o600 });
  const baseline = createSessionStore({ aiosPath });
  const created = await baseline.capture({
    source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
  });
  const canonical = path.join(aiosPath, created.relativePath);
  const maliciousRelative = "memory/sessions/not-a-date/canary.md";
  const maliciousTarget = path.join(aiosPath, maliciousRelative);
  const canaryBytes = await fsp.readFile(canonical);
  await fsp.writeFile(sourcePath, JSON.stringify(session({
    turns: [
      { role: "user", content: "ORIGINAL_CANONICAL_CANARY" },
      { role: "assistant", content: "STRICTLY_LONGER_CONTINUATION" },
    ],
  })), { mode: 0o600 });

  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_pending") throw new Error("leave-grow-pending");
    },
  });
  await assert.rejects(() => interrupted.capture({
    source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
  }));
  await fsp.mkdir(path.dirname(maliciousTarget));
  await fsp.rename(canonical, maliciousTarget);
  await replaceManifestTarget(aiosPath, maliciousRelative);

  const recovery = await settle(createSessionStore({ aiosPath }).reconcile({ apply: true }));

  assert.deepEqual(await fsp.readFile(maliciousTarget).catch(() => null), canaryBytes);
  assert.equal(recovery.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
  assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
});

test("recovery rejects a pending target whose basename is not canonical session filename grammar", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const baseline = createSessionStore({ aiosPath });
  const created = await baseline.capture({ session: session() });
  const canonical = path.join(aiosPath, created.relativePath);
  const maliciousRelative = "memory/sessions/2026-08-11/not-a-session-filename.md";
  const maliciousTarget = path.join(aiosPath, maliciousRelative);
  const canaryBytes = await fsp.readFile(canonical);

  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_pending") throw new Error("leave-bad-basename-delete-pending");
    },
  });
  await assert.rejects(() => interrupted.delete({ sessionId: created.session.session_id }));
  await fsp.rename(canonical, maliciousTarget);
  await replaceManifestTarget(aiosPath, maliciousRelative);

  const recovery = await settle(createSessionStore({ aiosPath }).capture({
    session: session({ session_id: "22222222", captured_at: "2026-08-11T11:00:00.000Z" }),
  }));

  assert.equal(recovery.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
  assert.deepEqual(await fsp.readFile(maliciousTarget).catch(() => null), canaryBytes);
  assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
});

for (const swappedAncestor of ["date", "sessions"]) {
  test(`canonical publication re-proves the ${swappedAncestor} ancestor before linking`, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX ancestor-swap fixture");
    const aiosPath = tmpAios();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-publish-outside-"));
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    await fsp.writeFile(path.join(outsideRoot, "canary.txt"), "OUTSIDE_PUBLICATION_CANARY\n", { mode: 0o600 });
    if (swappedAncestor === "sessions") await fsp.mkdir(path.join(outsideRoot, "2026-08-11"));
    const outsideBefore = await treeBytes(outsideRoot);
    let swapped = false;

    const filesystem = Object.create(fsp);
    filesystem.link = async (source, destination) => {
      if (!swapped && String(source).endsWith(`${path.sep}pending${path.sep}canonical.md`)) {
        swapped = true;
        const dateRoot = path.dirname(String(destination));
        const sessionsRoot = path.dirname(dateRoot);
        const ancestor = swappedAncestor === "date" ? dateRoot : sessionsRoot;
        await fsp.rename(ancestor, `${ancestor}-parked`);
        await fsp.symlink(outsideRoot, ancestor, "dir");
      }
      return fsp.link(source, destination);
    };
    const outcome = await settle(createSessionStore({ aiosPath, filesystem }).capture({ session: session() }));

    assert.equal(swapped, true);
    assert.deepEqual(await treeBytes(outsideRoot), outsideBefore);
    assert.equal(outcome.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
    assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
  });
}

test("closed-transaction cleanup restores a child replaced during detach", async (t) => {
  const aiosPath = tmpAios();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-cleanup-outside-"));
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const outsideCanary = path.join(outsideRoot, "canary.txt");
  await fsp.writeFile(outsideCanary, "OUTSIDE_CLEANUP_CANARY\n", { mode: 0o600 });

  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_cleanup_detach") throw new Error("leave-closed-transaction");
    },
  });
  await assert.rejects(() => interrupted.capture({ session: session() }));
  const [cleanupName] = (await fsp.readdir(path.join(aiosPath, ".dotaios", "session-store")))
    .filter((name) => name.startsWith(".cleanup-"));
  assert.ok(cleanupName);
  const replacementMarker = "CLOSED_CHILD_REPLACEMENT_CANARY";
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.rename = async (candidate, destination) => {
    if (
      !swapped
      && path.basename(String(candidate)) === "manifest.json"
      && path.basename(path.dirname(String(candidate))) === cleanupName
      && path.basename(String(destination)).startsWith(".purge-")
    ) {
      swapped = true;
      await fsp.rename(candidate, path.join(outsideRoot, "held-closed-manifest.json"));
      await fsp.writeFile(candidate, `${replacementMarker}\n`, { mode: 0o600 });
    }
    return fsp.rename(candidate, destination);
  };
  const outcome = await settle(createSessionStore({ aiosPath, filesystem }).capture({
    session: session({ session_id: "22222222", captured_at: "2026-08-11T11:00:00.000Z" }),
  }));

  assert.equal(swapped, true);
  assert.equal(await fsp.readFile(outsideCanary, "utf8"), "OUTSIDE_CLEANUP_CANARY\n");
  assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
  assert.equal(await containsBytes(aiosPath, replacementMarker), true);
  assert.equal(outcome.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
});

test("unpublished-transaction cleanup restores a child replaced during detach", async (t) => {
  const aiosPath = tmpAios();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-discard-outside-"));
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const outsideCanary = path.join(outsideRoot, "canary.txt");
  await fsp.writeFile(outsideCanary, "OUTSIDE_DISCARD_CANARY\n", { mode: 0o600 });

  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "before_pending") throw new Error("leave-unpublished-transaction");
    },
  });
  await assert.rejects(() => interrupted.capture({ session: session() }));
  const replacementMarker = "UNPUBLISHED_CHILD_REPLACEMENT_CANARY";
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.rename = async (candidate, destination) => {
    if (
      !swapped
      && path.basename(String(candidate)) === "canonical.md"
      && path.basename(path.dirname(String(candidate))).startsWith(".discard-")
      && path.basename(String(destination)).startsWith(".purge-")
    ) {
      swapped = true;
      await fsp.rename(candidate, path.join(outsideRoot, "held-unpublished-canonical.md"));
      await fsp.writeFile(candidate, `${replacementMarker}\n`, { mode: 0o600 });
    }
    return fsp.rename(candidate, destination);
  };
  const outcome = await settle(createSessionStore({ aiosPath, filesystem }).capture({
    session: session({ session_id: "22222222", captured_at: "2026-08-11T11:00:00.000Z" }),
  }));

  assert.equal(swapped, true);
  assert.equal(await fsp.readFile(outsideCanary, "utf8"), "OUTSIDE_DISCARD_CANARY\n");
  assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
  assert.equal(await containsBytes(aiosPath, replacementMarker), true);
  assert.equal(outcome.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
});

for (const purpose of ["catalog", "metadata", "body", "exact", "working-context", "compact-digest"]) {
  test(`${purpose} search refuses a canonical snapshot changed after projection observation begins`, async (t) => {
    const aiosPath = tmpAios();
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    const baseline = createSessionStore({ aiosPath });
    const created = await baseline.capture({ session: session() });
    const canonical = path.join(aiosPath, created.relativePath);
    const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
    const originalMarkdown = await fsp.readFile(canonical, "utf8");
    const replacementMarkdown = originalMarkdown.replace(
      "ORIGINAL_CANONICAL_CANARY",
      "REPLACED_CANONICAL_CANARY",
    );
    assert.notEqual(replacementMarkdown, originalMarkdown);
    let changed = false;
    const filesystem = Object.create(fsp);
    filesystem.open = async (candidate, flags, mode) => {
      if (!changed && path.resolve(String(candidate)) === path.resolve(indexPath)) {
        changed = true;
        await fsp.writeFile(canonical, replacementMarkdown, { mode: 0o600 });
      }
      return fsp.open(candidate, flags, mode);
    };

    await assert.rejects(
      () => createSessionStore({ aiosPath, filesystem }).search({
        purpose,
        ...(purpose === "exact" ? { sessionId: created.session.session_id } : {}),
      }),
      { code: "DOTAIOS_SESSION_PROJECTION_DRIFT" },
    );
    assert.equal(changed, true);
    assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
  });
}

for (const artifact of ["manifest", "canonical-stage"]) {
  test(`recovery bounds an oversized ${artifact} before reading transaction bytes`, async (t) => {
    const aiosPath = tmpAios();
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    const interrupted = createSessionStore({
      aiosPath,
      faultInjector(phase) {
        if (phase === "before_pending") throw new Error("leave-private-transaction");
      },
    });
    await assert.rejects(() => interrupted.capture({ session: session() }));
    const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
    const privateName = (await fsp.readdir(storeRoot)).find((name) => name.startsWith(".private-"));
    assert.ok(privateName);
    const artifactPath = path.join(
      storeRoot,
      privateName,
      artifact === "manifest" ? "manifest.json" : "canonical.md",
    );
    const oversizedBytes = artifact === "manifest" ? 16 * 1024 + 1 : 8 * 1024 * 1024 + 1;
    await fsp.truncate(artifactPath, oversizedBytes);

    await assert.rejects(
      () => createSessionStore({ aiosPath }).capture({
        session: session({ captured_at: "2026-08-11T11:00:00.000Z" }),
      }),
      { code: "DOTAIOS_SESSION_STORE_POISONED" },
    );
    assert.equal((await fsp.stat(artifactPath)).size, oversizedBytes);
    assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
  });
}

for (const scenario of [
  { name: "bootstrap", phase: "after_bootstrap_directory", prefix: ".bootstrap-" },
  { name: "unpublished", phase: "before_pending", prefix: ".private-" },
  { name: "closed", phase: "after_cleanup_detach", prefix: ".cleanup-" },
]) {
  test(`${scenario.name} recovery bounds hostile transaction children before allocating the full directory`, async (t) => {
    const aiosPath = tmpAios();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-entry-bound-outside-"));
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const outsideCanary = path.join(outsideRoot, "canary.txt");
    await fsp.writeFile(outsideCanary, "OUTSIDE_ENTRY_BOUND_CANARY\n", { mode: 0o600 });

    const interrupted = createSessionStore({
      aiosPath,
      faultInjector(phase) {
        if (phase === scenario.phase) throw new Error(`leave-${scenario.name}-transaction`);
      },
    });
    await assert.rejects(() => interrupted.capture({ session: session() }));
    const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
    const transactionName = (await fsp.readdir(storeRoot)).find((name) => name.startsWith(scenario.prefix));
    assert.ok(transactionName, `${scenario.name} transaction must survive the injected failure`);
    const transactionPath = path.join(storeRoot, transactionName);
    for (let index = 0; index < 9; index += 1) {
      await fsp.writeFile(
        path.join(transactionPath, `hostile-${String(index).padStart(2, "0")}.bin`),
        `HOSTILE_TRANSACTION_CHILD_${index}\n`,
        { mode: 0o600 },
      );
    }
    const transactionBefore = await treeBytes(transactionPath);
    let unboundedReadAttempted = false;
    const filesystem = Object.create(fsp);
    filesystem.readdir = async (candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(transactionPath)) {
        unboundedReadAttempted = true;
        const error = new Error("transaction recovery attempted an unbounded directory read");
        error.code = "DOTAIOS_TEST_UNBOUNDED_READ";
        throw error;
      }
      return fsp.readdir(candidate, ...args);
    };

    const outcome = await settle(createSessionStore({ aiosPath, filesystem }).capture({
      session: session({ captured_at: "2026-08-11T11:00:00.000Z" }),
    }));

    assert.equal(outcome.error?.code, "DOTAIOS_SESSION_STORE_POISONED");
    assert.equal(unboundedReadAttempted, false, "transaction children must be consumed incrementally");
    assert.deepEqual(await treeBytes(transactionPath), transactionBefore, "refusal must preserve transaction evidence");
    assert.equal(await fsp.readFile(path.join(aiosPath, "unrelated", "canary.txt"), "utf8"), "UNRELATED_CANARY\n");
    assert.equal(await fsp.readFile(outsideCanary, "utf8"), "OUTSIDE_ENTRY_BOUND_CANARY\n");
  });
}

async function treeBytes(root) {
  const tree = {};
  async function walk(current, relative = "") {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.posix.join(relative, entry.name);
      const child = path.join(current, entry.name);
      const stats = await fsp.lstat(child);
      const identity = `${stats.dev}:${stats.ino}:${stats.mode}:${stats.uid}:${stats.nlink}`;
      if (entry.isSymbolicLink()) tree[childRelative] = `${identity}:link:${await fsp.readlink(child)}`;
      else if (entry.isDirectory()) {
        tree[`${childRelative}/`] = `${identity}:directory`;
        await walk(child, childRelative);
      } else tree[childRelative] = `${identity}:file:${(await fsp.readFile(child)).toString("base64")}`;
    }
  }
  await walk(root);
  return tree;
}

async function containsBytes(root, marker) {
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (await walk(child)) return true;
      } else if ((await fsp.readFile(child, "utf8")).includes(marker)) {
        return true;
      }
    }
    return false;
  }
  return walk(root);
}
