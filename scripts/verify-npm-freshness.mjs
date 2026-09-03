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
    if (out === "") return { gitHead: null, error: null };
    if (!/^[0-9a-f]{7,40}$/.test(out)) {
      return { gitHead: null, error: new Error(`npm returned an invalid gitHead for ${version}`) };
    }
    return { gitHead: out, error: null };
  } catch (error) {
    return { gitHead: null, error };
  }
}

function publishedVersions() {
  const out = execFileSync("npm", ["view", "dotaios", "versions", "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  const versions = Array.isArray(parsed) ? parsed : [parsed];
  if (
    versions.length === 0
    || versions.some((version) => typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
  ) {
    throw new Error("npm returned an invalid published-version list");
  }
  return [...new Set(versions)];
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
  const { gitHead, error: gitHeadError } = publishedGitHead(npmVersion);
  console.error(
    `FAIL: untagged npm release. \`npx dotaios@latest\` serves ${npmVersion} but no ${expectedTag} tag exists ` +
    `(newest released tag is v${tagVersion}). Tag the published commit and push it to origin:\n` +
    `  git tag -a ${expectedTag} ${gitHead || "<gitHead>"} -m "${expectedTag}"\n` +
    `  git push origin ${expectedTag}\n` +
    (gitHead
      ? `${gitHead} is npm's recorded gitHead for ${npmVersion} — the commit that was published.`
      : gitHeadError
        ? `The npm gitHead lookup failed: ${gitHeadError.message}`
      : `Find the published commit with: npm view dotaios@${npmVersion} gitHead.`) +
    ` Until that tag is on origin, every release-pinned link 404s — including README's ` +
    `blob/${expectedTag}/INSTALL.md install path and releases/tag/${expectedTag}.`
  );
  process.exit(1);
}

// The latest-version checks above cannot see older holes once a newer release
// is tagged. Every published version is a documentation namespace, so a
// historical gap still leaves version-pinned safety links returning 404.
let allPublishedVersions;
try {
  allPublishedVersions = publishedVersions();
} catch (error) {
  console.error(`FAIL: could not read the full published version list from npm: ${error.message}`);
  process.exit(1);
}
const missingPublishedTags = tagNames.length === 0
  ? []
  : allPublishedVersions.filter((version) => !tagNames.includes(`v${version}`));
if (missingPublishedTags.length > 0) {
  const instructions = missingPublishedTags.map((version) => {
    const tag = `v${version}`;
    const { gitHead, error: gitHeadError } = publishedGitHead(version);
    return gitHead
      ? `  git tag -a ${tag} ${gitHead} -m "${tag}"\n  git push origin ${tag}`
      : gitHeadError
        ? `  ${tag}: npm gitHead lookup failed (${gitHeadError.message}); retry before tagging.`
      : `  ${tag}: npm records no usable gitHead; identify the published commit before tagging (do not guess).`;
  });
  console.error(
    `FAIL: ${missingPublishedTags.length} published npm release${missingPublishedTags.length === 1 ? " is" : "s are"} `
    + `missing source tag${missingPublishedTags.length === 1 ? "" : "s"}: `
    + `${missingPublishedTags.map((version) => `v${version}`).join(", ")}.\n`
    + `${instructions.join("\n")}`
  );
  process.exit(1);
}

// A tag that exists only locally still 404s on github.com. Verify the full
// published namespace in one remote query so an older local-only tag cannot be
// hidden by a healthy latest release. If origin is unreachable, degrade to a
// note rather than passing something the script did not verify.
let remoteTagCommits = null;
if (tagVersion) {
  try {
    const output = execFileSync("git", ["ls-remote", "--tags", "origin", "refs/tags/v*"], {
      encoding: "utf8"
    }).trim();
    remoteTagCommits = new Map();
    const peeledTags = new Set();
    for (const line of output.split("\n").filter(Boolean)) {
      const [commit = "", ref = ""] = line.trim().split(/\s+/);
      const peeled = ref.endsWith("^{}");
      const tag = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
      if (tag && (peeled || !peeledTags.has(tag))) remoteTagCommits.set(tag, commit);
      if (peeled) peeledTags.add(tag);
    }
  } catch {
    console.log("(note: could not reach origin to confirm published tags are pushed.)");
  }
  const unpushedPublishedTags = remoteTagCommits === null
    ? []
    : allPublishedVersions.map((version) => `v${version}`).filter((tag) => !remoteTagCommits.has(tag));
  if (unpushedPublishedTags.length > 0) {
    console.error(
      `FAIL: ${unpushedPublishedTags.length} published release tag${unpushedPublishedTags.length === 1 ? " is" : "s are"} ` +
      `not on origin: ${unpushedPublishedTags.join(", ")}. Release-pinned links still 404 for everyone else.\n` +
      unpushedPublishedTags.map((tag) => `  git push origin ${tag}`).join("\n")
    );
    process.exit(1);
  }
}

// A tag must point at the commit npm actually published. Check every published
// namespace, not only latest, because an older wrong tag serves plausible but
// unverified source. Missing npm gitHead metadata remains explicitly unknown;
// never guess a commit for it.
if (tagNames.length > 0) {
  const mismatchedTags = [];
  const gitHeadLookupFailures = [];
  for (const version of allPublishedVersions) {
    const tag = `v${version}`;
    const { gitHead, error: gitHeadError } = publishedGitHead(version);
    if (gitHeadError) {
      gitHeadLookupFailures.push({ version, message: gitHeadError.message });
      continue;
    }
    if (!gitHead) {
      console.log(`(note: npm records no gitHead for ${version}; could not confirm ${tag} points at it.)`);
      continue;
    }
    let tagCommit = remoteTagCommits?.get(tag) || null;
    if (remoteTagCommits === null) {
      try {
        tagCommit = execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
      } catch {
        gitHeadLookupFailures.push({ version, message: `could not resolve ${tag} to a commit` });
        continue;
      }
    }
    if (tagCommit && gitHead !== tagCommit) {
      mismatchedTags.push({ version, tag, tagCommit, gitHead });
    }
  }
  if (gitHeadLookupFailures.length > 0) {
    console.error(
      "FAIL: could not read npm gitHead metadata for published releases:\n" +
      gitHeadLookupFailures.map(({ version, message }) => `  ${version}: ${message}`).join("\n")
    );
    process.exit(1);
  }
  if (mismatchedTags.length > 0) {
    console.error(
      "FAIL: published source tags do not match npm's recorded commits:\n" +
      mismatchedTags.map(({ version, tag, tagCommit, gitHead }) =>
        `  ${tag} points at ${tagCommit}, but npm published ${version} from ${gitHead}.`
      ).join("\n") + "\n" +
      `Anyone following INSTALL.md's "compare gitHead with the source tag" step reads different source than ` +
      "they installed. Move the tag to the published commit, or publish the tagged commit."
    );
    process.exit(1);
  }
}

console.log(
  `OK: npm latest = ${npmVersion}; latest released tag = ${tagVersion || "(none)"}; local = ${localVersion}.` +
  (compareSemver(npmVersion, localVersion) !== 0
    ? ` (note: working tree is ${localVersion}, ahead of the published ${npmVersion} — expected before publishing.)`
    : "")
);
