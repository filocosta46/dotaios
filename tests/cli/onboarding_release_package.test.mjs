import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  inspectPackageArchive,
} from "../../scripts/onboarding-release-acceptance.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const admission = path.join(repoRoot, "scripts", "onboarding-release-acceptance.mjs");
let releaseFixtureRoot = null;

after(() => {
  if (releaseFixtureRoot) fs.rmSync(releaseFixtureRoot, { recursive: true, force: true });
});

test("the publishable package freezes one deterministic dependency graph", { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-admission-pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceCommit = releaseSourceCommit();
  const first = pack(path.join(root, "first"));
  const second = pack(path.join(root, "second"));

  assert.equal(sha256(first), sha256(second), "unchanged source must produce byte-identical tarballs");
  const inventory = run("tar", ["-tzf", first]).stdout.trim().split(/\r?\n/);
  assert.ok(
    inventory.includes("package/npm-shrinkwrap.json"),
    "the public package must carry the admitted npm dependency graph",
  );

  const manifest = JSON.parse(run("tar", ["-xOzf", first, "package/package.json"]).stdout);
  assert.equal(
    manifest.gitHead,
    sourceCommit,
    "the prebuilt tarball publication manifest must bind the reviewed source commit",
  );
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
  const sourceCommit = releaseSourceCommit();
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

test("package admission rejects a missing, malformed, or mismatched manifest source commit", { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-source-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = pack(path.join(root, "artifact"));
  const artifactBytes = fs.readFileSync(artifact);
  const sourceCommit = releaseSourceCommit();
  const cases = [
    ["missing", (manifest) => { delete manifest.gitHead; }],
    ["malformed", (manifest) => { manifest.gitHead = "not-a-commit"; }],
    ["mismatched", (manifest) => { manifest.gitHead = "a".repeat(40); }],
  ];

  for (const [label, mutate] of cases) {
    const tampered = path.join(root, `${label}.tgz`);
    fs.writeFileSync(tampered, replaceArchiveJsonSameSize(artifactBytes, "package/package.json", mutate));
    const result = spawnSync(process.execPath, [
      admission,
      "--artifact", tampered,
      "--source-commit", sourceCommit,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: "" },
    });

    assert.notEqual(result.status, 0, `${label}: ${result.stdout}`);
    assert.match(result.stderr, /manifest.*source commit/i, label);
  }
});

test("package construction rejects a reviewed commit that does not match the checkout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-reviewed-head-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    releaseAdmission(),
    "--build-package",
    "--source-commit", "a".repeat(40),
    "--pack-destination", root,
  ], {
    cwd: releaseRepository(),
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /reviewed source commit.*package source checkout/i);
  assert.equal(fs.readdirSync(root).some((entry) => entry.endsWith(".tgz")), false);
});

test("package construction refuses tracked or untracked checkout changes", { timeout: 120_000 }, (t) => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-dirty-source-"));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  const repository = releaseRepository();
  const sourceCommit = releaseSourceCommit();
  const trackedPath = path.join(repository, "README.md");
  const trackedBytes = fs.readFileSync(trackedPath);
  const untrackedPath = path.join(repository, "untracked-release-input.txt");

  try {
    fs.appendFileSync(trackedPath, "\nchanged after review\n");
    assert.match(run("git", ["status", "--porcelain"], { cwd: repository }).stdout, /README\.md/);
    assertBuildRefusesDirtySource({ repository, sourceCommit, outputRoot, label: "tracked" });
    fs.writeFileSync(trackedPath, trackedBytes);
    assert.equal(run("git", ["status", "--porcelain"], { cwd: repository }).stdout, "");

    fs.writeFileSync(untrackedPath, "unreviewed release input\n");
    assert.match(run("git", ["status", "--porcelain"], { cwd: repository }).stdout, /untracked-release-input\.txt/);
    assertBuildRefusesDirtySource({ repository, sourceCommit, outputRoot, label: "untracked" });
  } finally {
    fs.writeFileSync(trackedPath, trackedBytes);
    if (fs.existsSync(untrackedPath)) fs.rmSync(untrackedPath);
  }
  assert.equal(run("git", ["status", "--porcelain"], { cwd: repository }).stdout, "");
});

test("package construction stages only files from the reviewed Git commit", { timeout: 120_000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-reviewed-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = releaseRepository();
  const ignoredPath = path.join(repository, "templates", "ignored-release-input.pem");

  try {
    fs.writeFileSync(ignoredPath, "unreviewed secret material\n", { mode: 0o600 });
    assert.equal(run("git", ["check-ignore", "--quiet", ignoredPath], { cwd: repository }).status, 0);
    assert.equal(run("git", ["status", "--porcelain"], { cwd: repository }).stdout, "");
    const withIgnoredInput = pack(path.join(root, "with-ignored-input"));

    fs.rmSync(ignoredPath);
    const fromReviewedCommitOnly = pack(path.join(root, "reviewed-commit-only"));

    assert.equal(
      sha256(withIgnoredInput),
      sha256(fromReviewedCommitOnly),
      "ignored filesystem input must not alter reviewed package bytes",
    );
    assert.doesNotMatch(
      run("tar", ["-tzf", withIgnoredInput]).stdout,
      /package\/templates\/ignored-release-input\.pem/,
    );
  } finally {
    if (fs.existsSync(ignoredPath)) fs.rmSync(ignoredPath);
  }
});

test("npm 12 publishes the frozen tarball bytes with their bound source commit", { timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-publish-capture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = pack(path.join(root, "artifact"));
  const artifactBytes = fs.readFileSync(artifact);
  const sourceCommit = releaseSourceCommit();
  const version = JSON.parse(fs.readFileSync(path.join(releaseRepository(), "package.json"), "utf8")).version;
  const requests = [];
  let publishedMetadata = null;
  const registry = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      publishedMetadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => registry.close(resolve)));
  const address = registry.address();
  assert.ok(address && typeof address === "object");
  const registryOrigin = `http://127.0.0.1:${address.port}/`;
  const processHome = path.join(root, "home");
  const npmCache = path.join(root, "cache");
  const userConfig = path.join(root, "npmrc");
  fs.mkdirSync(processHome, { recursive: true });
  fs.writeFileSync(userConfig, "", { mode: 0o600 });

  const result = await runAsync(npxCommand(), [
    "--yes", "--package", "npm@12.0.2", "npm", "publish", artifact,
    `--registry=${registryOrigin}`,
    `--//127.0.0.1:${address.port}/:_authToken=local-test-token`,
    "--ignore-scripts",
    "--tag=candidate",
    `--cache=${npmCache}`,
    `--userconfig=${userConfig}`,
    "--json",
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: processHome,
      USERPROFILE: processHome,
      GIT_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_WORK_TREE: undefined,
      npm_config_update_notifier: "false",
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(publishedMetadata, `npm made no registry PUT: ${requests.join(", ")}`);
  assert.equal(publishedMetadata["dist-tags"]?.candidate, version);
  const published = publishedMetadata.versions?.[version];
  assert.equal(published?.gitHead, sourceCommit);
  assert.equal(
    published?.dist?.integrity,
    `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`,
  );
  const attachment = publishedMetadata._attachments?.[`dotaios-${version}.tgz`];
  assert.ok(attachment?.data, "npm registry metadata must carry the frozen tarball attachment");
  const publishedBytes = Buffer.from(attachment.data, "base64");
  assert.equal(sha256Bytes(publishedBytes), sha256Bytes(artifactBytes));
  assert.deepEqual(publishedBytes, artifactBytes);
  assert.equal(inspectPackageArchive(publishedBytes).packageJson.gitHead, sourceCommit);
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
  const sourceCommit = releaseSourceCommit();
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
    "--source-commit", sourceCommit,
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
  ], { cwd: releaseRepository() });
  const filename = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(filename?.endsWith(".tgz"), result.stdout);
  return path.join(destination, filename);
}

function releaseRepository() {
  if (releaseFixtureRoot) return releaseFixtureRoot;
  releaseFixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-release-source-")));
  const trackedPaths = run("git", ["ls-files", "-z"], { cwd: repoRoot }).stdout
    .split("\0")
    .filter(Boolean);
  for (const relativePath of trackedPaths) {
    const source = path.join(repoRoot, relativePath);
    const target = path.join(releaseFixtureRoot, relativePath);
    const stats = fs.lstatSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stats.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else {
      assert.equal(stats.isFile(), true, `${relativePath} must be a tracked file or symlink`);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stats.mode & 0o777);
    }
  }
  run("git", ["init", "--quiet"], { cwd: releaseFixtureRoot });
  run("git", ["config", "user.name", "DotAIOS Release Test"], { cwd: releaseFixtureRoot });
  run("git", ["config", "user.email", "release-test@invalid.example"], { cwd: releaseFixtureRoot });
  run("git", ["add", "--all"], { cwd: releaseFixtureRoot });
  run("git", ["commit", "--quiet", "-m", "test: freeze release source"], {
    cwd: releaseFixtureRoot,
    env: {
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  return releaseFixtureRoot;
}

function releaseSourceCommit() {
  return run("git", ["rev-parse", "HEAD"], { cwd: releaseRepository() }).stdout.trim();
}

function releaseAdmission() {
  return path.join(releaseRepository(), "scripts", "onboarding-release-acceptance.mjs");
}

function assertBuildRefusesDirtySource({ repository, sourceCommit, outputRoot, label }) {
  const destination = path.join(outputRoot, label);
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync(process.execPath, [
    path.join(repository, "scripts", "onboarding-release-acceptance.mjs"),
    "--build-package",
    "--source-commit", sourceCommit,
    "--pack-destination", destination,
  ], { cwd: repository, encoding: "utf8" });
  assert.notEqual(result.status, 0, `${label}: ${result.stdout}`);
  assert.match(result.stderr, /source checkout.*fully clean/i, label);
  assert.equal(fs.readdirSync(destination).some((entry) => entry.endsWith(".tgz")), false, label);
}

function sha256(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
      ...options.env,
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

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
