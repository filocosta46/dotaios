import test from "node:test";
import assert from "node:assert/strict";

import * as repo from "../../packages/cli/src/sync/repo.mjs";

const { pollForRepoExists } = repo;

// `visibility: private` in buildCreateRepoUrl is only a query-string prefill on
// github.com/new — a page the user drives and can change, and a setting they can
// flip afterwards. The whole confidentiality story of sync rests on that repo
// actually being private, so it has to be read from the API rather than assumed.

function githubStub({ private: isPrivate, repoOk = true } = {}) {
  return async (url) => {
    if (url.endsWith("/commits")) return { ok: false, status: 409, json: async () => ({}) };
    return {
      ok: repoOk,
      status: repoOk ? 200 : 404,
      json: async () => ({ full_name: "user/user-aios", private: isPrivate })
    };
  };
}

const base = {
  accessToken: "T",
  fullName: "user/user-aios",
  sleep: async () => {},
  now: () => 0,
  timeoutMs: 1000
};

const unverifiableSetupMessage =
  "could not verify that user/user-aios is private. DotAIOS will not upload your personal context until GitHub explicitly confirms the repository is private. Re-run \"dotaios sync setup\".";
const publicSetupMessage =
  "the repo user/user-aios is public. DotAIOS will not sync your personal context to a public repository. On github.com open the repo, go to Settings, and change its visibility to Private — then re-run \"dotaios sync setup\".";

test("a private repo is accepted", async () => {
  const ok = await pollForRepoExists({ ...base, fetchImpl: githubStub({ private: true }) });
  assert.equal(ok, true);
});

test("a PUBLIC repo is refused, and the message says why it matters", async () => {
  await assert.rejects(
    () => pollForRepoExists({ ...base, fetchImpl: githubStub({ private: false }) }),
    { message: publicSetupMessage },
    "setup must not proceed against a public repo"
  );
});

test("a repo whose privacy cannot be determined is refused rather than assumed", async () => {
  // A response missing the field entirely must not be read as private.
  const fetchImpl = async (url) => {
    if (url.endsWith("/commits")) return { ok: false, status: 409, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ full_name: "user/user-aios" }) };
  };
  await assert.rejects(
    () => pollForRepoExists({ ...base, fetchImpl }),
    { message: unverifiableSetupMessage }
  );
});

test("a malformed setup privacy response is reported as unverifiable, not public", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error("invalid json"); }
  });

  await assert.rejects(
    () => pollForRepoExists({ ...base, fetchImpl }),
    { message: unverifiableSetupMessage }
  );
});

test("sync privacy verification accepts only an explicit private response", async () => {
  assert.equal(typeof repo.verifyRepoPrivate, "function");
  await assert.doesNotReject(() => repo.verifyRepoPrivate({
    accessToken: "T",
    fullName: "user/user-aios",
    fetchImpl: githubStub({ private: true })
  }));
});

test("sync privacy verification fails closed for public, non-OK, and unparseable responses", async () => {
  assert.equal(typeof repo.verifyRepoPrivate, "function");
  await assert.rejects(() => repo.verifyRepoPrivate({
    accessToken: "T",
    fullName: "user/user-aios",
    fetchImpl: githubStub({ private: false })
  }), /public/i);
  await assert.rejects(() => repo.verifyRepoPrivate({
    accessToken: "T",
    fullName: "user/user-aios",
    fetchImpl: githubStub({ repoOk: false })
  }), /could not verify/i);
  await assert.rejects(() => repo.verifyRepoPrivate({
    accessToken: "T",
    fullName: "user/user-aios",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("invalid json"); }
    })
  }), /could not verify/i);
});
