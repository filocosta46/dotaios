#!/usr/bin/env node
// DotAIOS release checklist — verifies the repo is ready before `npm publish`.
// Run: node scripts/release-checklist.mjs   (or: npm run release:check)
// Read-only: it never publishes, tags, or pushes.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

console.log(`\nDotAIOS release checklist — v${pkg.version}\n`);

function run(cmd) {
  execSync(cmd, { stdio: "pipe" });
  return true;
}

const items = [
  { label: "Unit tests pass (npm test)", check: () => run("npm test") },
  { label: "Smoke test passes (npm run smoke)", check: () => run("npm run smoke") },
  { label: "CLI help loads (npm run check)", check: () => run("npm run check") },
  {
    label: "CHANGELOG.md has an entry for this version",
    check: () => existsSync("CHANGELOG.md") && readFileSync("CHANGELOG.md", "utf8").includes(`[${pkg.version}]`)
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
    label: "On main branch",
    check: () => execSync("git branch --show-current", { encoding: "utf8" }).trim() === "main"
  }
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
