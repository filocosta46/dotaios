import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireOperationLock,
  releaseOperationLock,
} from "../../packages/core/src/operation-lock.mjs";

test("32 strict contenders never parse a torn owner-state transition", { timeout: 120_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-transition-"));
  const lockPath = path.join(root, "operation.lock");
  const filesystem = slowStrictRewriteFilesystem(lockPath);
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
      const lock = await acquireOperationLock(lockPath, options);
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

test("strict reclaim completes a dead owner transition interrupted during its rewrite", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lock-transition-partial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "operation.lock");
  const filesystem = failDuringStrictRewriteFilesystem(lockPath);
  const options = {
    filesystem,
    strictOwnedState: true,
    ownsParent: false,
    ownedDirectories: [root],
    format: "dotaios-operation-lock-transition-test/v1",
    isOwnerAlive: () => false,
  };

  const interrupted = await acquireOperationLock(lockPath, options);
  await assert.rejects(
    () => releaseOperationLock(interrupted, options),
    { code: "INJECTED_DURING_REWRITE" },
  );
  const interruptedBytes = await fs.readFile(lockPath, "utf8");
  assert.throws(() => JSON.parse(interruptedBytes));

  const recovered = await acquireOperationLock(lockPath, options);
  assert.ok(recovered, "the exact journaled owner transition must recover forward");
  await releaseOperationLock(recovered, options);
  assert.deepEqual(await fs.readdir(root), []);
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
});

function slowStrictRewriteFilesystem(lockPath) {
  return new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        const handle = await target.open(filePath, flags, ...rest);
        if (path.resolve(filePath) !== path.resolve(lockPath) || flags !== "r+") return handle;
        let widened = false;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty !== "write") {
              const value = Reflect.get(handleTarget, handleProperty, handleTarget);
              return typeof value === "function" ? value.bind(handleTarget) : value;
            }
            return async (buffer, offset, length, position) => {
              if (widened || length < 4) return handleTarget.write(buffer, offset, length, position);
              widened = true;
              // Publish every byte except the JSON terminator, then hold the
              // exact inode in a stable malformed state. A contender may
              // retry only if it can prove the live owner is transitioning
              // this same inode; generic malformed strict state must refuse.
              const partial = Math.max(1, length - 2);
              const result = await handleTarget.write(buffer, offset, partial, position);
              await new Promise((resolve) => setTimeout(resolve, 15));
              return result;
            };
          },
        });
      };
    },
  });
}


function failDuringStrictRewriteFilesystem(lockPath) {
  let failOnce = true;
  return new Proxy(fs, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (filePath, flags, ...rest) => {
        const handle = await target.open(filePath, flags, ...rest);
        if (path.resolve(filePath) !== path.resolve(lockPath) || flags !== "r+") return handle;
        return new Proxy(handle, {
          get(handleTarget, handleProperty) {
            if (handleProperty !== "write" || !failOnce) {
              const value = Reflect.get(handleTarget, handleProperty, handleTarget);
              return typeof value === "function" ? value.bind(handleTarget) : value;
            }
            return async (buffer, offset, length, position) => {
              await handleTarget.write(buffer, offset, Math.max(1, length - 2), position);
              failOnce = false;
              const error = new Error("simulated interruption during owner-state rewrite");
              error.code = "INJECTED_DURING_REWRITE";
              throw error;
            };
          },
        });
      };
    },
  });
}
