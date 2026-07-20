#!/usr/bin/env node
// Fail loudly if the published npm package is BEHIND the latest released git
// tag — the exact "stale-npm release" regression the VC audit flagged (repo at
// v1.23 while `npx dotaios@latest` still resolved 1.22). A fresh user's
// `npx dotaios@latest` must never serve an older CLI than the repo has released.
//
// Runs the resolution in a throwaway HOME so no local cache masks what a real
// first-time user would download. Intended for the release-freshness workflow
// (scheduled + on release tags), NOT every PR: a pre-publish version bump on a
// feature branch is expected to be ahead of npm and must not fail here.

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

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const localVersion = pkg.version;

let tagVersion = null;
try {
  const tags = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (tags[0]) tagVersion = tags[0].replace(/^v/, "");
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

console.log(
  `OK: npm latest = ${npmVersion}; latest released tag = ${tagVersion || "(none)"}; local = ${localVersion}.` +
  (compareSemver(npmVersion, localVersion) !== 0
    ? ` (note: working tree is ${localVersion}, ahead of the published ${npmVersion} — expected before publishing.)`
    : "")
);
