import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderSessionMarkdown } from "../../packages/core/src/session-codec.mjs";
import { createSessionStore } from "../../packages/core/src/session-store.mjs";

function tmpAios(prefix = "dotaios-session-security-") {
  // Unix-domain sockets have a small pathname ceiling on macOS. Keep this
  // adversarial fixture short enough that the socket is created at the exact
  // canonical/projection pathname under test rather than a truncated alias.
  const base = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const root = fs.mkdtempSync(path.join(base, prefix === "dotaios-session-security-" ? "dss-" : prefix));
  fs.writeFileSync(path.join(root, "aios.json"), "{\"version\":\"1\"}\n");
  return root;
}

function session(overrides = {}) {
  return {
    agent: "manual",
    session_id: "11111111",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "manual",
    title: "Owned session",
    turns: [{ role: "user", content: "ORIGINAL_SESSION_BYTES" }],
    ...overrides,
  };
}

test("operational ancestors and lock state cannot redirect writes outside the store", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX link ownership fixture");
  for (const artifact of ["store-root-symlink", "pending-symlink", "lock-symlink", "lock-hardlink"]) {
    const aiosPath = tmpAios();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dss-operational-"));
    const canary = path.join(outsideRoot, "canary");
    await fsp.writeFile(canary, "OUTSIDE_OPERATIONAL_CANARY\n", { mode: 0o600 });
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

    const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
    if (artifact === "store-root-symlink") {
      await fsp.mkdir(path.dirname(storeRoot), { mode: 0o700 });
      await fsp.symlink(outsideRoot, storeRoot);
    } else {
      await createSessionStore({ aiosPath }).capture({ session: session() });
      const target = artifact === "pending-symlink"
        ? path.join(storeRoot, "pending")
        : path.join(storeRoot, "store.lock");
      if (artifact === "lock-hardlink") await fsp.link(canary, target);
      else await fsp.symlink(artifact === "pending-symlink" ? outsideRoot : canary, target);
    }

    await assert.rejects(
      () => createSessionStore({ aiosPath, lockTimeoutMs: 100 }).capture({
        session: session({ session_id: "22222222" }),
      }),
      (error) => typeof error?.code === "string" && error.code.startsWith("DOTAIOS_"),
      artifact,
    );
    assert.equal(await fsp.readFile(canary, "utf8"), "OUTSIDE_OPERATIONAL_CANARY\n", artifact);
  }
});

test("report-only reconciliation distinguishes pending, poisoned, and unsafe operational nodes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX linked and special-node fixture");

  await t.test("one proved pending directory is pending", async (subtest) => {
    const aiosPath = tmpAios();
    subtest.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
    await fsp.mkdir(path.join(storeRoot, "pending"), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.join(aiosPath, ".dotaios"), 0o700);
    await fsp.chmod(storeRoot, 0o700);

    const report = await createSessionStore({ aiosPath }).reconcile({ apply: false });

    assert.equal(report.operational_state, "pending");
    assert.equal((await fsp.lstat(path.join(storeRoot, "pending"))).isDirectory(), true);
  });

  await t.test("an unknown regular artifact is poisoned", async (subtest) => {
    const aiosPath = tmpAios();
    subtest.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
    await fsp.mkdir(storeRoot, { recursive: true, mode: 0o700 });
    await fsp.chmod(path.join(aiosPath, ".dotaios"), 0o700);
    await fsp.chmod(storeRoot, 0o700);
    const poison = path.join(storeRoot, "unexpected-residue");
    await fsp.writeFile(poison, "POISON_CANARY\n", { mode: 0o600 });

    const report = await createSessionStore({ aiosPath }).reconcile({ apply: false });

    assert.equal(report.operational_state, "poisoned");
    assert.equal(await fsp.readFile(poison, "utf8"), "POISON_CANARY\n");
  });

  for (const artifact of ["pending-symlink", "lock-hardlink", "lock-fifo", "pending-socket"]) {
    await t.test(`${artifact} is unsafe and preserved`, async (subtest) => {
      const aiosPath = tmpAios();
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dss-operational-report-"));
      subtest.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
      subtest.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
      const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
      await fsp.mkdir(storeRoot, { recursive: true, mode: 0o700 });
      await fsp.chmod(path.join(aiosPath, ".dotaios"), 0o700);
      await fsp.chmod(storeRoot, 0o700);
      const target = path.join(storeRoot, artifact.startsWith("lock-") ? "store.lock" : "pending");
      const canary = path.join(outsideRoot, "canary");
      let cleanup = async () => {};
      if (artifact === "pending-symlink") {
        await fsp.writeFile(canary, "OUTSIDE_OPERATIONAL_REPORT_CANARY\n", { mode: 0o600 });
        await fsp.symlink(outsideRoot, target);
      } else if (artifact === "lock-hardlink") {
        await fsp.writeFile(canary, "OUTSIDE_OPERATIONAL_REPORT_CANARY\n", { mode: 0o600 });
        await fsp.link(canary, target);
      } else if (artifact === "lock-fifo") {
        const result = spawnSync("mkfifo", [target], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || "mkfifo failed");
      } else {
        const server = net.createServer();
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(target, resolve);
        });
        cleanup = async () => new Promise((resolve) => server.close(resolve));
        subtest.after(cleanup);
      }

      const report = await createSessionStore({ aiosPath }).reconcile({ apply: false });

      assert.equal(report.operational_state, "unsafe");
      assert.equal(fs.existsSync(target), true);
      if (fs.existsSync(canary)) {
        assert.equal(await fsp.readFile(canary, "utf8"), "OUTSIDE_OPERATIONAL_REPORT_CANARY\n");
      }
    });
  }
});

test("operational and published files remain private under a permissive umask", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission fixture");
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const previousUmask = process.umask(0);
  let created;
  try {
    created = await createSessionStore({ aiosPath }).capture({ session: session() });
  } finally {
    process.umask(previousUmask);
  }

  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const canonicalPath = path.join(aiosPath, created.relativePath);
  assert.equal((await fsp.stat(storeRoot)).mode & 0o777, 0o700);
  assert.equal((await fsp.stat(indexPath)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(canonicalPath)).mode & 0o777, 0o600);
});

test("delete restores a swapped foreign node instead of losing its bytes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX path-swap fixture");
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const initial = createSessionStore({ aiosPath });
  const created = await initial.capture({ session: session() });
  const canonical = path.join(aiosPath, created.relativePath);
  const parkedOriginal = path.join(aiosPath, "parked-original.md");
  const foreignBytes = "FOREIGN_DELETE_CANARY\n";
  let swapped = false;

  const filesystem = Object.create(fsp);
  filesystem.rename = async (source, destination) => {
    if (!swapped && path.resolve(String(source)) === path.resolve(canonical) && String(destination).endsWith("deleted.md")) {
      swapped = true;
      await fsp.rename(canonical, parkedOriginal);
      await fsp.writeFile(canonical, foreignBytes, { mode: 0o600 });
    }
    return fsp.rename(source, destination);
  };
  const store = createSessionStore({ aiosPath, filesystem });

  await assert.rejects(
    () => store.delete({ sessionId: created.session.session_id }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );

  assert.equal(swapped, true);
  assert.equal(await fsp.readFile(canonical, "utf8"), foreignBytes);
  assert.match(await fsp.readFile(parkedOriginal, "utf8"), /ORIGINAL_SESSION_BYTES/);
});

test("delete identifies the exact inode even when a swapped node has identical bytes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX inode fixture");
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const initial = createSessionStore({ aiosPath });
  const created = await initial.capture({ session: session() });
  const canonical = path.join(aiosPath, created.relativePath);
  const parkedOriginal = path.join(aiosPath, "parked-identical-original.md");
  const originalBytes = await fsp.readFile(canonical);
  let replacementInode = null;
  const filesystem = Object.create(fsp);
  filesystem.rename = async (source, destination) => {
    if (replacementInode === null && path.resolve(String(source)) === path.resolve(canonical) && String(destination).endsWith("deleted.md")) {
      await fsp.rename(canonical, parkedOriginal);
      await fsp.writeFile(canonical, originalBytes, { mode: 0o600 });
      replacementInode = (await fsp.lstat(canonical)).ino;
    }
    return fsp.rename(source, destination);
  };
  const store = createSessionStore({ aiosPath, filesystem });

  await assert.rejects(
    () => store.delete({ sessionId: created.session.session_id }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );

  assert.equal((await fsp.lstat(canonical)).ino, replacementInode);
  assert.deepEqual(await fsp.readFile(canonical), originalBytes);
  assert.deepEqual(await fsp.readFile(parkedOriginal), originalBytes);
});

test("canonical after-image publication never overwrites a newly occupied target", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const foreignBytes = "FOREIGN_CANONICAL_PUBLICATION_CANARY\n";
  let occupiedTarget = null;
  const filesystem = Object.create(fsp);
  filesystem.link = async (source, destination) => {
    if (occupiedTarget === null && String(source).endsWith(`${path.sep}pending${path.sep}canonical.md`)) {
      occupiedTarget = String(destination);
      await fsp.writeFile(occupiedTarget, foreignBytes, { mode: 0o600 });
    }
    return fsp.link(source, destination);
  };
  const store = createSessionStore({ aiosPath, filesystem });

  await assert.rejects(
    () => store.capture({ session: session() }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );

  assert.ok(occupiedTarget);
  assert.equal(await fsp.readFile(occupiedTarget, "utf8"), foreignBytes);
});

test("projection publication never overwrites a newly occupied target", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const foreignBytes = "FOREIGN_PROJECTION_PUBLICATION_CANARY\n";
  let occupiedTarget = null;
  async function occupyForProjection(source, destination) {
    if (
      occupiedTarget === null
      && String(source).endsWith(`${path.sep}pending${path.sep}index.jsonl`)
    ) {
      occupiedTarget = String(destination);
      await fsp.writeFile(occupiedTarget, foreignBytes, { mode: 0o600 });
    }
  }
  const filesystem = Object.create(fsp);
  filesystem.link = async (source, destination) => {
    await occupyForProjection(source, destination);
    return fsp.link(source, destination);
  };
  filesystem.rename = async (source, destination) => {
    await occupyForProjection(source, destination);
    return fsp.rename(source, destination);
  };
  const store = createSessionStore({ aiosPath, filesystem });

  await assert.rejects(
    () => store.capture({ session: session() }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );

  assert.ok(occupiedTarget);
  assert.equal(await fsp.readFile(occupiedTarget, "utf8"), foreignBytes);
});

test("manifestless private recovery residue is poison-preserved, never guessed-owned cleanup", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  const privateRoot = path.join(storeRoot, `.private-${crypto.randomUUID()}`);
  await fsp.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fsp.chmod(path.join(aiosPath, ".dotaios"), 0o700);
    await fsp.chmod(storeRoot, 0o700);
    await fsp.chmod(privateRoot, 0o700);
  }
  const canary = path.join(privateRoot, "canonical.md");
  await fsp.writeFile(canary, "UNPROVED_PRIVATE_CANARY\n", { mode: 0o600 });

  const store = createSessionStore({ aiosPath });
  await assert.rejects(
    () => store.capture({ session: session() }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );
  assert.equal(await fsp.readFile(canary, "utf8"), "UNPROVED_PRIVATE_CANARY\n");
});

test("an interrupted private-transaction bootstrap is recoverable without weakening private residue refusal", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_bootstrap_directory") throw new Error("interrupt-bootstrap");
    },
  });

  await assert.rejects(
    () => interrupted.capture({ session: session() }),
    { code: "DOTAIOS_SESSION_STORE_IO" },
  );

  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  assert.equal(
    (await fsp.readdir(storeRoot)).some((entry) => entry.startsWith(".bootstrap-")),
    true,
  );
  const recovered = await createSessionStore({ aiosPath }).capture({ session: session() });
  assert.equal(recovered.outcome, "created");
  assert.equal(
    (await fsp.readdir(storeRoot)).some((entry) => entry.startsWith(".bootstrap-")),
    false,
  );
});

for (const residue of ["unknown-id", "malformed-manifest"]) {
  test(`${residue} cleanup residue is poison-preserved, never guessed-owned cleanup`, async (t) => {
    const aiosPath = tmpAios();
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    const store = createSessionStore({ aiosPath });
    await store.capture({ session: session() });
    const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
    const cleanupRoot = path.join(storeRoot, residue === "unknown-id"
      ? ".cleanup-untrusted"
      : ".cleanup-11111111-1111-4111-8111-111111111111");
    await fsp.mkdir(cleanupRoot, { mode: 0o700 });
    const canary = path.join(cleanupRoot, "canary.txt");
    await fsp.writeFile(canary, "UNPROVED_CLEANUP_CANARY\n", { mode: 0o600 });
    if (residue === "malformed-manifest") {
      await fsp.writeFile(path.join(cleanupRoot, "manifest.json"), "{malformed}\n", { mode: 0o600 });
    }

    await assert.rejects(
      () => store.reconcile({ apply: true }),
      { code: "DOTAIOS_SESSION_STORE_POISONED" },
    );
    assert.equal(await fsp.readFile(canary, "utf8"), "UNPROVED_CLEANUP_CANARY\n");
  });
}

test("unpublished cleanup re-proves the exact private directory after nonce tombstoning", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "before_pending") throw new Error("interrupt-before-publication");
    },
  });
  await assert.rejects(() => interrupted.capture({ session: session() }));
  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  const parkedOriginal = path.join(aiosPath, "parked-private-original");
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.rename = async (source, destination) => {
    if (
      !swapped
      && path.basename(String(source)).startsWith(".private-")
      && path.basename(String(destination)).startsWith(".discard-")
    ) {
      swapped = true;
      await fsp.rename(source, parkedOriginal);
      await fsp.cp(parkedOriginal, source, { recursive: true, preserveTimestamps: true });
      if (process.platform !== "win32") {
        await fsp.chmod(source, 0o700);
        for (const entry of await fsp.readdir(source)) await fsp.chmod(path.join(source, entry), 0o600);
      }
    }
    return fsp.rename(source, destination);
  };
  const recovery = createSessionStore({ aiosPath, filesystem });

  await assert.rejects(
    () => recovery.capture({ session: session() }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );

  assert.equal(swapped, true);
  assert.equal(fs.existsSync(path.join(parkedOriginal, "manifest.json")), true);
  assert.equal(
    (await fsp.readdir(storeRoot)).some((entry) => entry.startsWith(".discard-")),
    true,
    "the unproved replacement tombstone must be preserved",
  );
});

test("pending recovery refuses a persistent canonical ancestor redirect without moving outside bytes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX directory-link fixture");
  const aiosPath = tmpAios();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dss-recovery-date-"));
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const baseline = createSessionStore({ aiosPath });
  const created = await baseline.capture({ session: session() });
  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_pending") throw new Error("interrupt-delete");
    },
  });
  await assert.rejects(() => interrupted.delete({ sessionId: created.session.session_id }));

  const canonical = path.join(aiosPath, created.relativePath);
  const dateRoot = path.dirname(canonical);
  const redirectedDateRoot = path.join(outsideRoot, "redirected-date");
  await fsp.rename(dateRoot, redirectedDateRoot);
  await fsp.symlink(redirectedDateRoot, dateRoot, "dir");
  const canonicalOutside = path.join(redirectedDateRoot, path.basename(canonical));
  const before = await fsp.readFile(canonicalOutside);
  try {
    await assert.rejects(
      () => createSessionStore({ aiosPath }).reconcile({ apply: true }),
      { code: "DOTAIOS_SESSION_STORE_POISONED" },
    );
    assert.deepEqual(await fsp.readFile(canonicalOutside), before);
  } finally {
    await fsp.unlink(dateRoot).catch(() => {});
    await fsp.rename(redirectedDateRoot, dateRoot).catch(() => {});
  }
});

test("recovery re-proves the owned store root across operational directory enumeration", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX directory-link fixture");
  const aiosPath = tmpAios();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dss-recovery-store-"));
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "before_pending") throw new Error("interrupt-private");
    },
  });
  await assert.rejects(() => interrupted.capture({ session: session() }));
  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  const parkedStore = path.join(aiosPath, "parked-session-store");
  const canary = path.join(outsideRoot, "outside-canary.txt");
  await fsp.writeFile(canary, "OUTSIDE_STORE_ROOT_CANARY\n", { mode: 0o600 });
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.opendir = async (candidate, options) => {
    if (!swapped && path.resolve(String(candidate)) === path.resolve(storeRoot)) {
      swapped = true;
      await fsp.rename(storeRoot, parkedStore);
      await fsp.symlink(outsideRoot, storeRoot, "dir");
    }
    return fsp.opendir(candidate, options);
  };
  try {
    await assert.rejects(
      () => createSessionStore({ aiosPath, filesystem }).capture({ session: session() }),
      (error) => typeof error?.code === "string" && error.code.startsWith("DOTAIOS_"),
    );
    assert.equal(swapped, true);
    assert.equal(await fsp.readFile(canary, "utf8"), "OUTSIDE_STORE_ROOT_CANARY\n");
    assert.equal(
      (await fsp.readdir(parkedStore)).some((entry) => entry.startsWith(".private-")),
      true,
    );
  } finally {
    await fsp.unlink(storeRoot).catch(() => {});
    await fsp.rename(parkedStore, storeRoot).catch(() => {});
  }
});

test("closed cleanup retains its exact directory identity through the final purge", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX inode fixture");
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const interrupted = createSessionStore({
    aiosPath,
    faultInjector(phase) {
      if (phase === "after_cleanup_detach") throw new Error("interrupt-cleanup");
    },
  });
  await assert.rejects(() => interrupted.capture({ session: session() }));
  const storeRoot = path.join(aiosPath, ".dotaios", "session-store");
  const cleanupName = (await fsp.readdir(storeRoot)).find((entry) => entry.startsWith(".cleanup-"));
  const cleanupRoot = path.join(storeRoot, cleanupName);
  const parkedCleanup = path.join(aiosPath, "parked-cleanup");
  let replacementInode = null;
  const filesystem = Object.create(fsp);
  filesystem.unlink = async (candidate) => {
    const result = await fsp.unlink(candidate);
    if (
      replacementInode === null
      && path.dirname(String(candidate)) === cleanupRoot
      && path.basename(String(candidate)).startsWith(".purge-")
    ) {
      await fsp.rename(cleanupRoot, parkedCleanup);
      await fsp.mkdir(cleanupRoot, { mode: 0o700 });
      replacementInode = (await fsp.lstat(cleanupRoot)).ino;
    }
    return result;
  };

  await assert.rejects(
    () => createSessionStore({ aiosPath, filesystem }).capture({ session: session() }),
    { code: "DOTAIOS_SESSION_STORE_POISONED" },
  );
  assert.notEqual(replacementInode, null);
  assert.equal((await fsp.lstat(cleanupRoot)).ino, replacementInode);
  assert.equal(fs.existsSync(parkedCleanup), true);
});

for (const artifact of ["symlink", "hardlink", "fifo", "socket", "invalid-utf8"]) {
  test(`projection ${artifact} refuses read and report-only reconciliation mutates nothing`, async (t) => {
    if (process.platform === "win32" && ["symlink", "fifo", "socket"].includes(artifact)) {
      return t.skip("POSIX artifact fixture");
    }
    const aiosPath = tmpAios();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-outside-"));
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const store = createSessionStore({ aiosPath });
    await store.capture({ session: session() });
    const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
    const outsideCanary = path.join(outsideRoot, "projection-canary");
    const original = await fsp.readFile(indexPath);
    await fsp.writeFile(outsideCanary, original, { mode: 0o600 });
    const cleanup = await installArtifact(artifact, indexPath, outsideCanary);
    t.after(cleanup);
    const canaryBefore = await fsp.readFile(outsideCanary);

    await assert.rejects(() => store.search({ purpose: "catalog", query: "" }));
    const report = await store.reconcile({ apply: false });

    assert.equal(report.unsafe_rows, 1);
    assert.deepEqual(await fsp.readFile(outsideCanary), canaryBefore);
    assert.equal(fs.existsSync(`${indexPath}.bad.jsonl`), false);
  });
}

for (const artifact of ["symlink", "hardlink", "fifo", "socket", "invalid-utf8"]) {
  test(`canonical ${artifact} is reported and cannot be read or reconciled away`, async (t) => {
    if (process.platform === "win32" && ["symlink", "fifo", "socket"].includes(artifact)) {
      return t.skip("POSIX artifact fixture");
    }
    const aiosPath = tmpAios();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-outside-"));
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const store = createSessionStore({ aiosPath });
    const created = await store.capture({ session: session() });
    const canonical = path.join(aiosPath, created.relativePath);
    const outsideCanary = path.join(outsideRoot, "canonical-canary");
    await fsp.writeFile(outsideCanary, await fsp.readFile(canonical), { mode: 0o600 });
    const cleanup = await installArtifact(artifact, canonical, outsideCanary);
    t.after(cleanup);
    const canaryBefore = await fsp.readFile(outsideCanary);

    await assert.rejects(() => store.search({ purpose: "catalog", query: "" }));
    const report = await store.reconcile({ apply: false });
    await assert.rejects(() => store.reconcile({ apply: true }));

    assert.ok(report.invalid_markdown.includes(created.relativePath));
    assert.deepEqual(await fsp.readFile(outsideCanary), canaryBefore);
  });
}

for (const artifact of ["symlink", "hardlink", "fifo", "socket", "invalid-utf8"]) {
  test(`source ${artifact} refuses capture without publishing user memory`, async (t) => {
    if (process.platform === "win32" && ["symlink", "fifo", "socket"].includes(artifact)) {
      return t.skip("POSIX artifact fixture");
    }
    const aiosPath = tmpAios();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-source-"));
    t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
    t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
    const sourcePath = path.join(aiosPath, "source.json");
    const outsideCanary = path.join(outsideRoot, "source-canary.json");
    await fsp.writeFile(sourcePath, JSON.stringify(session()), { mode: 0o600 });
    await fsp.writeFile(outsideCanary, JSON.stringify(session()), { mode: 0o600 });
    const cleanup = await installArtifact(artifact, sourcePath, outsideCanary);
    t.after(cleanup);
    const canaryBefore = await fsp.readFile(outsideCanary);
    const store = createSessionStore({ aiosPath });

    await assert.rejects(() => store.capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    }));

    assert.deepEqual(await fsp.readFile(outsideCanary), canaryBefore);
    assert.equal(fs.existsSync(path.join(aiosPath, "memory", "sessions")), false);
  });
}

test("absolute, traversal, and backslash projection rows never select outside evidence", async (t) => {
  const aiosPath = tmpAios();
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-row-"));
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const store = createSessionStore({ aiosPath });
  const created = await store.capture({ session: session() });
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const [validRow] = (await fsp.readFile(indexPath, "utf8")).trim().split("\n").map(JSON.parse);
  const outsideCanary = path.join(outsideRoot, "outside.md");
  await fsp.writeFile(outsideCanary, "OUTSIDE_ROW_CANARY\n", { mode: 0o600 });

  for (const hostilePath of [outsideCanary, "memory/sessions/../outside.md", "memory\\sessions\\outside.md"]) {
    await fsp.writeFile(indexPath, `${JSON.stringify({ ...validRow, path: hostilePath })}\n`, { mode: 0o600 });
    await assert.rejects(
      () => store.search({ purpose: "exact", sessionId: created.session.session_id }),
      { code: "DOTAIOS_SESSION_PROJECTION_ROW_UNSAFE" },
    );
    const report = await store.reconcile({ apply: false });
    assert.equal(report.unsafe_rows, 1);
    assert.equal(await fsp.readFile(outsideCanary, "utf8"), "OUTSIDE_ROW_CANARY\n");
  }
});

test("reconciliation deterministically reports orphan, stale, duplicate, and conflicting source evidence", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const sourcePath = path.join(aiosPath, "source.json");
  const base = session({ source_path: sourcePath, source_type: "import" });
  await fsp.writeFile(sourcePath, JSON.stringify({ ...base, source_path: undefined }), { mode: 0o600 });
  const store = createSessionStore({ aiosPath });
  const created = await store.capture({
    source: { path: sourcePath, policy: "manual-exact", parser: (text) => JSON.parse(text) },
  });
  const dateRoot = path.dirname(path.join(aiosPath, created.relativePath));
  const duplicatePath = path.join(dateRoot, "duplicate.md");
  const conflictPath = path.join(dateRoot, "conflict.md");
  await fsp.writeFile(duplicatePath, renderSessionMarkdown({ ...base, session_id: "22222222" }), { mode: 0o600 });
  await fsp.writeFile(conflictPath, renderSessionMarkdown({
    ...base,
    session_id: "33333333",
    turns: [{ role: "user", content: "DIVERGENT_BRANCH" }],
  }), { mode: 0o600 });
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const row = JSON.parse((await fsp.readFile(indexPath, "utf8")).trim());
  const stale = { ...row, title: "forged stale title" };
  await fsp.writeFile(indexPath, `${JSON.stringify(stale)}\n${JSON.stringify(stale)}\n`, { mode: 0o600 });

  const report = await store.reconcile({ apply: false });

  assert.equal(report.stale_rows.length, 2);
  assert.deepEqual(report.duplicate_ids, [row.session_id]);
  assert.deepEqual(report.duplicate_paths, [row.path]);
  assert.deepEqual(report.orphan_markdown, [
    created.relativePath,
    path.posix.join("memory/sessions/2026-08-11", "conflict.md"),
    path.posix.join("memory/sessions/2026-08-11", "duplicate.md"),
  ].sort());
  assert.equal(report.conflicting_sources.length, 1);
  assert.deepEqual(report.duplicate_sources, []);
});

test("delete refuses stale, missing, replaced, duplicate, and hardlinked canonical ownership", async (t) => {
  const scenarios = ["stale", "missing", "replaced", "duplicate", "hardlink"];
  for (const scenario of scenarios) {
    await t.test(scenario, async (subtest) => {
      if (process.platform === "win32" && scenario === "hardlink") return subtest.skip("POSIX link-count fixture");
      const aiosPath = tmpAios();
      subtest.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
      const store = createSessionStore({ aiosPath });
      const created = await store.capture({ session: session() });
      const canonical = path.join(aiosPath, created.relativePath);
      const original = await fsp.readFile(canonical);
      const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
      if (scenario === "stale") {
        const row = JSON.parse((await fsp.readFile(indexPath, "utf8")).trim());
        await fsp.writeFile(indexPath, `${JSON.stringify({ ...row, title: "forged" })}\n`, { mode: 0o600 });
      } else if (scenario === "missing") {
        await fsp.unlink(canonical);
      } else if (scenario === "replaced") {
        await fsp.writeFile(canonical, renderSessionMarkdown(session({
          session_id: "99999999",
          turns: [{ role: "user", content: "REPLACEMENT_CANARY" }],
        })), { mode: 0o600 });
      } else if (scenario === "duplicate") {
        await fsp.writeFile(path.join(path.dirname(canonical), "duplicate-id.md"), original, { mode: 0o600 });
      } else {
        const linked = path.join(aiosPath, "canonical-hardlink-canary.md");
        await fsp.link(canonical, linked);
      }

      await assert.rejects(() => store.delete({ sessionId: created.session.session_id }));

      if (scenario !== "missing") assert.equal(fs.existsSync(canonical), true);
      if (scenario === "replaced") assert.match(await fsp.readFile(canonical, "utf8"), /REPLACEMENT_CANARY/);
    });
  }
});

test("source ancestor replacement is detected before parser observation and outside bytes survive", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX ancestor-swap fixture");
  const aiosPath = tmpAios();
  const sourceParent = path.join(aiosPath, "incoming");
  const parkedParent = path.join(aiosPath, "incoming-parked");
  const outsideParent = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-session-source-swap-"));
  const sourcePath = path.join(sourceParent, "source.json");
  const outsidePath = path.join(outsideParent, "source.json");
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideParent, { recursive: true, force: true }));
  await fsp.mkdir(sourceParent);
  await fsp.writeFile(sourcePath, JSON.stringify(session()), { mode: 0o600 });
  await fsp.writeFile(outsidePath, "OUTSIDE_SOURCE_SWAP_CANARY\n", { mode: 0o600 });
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (candidate, flags, mode) => {
    if (!swapped && path.resolve(String(candidate)) === path.resolve(sourcePath)) {
      swapped = true;
      await fsp.rename(sourceParent, parkedParent);
      await fsp.symlink(outsideParent, sourceParent, "dir");
    }
    return fsp.open(candidate, flags, mode);
  };
  const store = createSessionStore({ aiosPath, filesystem });

  try {
    await assert.rejects(() => store.capture({
      source: { path: sourcePath, policy: "manual-exact", parser: JSON.parse },
    }));
  } finally {
    await fsp.unlink(sourceParent).catch(() => {});
    await fsp.rename(parkedParent, sourceParent).catch(() => {});
  }
  assert.equal(swapped, true);
  assert.equal(await fsp.readFile(outsidePath, "utf8"), "OUTSIDE_SOURCE_SWAP_CANARY\n");
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "sessions")), false);
});

test("projection leaf replacement is refused before replacement bytes can select a path", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const baseline = createSessionStore({ aiosPath });
  const created = await baseline.capture({ session: session() });
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const parked = path.join(aiosPath, "parked-index.jsonl");
  let swapped = false;
  const filesystem = Object.create(fsp);
  filesystem.open = async (candidate, flags, mode) => {
    if (!swapped && path.resolve(String(candidate)) === path.resolve(indexPath)) {
      swapped = true;
      await fsp.rename(indexPath, parked);
      await fsp.writeFile(indexPath, `${JSON.stringify({
        session_id: "attacker",
        path: "/tmp/outside-attacker.md",
      })}\n`, { mode: 0o600 });
    }
    return fsp.open(candidate, flags, mode);
  };
  const store = createSessionStore({ aiosPath, filesystem });

  await assert.rejects(() => store.search({ purpose: "catalog", query: "" }));

  assert.equal(swapped, true);
  assert.match(await fsp.readFile(indexPath, "utf8"), /outside-attacker/);
  assert.match(await fsp.readFile(parked, "utf8"), new RegExp(created.session.session_id));
});

test("capture refuses a canonical replacement before pending publication instead of returning false success", async (t) => {
  const aiosPath = tmpAios();
  t.after(() => fs.rmSync(aiosPath, { recursive: true, force: true }));
  const initial = createSessionStore({ aiosPath });
  const first = await initial.capture({ session: session() });
  const firstPath = path.join(aiosPath, first.relativePath);
  const replacement = renderSessionMarkdown(session({
    session_id: "99999999",
    turns: [{ role: "user", content: "REPLACED_DURING_PUBLICATION" }],
  }));
  let replaced = false;
  const store = createSessionStore({
    aiosPath,
    faultInjector: async (phase, context) => {
      if (phase !== "before_pending" || context.kind !== "create" || replaced) return;
      replaced = true;
      await fsp.writeFile(firstPath, replacement, { mode: 0o600 });
    },
  });

  await assert.rejects(() => store.capture({
    session: session({
      session_id: "22222222",
      captured_at: "2026-08-11T11:00:00.000Z",
      turns: [{ role: "user", content: "SECOND_SESSION" }],
    }),
  }));

  assert.equal(replaced, true);
  assert.match(await fsp.readFile(firstPath, "utf8"), /REPLACED_DURING_PUBLICATION/);
  const markdownFiles = fs.readdirSync(path.dirname(firstPath)).filter((name) => name.endsWith(".md"));
  assert.equal(markdownFiles.length, 1, "the refused capture must not publish its new canonical file");
});

async function installArtifact(kind, target, canary) {
  await fsp.rm(target, { force: true });
  if (kind === "symlink") {
    await fsp.symlink(canary, target);
    return async () => {};
  }
  if (kind === "hardlink") {
    await fsp.link(canary, target);
    return async () => {};
  }
  if (kind === "invalid-utf8") {
    await fsp.writeFile(target, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    return async () => {};
  }
  if (kind === "fifo") {
    const result = spawnSync("mkfifo", [target], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || "mkfifo failed");
    return async () => {};
  }
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, resolve);
  });
  return async () => new Promise((resolve) => server.close(resolve));
}
