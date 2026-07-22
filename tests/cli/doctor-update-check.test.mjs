import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { checkLatestVersion } from "../../packages/cli/src/commands/doctor.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-upd-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("doctor warns, with the exact upgrade command, when a newer version exists", async (t) => {
  await fixture(t);
  const check = await checkLatestVersion({
    currentVersion: "1.25.0",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: "1.26.0" }) })
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /1\.26\.0/);
  assert.match(check.fix, /npx dotaios@latest/, "must tell the user exactly how to upgrade");
});

test("doctor reports ok when already on the newest version", async (t) => {
  await fixture(t);
  const check = await checkLatestVersion({
    currentVersion: "1.25.0",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: "1.25.0" }) })
  });
  assert.equal(check.status, "ok");
  assert.match(check.detail, /1\.25\.0/);
});

test("offline never fails doctor — it reports ok and stays quiet", async (t) => {
  await fixture(t);
  const check = await checkLatestVersion({
    currentVersion: "1.25.0",
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.notEqual(check.status, "fail", "a health check must never fail because the network is down");
  assert.equal(check.status, "ok");
  assert.match(check.detail, /offline|skipped|could not/i);
});

test("opt-out makes doctor skip the check entirely", async (t) => {
  await fixture(t);
  let called = false;
  const check = await checkLatestVersion({
    currentVersion: "1.25.0",
    env: { DOTAIOS_NO_UPDATE_CHECK: "1" },
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({ version: "9.9.9" }) }; }
  });
  assert.equal(called, false);
  assert.equal(check.status, "ok");
  assert.match(check.detail, /disabled|skipped|off/i);
});
