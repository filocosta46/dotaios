import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectPackageArchive,
} from "../../scripts/onboarding-release-acceptance.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const admission = path.join(repoRoot, "scripts", "onboarding-release-acceptance.mjs");

test("the publishable package freezes one deterministic dependency graph", { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-admission-pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = pack(path.join(root, "first"));
  const second = pack(path.join(root, "second"));

  assert.equal(sha256(first), sha256(second), "unchanged source must produce byte-identical tarballs");
  const inventory = run("tar", ["-tzf", first]).stdout.trim().split(/\r?\n/);
  assert.ok(
    inventory.includes("package/npm-shrinkwrap.json"),
    "the public package must carry the admitted npm dependency graph",
  );

  const manifest = JSON.parse(run("tar", ["-xOzf", first, "package/package.json"]).stdout);
  for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must be immutable`);
    assert.ok(
      inventory.some((entry) => entry.startsWith(`package/node_modules/${name}/`)),
      `${name} must be bundled so npm 12 cannot re-resolve its graph`,
    );
  }
});

test("package identity survives runtime-dependent gzip encoding", () => {
  const source = tarball([
    { name: "package/package.json", type: "0", body: "{}" },
    { name: "package/npm-shrinkwrap.json", type: "0", body: "{}" },
  ]);
  const tarBytes = gunzipSync(source);
  const fastGzip = gzipSync(tarBytes, { level: 1, mtime: 0 });
  const compactGzip = gzipSync(tarBytes, { level: 9, mtime: 0 });

  assert.notEqual(
    createHash("sha256").update(fastGzip).digest("hex"),
    createHash("sha256").update(compactGzip).digest("hex"),
    "the fixture must model two valid runtime-dependent gzip byte streams",
  );
  const first = inspectPackageArchive(fastGzip);
  const second = inspectPackageArchive(compactGzip);
  assert.match(first.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.payloadSha256, second.payloadSha256);
});

test("package admission extracts with owned OS tools and returns a bounded package verdict", { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = pack(path.join(root, "artifact"));
  const sourceCommit = "a".repeat(40);
  const result = spawnSync(process.execPath, [
    admission,
    "--artifact", artifact,
    "--source-commit", sourceCommit,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: "",
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "artifact", "assertions", "package_go", "schema", "source_commit", "verdict",
  ]);
  assert.equal(receipt.schema, "dotaios.package-admission.v1");
  assert.equal(receipt.verdict, "go");
  assert.equal(receipt.package_go, "GO");
  assert.equal(receipt.source_commit, sourceCommit);
  assert.equal(receipt.artifact.sha256, sha256(artifact));
  assert.equal(
    receipt.artifact.payload_sha256,
    createHash("sha256").update(gunzipSync(fs.readFileSync(artifact))).digest("hex"),
  );
  assert.match(receipt.artifact.dependency_graph_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.assertions, {
    archive_regular_files_only: true,
    artifact_identity_stable: true,
    bundled_graph_complete: true,
    candidate_loaded_without_ambient_modules: true,
    lifecycle_scripts_absent: true,
    shrinkwrap_admitted: true,
  });
  assert.ok(JSON.stringify(receipt).length < 2_000);
  assert.equal(JSON.stringify(receipt).includes(root), false, "private paths must not enter receipts");
});

test("archive admission rejects traversal, links, special files, and duplicate entries", () => {
  const cases = [
    ["traversal", [{ name: "package/../escape", type: "0", body: "x" }]],
    ["absolute", [{ name: "/package/file", type: "0", body: "x" }]],
    ["symlink", [{ name: "package/link", type: "2", body: "" }]],
    ["special", [{ name: "package/device", type: "3", body: "" }]],
    ["duplicate", [
      { name: "package/file", type: "0", body: "one" },
      { name: "package/file", type: "0", body: "two" },
    ]],
  ];

  for (const [label, entries] of cases) {
    assert.throws(
      () => inspectPackageArchive(tarball(entries)),
      /archive|entry|link|regular|path|duplicate/i,
      label,
    );
  }
});

test("archive admission rejects implicit node-gyp build entrypoints", () => {
  const manifests = [
    { name: "package/binding.gyp", body: "{}" },
    { name: "package/node_modules/alpha/binding.gyp", body: "{}" },
  ];

  for (const nativeBuild of manifests) {
    assert.throws(
      () => inspectPackageArchive(tarball([
        { name: "package/package.json", type: "0", body: "{}" },
        { name: "package/npm-shrinkwrap.json", type: "0", body: "{}" },
        { ...nativeBuild, type: "0" },
      ])),
      /binding\.gyp|native build/i,
      nativeBuild.name,
    );
  }
});

test("package admission rejects same-size bundled manifest dependency drift", { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-graph-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = pack(path.join(root, "artifact"));
  const artifactBytes = fs.readFileSync(artifact);
  const { entries, shrinkwrap } = inspectPackageArchive(artifactBytes);
  const locked = Object.entries(shrinkwrap.packages)
    .find(([packagePath, entry]) => packagePath && Object.keys(entry.dependencies || {}).length > 0);
  assert.ok(locked, "fixture must include a bundled package with a dependency edge");
  const [packagePath] = locked;
  const manifestPath = `package/${packagePath}/package.json`;
  const originalSize = entries.get(manifestPath).length;
  const tamperedBytes = replaceArchiveJsonSameSize(artifactBytes, manifestPath, (manifest) => {
    const dependency = Object.keys(manifest.dependencies || {})[0];
    assert.ok(dependency, `${manifestPath} must expose the locked dependency edge`);
    manifest.dependencies[dependency] = sameLengthDifferentRange(manifest.dependencies[dependency]);
  });
  assert.equal(
    inspectPackageArchive(tamperedBytes).entries.get(manifestPath).length,
    originalSize,
    "the tampered manifest must preserve its tar entry size",
  );
  const tampered = path.join(root, "tampered.tgz");
  fs.writeFileSync(tampered, tamperedBytes);

  const result = spawnSync(process.execPath, [
    admission,
    "--artifact", tampered,
    "--source-commit", "a".repeat(40),
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /bundled dependency.*dependencies.*admitted graph/i);
});

function pack(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = run(npmCommand(), [
    "run", "pack:admission", "--", "--silent", "--pack-destination", destination,
  ], { cwd: repoRoot });
  const filename = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(filename?.endsWith(".tgz"), result.stdout);
  return path.join(destination, filename);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tarball(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body || "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, body.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { mtime: 0 });
}

function replaceArchiveJsonSameSize(artifactBytes, entryName, mutate) {
  const tarBytes = gunzipSync(artifactBytes);
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(),
      8,
    );
    const dataOffset = offset + 512;
    if (name === entryName) {
      const value = JSON.parse(tarBytes.subarray(dataOffset, dataOffset + size).toString("utf8"));
      mutate(value);
      const replacement = Buffer.from(JSON.stringify(value));
      assert.ok(replacement.length <= size, "replacement JSON must fit the original tar entry");
      tarBytes.fill(0x20, dataOffset, dataOffset + size);
      replacement.copy(tarBytes, dataOffset);
      return gzipSync(tarBytes, { mtime: 0 });
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  assert.fail(`archive is missing ${entryName}`);
}

function sameLengthDifferentRange(range) {
  assert.equal(typeof range, "string");
  const first = range[0] === "^" ? "~" : range[0] === "~" ? "^" : range[0] === "0" ? "1" : "0";
  return `${first}${range.slice(1)}`;
}

function writeOctal(buffer, value, offset, length) {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_WORK_TREE: undefined,
    },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
