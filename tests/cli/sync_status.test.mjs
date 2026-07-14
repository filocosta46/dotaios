import test from "node:test";
import assert from "node:assert/strict";
import { renderStatus } from "../../packages/cli/src/sync/status-cmd.mjs";

test("renderStatus prints 'sync is OFF' when no config", () => {
  const out = renderStatus(null);
  assert.ok(out.includes("OFF"));
  assert.ok(out.includes("dotaios sync setup"));
});

test("renderStatus prints repo + last tick when config present", () => {
  const out = renderStatus({
    access_token: "T",
    username: "alice",
    repo_full_name: "alice/alice-aios",
    last_tick_at: "2026-05-19T14:00:00.000Z",
    last_push_sha: "abc1234567",
    last_error: null
  });
  assert.ok(out.includes("alice/alice-aios"));
  assert.ok(out.includes("abc1234"));
  assert.ok(out.includes("2026-05-19"));
});

test("renderStatus calls out last_error when present", () => {
  const out = renderStatus({
    access_token: "T",
    username: "alice",
    repo_full_name: "alice/alice-aios",
    last_tick_at: "2026-05-19T14:00:00.000Z",
    last_error: "Bad credentials"
  });
  assert.ok(out.includes("Bad credentials"));
});

test("renderStatus does not leak the access token", () => {
  const out = renderStatus({
    access_token: "ghu_SUPERSECRET",
    username: "alice",
    repo_full_name: "alice/alice-aios",
    last_tick_at: "2026-05-19T14:00:00.000Z"
  });
  assert.ok(!out.includes("ghu_SUPERSECRET"), "status output must never print the token");
});

test("renderStatus reports stale cached push metadata against the remote ref", () => {
  const out = renderStatus({
    access_token: "T",
    username: "alice",
    repo_full_name: "alice/alice-aios",
    last_push_sha: "780f61f2old"
  }, {
    sha: "e5b05dfb181cdfd1d4a928809e6a3e42d0463cf1"
  });
  assert.match(out, /Remote main sha:\s+e5b05df/);
  assert.match(out, /Remote parity:\s+MISMATCH/);
  assert.match(out, /cached 780f61f/);
});

test("renderStatus makes a failed remote check visible", () => {
  const out = renderStatus({
    access_token: "T",
    username: "alice",
    repo_full_name: "alice/alice-aios"
  }, {
    error: "git ls-remote failed"
  });
  assert.match(out, /Remote parity:\s+UNKNOWN/);
  assert.match(out, /git ls-remote failed/);
});
