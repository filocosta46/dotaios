import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  admitRegistryArtifact,
  parseExactDotaiosNpmSpec,
} from "../../scripts/onboarding-release-acceptance.mjs";

const version = "2.0.12";
const sourceCommit = "b".repeat(40);
const bytes = Buffer.from("immutable registry artifact\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

test("registry admission accepts only an exact DotAIOS semver", () => {
  assert.deepEqual(parseExactDotaiosNpmSpec(`dotaios@${version}`), {
    packageSpec: `dotaios@${version}`,
    version,
  });
  for (const mutable of [
    "dotaios@latest",
    "dotaios@candidate",
    "dotaios@^2.0.12",
    "dotaios@2.x",
    "github:filocosta46/dotaios",
    "other-package@2.0.12",
  ]) {
    assert.throws(() => parseExactDotaiosNpmSpec(mutable), /exact DotAIOS semver/i, mutable);
  }
});

test("registry admission binds exact bytes, official tarball, integrity, and source commit", () => {
  const receipt = admitRegistryArtifact({
    packageSpec: `dotaios@${version}`,
    metadataJson: metadata(),
    registryBytes: bytes,
    expectedArtifactSha256: sha256,
    expectedSourceCommit: sourceCommit,
  });

  assert.deepEqual(receipt, {
    schema: "dotaios.registry-artifact.v1",
    package: "dotaios",
    version,
    artifact_sha256: sha256,
    dependency_source: "npm-shrinkwrap",
    git_head: sourceCommit,
    integrity_sha512: integrity,
  });
});

test("registry admission refuses mutable metadata or identity drift", () => {
  const base = {
    packageSpec: `dotaios@${version}`,
    metadataJson: metadata(),
    registryBytes: bytes,
    expectedArtifactSha256: sha256,
    expectedSourceCommit: sourceCommit,
  };
  const cases = [
    ["version", { metadataJson: metadata({ version: "2.0.13" }) }],
    ["tarball host", { metadataJson: metadata({ "dist.tarball": `https://example.com/dotaios-${version}.tgz` }) }],
    ["tarball path", { metadataJson: metadata({ "dist.tarball": `https://registry.npmjs.org/other/-/other-${version}.tgz` }) }],
    ["integrity", { registryBytes: Buffer.from("substituted artifact\n") }],
    ["git head", { expectedSourceCommit: "c".repeat(40) }],
    ["artifact hash", { expectedArtifactSha256: "d".repeat(64) }],
    ["ambiguous metadata", { metadataJson: JSON.stringify([JSON.parse(metadata())[0], JSON.parse(metadata())[0]]) }],
  ];

  for (const [label, changed] of cases) {
    assert.throws(
      () => admitRegistryArtifact({ ...base, ...changed }),
      /registry|version|tarball|integrity|commit|hash|metadata|artifact/i,
      label,
    );
  }
});

function metadata(overrides = {}) {
  return JSON.stringify([{
    version,
    "dist.integrity": integrity,
    "dist.tarball": `https://registry.npmjs.org/dotaios/-/dotaios-${version}.tgz`,
    gitHead: sourceCommit,
    ...overrides,
  }]);
}
