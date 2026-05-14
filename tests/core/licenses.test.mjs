import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-licenses-"));
process.env.DOTAIOS_LICENSE_DIR = tempBase;

const {
  addLicense,
  findLicense,
  hasLicense,
  licenseFile,
  listLicenses,
  removeLicense,
  verifyGumroadLicense
} = await import("../../packages/core/src/licenses.mjs");

test("license store starts empty", async () => {
  assert.deepEqual(await listLicenses(), []);
  assert.equal(await hasLicense("anything"), false);
});

test("addLicense persists after verifier success", async () => {
  const fakeVerifier = async () => ({ success: true, uses: 3 });
  const entry = await addLicense({ productId: "career-pack", key: "ABC-123", vendor: "filocosta", verifier: fakeVerifier });
  assert.equal(entry.product_id, "career-pack");
  assert.equal(entry.uses, 3);
  assert.equal(await hasLicense("career-pack"), true);
  assert.ok(fs.existsSync(licenseFile()));
});

test("addLicense rejects on verifier failure", async () => {
  const fakeVerifier = async () => ({ success: false, message: "no such key" });
  await assert.rejects(
    () => addLicense({ productId: "missing-pack", key: "BAD", verifier: fakeVerifier }),
    /no such key/
  );
  assert.equal(await hasLicense("missing-pack"), false);
});

test("findLicense returns the stored entry", async () => {
  const entry = await findLicense("career-pack");
  assert.ok(entry);
  assert.equal(entry.key, "ABC-123");
  assert.equal(entry.vendor, "filocosta");
});

test("removeLicense deletes only the requested entry", async () => {
  const fakeVerifier = async () => ({ success: true });
  await addLicense({ productId: "second-pack", key: "X", verifier: fakeVerifier });

  assert.equal(await removeLicense("career-pack"), true);
  assert.equal(await hasLicense("career-pack"), false);
  assert.equal(await hasLicense("second-pack"), true);
  assert.equal(await removeLicense("does-not-exist"), false);
});

test("verifyGumroadLicense posts to Gumroad and parses success", async () => {
  let capturedUrl;
  let capturedBody;
  const stubFetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = init.body;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, uses: 7, purchase: { email: "a@b.com" } })
    };
  };
  const result = await verifyGumroadLicense({ productId: "p1", key: "k1", fetchImpl: stubFetch });
  assert.equal(result.success, true);
  assert.equal(result.uses, 7);
  assert.equal(capturedUrl, "https://api.gumroad.com/v2/licenses/verify");
  assert.match(capturedBody, /product_id=p1/);
  assert.match(capturedBody, /license_key=k1/);
});

test("verifyGumroadLicense returns the rejection message", async () => {
  const stubFetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ success: false, message: "That license does not exist." })
  });
  const result = await verifyGumroadLicense({ productId: "p1", key: "bad", fetchImpl: stubFetch });
  assert.equal(result.success, false);
  assert.match(result.message, /does not exist/);
});

test("verifyGumroadLicense handles network failure gracefully", async () => {
  const stubFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const result = await verifyGumroadLicense({ productId: "p1", key: "k1", fetchImpl: stubFetch });
  assert.equal(result.success, false);
  assert.match(result.message, /Could not reach Gumroad/);
});
