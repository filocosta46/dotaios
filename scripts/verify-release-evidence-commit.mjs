#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;
const HASH_256 = /^[a-f0-9]{64}$/;
const EVIDENCE_PREFIX = "docs/release-evidence/";

if (isMain()) {
  try {
    const input = readInput(parseInputPath(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(verifyEvidenceCommit(input))}\n`);
  } catch (error) {
    process.stderr.write(`Evidence commit admission refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export function verifyEvidenceCommit(input) {
  assertExactKeys(input, [
    "candidate_source_commit", "evidence_commit", "candidate_package_tree_sha256",
    "evidence_package_tree_sha256", "pr", "changes",
  ], "Evidence commit input");
  const {
    candidate_source_commit: candidateSourceCommit,
    evidence_commit: evidenceCommit,
    candidate_package_tree_sha256: candidatePackageTreeSha256,
    evidence_package_tree_sha256: evidencePackageTreeSha256,
    pr,
    changes,
  } = input;
  if (!GIT_OBJECT_ID.test(candidateSourceCommit || "") || !GIT_OBJECT_ID.test(evidenceCommit || "")) {
    throw new Error("Candidate source or evidence commit identity is invalid.");
  }
  if (candidateSourceCommit === evidenceCommit) throw new Error("Evidence commit must be separate from the package-bearing source commit.");
  if (!HASH_256.test(candidatePackageTreeSha256 || "") || !HASH_256.test(evidencePackageTreeSha256 || "")) {
    throw new Error("Package tree identity is invalid.");
  }
  if (candidatePackageTreeSha256 !== evidencePackageTreeSha256) {
    throw new Error("Evidence commit changed package-bearing bytes.");
  }
  assertExactKeys(pr, [
    "number", "state", "merged", "base_branch", "head_branch", "head_sha", "approved_head_sha",
  ], "Evidence PR");
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error("Evidence PR number is invalid.");
  if (pr.state !== "MERGED" || pr.merged !== true) throw new Error("Evidence must come from a merged reviewed PR.");
  if (pr.base_branch !== "main") throw new Error("Evidence PR must target main.");
  if (!validBranch(pr.head_branch) || pr.head_branch === "main") throw new Error("Direct-main evidence commits are refused.");
  if (pr.head_sha !== evidenceCommit || pr.approved_head_sha !== evidenceCommit) {
    throw new Error("Evidence commit is not the exact reviewed PR head.");
  }
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 64) {
    throw new Error("Evidence commit requires one bounded non-empty file set.");
  }
  const admitted = [];
  const seen = new Set();
  for (const change of changes) {
    assertExactKeys(change, ["path", "status", "mode", "blob_sha256"], "Evidence file");
    if (!validEvidencePath(change.path) || seen.has(change.path)) throw new Error("Evidence file path is unsafe, duplicated, or outside the evidence root.");
    if (!["added", "modified"].includes(change.status)) throw new Error("Evidence file status is not admitted.");
    if (change.mode !== "100644") throw new Error("Evidence links, executables, and special files are refused.");
    if (!HASH_256.test(change.blob_sha256 || "")) throw new Error("Evidence file hash is invalid.");
    seen.add(change.path);
    admitted.push({ ...change });
  }
  admitted.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: "dotaios.evidence-commit.v1",
    evidence_go: "GO",
    candidate_source_commit: candidateSourceCommit,
    evidence_commit: evidenceCommit,
    reviewed_pr: { number: pr.number, head: evidenceCommit },
    package_tree_sha256: candidatePackageTreeSha256,
    evidence_files_sha256: sha256(Buffer.from(canonicalJson(admitted), "utf8")),
  };
}

function validEvidencePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || !value.endsWith(".json")) return false;
  if (!value.startsWith(EVIDENCE_PREFIX) || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseInputPath(args) {
  if (args.length !== 2 || args[0] !== "--input" || !args[1] || args[1].startsWith("--")) {
    throw new Error("Usage: verify-release-evidence-commit.mjs --input <evidence-commit.json>");
  }
  return path.resolve(args[1]);
}

function readInput(file) {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 256 * 1024) {
    throw new Error("Evidence commit input must be one non-empty bounded regular file.");
  }
  try {
    return JSON.parse(fs.readFileSync(fs.realpathSync(file), "utf8"));
  } catch (error) {
    throw new Error(`Evidence commit input is invalid JSON: ${error.message}`);
  }
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} contains fields outside the admitted schema.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}
