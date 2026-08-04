#!/usr/bin/env node
// DotAIOS release checklist — verifies the repo is ready before `npm publish`.
// Run: node scripts/release-checklist.mjs   (or: npm run release:check)
// Read-only: it never publishes, tags, or pushes.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const options = parseOptions(process.argv.slice(2));

console.log(`\nDotAIOS release checklist — v${pkg.version}\n`);

function run(cmd) {
  execSync(cmd, { stdio: "pipe" });
  return true;
}

const items = [
  {
    label: `package version matches expected ${options.version}`,
    check: () => pkg.version === options.version,
  },
  { label: "Unit tests pass (npm test)", check: () => run("npm test") },
  { label: "Smoke test passes (npm run smoke)", check: () => run("npm run smoke") },
  { label: "CLI help loads (npm run check)", check: () => run("npm run check") },
  {
    label: "newest CHANGELOG.md release matches this version",
    check: () => existsSync("CHANGELOG.md") && newestChangelogVersion() === pkg.version,
  },
  {
    label: "npm pack includes the CLI entry point",
    check: () => execSync("npm pack --dry-run 2>&1", { encoding: "utf8" }).includes("packages/cli/src/index.mjs")
  },
  {
    label: "Working tree is clean",
    check: () => execSync("git status --porcelain", { encoding: "utf8" }).trim() === ""
  },
  {
    label: `On ${options.branch} branch`,
    check: () => options.allowBranch
      || execSync("git branch --show-current", { encoding: "utf8" }).trim() === options.branch,
  },
];

let allPass = true;
for (const item of items) {
  let ok = false;
  try { ok = item.check() === true; } catch { ok = false; }
  if (!ok) allPass = false;
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"}  ${item.label}`);
}

console.log("");
if (allPass) {
  console.log("All checks passed. Safe to: npm publish\n");
} else {
  console.log("One or more checks failed — fix before publishing.\n");
  process.exitCode = 1;
}

function newestChangelogVersion() {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  return changelog.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/m)?.[1] || null;
}

function parseOptions(args) {
  const parsed = { allowBranch: false, branch: "main", version: pkg.version };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-branch") {
      parsed.allowBranch = true;
    } else if (arg === "--branch" || arg === "--version") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      parsed[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}
