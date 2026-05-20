import test from "node:test";
import assert from "node:assert/strict";
import { requestDeviceCode, pollForToken, fetchUsername } from "../../packages/cli/src/sync/auth.mjs";

function jsonFetch(routes) {
  return async (url, opts = {}) => {
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`unstubbed fetch: ${url}`);
    let body = hit.body;
    if (typeof body === "function") body = body(opts);
    return {
      ok: hit.status ? hit.status < 400 : true,
      status: hit.status ?? 200,
      json: async () => body
    };
  };
}

test("requestDeviceCode returns parsed payload", async () => {
  const res = await requestDeviceCode({
    clientId: "ID",
    fetchImpl: jsonFetch([{
      match: "login/device/code",
      body: {
        device_code: "DC", user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        interval: 5, expires_in: 900
      }
    }])
  });
  assert.equal(res.userCode, "WDJB-MJHT");
  assert.equal(res.deviceCode, "DC");
  assert.equal(res.intervalSec, 5);
});

test("pollForToken returns token when user approves", async () => {
  let calls = 0;
  const res = await pollForToken({
    clientId: "ID",
    deviceCode: "DC",
    intervalSec: 0, // fast for test
    fetchImpl: jsonFetch([{
      match: "oauth/access_token",
      body: () => {
        calls += 1;
        if (calls < 3) return { error: "authorization_pending" };
        return { access_token: "ghu_TOKEN", token_type: "bearer", scope: "" };
      }
    }]),
    sleep: () => Promise.resolve()
  });
  assert.equal(res.accessToken, "ghu_TOKEN");
});

test("pollForToken respects slow_down by increasing interval", async () => {
  const intervals = [];
  let calls = 0;
  await pollForToken({
    clientId: "ID",
    deviceCode: "DC",
    intervalSec: 5,
    fetchImpl: jsonFetch([{
      match: "oauth/access_token",
      body: () => {
        calls += 1;
        if (calls === 1) return { error: "slow_down", interval: 10 };
        return { access_token: "T" };
      }
    }]),
    sleep: (sec) => { intervals.push(sec); return Promise.resolve(); }
  });
  assert.ok(intervals.some((s) => s >= 10), `expected a >=10s wait, got ${JSON.stringify(intervals)}`);
});

test("pollForToken throws on expired_token", async () => {
  await assert.rejects(
    pollForToken({
      clientId: "ID",
      deviceCode: "DC",
      intervalSec: 0,
      fetchImpl: jsonFetch([{
        match: "oauth/access_token",
        body: { error: "expired_token" }
      }]),
      sleep: () => Promise.resolve()
    }),
    /expired/
  );
});

test("fetchUsername returns login from /user", async () => {
  const name = await fetchUsername({
    accessToken: "T",
    fetchImpl: jsonFetch([{ match: "/user", body: { login: "filocosta46" } }])
  });
  assert.equal(name, "filocosta46");
});
