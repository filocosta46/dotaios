import test from "node:test";
import assert from "node:assert/strict";
import { checkGitHygiene } from "../../packages/cli/src/commands/doctor.mjs";

// The owner opened his own AIOS folder and found it on a branch called
// `codex/reliabiltfteel` with a dirty tree and a row of `local-*` branches he
// could not account for. `dotaios doctor` looked straight at that folder and
// reported nothing, because its only git check was for nested repositories.
//
// Sync refuses to run anywhere but `main`, which is the right behaviour and a
// silent one: the folder simply stops syncing and nothing says so. The
// `local-*` branches come from a release that cut one before hard-resetting to
// origin/main, so they hold the only copy of whatever it reset — reported as
// recoverable work, never as clutter to delete.

const state = (over = {}) => ({ kind: "state", branch: "main", dirty: 0, localBranches: [], ...over });

test("a healthy folder passes", () => {
  const check = checkGitHygiene("/anywhere", { runGit: () => state() });
  assert.equal(check.status, "ok");
});

test("a folder that is not a repository is not a problem", () => {
  const check = checkGitHygiene("/anywhere", { runGit: () => ({ kind: "not-a-repo" }) });
  assert.equal(check.status, "ok");
});

test("a check that could not run says so rather than passing", () => {
  // Reporting a pass here would state a specific thing we did not verify, on
  // exactly the folders most likely to be in trouble.
  const check = checkGitHygiene("/anywhere", {
    runGit: () => ({ kind: "unavailable", reason: "ENOENT" })
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /did not run/);
});

test("being off main is reported, because sync silently stops there", () => {
  const check = checkGitHygiene("/anywhere", {
    runGit: () => state({ branch: "codex/reliabiltfteel" })
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /codex\/reliabiltfteel/);
  assert.match(check.detail, /sync only runs from `main`/);
  assert.match(check.fix, /checkout main/);
});

test("local-* branches are reported as recoverable work, not as clutter", () => {
  const check = checkGitHygiene("/anywhere", {
    runGit: () => state({ localBranches: ["local-2026-07-01T10-00-00", "local-2026-07-02T10-00-00"] })
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /only copy of what it reset/);
  // The fix must not tell anyone to delete them.
  assert.doesNotMatch(check.fix, /delete|branch -D|branch -d/i);
  assert.match(check.fix, /log --oneline local-2026-07-01T10-00-00/);
});

test("the three symptoms are reported together, not one at a time", () => {
  // His folder had all three at once. A check that surfaces only the first
  // sends someone round the loop three times.
  const check = checkGitHygiene("/anywhere", {
    runGit: () => state({ branch: "codex/reliabiltfteel", dirty: 398, localBranches: ["local-2026-07-01T10-00-00"] })
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /codex\/reliabiltfteel/);
  assert.match(check.detail, /398 uncommitted change/);
  assert.match(check.detail, /local-\*/);
});
