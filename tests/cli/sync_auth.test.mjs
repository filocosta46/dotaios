import test from "node:test";
import assert from "node:assert/strict";
import { buildTokenCreateUrl, validateToken } from "../../packages/cli/src/sync/auth.mjs";

test("buildTokenCreateUrl pre-fills the repo scope and a description", () => {
  const url = buildTokenCreateUrl();
  assert.ok(url.startsWith("https://github.com/settings/tokens/new?"));
  assert.ok(url.includes("scopes=repo"));
  assert.ok(/description=/.test(url));
});

test("validateToken returns the GitHub username for a good token", async () => {
  const name = await validateToken({
    accessToken: "ghp_GOOD",
    fetchImpl: async (url, opts) => {
      assert.ok(url.includes("/user"));
      assert.equal(opts.headers.Authorization, "Bearer ghp_GOOD");
      return { ok: true, status: 200, json: async () => ({ login: "filocosta46" }) };
    }
  });
  assert.equal(name, "filocosta46");
});

test("validateToken throws a plain-language error on a rejected token", async () => {
  await assert.rejects(
    validateToken({
      accessToken: "ghp_BAD",
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }),
    /token was rejected/
  );
});

test("validateToken throws when the response carries no username", async () => {
  await assert.rejects(
    validateToken({
      accessToken: "ghp_X",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) })
    }),
    /username/
  );
});

test("validateToken surfaces a clear error when GitHub is unreachable", async () => {
  await assert.rejects(
    validateToken({
      accessToken: "ghp_X",
      fetchImpl: async () => { throw new Error("ENOTFOUND"); }
    }),
    /could not reach GitHub/
  );
});
