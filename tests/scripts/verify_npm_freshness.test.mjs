// Covers scripts/verify-npm-freshness.mjs without touching the network: `npx`
// and `npm` are shimmed onto PATH, git runs against a throwaway repo, and the
// "origin" remote is a local bare repo. Nothing is pushed and no real tag moves.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const SCRIPT = new URL("../../scripts/verify-npm-freshness.mjs", import.meta.url).pathname;
const PKG_VERSION = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
).version;
const FAKE_GIT_HEAD = "0123456789abcdef0123456789abcdef01234567";
const WINDOWS = process.platform === "win32";

// A git repo with the given tags, plus `npx`/`npm` shims that answer offline.
function fixture(t, { npmVersion, tags = [], origin = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-freshness-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", "README.md");
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  for (const tag of tags) git("tag", tag);
  if (origin) {
    const bare = path.join(root, "origin.git");
    execFileSync("git", ["init", "--bare", "-q", bare], { encoding: "utf8" });
    git("remote", "add", "origin", bare);
  }

  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const shim = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  shim("npx", `echo "${npmVersion}"`);
  shim("npm", `echo "${FAKE_GIT_HEAD}"`);

  return { root, repo, bin };
}

function run({ repo, bin, root }) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`
    }
  });
}

test("npm ahead of every tag fails, and says which commit to tag", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, { npmVersion: "1.1.0", tags: ["v1.0.0"] }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /FAIL: untagged npm release/);
  assert.match(result.stderr, /serves 1\.1\.0 but no v1\.1\.0 tag exists/);
  assert.match(result.stderr, new RegExp(`git tag -a v1\\.1\\.0 ${FAKE_GIT_HEAD}`), "must name npm's gitHead");
  assert.match(result.stderr, /git push origin v1\.1\.0/);
  assert.match(result.stderr, /404/, "must say release-pinned doc links are broken until then");
});

test("a tag that only exists locally fails — origin is what the docs resolve", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, { npmVersion: "1.0.0", tags: ["v1.0.0"], origin: true }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /FAIL: unpushed release tag/);
  assert.match(result.stderr, /git push origin v1\.0\.0/);
});

test("npm behind the newest tag still fails (pre-existing check intact)", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, { npmVersion: "1.0.0", tags: ["v1.0.0", "v1.2.0"] }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /FAIL: stale npm/);
});

test("a tagged, published version passes even when origin is unreachable", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, { npmVersion: "1.0.0", tags: ["v1.0.0"] }));
  assert.equal(result.status, 0, `expected pass, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /OK: npm latest = 1\.0\.0; latest released tag = 1\.0\.0/);
  assert.match(result.stdout, /could not reach origin/, "unverifiable origin degrades to a note, not a pass claim");
});

test("no tag information at all is unknown, not broken", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, { npmVersion: PKG_VERSION, tags: [] }));
  assert.equal(result.status, 0, `expected pass, got: ${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stderr, /untagged npm release/);
});
