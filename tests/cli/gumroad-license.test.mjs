import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGumroadLicense } from "../../packages/cli/src/adapters/gumroad-license.mjs";

// The Gumroad verifier lives in the CLI adapter layer, not packages/core —
// CLAUDE.md hard rule 6 keeps core offline. These are the tests that moved with
// it; tests/core/core-is-offline.test.mjs guards the boundary itself.

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
