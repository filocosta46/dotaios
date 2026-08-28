#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GIT_OBJECT_ID = /^[a-f0-9]{40}$/;

export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  "test (Node 20)",
  "test (Node 22)",
  "test (Node 24)",
  "windows runtime handoffs (Node 24)",
  "release admission firewall (Node 24)",
  "CodeRabbit",
]);

if (isMain()) {
  try {
    const input = readInput(parseInputPath(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(verifyReviewedSource(input))}\n`);
  } catch (error) {
    process.stderr.write(`Reviewed source admission refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export function verifyReviewedSource(input) {
  assertExactKeys(input, ["source_commit", "pr", "required_checks", "check_runs"], "Reviewed source input");
  const { source_commit: sourceCommit, pr, required_checks: requiredChecks, check_runs: checkRuns } = input;
  if (!GIT_OBJECT_ID.test(sourceCommit || "")) throw new Error("Release source commit is invalid.");
  assertExactKeys(pr, [
    "number", "state", "merged", "base_branch", "head_branch", "head_sha", "approved_head_sha",
  ], "Reviewed source PR");
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error("Reviewed source PR number is invalid.");
  if (pr.state !== "MERGED" || pr.merged !== true) throw new Error("Release source must come from a merged reviewed PR.");
  if (pr.base_branch !== "main") throw new Error("Reviewed source PR must target main.");
  if (!validBranch(pr.head_branch) || pr.head_branch === "main") {
    throw new Error("Direct-main release source is refused; a focused reviewed branch is required.");
  }
  if (pr.head_sha !== sourceCommit) throw new Error("Release source commit does not match the reviewed PR head.");
  if (pr.approved_head_sha !== sourceCommit) throw new Error("Release source PR approval is stale or absent for this head.");

  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0 || requiredChecks.length > 64) {
    throw new Error("Release source requires one bounded required-check set.");
  }
  const required = [...requiredChecks];
  if (required.some((name) => !validCheckName(name)) || new Set(required).size !== required.length) {
    throw new Error("Release source required checks must be unique bounded names.");
  }
  if (canonicalJson(required.toSorted()) !== canonicalJson(REQUIRED_RELEASE_CHECKS.toSorted())) {
    throw new Error("Release source required checks do not match the repository release gate.");
  }
  if (!Array.isArray(checkRuns) || checkRuns.length > 256) throw new Error("Release source check runs are invalid.");
  const admitted = [];
  for (const name of required.sort()) {
    const matches = checkRuns.filter((run) => run?.name === name);
    if (matches.length !== 1) throw new Error(`Required check ${name} is missing or ambiguous.`);
    const run = matches[0];
    assertExactKeys(run, ["name", "conclusion", "head_sha"], "Required check run");
    if (run.conclusion !== "success") throw new Error(`Required check ${name} did not pass.`);
    if (run.head_sha !== sourceCommit) throw new Error(`Required check ${name} belongs to a stale PR head.`);
    admitted.push({ name, conclusion: "success", head_sha: sourceCommit });
  }
  return {
    schema: "dotaios.reviewed-source.v1",
    source_go: "GO",
    source_commit: sourceCommit,
    reviewed_pr: {
      number: pr.number,
      head: sourceCommit,
      required_checks_sha256: sha256(Buffer.from(canonicalJson(admitted), "utf8")),
    },
  };
}

function validBranch(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validCheckName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseInputPath(args) {
  if (args.length !== 2 || args[0] !== "--input" || !args[1] || args[1].startsWith("--")) {
    throw new Error("Usage: verify-release-source.mjs --input <reviewed-source.json>");
  }
  return path.resolve(args[1]);
}

function readInput(file) {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 256 * 1024) {
    throw new Error("Reviewed source input must be one non-empty bounded regular file.");
  }
  try {
    return JSON.parse(fs.readFileSync(fs.realpathSync(file), "utf8"));
  } catch (error) {
    throw new Error(`Reviewed source input is invalid JSON: ${error.message}`);
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
