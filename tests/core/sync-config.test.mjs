import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readSyncConfig, writeSyncConfig, isSyncEnabled } from "../../packages/core/src/sync-config.mjs";

async function withTmpHome(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-sync-cfg-"));
  const cfg = path.join(tmp, "sync.json");
  try { await fn(cfg, tmp); } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

test("readSyncConfig returns null when file missing", async () => {
  await withTmpHome(async (cfg) => {
    assert.equal(await readSyncConfig(cfg), null);
  });
});

test("writeSyncConfig creates file with 0600 mode", async () => {
  await withTmpHome(async (cfg) => {
    await writeSyncConfig(cfg, { client_id: "abc", access_token: "tok" });
    const stat = await fs.stat(cfg);
    // skip mode assert on win32 — POSIX modes are noise there
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const data = JSON.parse(await fs.readFile(cfg, "utf8"));
    assert.equal(data.client_id, "abc");
    assert.equal(data.access_token, "tok");
  });
});

test("writeSyncConfig merges with existing values", async () => {
  await withTmpHome(async (cfg) => {
    await writeSyncConfig(cfg, { client_id: "abc", access_token: "tok" });
    await writeSyncConfig(cfg, { last_tick_at: "2026-05-19T00:00:00Z" });
    const data = await readSyncConfig(cfg);
    assert.equal(data.client_id, "abc");
    assert.equal(data.access_token, "tok");
    assert.equal(data.last_tick_at, "2026-05-19T00:00:00Z");
  });
});

test("isSyncEnabled is false when no access_token", async () => {
  await withTmpHome(async (cfg) => {
    assert.equal(await isSyncEnabled(cfg), false);
    await writeSyncConfig(cfg, { client_id: "abc" });
    assert.equal(await isSyncEnabled(cfg), false);
    await writeSyncConfig(cfg, { access_token: "tok" });
    assert.equal(await isSyncEnabled(cfg), true);
  });
});

test("writeSyncConfig tightens mode on pre-existing looser file", { skip: process.platform === "win32" }, async () => {
  await withTmpHome(async (cfg) => {
    await fs.writeFile(cfg, "{}", { mode: 0o644 });
    await fs.chmod(cfg, 0o644);
    await writeSyncConfig(cfg, { access_token: "T" });
    const stat = await fs.stat(cfg);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("readSyncConfig throws typed error on malformed JSON", async () => {
  await withTmpHome(async (cfg) => {
    await fs.writeFile(cfg, "{not json", { mode: 0o600 });
    await assert.rejects(readSyncConfig(cfg), /malformed/);
  });
});

test("writeSyncConfig ensures parent dir is 0700", { skip: process.platform === "win32" }, async () => {
  await withTmpHome(async (cfgPath, tmpRoot) => {
    // Place sync.json inside a nested subdir that mkdir must create
    const nested = path.join(tmpRoot, "sub", "sync.json");
    await writeSyncConfig(nested, { access_token: "T" });
    const dirStat = await fs.stat(path.dirname(nested));
    assert.equal(dirStat.mode & 0o777, 0o700);
  });
});

test("concurrent identical config writes use unique temporary files", async () => {
  await withTmpHome(async (cfg, dir) => {
    await Promise.all(Array.from({ length: 32 }, () =>
      writeSyncConfig(cfg, { access_token: "T", repo_full_name: "alice/alice-aios" })
    ));
    assert.deepEqual(await readSyncConfig(cfg), {
      access_token: "T",
      repo_full_name: "alice/alice-aios"
    });
    assert.deepEqual(
      (await fs.readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
      "successful and losing writers must leave no fixed or unique temp residue"
    );
  });
});
