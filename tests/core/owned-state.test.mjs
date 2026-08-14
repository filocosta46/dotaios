import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertOwnedFileStats,
  recoverOwnedFileExclusivePublication
} from "../../packages/core/src/owned-state.mjs";

function fileStats({ nlink, uid = -1, mode = 0 } = {}) {
  return {
    nlink,
    uid,
    mode,
    isFile: () => true,
    isSymbolicLink: () => false
  };
}

test("Windows owned files require exactly one link without relying on POSIX ownership metadata", () => {
  assert.doesNotThrow(() => assertOwnedFileStats(
    fileStats({ nlink: 1 }),
    0o600,
    { platform: "win32" }
  ));
});

test("Windows owned files reject two or more links", () => {
  for (const nlink of [2, 3]) {
    assert.throws(
      () => assertOwnedFileStats(fileStats({ nlink }), 0o600, { platform: "win32" }),
      (error) => error?.code === "DOTAIOS_OWNED_STATE_INVALID"
    );
  }
});

test("POSIX owned files accept bigint filesystem stats", () => {
  assert.doesNotThrow(() => assertOwnedFileStats(
    fileStats({
      nlink: 1n,
      uid: BigInt(typeof process.getuid === "function" ? process.getuid() : -1),
      mode: 0o100600n
    }),
    0o600,
    { platform: "linux" }
  ));
});

test("Windows recovery accepts exactly the two links created by exclusive publication", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-owned-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "receipt.json");
  const temporary = path.join(directory, ".receipt.json.00000000-0000-4000-8000-000000000001.tmp");
  fs.writeFileSync(target, "owned bytes\n", { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  fs.linkSync(target, temporary);

  assert.equal(await recoverOwnedFileExclusivePublication(target, { platform: "win32" }), true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.readFileSync(target, "utf8"), "owned bytes\n");
  assert.equal(fs.lstatSync(target).nlink, 1);
});

test("Windows recovery rejects an ordinary one-link owned file", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-owned-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "receipt.json");
  fs.writeFileSync(target, "ordinary bytes\n", { mode: 0o644 });
  fs.chmodSync(target, 0o644);

  assert.equal(await recoverOwnedFileExclusivePublication(target, { platform: "win32" }), false);
  assert.equal(fs.readFileSync(target, "utf8"), "ordinary bytes\n");
  assert.equal(fs.lstatSync(target).nlink, 1);
});

test("Windows recovery rejects excess links without unlinking the publication temporary", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-owned-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "receipt.json");
  const temporary = path.join(directory, ".receipt.json.00000000-0000-4000-8000-000000000002.tmp");
  const excess = path.join(directory, "foreign-hardlink");
  fs.writeFileSync(target, "owned bytes\n", { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  fs.linkSync(target, temporary);
  fs.linkSync(target, excess);

  assert.equal(await recoverOwnedFileExclusivePublication(target, { platform: "win32" }), false);
  assert.equal(fs.existsSync(temporary), true);
  assert.equal(fs.existsSync(excess), true);
  assert.equal(fs.lstatSync(target).nlink, 3);
});

test("Windows recovery leaves two UUID-shaped publication temporaries untouched", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-owned-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "receipt.json");
  const first = path.join(directory, ".receipt.json.00000000-0000-4000-8000-000000000003.tmp");
  const second = path.join(directory, ".receipt.json.00000000-0000-4000-8000-000000000004.tmp");
  fs.writeFileSync(target, "owned bytes\n", { mode: 0o644 });
  fs.linkSync(target, first);
  fs.linkSync(target, second);

  assert.equal(await recoverOwnedFileExclusivePublication(target, { platform: "win32" }), false);
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
  assert.equal(fs.lstatSync(target).nlink, 3);
});

test("Windows recovery ignores a non-UUID publication temporary", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-owned-state-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "receipt.json");
  const temporary = path.join(directory, ".receipt.json.00000000-0000-4000-8000-000000000005.tmp");
  const nonUuid = path.join(directory, ".receipt.json.not-a-uuid.tmp");
  fs.writeFileSync(target, "owned bytes\n", { mode: 0o644 });
  fs.linkSync(target, temporary);
  fs.writeFileSync(nonUuid, "unrelated bytes\n");

  assert.equal(await recoverOwnedFileExclusivePublication(target, { platform: "win32" }), true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.readFileSync(nonUuid, "utf8"), "unrelated bytes\n");
  assert.equal(fs.lstatSync(target).nlink, 1);
});
