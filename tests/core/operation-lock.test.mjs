import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  inspectOperationLock,
  poisonOperationLock,
  releaseOperationLock,
} from "../../packages/core/src/operation-lock.mjs";

test("32 strict contenders never parse a torn owner-state transition", { timeout: 120_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-transition-"));
  const lockPath = path.join(root, "operation.lock");
  const filesystem = fs;
  const options = {
    filesystem,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
  };
  const first = await acquireOperationLock(lockPath, options);
  assert.ok(first);

  const contenders = Array.from({ length: 32 }, async () => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      let lock;
      try {
        lock = await acquireOperationLock(lockPath, options);
      } catch (error) {
        // Acquisition reports a busy lock by returning nothing, but it reports
        // one that was released mid-read by throwing. Both are this test
        // deliberately creating contention, and the loop has to treat them the
        // same way or the contention it asks for fails it.
        //
        // Only this one code is retried. A torn parse -- the thing being
        // asserted -- surfaces as DOTAIOS_OWNED_STATE_INVALID and still fails
        // the test, so the assertion below keeps its teeth.
        if (error?.code !== "DOTAIOS_OPERATION_LOCK_REMOVED") throw error;
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      if (!lock) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      await releaseOperationLock(lock, options);
      return lock.owner;
    }
    throw new Error("strict contender timed out");
  });

  await releaseOperationLock(first, options);
  const owners = await Promise.all(contenders);
  assert.equal(new Set(owners).size, 32);
});

test("normal strict release never rewrites the live owner record", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-direct-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const owner = await acquireOperationLock(lockPath, {
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
  });
  const filesystem = rejectLiveOwnerRewriteFilesystem(lockPath);
  const options = {
    filesystem,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
  };
  await releaseOperationLock(owner, options);
  assert.deepEqual(await fs.readdir(root), []);
});

test("strict release refuses and restores an identical-byte inode replacement", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-release-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const options = {
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
  };
  const owner = await acquireOperationLock(lockPath, options);
  const original = await fs.readFile(lockPath);
  let replacementIdentity = null;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "rename") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (source, destination) => {
        if (path.resolve(source) === path.resolve(lockPath) && String(destination).includes(".release.")) {
          const replacement = `${lockPath}.replacement`;
          await target.writeFile(replacement, original, { mode: 0o600 });
          await target.rename(replacement, lockPath);
          replacementIdentity = await target.lstat(lockPath);
        }
        return target.rename(source, destination);
      };
    },
  });

  await assert.rejects(
    () => releaseOperationLock(owner, { filesystem, strictOwnedState: true }),
    { code: "DOTAIOS_OWNED_STATE_INVALID" },
  );
  const restored = await fs.lstat(lockPath);
  assert.equal(restored.dev, replacementIdentity.dev);
  assert.equal(restored.ino, replacementIdentity.ino);
  assert.deepEqual(await fs.readFile(lockPath), original);
});

test("strict acquisition proves a scheduler-delayed exclusive publication sibling", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-publication-delayed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const harness = delayedExclusivePublicationFilesystem(lockPath, 100);
  const options = {
    filesystem: harness.filesystem,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
  };

  const ownerPromise = acquireOperationLock(lockPath, options);
  await harness.waitForPublicationWindow();
  const record = JSON.parse(await fs.readFile(lockPath, "utf8"));
  assert.equal(
    path.basename(harness.ownerTemporary()),
    `.operation.lock.${record.owner}.tmp`,
    "the owner token must name the exact sibling proof",
  );
  const observed = await acquireOperationLock(lockPath, options).then(
    (lock) => ({ lock }),
    (error) => ({ error }),
  );
  const owner = await ownerPromise;

  assert.equal(observed.error, undefined);
  assert.equal(observed.lock, null);
  await releaseOperationLock(owner, options);
  const acquired = await acquireOperationLock(lockPath, options);
  assert.ok(acquired, "the contender must acquire after the proved publisher releases");
  await releaseOperationLock(acquired, options);
});

test("strict acquisition waits for an exact owner temp opened before its bytes are complete", { timeout: 7_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-publication-prewrite-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const harness = delayedStrictOwnerWriteFilesystem(lockPath, 75);
  const options = {
    filesystem: harness.filesystem,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
  };

  const ownerPromise = acquireOperationLock(lockPath, options);
  await harness.waitForEmptyTemporary();
  const observed = await acquireOperationLock(lockPath, options).then(
    (lock) => ({ lock }),
    (error) => ({ error }),
  );
  const owner = await ownerPromise;

  assert.equal(observed.error, undefined);
  assert.equal(observed.lock, null);
  assert.ok(owner);
  await releaseOperationLock(owner, options);
  assert.deepEqual(await fs.readdir(root), []);
});

test("proved sibling disappearance remains occupied without reclaiming stale nlink state", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX hardlink publication fixture");
  const format = "dotaios-operation-lock-transition-test/v1";
  for (const phase of ["lstat", "lstat-nlink1", "open", "after-open"]) {
    await t.test(phase, async (subtest) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-sibling-disappear-"));
      subtest.after(() => fs.rm(root, { recursive: true, force: true }));
      const lockPath = path.join(root, "operation.lock");
      const owner = "01234567-89ab-4cde-8fab-0123456789ab";
      const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
      const raw = `${JSON.stringify({ format, pid: 987654321, owner, at: Date.now() })}\n`;
      await fs.writeFile(temporary, raw, { mode: 0o600 });
      await fs.link(temporary, lockPath);
      let injected = false;
      const filesystem = disappearingPublicationSiblingFilesystem(temporary, phase, () => {
        injected = true;
      });

      const acquired = await acquireOperationLock(lockPath, {
        filesystem,
        format,
        strictOwnedState: true,
        ownsParent: false,
        ownedDirectories: [root],
        isOwnerAlive: () => false,
      });

      assert.equal(acquired, null);
      assert.equal(injected, true);
      assert.equal(await fs.readFile(lockPath, "utf8"), raw);
      assert.equal((await fs.lstat(lockPath)).nlink, 1);
    });
  }
});

test("steal re-observation preserves a publication that settles busy", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX hardlink publication fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-steal-settled-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
  const raw = `${JSON.stringify({ format, pid: 987654321, owner, at: Date.now() })}\n`;
  await fs.writeFile(temporary, raw, { mode: 0o600 });
  await fs.link(temporary, lockPath);
  let injected = false;

  const acquired = await acquireOperationLock(lockPath, {
    filesystem: disappearingPublicationSiblingFilesystem(temporary, "lstat", () => {
      injected = true;
    }, 2),
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });

  assert.equal(acquired, null);
  assert.equal(injected, true);
  assert.equal(await fs.readFile(lockPath, "utf8"), raw);
  assert.equal((await fs.lstat(lockPath)).nlink, 1);
});

test("canonical removal during publication fallback remains busy until the next acquire", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX hardlink publication fixture");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-fallback-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
  const raw = `${JSON.stringify({ format, pid: 987654321, owner, at: Date.now() })}\n`;
  await fs.writeFile(temporary, raw, { mode: 0o600 });
  await fs.link(temporary, lockPath);

  const first = await acquireOperationLock(lockPath, {
    filesystem: missingCanonicalDuringPublicationFallbackFilesystem(lockPath, temporary),
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });

  assert.equal(first, null);
  await assert.rejects(() => fs.lstat(lockPath), { code: "ENOENT" });
  assert.equal(await fs.readFile(temporary, "utf8"), raw);
  assert.equal((await fs.lstat(temporary)).nlink, 1);

  const recovered = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });
  assert.ok(recovered);
  await releaseOperationLock(recovered, { strictOwnedState: true });
  assert.deepEqual(await fs.readdir(root), []);
});

test("canonical removal during fallback observation stays busy without publishing", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX hardlink publication fixture");
  const format = "dotaios-operation-lock-transition-test/v1";
  for (const phase of ["open", "after-open"]) {
    await t.test(phase, async (subtest) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-fallback-remove-"));
      subtest.after(() => fs.rm(root, { recursive: true, force: true }));
      const lockPath = path.join(root, "operation.lock");
      const owner = "01234567-89ab-4cde-8fab-0123456789ab";
      const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
      const raw = `${JSON.stringify({ format, pid: 987654321, owner, at: Date.now() })}\n`;
      await fs.writeFile(temporary, raw, { mode: 0o600 });
      await fs.link(temporary, lockPath);

      const first = await acquireOperationLock(lockPath, {
        filesystem: changingCanonicalDuringPublicationFallbackFilesystem(
          lockPath,
          temporary,
          phase,
          raw,
        ),
        format,
        strictOwnedState: true,
        ownsParent: false,
        ownedDirectories: [root],
        isOwnerAlive: () => false,
      });

      assert.equal(first, null);
      await assert.rejects(() => fs.lstat(lockPath), { code: "ENOENT" });
      const recovered = await acquireOperationLock(lockPath, {
        format,
        strictOwnedState: true,
        ownsParent: false,
        ownedDirectories: [root],
        isOwnerAlive: () => false,
      });
      assert.ok(recovered);
      await releaseOperationLock(recovered, { strictOwnedState: true });
    });
  }
});

test("fallback observation refuses canonical replacement or same-inode owner mutation", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX hardlink publication fixture");
  const format = "dotaios-operation-lock-transition-test/v1";
  for (const phase of ["replacement", "same-inode-mutation"]) {
    await t.test(phase, async (subtest) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-fallback-change-"));
      subtest.after(() => fs.rm(root, { recursive: true, force: true }));
      const lockPath = path.join(root, "operation.lock");
      const owner = "01234567-89ab-4cde-8fab-0123456789ab";
      const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
      const raw = `${JSON.stringify({ format, pid: 987654321, owner, at: Date.now() })}\n`;
      const replacementOwner = "11234567-89ab-4cde-8fab-0123456789ab";
      const replacementRaw = `${JSON.stringify({
        format,
        pid: 987654322,
        owner: replacementOwner,
        at: Date.now(),
      })}\n`;
      await fs.writeFile(temporary, raw, { mode: 0o600 });
      await fs.link(temporary, lockPath);

      await assert.rejects(
        () => acquireOperationLock(lockPath, {
          filesystem: changingCanonicalDuringPublicationFallbackFilesystem(
            lockPath,
            temporary,
            phase,
            replacementRaw,
          ),
          format,
          strictOwnedState: true,
          ownsParent: false,
          ownedDirectories: [root],
          isOwnerAlive: () => false,
        }),
        { code: "DOTAIOS_OWNED_STATE_INVALID" },
      );
      assert.equal(await fs.readFile(lockPath, "utf8"), replacementRaw);
    });
  }
});

test("strict poison is a retained terminal marker and never rewrites the canonical owner", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-transition-partial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const options = {
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
    isOwnerAlive: () => false,
  };

  const owner = await acquireOperationLock(lockPath, options);
  const beforeBytes = await fs.readFile(lockPath);
  const beforeIdentity = await fs.lstat(lockPath);
  await poisonOperationLock(owner, options);
  assert.deepEqual(await fs.readFile(lockPath), beforeBytes);
  const afterIdentity = await fs.lstat(lockPath);
  assert.equal(afterIdentity.dev, beforeIdentity.dev);
  assert.equal(afterIdentity.ino, beforeIdentity.ino);
  assert.equal(await acquireOperationLock(lockPath, options), null);
  const inspected = await inspectOperationLock(lockPath, {
    format: options.format,
    strictOwnedState: true,
    isOwnerAlive: () => false,
  });
  assert.equal(inspected.record.poisoned, true);
  assert.ok((await fs.readdir(root)).includes("operation.lock.transition"));
});

test("legacy releasing journal is resolved before dead-owner reclaim", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-legacy-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
  });
  const held = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const stats = await fs.lstat(lockPath);
  const transition = {
    format: "dotaios-operation-lock-transition/v1",
    lock_format: format,
    pid: held.pid,
    owner: held.owner,
    at: held.at,
    ...(held.process_started_at && { process_started_at: held.process_started_at }),
    lock_dev: String(stats.dev),
    lock_ino: String(stats.ino),
    next: { ...held, releasing: true },
  };
  await fs.writeFile(`${lockPath}.transition`, `${JSON.stringify(transition)}\n`, { mode: 0o600 });

  const recovered = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });
  assert.ok(recovered);
  assert.notEqual(recovered.owner, owner.owner);
  await assert.rejects(() => fs.lstat(`${lockPath}.transition`), { code: "ENOENT" });
  await releaseOperationLock(recovered, { strictOwnedState: true });
});

test("dead exact publication residue normalizes under recovery lock", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-publication-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const record = { format, pid: 987654321, owner, at: Date.now() };
  const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.link(temporary, lockPath);
  const canary = path.join(root, "outside-canary");
  await fs.writeFile(canary, "outside\n", { mode: 0o600 });

  const recovered = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });
  assert.ok(recovered);
  assert.notEqual(recovered.owner, owner);
  await assert.rejects(() => fs.lstat(temporary), { code: "ENOENT" });
  assert.equal(await fs.readFile(canary, "utf8"), "outside\n");
  await releaseOperationLock(recovered, { strictOwnedState: true });
});

test("dead owner temp-only residue converges after fsync before link", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-owner-temp-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify({
    format,
    pid: 987654321,
    owner,
    at: Date.now(),
  })}\n`, { mode: 0o600 });
  const canary = path.join(root, "outside-canary");
  await fs.writeFile(canary, "outside\n", { mode: 0o600 });

  const recovered = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });

  assert.ok(recovered);
  assert.notEqual(recovered.owner, owner);
  await assert.rejects(() => fs.lstat(temporary), { code: "ENOENT" });
  assert.equal(await fs.readFile(canary, "utf8"), "outside\n");
  await releaseOperationLock(recovered, { strictOwnedState: true });
});

test("poison transition temp-only residue is terminal after fsync before link", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-poison-temp-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const transitionPath = `${lockPath}.transition`;
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
  });
  const held = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const stats = await fs.lstat(lockPath);
  const transition = {
    format: "dotaios-operation-lock-transition/v1",
    lock_format: format,
    pid: held.pid,
    owner: held.owner,
    at: held.at,
    ...(held.process_started_at && { process_started_at: held.process_started_at }),
    lock_dev: String(stats.dev),
    lock_ino: String(stats.ino),
    next: { ...held, poisoned: true },
  };
  const temporary = path.join(root, `.operation.lock.transition.${owner.owner}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(transition)}\n`, { mode: 0o600 });
  const canary = path.join(root, "outside-canary");
  await fs.writeFile(canary, "outside\n", { mode: 0o600 });

  const acquired = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });
  assert.equal(acquired, null);
  const inspected = await inspectOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    isOwnerAlive: () => false,
  });
  assert.equal(inspected.record.poisoned, true);
  assert.equal(await fs.readFile(canary, "utf8"), "outside\n");
  assert.deepEqual(JSON.parse(await fs.readFile(temporary, "utf8")), transition);
  await assert.rejects(() => fs.lstat(transitionPath), { code: "ENOENT" });
});

test("orphan poison authority cannot admit a replacement owner", { timeout: 5_000 }, async (t) => {
  const format = "dotaios-operation-lock-transition-test/v1";
  for (const staged of [false, true]) {
    await t.test(staged ? "staged transition" : "published transition", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-orphan-poison-"));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const lockPath = path.join(root, "operation.lock");
      const owner = await acquireOperationLock(lockPath, {
        format,
        strictOwnedState: true,
        ownsParent: false,
        ownedDirectories: [root],
      });
      await poisonOperationLock(owner, { strictOwnedState: true });
      const transitionPath = `${lockPath}.transition`;
      if (staged) {
        const temporary = path.join(root, `.operation.lock.transition.${owner.owner}.tmp`);
        await fs.rename(transitionPath, temporary);
      }
      await fs.unlink(lockPath);

      const acquired = await acquireOperationLock(lockPath, {
        format,
        strictOwnedState: true,
        ownsParent: false,
        ownedDirectories: [root],
        isOwnerAlive: () => false,
      });

      assert.equal(acquired, null);
      await assert.rejects(() => fs.lstat(lockPath), { code: "ENOENT" });
    });
  }
});

test("only dot-prefixed staged transition names carry orphan terminal authority", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-transition-grammar-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const record = {
    format: "dotaios-operation-lock-transition/v1",
    lock_format: format,
    pid: process.pid,
    owner,
    at: Date.now(),
    lock_dev: "1",
    lock_ino: "1",
    next: { format, pid: process.pid, owner, at: Date.now(), poisoned: true },
  };
  record.next.at = record.at;
  const lookalike = path.join(root, `Xoperation.lock.transition.${owner}.tmp`);
  await fs.writeFile(lookalike, `${JSON.stringify(record)}\n`, { mode: 0o600 });

  const acquired = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
  });
  assert.ok(acquired);
  assert.equal(await fs.readFile(lookalike, "utf8"), `${JSON.stringify(record)}\n`);
  await releaseOperationLock(acquired, { strictOwnedState: true });
});

test("same-inode unpublished mutation cannot be skipped before owner publication", { timeout: 7_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-unpublished-mutated-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify({ format, pid: process.pid, owner, at: Date.now() })}\n`, { mode: 0o600 });
  let mutated = false;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        if (!mutated && path.resolve(filePath) === path.resolve(temporary) && flags === "r") {
          mutated = true;
          await target.writeFile(temporary, "{malformed}\n", { mode: 0o600 });
        }
        return target.open(filePath, flags, ...rest);
      };
    },
  });

  await assert.rejects(
    () => acquireOperationLock(lockPath, {
      filesystem,
      format,
      strictOwnedState: true,
      ownsParent: false,
      ownedDirectories: [root],
    }),
    { code: "DOTAIOS_OWNED_STATE_INVALID" },
  );
  assert.equal(mutated, true);
  assert.equal(await fs.readFile(temporary, "utf8"), "{malformed}\n");
  await assert.rejects(() => fs.lstat(lockPath), { code: "ENOENT" });
});

test("exact unpublished owner observation outlives the generic transition window", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-unpublished-churn-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = "01234567-89ab-4cde-8fab-0123456789ab";
  const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify({ format, pid: process.pid, owner, at: Date.now() })}\n`, { mode: 0o600 });
  const startedAt = Date.now();
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        if (
          path.resolve(filePath) === path.resolve(temporary)
          && flags === "r"
          && Date.now() - startedAt < 75
        ) await target.chmod(temporary, 0o600);
        return target.open(filePath, flags, ...rest);
      };
    },
  });

  const acquired = await acquireOperationLock(lockPath, {
    filesystem,
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => true,
  });
  assert.equal(acquired, null);
  assert.equal(JSON.parse(await fs.readFile(temporary, "utf8")).owner, owner);
});

test("partial pre-link write cleans only the exact exclusively-created inode", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-partial-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  let failed = false;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        const handle = await target.open(filePath, flags, ...rest);
        if (failed || flags !== "wx" || !String(filePath).endsWith(".tmp")) return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty !== "writeFile") {
              const value = Reflect.get(handleTarget, handleProperty, handleTarget);
              return typeof value === "function" ? value.bind(handleTarget) : value;
            }
            return async () => {
              failed = true;
              await handleTarget.writeFile("{partial", "utf8");
              throw Object.assign(new Error("injected partial publication"), { code: "INJECTED_PARTIAL_WRITE" });
            };
          },
        });
      };
    },
  });
  const options = {
    filesystem,
    format: "dotaios-operation-lock-transition-test/v1",
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
  };

  await assert.rejects(() => acquireOperationLock(lockPath, options), { code: "INJECTED_PARTIAL_WRITE" });
  assert.deepEqual(await fs.readdir(root), []);
  const acquired = await acquireOperationLock(lockPath, options);
  assert.ok(acquired);
  await releaseOperationLock(acquired, options);
});

test("legacy releasing temp-only transition is cleared after exact reclaim", { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-releasing-temp-only-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const format = "dotaios-operation-lock-transition-test/v1";
  const owner = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
  });
  const held = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const stats = await fs.lstat(lockPath);
  const transition = {
    format: "dotaios-operation-lock-transition/v1",
    lock_format: format,
    pid: held.pid,
    owner: held.owner,
    at: held.at,
    ...(held.process_started_at && { process_started_at: held.process_started_at }),
    lock_dev: String(stats.dev),
    lock_ino: String(stats.ino),
    next: { ...held, releasing: true },
  };
  const temporary = path.join(root, `.operation.lock.transition.${owner.owner}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(transition)}\n`, { mode: 0o600 });

  const recovered = await acquireOperationLock(lockPath, {
    format,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    isOwnerAlive: () => false,
  });
  assert.ok(recovered);
  await assert.rejects(() => fs.lstat(temporary), { code: "ENOENT" });
  await releaseOperationLock(recovered, { strictOwnedState: true });
});

test("strict transition retry never normalizes stable malformed or linked state", async (t) => {
  const format = "dotaios-operation-lock-transition-test/v1";

  await t.test("stable malformed owner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-malformed-"));
    const lockPath = path.join(root, "operation.lock");
    await fs.writeFile(lockPath, "{malformed}\n", { mode: 0o600 });
    await assert.rejects(
      () => acquireOperationLock(lockPath, { format, strictOwnedState: true }),
      { code: "DOTAIOS_OWNED_STATE_INVALID" },
    );
    assert.equal(await fs.readFile(lockPath, "utf8"), "{malformed}\n");
  });

  for (const replacement of ["missing", "valid-replacement"]) {
    await t.test(`dynamic malformed ${replacement} refuses without forgiveness`, { timeout: 5_000 }, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-malformed-dynamic-"));
      const lockPath = path.join(root, "operation.lock");
      const canary = path.join(root, "outside-canary");
      await fs.writeFile(lockPath, "{malformed}\n", { mode: 0o600 });
      await fs.writeFile(canary, "outside\n", { mode: 0o600 });
      let replaced = false;
      const filesystem = new Proxy(fs, {
        get(target, property) {
          if (property !== "lstat") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (filePath, ...rest) => {
            if (!replaced && path.resolve(filePath) === path.resolve(`${lockPath}.transition`)) {
              replaced = true;
              if (replacement === "missing") await target.unlink(lockPath);
              else {
                const staged = `${lockPath}.replacement`;
                await target.writeFile(staged, `${JSON.stringify({
                  format,
                  pid: process.pid,
                  owner: "01234567-89ab-4cde-8fab-0123456789ab",
                  at: Date.now(),
                })}\n`, { mode: 0o600 });
                await target.rename(staged, lockPath);
              }
            }
            return target.lstat(filePath, ...rest);
          };
        },
      });
      await assert.rejects(
        () => acquireOperationLock(lockPath, { filesystem, format, strictOwnedState: true }),
        { code: "DOTAIOS_OWNED_STATE_INVALID" },
      );
      assert.equal(replaced, true);
      assert.equal(await fs.readFile(canary, "utf8"), "outside\n");
      if (replacement === "valid-replacement") {
        assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).owner, "01234567-89ab-4cde-8fab-0123456789ab");
      }
    });
  }

  await t.test("persistent hardlink", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-linked-"));
    const lockPath = path.join(root, "operation.lock");
    const canary = path.join(root, "canary");
    await fs.writeFile(canary, `${JSON.stringify({
      format,
      pid: process.pid,
      owner: "linked-owner",
      at: Date.now(),
    })}\n`, { mode: 0o600 });
    await fs.link(canary, lockPath);
    const before = await fs.readFile(canary);
    await assert.rejects(
      () => acquireOperationLock(lockPath, { format, strictOwnedState: true }),
      { code: "DOTAIOS_OWNED_STATE_INVALID" },
    );
    assert.deepEqual(await fs.readFile(canary), before);
  });

  await t.test("owner-derived sibling with a third hardlink", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-linked-three-"));
    const lockPath = path.join(root, "operation.lock");
    const owner = "01234567-89ab-4cde-8fab-0123456789ab";
    const temporary = path.join(root, `.operation.lock.${owner}.tmp`);
    const third = path.join(root, "third-link");
    const raw = `${JSON.stringify({ format, pid: process.pid, owner, at: Date.now() })}\n`;
    await fs.writeFile(temporary, raw, { mode: 0o600 });
    await fs.link(temporary, lockPath);
    await fs.link(temporary, third);
    await assert.rejects(
      () => acquireOperationLock(lockPath, { format, strictOwnedState: true }),
      { code: "DOTAIOS_OWNED_STATE_INVALID" },
    );
    assert.equal(await fs.readFile(temporary, "utf8"), raw);
    assert.equal(await fs.readFile(third, "utf8"), raw);
  });

  await t.test("owner-derived sibling missing beside a stable foreign hardlink", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-linked-missing-"));
    const lockPath = path.join(root, "operation.lock");
    const owner = "01234567-89ab-4cde-8fab-0123456789ab";
    const foreign = path.join(root, "foreign-hardlink");
    const raw = `${JSON.stringify({ format, pid: process.pid, owner, at: Date.now() })}\n`;
    await fs.writeFile(lockPath, raw, { mode: 0o600 });
    await fs.link(lockPath, foreign);
    await assert.rejects(
      () => acquireOperationLock(lockPath, { format, strictOwnedState: true }),
      { code: "DOTAIOS_OWNED_STATE_INVALID" },
    );
    assert.equal(await fs.readFile(lockPath, "utf8"), raw);
    assert.equal(await fs.readFile(foreign, "utf8"), raw);
  });
});

function rejectLiveOwnerRewriteFilesystem(lockPath) {
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        if (path.resolve(filePath) === path.resolve(lockPath) && flags === "r+") {
          const error = new Error("normal release attempted a live owner rewrite");
          error.code = "LIVE_OWNER_REWRITE";
          throw error;
        }
        return target.open(filePath, flags, ...rest);
      };
    },
  });
  return filesystem;
}

function delayedExclusivePublicationFilesystem(lockPath, delayMs) {
  let ownerTemporary = null;
  let publicationWindowReady = null;
  const publicationWindow = new Promise((resolve) => { publicationWindowReady = resolve; });
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property === "link") {
        return async (source, targetPath) => {
          const result = await target.link(source, targetPath);
          if (path.resolve(targetPath) === path.resolve(lockPath) && ownerTemporary === null) {
            ownerTemporary = path.resolve(source);
            publicationWindowReady();
          }
          return result;
        };
      }
      if (property === "unlink") {
        return async (targetPath) => {
          if (ownerTemporary && path.resolve(targetPath) === ownerTemporary) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return target.unlink(targetPath);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    filesystem,
    ownerTemporary: () => ownerTemporary,
    waitForPublicationWindow: () => publicationWindow,
  });
}

function delayedStrictOwnerWriteFilesystem(lockPath, delayMs) {
  let delayed = false;
  let emptyTemporaryReady = null;
  const emptyTemporary = new Promise((resolve) => { emptyTemporaryReady = resolve; });
  const matcher = new RegExp(`^\\.${path.basename(lockPath)}\\.[0-9a-f-]+\\.tmp$`, "i");
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        const handle = await target.open(filePath, flags, ...rest);
        if (delayed || flags !== "wx" || !matcher.test(path.basename(filePath))) return handle;
        delayed = true;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty !== "writeFile") {
              const value = Reflect.get(handleTarget, handleProperty, handleTarget);
              return typeof value === "function" ? value.bind(handleTarget) : value;
            }
            return async (...args) => {
              emptyTemporaryReady();
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return handleTarget.writeFile(...args);
            };
          },
        });
      };
    },
  });
  return Object.freeze({ filesystem, waitForEmptyTemporary: () => emptyTemporary });
}

function disappearingPublicationSiblingFilesystem(temporary, phase, onInjected, occurrence = 1) {
  let observations = 0;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "lstat") {
        return async (filePath, ...rest) => {
          if (
            !onInjected.done
            && phase === "lstat"
            && path.resolve(filePath) === path.resolve(temporary)
          ) {
            observations += 1;
            if (observations !== occurrence) return target.lstat(filePath, ...rest);
            onInjected.done = true;
            onInjected();
            await target.unlink(temporary);
          }
          if (
            !onInjected.done
            && phase === "lstat-nlink1"
            && path.resolve(filePath) === path.resolve(temporary)
          ) {
            const handle = await target.open(temporary, "r");
            try {
              await target.unlink(temporary);
              onInjected.done = true;
              onInjected();
              return handle.stat();
            } finally {
              await handle.close();
            }
          }
          return target.lstat(filePath, ...rest);
        };
      }
      if (property === "open") {
        return async (filePath, flags, ...rest) => {
          if (path.resolve(filePath) !== path.resolve(temporary) || flags !== "r") {
            return target.open(filePath, flags, ...rest);
          }
          if (!onInjected.done && phase === "open") {
            onInjected.done = true;
            onInjected();
            await target.unlink(temporary);
            return target.open(filePath, flags, ...rest);
          }
          const handle = await target.open(filePath, flags, ...rest);
          if (onInjected.done || phase !== "after-open") return handle;
          return new Proxy(handle, {
            get(handleTarget, handleProperty) {
              if (handleProperty !== "readFile") {
                const value = Reflect.get(handleTarget, handleProperty, handleTarget);
                return typeof value === "function" ? value.bind(handleTarget) : value;
              }
              return async (...args) => {
                const value = await handleTarget.readFile(...args);
                onInjected.done = true;
                onInjected();
                await target.unlink(temporary);
                return value;
              };
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function missingCanonicalDuringPublicationFallbackFilesystem(lockPath, temporary) {
  let injected = false;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "lstat") {
        return async (filePath, ...rest) => {
          if (!injected && path.resolve(filePath) === path.resolve(temporary)) {
            injected = true;
            await target.unlink(lockPath);
          }
          return target.lstat(filePath, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function changingCanonicalDuringPublicationFallbackFilesystem(lockPath, temporary, phase, replacementRaw) {
  let fallback = false;
  let injected = false;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "lstat") {
        return async (filePath, ...rest) => {
          if (!fallback && path.resolve(filePath) === path.resolve(temporary)) {
            fallback = true;
            await target.unlink(temporary);
          }
          return target.lstat(filePath, ...rest);
        };
      }
      if (property === "open") {
        return async (filePath, flags, ...rest) => {
          if (!fallback || injected || path.resolve(filePath) !== path.resolve(lockPath) || flags !== "r") {
            return target.open(filePath, flags, ...rest);
          }
          injected = true;
          if (phase === "open") {
            await target.unlink(lockPath);
            return target.open(filePath, flags, ...rest);
          }
          if (phase === "replacement") {
            const replacement = `${lockPath}.replacement`;
            await target.writeFile(replacement, replacementRaw, { mode: 0o600 });
            await target.rename(replacement, lockPath);
            return target.open(filePath, flags, ...rest);
          }
          const handle = await target.open(filePath, flags, ...rest);
          return new Proxy(handle, {
            get(handleTarget, handleProperty) {
              if (handleProperty !== "readFile") {
                const value = Reflect.get(handleTarget, handleProperty, handleTarget);
                return typeof value === "function" ? value.bind(handleTarget) : value;
              }
              return async (...args) => {
                const value = await handleTarget.readFile(...args);
                if (phase === "after-open") await target.unlink(lockPath);
                else await target.writeFile(lockPath, replacementRaw, { mode: 0o600 });
                return value;
              };
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
