#!/usr/bin/env node
// Fail loudly if the published npm package is BEHIND the latest released git
// tag — the exact "stale-npm release" regression the VC audit flagged (repo at
// v1.23 while `npx dotaios@latest` still resolved 1.22). A fresh user's
// `npx dotaios@latest` must never serve an older CLI than the repo has released.
//
// Also fails on the inverse hole: npm AHEAD of every released tag. A published
// version that no tag points at is just as broken — every release-pinned doc
// link (README's `blob/v<version>/INSTALL.md` install path) 404s until the tag
// is on origin — but a "not behind" check reports it as OK.
//
// Runs the resolution in a throwaway HOME so no local cache masks what a real
// first-time user would download. Intended for the release-freshness workflow
// (scheduled + on release tags), NOT every PR: a pre-publish version bump on a
// feature branch is expected to be ahead of npm and must not fail here.
//
// No grace period for the publish-then-tag window: the verdict is a function of
// repo + registry state only, never of the clock. Publish AFTER pushing the tag
// and the window never exists.

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function parseSemver(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// The commit npm published, so the failure below can name the exact tag target.
function publishedGitHead(version) {
  try {
    const out = execFileSync("npm", ["view", `dotaios@${version}`, "gitHead"], { encoding: "utf8" }).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const localVersion = pkg.version;

let tagVersion = null;
let tagNames = [];
try {
  tagNames = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (tagNames[0]) tagVersion = tagNames[0].replace(/^v/, "");
} catch {
  // No git / no tags — fall back to package.json version below.
}

const home = mkdtempSync(join(tmpdir(), "dotaios-freshness-"));
let npmRaw;
try {
  npmRaw = execFileSync("npx", ["--yes", "dotaios@latest", "--version"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: join(home, ".npm") }
  });
} catch (error) {
  console.error(`FAIL: could not resolve \`npx dotaios@latest --version\` from a clean home: ${error.message}`);
  process.exit(1);
}

const npmVersion = parseSemver(npmRaw)?.join(".");
if (!npmVersion) {
  console.error(`FAIL: could not parse a version from npx output: ${JSON.stringify(npmRaw)}`);
  process.exit(1);
}

const expected = tagVersion || localVersion;
const cmp = compareSemver(npmVersion, expected);
if (cmp === null) {
  console.error(`FAIL: uncomparable versions npm=${npmVersion} expected=${expected}`);
  process.exit(1);
}
if (cmp < 0) {
  console.error(
    `FAIL: stale npm. Released ${expected} (tag) but \`npx dotaios@latest\` resolves ${npmVersion}. ` +
    "Publish the release to npm, or fix npm auth/ownership, before announcing."
  );
  process.exit(1);
}

// The inverse: npm ahead of every tag, or ahead of its own. Assert the exact ref
// the docs pin — `v<npm latest>` — not merely "some tag >= npm", because that is
// the property README's install link depends on. Skipped when there is no tag
// information at all (no git, no tags): that is unknown, not broken.
const expectedTag = `v${npmVersion}`;
if (tagVersion && !tagNames.includes(expectedTag)) {
  const gitHead = publishedGitHead(npmVersion);
  console.error(
    `FAIL: untagged npm release. \`npx dotaios@latest\` serves ${npmVersion} but no ${expectedTag} tag exists ` +
    `(newest released tag is v${tagVersion}). Tag the published commit and push it to origin:\n` +
    `  git tag -a ${expectedTag} ${gitHead || "<gitHead>"} -m "${expectedTag}"\n` +
    `  git push origin ${expectedTag}\n` +
    (gitHead
      ? `${gitHead} is npm's recorded gitHead for ${npmVersion} — the commit that was published.`
      : `Find the published commit with: npm view dotaios@${npmVersion} gitHead.`) +
    ` Until that tag is on origin, every release-pinned link 404s — including README's ` +
    `blob/${expectedTag}/INSTALL.md install path and releases/tag/${expectedTag}.`
  );
  process.exit(1);
}

// A tag that exists only locally still 404s on github.com. This may add a
// failure, never mask one: if origin is unreachable the check degrades to a note
// rather than passing something it did not verify.
if (tagVersion) {
  let remoteTag = null;
  try {
    remoteTag = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${expectedTag}`], {
      encoding: "utf8"
    }).trim();
  } catch {
    console.log(`(note: could not reach origin to confirm ${expectedTag} is pushed.)`);
  }
  if (remoteTag === "") {
    console.error(
      `FAIL: unpushed release tag. ${expectedTag} exists locally but not on origin, so release-pinned ` +
      `links like blob/${expectedTag}/INSTALL.md still 404 for everyone else. Run: git push origin ${expectedTag}.`
    );
    process.exit(1);
  }
}

// The tag existing is not the property the docs depend on — the tag pointing at
// the published commit is. A v<x> on the wrong commit passes every check above
// while blob/v<x>/INSTALL.md serves source that was never published, which is
// worse than the 404: it looks verified. Degrades to a note when npm records no
// gitHead (2.0.1 has none) or the tag is unreadable, rather than guessing.
if (tagVersion && tagNames.includes(expectedTag)) {
  const gitHead = publishedGitHead(npmVersion);
  let tagCommit = null;
  try {
    tagCommit = execFileSync("git", ["rev-parse", `${expectedTag}^{commit}`], { encoding: "utf8" }).trim();
  } catch {
    tagCommit = null;
  }
  if (gitHead && tagCommit && gitHead !== tagCommit) {
    console.error(
      `FAIL: ${expectedTag} points at ${tagCommit}, but npm published ${npmVersion} from ${gitHead}. ` +
      `Anyone following INSTALL.md's "compare gitHead with the source tag" step reads different source than ` +
      "they installed. Move the tag to the published commit, or publish the tagged commit."
    );
    process.exit(1);
  }
  if (!gitHead) {
    console.log(`(note: npm records no gitHead for ${npmVersion}; could not confirm ${expectedTag} points at it.)`);
  }
}

console.log(
  `OK: npm latest = ${npmVersion}; latest released tag = ${tagVersion || "(none)"}; local = ${localVersion}.` +
  (compareSemver(npmVersion, localVersion) !== 0
    ? ` (note: working tree is ${localVersion}, ahead of the published ${npmVersion} — expected before publishing.)`
    : "")
);
