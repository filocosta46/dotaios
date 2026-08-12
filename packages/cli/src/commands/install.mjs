import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizePermissions, validateManifest } from "../../../core/src/manifest.mjs";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { pathExists } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";
import { createManagedSkillStore } from "../../../core/src/managed-skill-store.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export async function installCommand(args) {
  if (hasHelpFlag(args)) {
    console.log(`Usage:
  dotaios install <reviewed-local-path> [options]

Accepts:
  - A reviewed local Agent Skill folder containing SKILL.md.
  - The same folder may also carry a manifest that declares that one skill;
    nested or multi-skill plugin packages are deferred and refused.

Remote URLs are refused. Download or clone a source yourself, inspect it, then
pass the reviewed local folder to this command.

Options:
  --path <dir>     Install into an AIOS folder other than ~/aios
  --home <dir>     Write native agent bridges and skills under this home directory
  --dry-run        Validate and display permissions without copying files
  --apply <id>     Apply only a previously displayed exact adoption proof
  --fingerprint <sha256>  Require the displayed plan fingerprint
  --subdir <path>  Install from this subdirectory of the local source
  --json           Print the exact proof or result as JSON
`);
    return;
  }

  const options = parseOptions(args);
  if (options.dryRun && (options.apply || options.fingerprint)) {
    throw new Error("--dry-run cannot be combined with --apply or --fingerprint");
  }
  const [pluginPath] = options.positionals;

  if (!pluginPath) {
    throw new Error("Usage: dotaios install <reviewed-local-path> [--path <aios-dir>] [--home <home-dir>] [--dry-run]");
  }

  assertLocalInstallSource(pluginPath);

  // Keep a local subdirectory selection inside the reviewed source directory.
  assertSafeSubdir(options.subdir);

  const sourcePath = options.subdir
    ? path.join(path.resolve(pluginPath), options.subdir)
    : path.resolve(pluginPath);
  await runInstall(sourcePath, options);
}

async function runInstall(sourcePath, options) {
  await ensureDirectory(sourcePath, "Reviewed local path");
  const manifestPath = path.join(sourcePath, "manifest.json");
  
  let manifest;
  let isRawSkill = false;
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    if (error.message.includes("No manifest.json found")) {
      const skillFile = path.join(sourcePath, "SKILL.md");
      if (await pathExists(skillFile)) {
        isRawSkill = true;
      } else {
        throw new Error(`Directory ${sourcePath} is neither an Agent Skill bundle (missing SKILL.md) nor a manifest that identifies one reviewed Agent Skill.`);
      }
    } else {
      throw error;
    }
  }

  if (isRawSkill) {
    const skillName = path.basename(sourcePath);
    if (!options.json) console.log(`Valid Raw Skill detected: ${skillName}`);
    const target = path.resolve(expandHome(options.path || defaultAiosPath()));
    const homePath = path.resolve(expandHome(options.home || os.homedir()));
    const store = createManagedSkillStore({ aiosPath: target, homePath });
    if (Boolean(options.apply) !== Boolean(options.fingerprint)) {
      throw new Error("--apply and --fingerprint are required together");
    }
    if (!options.apply) {
      const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
        return;
      }
      console.log(`\nManaged skill adoption preview: ${proof.operation_id}`);
      console.log(`Plan fingerprint: ${proof.plan_fingerprint}`);
      printAdoptionCollisions(proof);
      console.log("No files changed. Re-run with --apply <id> --fingerprint <sha256>.");
      return;
    }
    const result = await store.applyAdoption({
      sourcePath,
      sourceKind: "local-reviewed-directory",
      operationId: options.apply,
      planFingerprint: options.fingerprint
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    console.log(`\n${result.status === "already_adopted" ? "Already adopted" : "Adopted"} skill '${skillName}'.`);
    return;
  }

  const result = validateManifest(manifest);

  if (!result.valid) {
    throw new Error(`Invalid manifest:\n- ${result.errors.join("\n- ")}`);
  }

  if (!options.json) printManifestSummary(manifest);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const providedSkills = manifest.provides?.skills || [];
  if (providedSkills.length !== 1) {
    throw new Error("This release requires a local manifest to identify exactly one reviewed Agent Skill bundle for adoption.");
  }
  if (Boolean(options.apply) !== Boolean(options.fingerprint)) {
    throw new Error("--apply and --fingerprint are required together");
  }
  const skillSource = await findPluginSkillSource(sourcePath, providedSkills[0], providedSkills.length);
  const homePath = path.resolve(expandHome(options.home || os.homedir()));
  const store = createManagedSkillStore({ aiosPath: target, homePath });
  const proof = await store.previewAdoption({ sourcePath: skillSource, sourceKind: "local-reviewed-directory" });
  if (proof.skill.name !== providedSkills[0]) {
    throw new Error(
      `Manifest declares skill "${providedSkills[0]}", but the reviewed root bundle declares "${proof.skill.name}".`
    );
  }
  if (!options.apply) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
      return;
    }
    console.log(`\nManaged plugin-skill adoption preview: ${proof.operation_id}`);
    console.log(`Plan fingerprint: ${proof.plan_fingerprint}`);
    printAdoptionCollisions(proof);
    console.log("Manifest code was not installed. Re-run with --apply <id> --fingerprint <sha256> to adopt only the reviewed Agent Skill bundle.");
    return;
  }
  const applied = await store.applyAdoption({
    sourcePath: skillSource,
    sourceKind: "local-reviewed-directory",
    operationId: options.apply,
    planFingerprint: options.fingerprint
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(applied, null, 2)}\n`);
    return;
  }
  console.log(`\n${applied.status === "already_adopted" ? "Already adopted" : "Adopted"} ${providedSkills[0]} from ${manifest.name}@${manifest.version}.`);
}

function printAdoptionCollisions(proof) {
  for (const collision of proof.collisions || []) {
    if (["selected-native-source", "selected-canonical-link"].includes(collision.classification)) {
      console.log(`Proved source replacement: ${collision.classification} at ${collision.coordinate}; apply moves this exact source to recovery and installs the managed projection or bundle.`);
    } else if (collision.classification === "indirect-selected-source") {
      console.log(`Preserved indirect projection: ${collision.coordinate}; it will continue resolving through the proved source projection.`);
    } else {
      console.log(`Blocking destination collision: ${collision.classification} at ${collision.coordinate}; it will not be replaced.`);
    }
  }
  for (const projection of proof.projections || []) {
    console.log(`Projection: ${projection.relative_path} (${projection.classification}; ${projection.hosts.join(", ")})`);
  }
}

export function assertLocalInstallSource(input) {
  if (typeof input !== "string") return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith("git@")) {
    throw new Error(
      "Remote plugin sources are not executed directly. Download or clone it yourself, " +
      "inspect the source and revision, then pass the reviewed local folder to `dotaios install`."
    );
  }
}

async function readManifest(manifestPath) {
  try {
    const before = await fs.lstat(manifestPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error("manifest.json must be a single-link regular file");
    }
    if (before.size > BigInt(MAX_MANIFEST_BYTES)) {
      throw new Error(`manifest.json exceeds the ${MAX_MANIFEST_BYTES}-byte bound`);
    }
    const handle = await fs.open(
      manifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
    );
    let bytes;
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile()
        || opened.nlink !== 1n
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.size !== before.size
      ) throw new Error("manifest.json changed while opening");
      if (opened.size > BigInt(MAX_MANIFEST_BYTES)) {
        throw new Error(`manifest.json exceeds the ${MAX_MANIFEST_BYTES}-byte bound`);
      }
      bytes = Buffer.alloc(Number(opened.size));
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        bytesRead !== bytes.length
        || after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.size !== opened.size
      ) throw new Error("manifest.json changed while reading");
    } finally {
      await handle.close();
    }
    let text;
    try {
      text = STRICT_UTF8.decode(bytes);
    } catch {
      throw new Error("manifest.json is not valid UTF-8");
    }
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`No manifest.json found at ${manifestPath}`);
    }
    throw new Error(`Could not read plugin manifest: ${error.message}`);
  }
}

// Reject a --subdir that is absolute or contains ".." segments so the install
// cannot escape the reviewed local source directory.
export function assertSafeSubdir(subdir) {
  if (subdir == null) return;
  if (path.isAbsolute(subdir)) {
    throw new Error(`--subdir must be a relative path inside the source, got: ${subdir}`);
  }
  if (subdir.split(/[\\/]+/).includes("..")) {
    throw new Error(`--subdir may not contain ".." path segments: ${subdir}`);
  }
}

function parseOptions(args = []) {
  const options = {
    dryRun: false,
    home: null,
    path: null,
    subdir: null,
    apply: null,
    fingerprint: null,
    json: false,
    positionals: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--home") {
      options.home = readOptionValue(args, index, "--home");
      index += 1;
    } else if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--subdir") {
      options.subdir = readOptionValue(args, index, "--subdir");
      index += 1;
    } else if (arg === "--apply") {
      options.apply = readOptionValue(args, index, "--apply");
      index += 1;
    } else if (arg === "--fingerprint") {
      options.fingerprint = readOptionValue(args, index, "--fingerprint");
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

function printManifestSummary(manifest) {
  const permissions = summarizePermissions(manifest);

  console.log(`Plugin manifest is valid: ${manifest.name}@${manifest.version}`);
  console.log(manifest.description);
  console.log("\nDeclared permissions:");
  console.log(`- read: ${formatList(permissions.read)}`);
  console.log(`- write: ${formatList(permissions.write)}`);
  console.log(`- write with approval: ${formatList(permissions.write_with_approval)}`);
  console.log(`- connections: ${formatList(permissions.connections)}`);
}

function formatList(items) {
  return items.length > 0 ? items.join(", ") : "none";
}

async function findPluginSkillSource(pluginTarget, skillName, providedCount) {
  assertSafeSkillName(skillName);
  if (providedCount === 1 && await pathExists(path.join(pluginTarget, "SKILL.md"))) {
    return pluginTarget;
  }
  throw new Error(
    `Manifest declares skill "${skillName}", but this release accepts only a single Agent Skill bundle whose SKILL.md is at the reviewed root. Nested plugin packages are not installed.`
  );
}

function assertSafeSkillName(skillName) {
  if (typeof skillName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skillName)) {
    throw new Error(`Plugin skill name is unsafe: ${String(skillName)}`);
  }
}

async function ensureDirectory(directoryPath, label) {
  try {
    const stat = await fs.stat(directoryPath);
    if (!stat.isDirectory()) {
      throw new Error(`${label} is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${directoryPath}`);
    }
    throw error;
  }
}
