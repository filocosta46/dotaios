#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { validateMarketRegistry } from "../packages/core/src/market-registry.mjs";

const sourceUrl = new URL("../website/public/registry.json", import.meta.url);
const builtUrl = new URL("../website/dist/registry.json", import.meta.url);

const [source, built] = await Promise.all([
  readRegistry(sourceUrl),
  readRegistry(builtUrl),
]);

validateMarketRegistry(source, { source: sourceUrl.pathname });
validateMarketRegistry(built, { source: builtUrl.pathname });
assert.deepEqual(built, source, "built registry must exactly match website/public/registry.json");

console.log(`Website registry verified: ${built.entries.length} schema-valid entr${built.entries.length === 1 ? "y" : "ies"}.`);

async function readRegistry(url) {
  let content;
  try {
    content = await fs.readFile(url, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${url.pathname}. Run \`pnpm run site:build\` first: ${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${url.pathname} is not valid JSON`);
  }
}
