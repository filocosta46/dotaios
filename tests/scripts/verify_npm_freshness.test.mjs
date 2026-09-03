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
function fixture(t, {
  npmVersion,
  publishedVersions = [npmVersion],
  tags = [],
  origin = false,
  pushedTags = [],
  gitHead = "tagged",
  gitHeads = {},
  gitHeadFailures = [],
  retagAfterPush = []
}) {
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
    for (const tag of pushedTags) git("push", "-q", "origin", `refs/tags/${tag}`);
  }
  if (retagAfterPush.length > 0) {
    fs.appendFileSync(path.join(repo, "README.md"), "correct published source\n");
    git("add", "README.md");
    git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "published");
    for (const tag of retagAfterPush) git("tag", "-f", tag);
  }

  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const shim = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  shim("npx", `echo "${npmVersion}"`);
  // `gitHead: "tagged"` is the healthy shape — npm published the commit the tag
  // points at. "elsewhere" is the release that was tagged on the wrong commit,
  // which reads as verified while serving source nobody installed.
  const head = gitHead === "tagged"
    ? git("rev-parse", "HEAD").trim()
    : FAKE_GIT_HEAD;
  const recordedHeads = Object.fromEntries(
    publishedVersions.map((version) => [version, gitHeads[version] || head])
  );
  shim("npm", [
    'if [ "$1" = "view" ] && [ "$2" = "dotaios" ] && [ "$3" = "versions" ]; then',
    `  echo '${JSON.stringify(publishedVersions)}'`,
    "  exit 0",
    "fi",
    'case "$2" in',
    ...Object.entries(recordedHeads).map(([version, recordedHead]) =>
      gitHeadFailures.includes(version)
        ? `  dotaios@${version}) exit 1 ;;`
        : `  dotaios@${version}) echo "${recordedHead}" ;;`
    ),
    '  *) echo "" ;;',
    "esac"
  ].join("\n"));

  return { root, repo, bin, head };
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
  const environment = fixture(t, { npmVersion: "1.1.0", tags: ["v1.0.0"] });
  const result = run(environment);
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /FAIL: untagged npm release/);
  assert.match(result.stderr, /serves 1\.1\.0 but no v1\.1\.0 tag exists/);
  assert.match(result.stderr, new RegExp(`git tag -a v1\\.1\\.0 ${environment.head}`), "must name npm's gitHead");
  assert.match(result.stderr, /git push origin v1\.1\.0/);
  assert.match(result.stderr, /404/, "must say release-pinned doc links are broken until then");
});

test("a historical published version without a tag fails even when latest is tagged", { skip: WINDOWS }, (t) => {
  const environment = fixture(t, {
    npmVersion: "1.2.0",
    publishedVersions: ["1.0.0", "1.1.0", "1.2.0"],
    tags: ["v1.0.0", "v1.2.0"]
  });
  const result = run(environment);
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /published npm release.*missing.*source tag/is);
  assert.match(result.stderr, /v1\.1\.0/);
  assert.match(result.stderr, new RegExp(`git tag -a v1\\.1\\.0 ${environment.head}`));
});

test("a tag that only exists locally fails — origin is what the docs resolve", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, { npmVersion: "1.0.0", tags: ["v1.0.0"], origin: true }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /published release tag.*not on origin/);
  assert.match(result.stderr, /git push origin v1\.0\.0/);
});

test("an older local-only tag fails even when latest is pushed", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, {
    npmVersion: "1.1.0",
    publishedVersions: ["1.0.0", "1.1.0"],
    tags: ["v1.0.0", "v1.1.0"],
    origin: true,
    pushedTags: ["v1.1.0"]
  }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /not on origin: v1\.0\.0/);
  assert.doesNotMatch(result.stderr, /v1\.1\.0.*not on origin/);
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

test("a tag on the wrong commit fails — the tag existing is not the property docs need", { skip: WINDOWS }, (t) => {
  // INSTALL.md tells the reader to compare npm's gitHead against the source tag
  // and stop if they differ. A tag that resolves but points somewhere else
  // passes every other check here while blob/v<x>/INSTALL.md serves source that
  // was never published — which reads as verified, and is worse than the 404.
  const result = run(fixture(t, { npmVersion: "1.0.0", tags: ["v1.0.0"], gitHead: "elsewhere" }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /points at .*, but npm published 1\.0\.0 from/);
  assert.doesNotMatch(result.stderr, /untagged npm release/, "the tag exists; this is a different failure");
});

test("an older tag on the wrong commit fails even when latest matches", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, {
    npmVersion: "1.1.0",
    publishedVersions: ["1.0.0", "1.1.0"],
    tags: ["v1.0.0", "v1.1.0"],
    origin: true,
    pushedTags: ["v1.0.0", "v1.1.0"],
    gitHeads: { "1.0.0": FAKE_GIT_HEAD }
  }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /v1\.0\.0 points at .*, but npm published 1\.0\.0 from/);
  assert.doesNotMatch(result.stderr, /v1\.1\.0 points at/);
});

test("a historical gitHead lookup failure cannot produce a green check", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, {
    npmVersion: "1.1.0",
    publishedVersions: ["1.0.0", "1.1.0"],
    tags: ["v1.0.0", "v1.1.0"],
    gitHeadFailures: ["1.0.0"]
  }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /could not read npm gitHead metadata/);
  assert.match(result.stderr, /1\.0\.0/);
  assert.doesNotMatch(result.stdout, /^OK:/m);
});

test("a remote tag on different source fails even when the local tag matches npm", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, {
    npmVersion: "1.0.0",
    tags: ["v1.0.0"],
    origin: true,
    pushedTags: ["v1.0.0"],
    retagAfterPush: ["v1.0.0"]
  }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /v1\.0\.0 points at .*, but npm published 1\.0\.0 from/);
});

test("malformed non-empty gitHead metadata cannot produce a green check", { skip: WINDOWS }, (t) => {
  const result = run(fixture(t, {
    npmVersion: "1.0.0",
    tags: ["v1.0.0"],
    gitHeads: { "1.0.0": "not-a-commit" }
  }));
  assert.equal(result.status, 1, `expected failure, got: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /invalid gitHead for 1\.0\.0/);
  assert.doesNotMatch(result.stdout, /^OK:/m);
});
