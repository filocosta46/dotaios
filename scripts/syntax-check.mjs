#!/usr/bin/env node
// Zero-false-positive static gate: parse every source module with Node's own
// parser (`node --check`). Catches real breakage — a syntax error, a bad
// import shape — across the whole tree without the noise a first-time `checkJs`
// rollout produces on a never-typed codebase. Full TypeScript/JSDoc checking is
// tracked as a separate post-launch hardening step.

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["packages", "scripts"];
const SKIP = new Set(["node_modules", "dist", "build", ".git"]);

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if ([".mjs", ".js"].includes(extname(full))) acc.push(full);
  }
  return acc;
}

const files = ROOTS.flatMap((root) => walk(join(repoRoot, root)));
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed += 1;
    console.error(`SYNTAX ERROR: ${file}`);
    console.error(String(error.stderr || error.message).trim());
  }
}

if (failed > 0) {
  console.error(`\nsyntax-check FAILED: ${failed} of ${files.length} file(s) did not parse.`);
  process.exit(1);
}
console.log(`syntax-check OK: ${files.length} source file(s) parse cleanly.`);
