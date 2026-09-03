#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const THIRD_PARTY_NOTICES_SHA256 = "73c135f928fd4dcdb199d70605a4f74abcbc95a7bf88dbe9ce59873d060c1b93";
export const ADMISSION_NPM_VERSION = "11.6.4";
export const PACKAGE_ADMISSION_ASSERTION_KEYS = Object.freeze([
  "archive_regular_files_only",
  "artifact_identity_stable",
  "bundled_graph_complete",
  "candidate_loaded_without_ambient_modules",
  "lifecycle_scripts_absent",
  "shrinkwrap_admitted",
  "third_party_notices_admitted",
]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (isMain()) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--build-package")) {
      process.stdout.write(`${buildPackageArtifact(parseBuildArgs(args))}\n`);
    } else {
      const receipt = admitPackageArtifact(parseAdmissionArgs(args));
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    }
  } catch (error) {
    process.stderr.write(`Package admission refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export function buildPackageArtifact({ destination, dryRun = false, sourceCommit = null }) {
  const reviewedSourceCommit = resolveSourceCommit(sourceCommit);
  assertCleanSourceCheckout();
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const destinationStats = fs.lstatSync(destination);
  if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
    throw new Error("Package destination must be a regular directory.");
  }
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-build-"));
  fs.chmodSync(buildRoot, 0o700);
  try {
    const stageRoot = path.join(buildRoot, "package");
    fs.mkdirSync(stageRoot, { mode: 0o700 });
    stagePackageSource(stageRoot, reviewedSourceCommit);
    runNpm11([
      "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    ], stageRoot, "Install of the admitted dependency graph failed");
    pruneBundledDependencyJunk(stageRoot);
    const packArgs = ["pack", "--ignore-scripts", "--silent"];
    if (dryRun) packArgs.push("--dry-run");
    packArgs.push("--pack-destination", path.resolve(destination));
    const packed = runNpm11(packArgs, stageRoot, "Packaging the admitted dependency graph failed");
    const filename = packed.stdout.trim().split(/\r?\n/).at(-1);
    if (!filename || !/^[A-Za-z0-9._-]+\.tgz$/.test(filename)) {
      throw new Error("npm did not return one bounded package filename.");
    }
    return filename;
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

export function parseExactDotaiosNpmSpec(packageSpec) {
  const match = /^dotaios@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(packageSpec || "");
  if (!match) throw new Error("Registry admission requires one exact DotAIOS semver.");
  return { packageSpec, version: match[1] };
}

export function admitRegistryArtifact({
  packageSpec,
  metadataJson,
  registryBytes,
  expectedArtifactSha256,
  expectedSourceCommit,
}) {
  const { version } = parseExactDotaiosNpmSpec(packageSpec);
  if (!Buffer.isBuffer(registryBytes) || registryBytes.length === 0 || registryBytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error("Registry artifact must be one non-empty bounded Buffer.");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedArtifactSha256 || "")) {
    throw new Error("Expected artifact hash must be one lowercase SHA-256.");
  }
  if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit || "")) {
    throw new Error("Expected source commit must be one lowercase 40-character Git object ID.");
  }
  if (typeof metadataJson !== "string" || Buffer.byteLength(metadataJson) > 64 * 1024) {
    throw new Error("Registry metadata must be one bounded JSON document.");
  }
  let rows;
  try {
    rows = JSON.parse(metadataJson);
  } catch (error) {
    throw new Error(`Registry metadata is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Registry metadata must resolve to exactly one version.");
  }
  const metadata = rows[0];
  assertObject(metadata, "Registry metadata row");
  if (metadata.version !== version) throw new Error("Registry version does not match the exact package spec.");
  const expectedTarball = `https://registry.npmjs.org/dotaios/-/dotaios-${version}.tgz`;
  if (metadata["dist.tarball"] !== expectedTarball) {
    throw new Error("Registry tarball is not the exact official DotAIOS artifact URL.");
  }
  const integrity = metadata["dist.integrity"];
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity || "")) {
    throw new Error("Registry artifact has no admitted SHA-512 integrity.");
  }
  const actualIntegrity = `sha512-${createHash("sha512").update(registryBytes).digest("base64")}`;
  if (integrity !== actualIntegrity) throw new Error("Registry artifact integrity does not match its bytes.");
  const artifactSha256 = sha256(registryBytes);
  if (artifactSha256 !== expectedArtifactSha256) {
    throw new Error("Registry artifact hash does not match the frozen candidate.");
  }
  if (metadata.gitHead !== expectedSourceCommit) {
    throw new Error("Registry gitHead does not match the reviewed source commit.");
  }
  return {
    schema: "dotaios.registry-artifact.v1",
    package: "dotaios",
    version,
    artifact_sha256: artifactSha256,
    dependency_source: "npm-shrinkwrap",
    git_head: metadata.gitHead,
    integrity_sha512: integrity,
  };
}

export function inspectPackageArchive(artifactBytes) {
  if (!Buffer.isBuffer(artifactBytes) || artifactBytes.length === 0 || artifactBytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error("Package archive must be a non-empty bounded Buffer.");
  }
  let tarBytes;
  try {
    tarBytes = gunzipSync(artifactBytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    throw new Error(`Package archive is not a bounded gzip tarball: ${error.message}`);
  }

  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (entries.size >= MAX_ARCHIVE_ENTRIES) {
      throw new Error("Package archive contains too many entries.");
    }
    verifyTarChecksum(header);
    const name = tarPath(header);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    if (type !== "0") {
      throw new Error(`Package archive entry ${name} is not a regular file; links and special files are refused.`);
    }
    validateArchivePath(name);
    if (entries.has(name)) {
      throw new Error(`Package archive contains duplicate entry ${name}.`);
    }
    const size = readTarOctal(header, 124, 12, "entry size");
    if (size > MAX_ENTRY_BYTES) {
      throw new Error(`Package archive entry ${name} exceeds the admission size limit.`);
    }
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;
    if (nextOffset > tarBytes.length) {
      throw new Error(`Package archive entry ${name} is truncated.`);
    }
    entries.set(name, tarBytes.subarray(dataOffset, dataOffset + size));
    offset = nextOffset;
  }

  assertNoImplicitNativeBuild(entries);
  const packageJson = parseArchiveJson(entries, "package/package.json");
  const shrinkwrap = parseArchiveJson(entries, "package/npm-shrinkwrap.json");
  return { entries, packageJson, shrinkwrap, payloadSha256: sha256(tarBytes) };
}

export function admitDependencyGraph({ packageJson, shrinkwrap }) {
  assertObject(packageJson, "Package manifest");
  assertObject(shrinkwrap, "npm shrinkwrap");
  if (shrinkwrap.lockfileVersion !== 3) {
    throw new Error("Dependency graph must use npm lockfileVersion 3.");
  }
  if (shrinkwrap.name !== packageJson.name || shrinkwrap.version !== packageJson.version) {
    throw new Error("Dependency graph identity does not match package.json.");
  }
  for (const name of LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(packageJson.scripts || {}, name)) {
      throw new Error(`Package lifecycle script ${name} is not admitted.`);
    }
  }

  const directDependencies = packageJson.dependencies || {};
  assertObject(directDependencies, "Package dependencies");
  for (const [name, version] of Object.entries(directDependencies)) {
    if (!EXACT_VERSION.test(version)) {
      throw new Error(`Direct dependency ${name} must use one exact version.`);
    }
  }

  assertObject(shrinkwrap.packages, "Dependency graph packages");
  const root = shrinkwrap.packages[""];
  assertObject(root, "Dependency graph root");
  if (root.name !== packageJson.name || root.version !== packageJson.version) {
    throw new Error("Dependency graph root identity does not match package.json.");
  }
  if (JSON.stringify(sortedObject(root.dependencies || {})) !== JSON.stringify(sortedObject(directDependencies))) {
    throw new Error("Dependency graph root dependencies do not match package.json.");
  }

  const packages = Object.entries(shrinkwrap.packages)
    .filter(([packagePath]) => packagePath !== "")
    .map(([packagePath, entry]) => admitLockedPackage(packagePath, entry))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const name of Object.keys(directDependencies)) {
    if (!packages.some((entry) => entry.path === `node_modules/${name}`)) {
      throw new Error(`Direct dependency ${name} is missing from the dependency graph.`);
    }
  }

  const canonical = JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    dependencies: sortedObject(directDependencies),
    packages,
  });
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
    packages,
  };
}

export function admitPackageArtifact({ artifact, sourceCommit }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) {
    throw new Error("Source commit must be one lowercase 40-character Git object ID.");
  }
  const requested = fs.lstatSync(artifact, { bigint: true });
  if (!requested.isFile() || requested.isSymbolicLink()) {
    throw new Error("Candidate artifact must be a regular file, not a link or special file.");
  }
  if (requested.size <= 0n || requested.size > BigInt(MAX_ARTIFACT_BYTES)) {
    throw new Error("Candidate artifact size is outside the admission boundary.");
  }
  const canonical = fs.realpathSync(artifact);
  const artifactBytes = fs.readFileSync(canonical);
  const artifactSha256 = sha256(artifactBytes);
  const { entries, packageJson, shrinkwrap, payloadSha256 } = inspectPackageArchive(artifactBytes);
  if (packageJson.name !== "dotaios") throw new Error("Candidate artifact is not the DotAIOS package.");
  if (packageJson.gitHead !== sourceCommit) {
    throw new Error("Package manifest source commit does not match the reviewed source commit.");
  }
  const dependencyGraph = admitDependencyGraph({ packageJson, shrinkwrap });
  admitBundledGraph({ entries, packageJson, dependencyGraph });
  admitThirdPartyNotices({ entries, dependencyGraph });

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-package-admission-"));
  fs.chmodSync(runRoot, 0o700);
  try {
    const extractRoot = path.join(runRoot, "extract");
    const processHome = path.join(runRoot, "home");
    const verifiedArtifact = path.join(runRoot, "candidate.tgz");
    fs.mkdirSync(extractRoot, { mode: 0o700 });
    fs.mkdirSync(processHome, { mode: 0o700 });
    fs.writeFileSync(verifiedArtifact, artifactBytes, { flag: "wx", mode: 0o600 });
    const ownedTar = tarExecutable();
    const extracted = spawnSync(ownedTar, ["-xzf", verifiedArtifact, "-C", extractRoot], {
      cwd: runRoot,
      encoding: "utf8",
      env: {
        ...admissionEnvironment(processHome),
        PATH: path.dirname(ownedTar),
      },
      timeout: 60_000,
    });
    if (extracted.status !== 0) {
      throw new Error(`Verified archive extraction failed: ${boundedDiagnostic(extracted)}`);
    }
    const packageRoot = path.join(extractRoot, "package");
    assertContainedRegularTree(packageRoot, extractRoot);
    const cli = path.join(packageRoot, "packages", "cli", "src", "index.mjs");
    const loaded = spawnSync(process.execPath, [cli, "--help"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: admissionEnvironment(processHome),
      timeout: 60_000,
    });
    if (loaded.status !== 0 || !/DotAIOS|Usage:/i.test(loaded.stdout || "")) {
      throw new Error(`Candidate did not load from admitted bundled bytes: ${boundedDiagnostic(loaded)}`);
    }
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }

  const after = fs.lstatSync(canonical, { bigint: true });
  if (!sameFileIdentity(requested, after) || sha256(fs.readFileSync(canonical)) !== artifactSha256) {
    throw new Error("Candidate artifact identity changed during admission.");
  }
  return {
    schema: "dotaios.package-admission.v1",
    verdict: "go",
    package_go: "GO",
    source_commit: sourceCommit,
    artifact: {
      name: packageJson.name,
      version: packageJson.version,
      sha256: artifactSha256,
      payload_sha256: payloadSha256,
      dependency_graph_sha256: dependencyGraph.sha256,
    },
    assertions: Object.fromEntries(
      PACKAGE_ADMISSION_ASSERTION_KEYS.map((key) => [key, true])
    ),
  };
}

function admitLockedPackage(packagePath, entry) {
  assertObject(entry, `Dependency ${packagePath}`);
  if (
    packagePath.startsWith("/")
    || packagePath.includes("\\")
    || packagePath.split("/").includes("..")
    || !packagePath.split("/").includes("node_modules")
  ) {
    throw new Error(`Dependency path ${packagePath} is not admitted.`);
  }
  if (entry.link === true) {
    throw new Error(`Linked dependency ${packagePath} is not admitted.`);
  }
  if (entry.hasInstallScript === true) {
    throw new Error(`Dependency ${packagePath} exposes an install lifecycle script.`);
  }
  if (!EXACT_VERSION.test(entry.version || "")) {
    throw new Error(`Dependency ${packagePath} must resolve to one exact version.`);
  }
  if (!/^https:\/\/registry\.npmjs\.org\/.+\.tgz$/.test(entry.resolved || "")) {
    throw new Error(`Dependency ${packagePath} must resolve from the npm registry.`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || "")) {
    throw new Error(`Dependency ${packagePath} must carry a registry SHA-512 integrity.`);
  }
  return {
    path: packagePath,
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
    dependencies: sortedObject(entry.dependencies || {}),
    optionalDependencies: sortedObject(entry.optionalDependencies || {}),
  };
}

function sortedObject(value) {
  assertObject(value, "Dependency map");
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

export function admitBundledGraph({ entries, packageJson, dependencyGraph }) {
  const bundled = new Set(packageJson.bundleDependencies || packageJson.bundledDependencies || []);
  const direct = Object.keys(packageJson.dependencies || {});
  if (bundled.size !== direct.length || direct.some((name) => !bundled.has(name))) {
    throw new Error("Every direct dependency must be declared as a bundled dependency for npm 12 admission.");
  }
  const admittedPaths = new Set(dependencyGraph.packages.map((entry) => entry.path));
  for (const locked of dependencyGraph.packages) {
    const manifest = parseArchiveJson(entries, `package/${locked.path}/package.json`);
    if (manifest.version !== locked.version) {
      throw new Error(`Bundled dependency ${locked.path} does not match the admitted version.`);
    }
    if (
      JSON.stringify(sortedObject(manifest.dependencies || {}))
      !== JSON.stringify(locked.dependencies)
    ) {
      throw new Error(`Bundled dependency ${locked.path} dependencies do not match the admitted graph.`);
    }
    if (
      JSON.stringify(sortedObject(manifest.optionalDependencies || {}))
      !== JSON.stringify(locked.optionalDependencies)
    ) {
      throw new Error(`Bundled dependency ${locked.path} optional dependencies do not match the admitted graph.`);
    }
    for (const name of LIFECYCLE_SCRIPTS) {
      if (Object.hasOwn(manifest.scripts || {}, name)) {
        throw new Error(`Bundled dependency ${locked.path} exposes lifecycle script ${name}.`);
      }
    }
  }
  const packagedPaths = [...entries.keys()]
    .filter((name) => /^package\/node_modules\/.+\/package\.json$/.test(name))
    .map((name) => name.slice("package/".length, -"/package.json".length))
    .filter(isNodeModulesPackagePath);
  for (const packagePath of packagedPaths) {
    if (!admittedPaths.has(packagePath)) {
      throw new Error(`Bundled dependency ${packagePath} is absent from the admitted graph.`);
    }
  }
  if (packagedPaths.length !== admittedPaths.size) {
    throw new Error("Bundled dependency graph is incomplete.");
  }
}

export function admitThirdPartyNotices({ entries, dependencyGraph }) {
  const notices = entries.get("package/THIRD-PARTY-NOTICES.md");
  if (!Buffer.isBuffer(notices)) {
    throw new Error("Package is missing the reviewed third-party notices.");
  }
  if (notices.length === 0 || notices.length > 64 * 1024) {
    throw new Error("Package third-party notices are outside the admission boundary.");
  }
  try {
    UTF8.decode(notices);
  } catch {
    throw new Error("Package third-party notices are not valid UTF-8.");
  }
  if (sha256(notices) !== THIRD_PARTY_NOTICES_SHA256) {
    throw new Error("Package third-party notices do not match the reviewed license inventory.");
  }
  const graphMarker = notices.toString("utf8").match(
    /<!-- bundled-dependency-graph-sha256: ([a-f0-9]{64}) -->/
  )?.[1];
  if (!dependencyGraph || graphMarker !== dependencyGraph.sha256) {
    throw new Error("Package third-party notices do not describe the admitted dependency graph.");
  }
}

function assertNoImplicitNativeBuild(entries) {
  for (const name of entries.keys()) {
    if (name === "package/binding.gyp") {
      throw new Error("Package binding.gyp would enable an implicit native build lifecycle.");
    }
    if (!name.startsWith("package/") || !name.endsWith("/binding.gyp")) continue;
    const packagePath = name.slice("package/".length, -"/binding.gyp".length);
    if (isNodeModulesPackagePath(packagePath)) {
      throw new Error(`Bundled dependency ${packagePath} binding.gyp would enable an implicit native build lifecycle.`);
    }
  }
}

function isNodeModulesPackagePath(packagePath) {
  const packageName = "(?:@[^/]+/[^/]+|[^/@][^/]*)";
  return new RegExp(`^node_modules/${packageName}(?:/node_modules/${packageName})*$`).test(packagePath);
}

function assertContainedRegularTree(root, boundary) {
  const canonicalBoundary = fs.realpathSync(boundary);
  const canonicalRoot = fs.realpathSync(root);
  if (!isWithin(canonicalRoot, canonicalBoundary)) throw new Error("Extracted package escaped its owned root.");
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stats = fs.lstatSync(candidate);
      if (stats.isSymbolicLink()) throw new Error("Extracted package contains a link.");
      if (stats.isDirectory()) pending.push(candidate);
      else if (!stats.isFile()) throw new Error("Extracted package contains a special file.");
      if (!isWithin(fs.realpathSync(candidate), canonicalBoundary)) {
        throw new Error("Extracted package path escaped its owned root.");
      }
    }
  }
}

function admissionEnvironment(processHome) {
  return {
    HOME: processHome,
    USERPROFILE: processHome,
    PATH: path.dirname(process.execPath),
    DOTAIOS_NO_UPDATE_CHECK: "1",
    LANG: "C",
    LC_ALL: "C",
  };
}

function tarExecutable() {
  const candidate = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "/usr/bin/tar";
  const canonical = fs.realpathSync(candidate);
  const stats = fs.lstatSync(canonical);
  const systemBoundary = process.platform === "win32"
    ? fs.realpathSync(path.dirname(candidate))
    : "/usr/bin";
  if (!stats.isFile() || stats.isSymbolicLink() || !isWithin(canonical, systemBoundary)) {
    throw new Error("The owned tar executable is unavailable.");
  }
  return canonical;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isWithin(candidate, boundary) {
  const relative = path.relative(boundary, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedDiagnostic(result) {
  return `${result.stderr || ""}\n${result.stdout || ""}`.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseAdmissionArgs(args) {
  const parsed = { artifact: null, sourceCommit: null };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key !== "--artifact" && key !== "--source-commit") throw new Error(`Unknown option: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`);
    if (key === "--artifact") parsed.artifact = path.resolve(value);
    else parsed.sourceCommit = value;
    index += 1;
  }
  if (!parsed.artifact) throw new Error("--artifact is required.");
  if (!parsed.sourceCommit) throw new Error("--source-commit is required.");
  return parsed;
}

function parseBuildArgs(args) {
  let destination = REPO_ROOT;
  let sawMode = false;
  let dryRun = false;
  let sourceCommit = null;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--build-package") {
      if (sawMode) throw new Error("--build-package may be provided only once.");
      sawMode = true;
      continue;
    }
    if (key === "--silent") continue;
    if (key === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (key === "--source-commit") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--source-commit requires a value.");
      if (sourceCommit) throw new Error("--source-commit may be provided only once.");
      sourceCommit = value;
      index += 1;
      continue;
    }
    if (key !== "--pack-destination") throw new Error(`Unknown package build option: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--pack-destination requires a value.");
    destination = path.resolve(value);
    index += 1;
  }
  if (!sawMode) throw new Error("--build-package is required.");
  return { destination, dryRun, sourceCommit };
}

function stagePackageSource(stageRoot, sourceCommit) {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const sourceEntries = ["package.json", ...(manifest.files || [])];
  for (const relative of sourceEntries) {
    if (
      typeof relative !== "string"
      || relative.length === 0
      || path.isAbsolute(relative)
      || relative.includes("\\")
      || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`Package source path ${JSON.stringify(relative)} is not admitted.`);
    }
  }
  const trackedFiles = listTrackedPackageFiles(sourceCommit, sourceEntries);
  for (const relative of sourceEntries) {
    if (!trackedFiles.some((entry) => entry.path === relative || entry.path.startsWith(`${relative}/`))) {
      throw new Error(`Package source path ${JSON.stringify(relative)} is absent from the reviewed commit.`);
    }
  }
  for (const entry of trackedFiles) {
    const target = path.join(stageRoot, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readGitBlob(entry.objectId), {
      flag: "wx",
      mode: entry.mode === "100755" ? 0o755 : 0o644,
    });
  }
  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify({ ...manifest, gitHead: sourceCommit }, null, 2)}\n`,
  );
}

function pruneBundledDependencyJunk(stageRoot) {
  const nodeModulesRoot = path.join(stageRoot, "node_modules");
  const pending = [nodeModulesRoot];
  const prunedDirectories = new Set(["test", "tests", ".yarn"]);
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stats = fs.lstatSync(candidate);
      if (prunedDirectories.has(entry.name) || entry.name.endsWith(".map")) {
        fs.rmSync(candidate, { recursive: stats.isDirectory(), force: false });
      } else if (stats.isDirectory()) {
        pending.push(candidate);
      }
    }
  }
}

function listTrackedPackageFiles(sourceCommit, sourceEntries) {
  const result = spawnSync("git", ["ls-tree", "-r", "-z", sourceCommit, "--", ...sourceEntries], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`Reviewed package source could not be enumerated: ${boundedDiagnostic(result)}`);
  }
  return result.stdout.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d{6}) (\S+) ([a-f0-9]{40,64})\t(.+)$/.exec(record);
    if (!match) throw new Error("Reviewed package source inventory is malformed.");
    const [, mode, type, objectId, relative] = match;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`Reviewed package source ${JSON.stringify(relative)} is not a regular file.`);
    }
    if (
      path.isAbsolute(relative)
      || relative.includes("\\")
      || relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("Reviewed package source inventory contains an unsafe path.");
    }
    return { path: relative, objectId, mode };
  });
}

function readGitBlob(objectId) {
  const result = spawnSync("git", ["cat-file", "blob", objectId], {
    cwd: REPO_ROOT,
    encoding: null,
    env: sanitizedGitEnvironment(),
    maxBuffer: MAX_ENTRY_BYTES + 1,
    timeout: 10_000,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length > MAX_ENTRY_BYTES) {
    throw new Error(`Reviewed package source file could not be read: ${boundedDiagnostic(result)}`);
  }
  return result.stdout;
}

function resolveSourceCommit(expectedSourceCommit) {
  if (expectedSourceCommit !== null && !/^[a-f0-9]{40}$/.test(expectedSourceCommit)) {
    throw new Error("Reviewed source commit must be one lowercase 40-character Git object ID.");
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    timeout: 10_000,
  });
  const sourceCommit = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sourceCommit || "")) {
    throw new Error(`Package source commit could not be resolved: ${boundedDiagnostic(result)}`);
  }
  if (expectedSourceCommit !== null && expectedSourceCommit !== sourceCommit) {
    throw new Error("Reviewed source commit does not match the package source checkout.");
  }
  return sourceCommit;
}

function assertCleanSourceCheckout() {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`Package source checkout could not be inspected: ${boundedDiagnostic(result)}`);
  }
  if (result.stdout !== "") {
    throw new Error("Package source checkout must be fully clean before artifact construction.");
  }
}

function sanitizedGitEnvironment() {
  return {
    ...process.env,
    GIT_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_WORK_TREE: undefined,
  };
}

function runNpm11(args, cwd, label) {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, ["--yes", "--package", `npm@${ADMISSION_NPM_VERSION}`, "npm", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`${label}: ${boundedDiagnostic(result)}`);
  return result;
}

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

function verifyTarChecksum(header) {
  const expected = readTarOctal(header, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("Package archive header checksum is invalid.");
}

function tarPath(header) {
  const name = readTarText(header, 0, 100, "entry name");
  const prefix = readTarText(header, 345, 155, "entry prefix");
  return prefix ? `${prefix}/${name}` : name;
}

function readTarText(buffer, offset, length, label) {
  const field = buffer.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const bytes = nul === -1 ? field : field.subarray(0, nul);
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`Package archive ${label} is not valid UTF-8.`);
  }
}

function readTarOctal(buffer, offset, length, label) {
  const value = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`Package archive ${label} is not valid octal.`);
  return Number.parseInt(value, 8);
}

function validateArchivePath(name) {
  const segments = name.split("/");
  if (
    !name.startsWith("package/")
    || name.startsWith("/")
    || name.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(name)
    || segments.includes("")
    || segments.includes(".")
    || segments.includes("..")
  ) {
    throw new Error(`Package archive entry path ${JSON.stringify(name)} is not admitted.`);
  }
}

function parseArchiveJson(entries, name) {
  const bytes = entries.get(name);
  if (!bytes) throw new Error(`Package archive is missing ${name}.`);
  try {
    return JSON.parse(UTF8.decode(bytes));
  } catch (error) {
    throw new Error(`Package archive ${name} is invalid JSON: ${error.message}`);
  }
}
