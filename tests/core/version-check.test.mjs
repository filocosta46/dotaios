import test from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, compareVersions } from "../../packages/core/src/version-check.mjs";

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// --- version comparison ---

test("compareVersions orders semver correctly", () => {
  assert.equal(compareVersions("1.25.0", "1.26.0"), -1);
  assert.equal(compareVersions("1.26.0", "1.25.0"), 1);
  assert.equal(compareVersions("1.25.0", "1.25.0"), 0);
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1, "numeric, not lexical");
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

// --- the happy paths ---

test("reports an update when the registry is ahead", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.25.0",
    fetchImpl: async () => jsonResponse({ version: "1.26.0" })
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.current, "1.25.0");
  assert.equal(result.latest, "1.26.0");
});

test("reports no update when versions match", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.25.0",
    fetchImpl: async () => jsonResponse({ version: "1.25.0" })
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest, "1.25.0");
});

test("a local build ahead of the registry is not an update", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.26.0",
    fetchImpl: async () => jsonResponse({ version: "1.25.0" })
  });
  assert.equal(result.updateAvailable, false, "never tell a dev on an unreleased build to downgrade");
});

// --- it must NEVER break doctor: every failure degrades quietly ---

test("offline (fetch rejects) is skipped, never thrown", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.25.0",
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org"); }
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest, null);
  assert.ok(result.skipped, "must report why it was skipped");
});

test("a slow registry times out instead of hanging doctor", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.25.0",
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      // Honor the abort signal the way a real fetch does.
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.skipped, "timeout");
});

test("a non-OK registry response is skipped", async () => {
  const result = await checkForUpdate({
    currentVersion: "1.25.0",
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
  });
  assert.equal(result.updateAvailable, false);
  assert.ok(result.skipped);
});

test("malformed registry payload is skipped, never thrown", async () => {
  for (const body of [{}, { version: null }, { version: "not-a-version" }]) {
    const result = await checkForUpdate({
      currentVersion: "1.25.0",
      fetchImpl: async () => jsonResponse(body)
    });
    assert.equal(result.updateAvailable, false, `payload ${JSON.stringify(body)} must not claim an update`);
    assert.ok(result.skipped);
  }
  const badJson = await checkForUpdate({
    currentVersion: "1.25.0",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid json"); } })
  });
  assert.equal(badJson.updateAvailable, false);
  assert.ok(badJson.skipped);
});

// --- opt-out: no network call at all ---

test("opt-out env var skips the check without touching the network", async () => {
  let called = false;
  const result = await checkForUpdate({
    currentVersion: "1.25.0",
    env: { DOTAIOS_NO_UPDATE_CHECK: "1" },
    fetchImpl: async () => { called = true; return jsonResponse({ version: "1.26.0" }); }
  });
  assert.equal(called, false, "opt-out must make zero network calls");
  assert.equal(result.skipped, "disabled");
  assert.equal(result.updateAvailable, false);
});

test("opt-out only honors real 'off' values — 0/false/empty still check", async () => {
  for (const value of ["0", "false", ""]) {
    let called = false;
    const result = await checkForUpdate({
      currentVersion: "1.25.0",
      env: { DOTAIOS_NO_UPDATE_CHECK: value },
      fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({ version: "1.26.0" }) }; }
    });
    assert.equal(called, true, `DOTAIOS_NO_UPDATE_CHECK="${value}" must NOT disable the check`);
    assert.equal(result.updateAvailable, true);
  }
  for (const value of ["1", "true", "yes"]) {
    const result = await checkForUpdate({
      currentVersion: "1.25.0",
      env: { DOTAIOS_NO_UPDATE_CHECK: value },
      fetchImpl: async () => { throw new Error("must not be called"); }
    });
    assert.equal(result.skipped, "disabled", `DOTAIOS_NO_UPDATE_CHECK="${value}" must disable the check`);
  }
});

test("no usable fetch implementation is skipped, not fatal", async () => {
  const result = await checkForUpdate({ currentVersion: "1.25.0", fetchImpl: null });
  assert.equal(result.updateAvailable, false);
  assert.ok(result.skipped);
});

// --- privacy: it sends nothing but a plain GET ---

test("sends only a plain GET to the npm registry — no user data, no body", async () => {
  let seenUrl = null;
  let seenOptions = null;
  await checkForUpdate({
    currentVersion: "1.25.0",
    fetchImpl: async (url, options) => { seenUrl = url; seenOptions = options; return jsonResponse({ version: "1.25.0" }); }
  });
  assert.match(String(seenUrl), /^https:\/\/registry\.npmjs\.org\/dotaios/, "npm registry only");
  assert.ok(!seenOptions?.body, "must never send a request body");
  const method = (seenOptions?.method || "GET").toUpperCase();
  assert.equal(method, "GET");
});
