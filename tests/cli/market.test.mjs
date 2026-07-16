import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { marketCommand } from "../../packages/cli/src/commands/market.mjs";

async function withRegistry(skills, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-market-"));
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(registryPath, JSON.stringify({ skills }), "utf8");
  try {
    return await fn(pathToFileURL(registryPath).href);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function captureLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs.join("\n");
}

test("market list labels draft outcome packs as coming soon", async () => {
  await withRegistry([
    {
      id: "guided-work",
      name: "Guided Work",
      status: "draft",
      price_eur: "12.99"
    }
  ], async (registry) => {
    const output = await captureLogs(() => marketCommand(["list", "--registry", registry]));
    assert.match(output, /guided-work/);
    assert.match(output, /coming soon, planned EUR 12\.99/);
    assert.doesNotMatch(output, /\[free\]/);
  });
});

test("market help points at the deployed official registry", async () => {
  const output = await captureLogs(() => marketCommand(["--help"]));
  assert.match(output, /https:\/\/dotaios\.vercel\.app\/registry\.json/);
  assert.doesNotMatch(output, /https:\/\/dotaios\.com\/registry\.json/);
});

test("market install refuses a draft before resolving any package source", async () => {
  await withRegistry([
    {
      id: "done-for-you",
      name: "Done For You",
      status: "draft",
      price_eur: "35.00"
    }
  ], async (registry) => {
    await assert.rejects(
      marketCommand(["install", "done-for-you", "--registry", registry]),
      /still in preparation.*no checkout or install/i
    );
  });
});

test("market rejects an unknown entry status", async () => {
  await withRegistry([
    { id: "broken", name: "Broken", status: "maybe" }
  ], async (registry) => {
    await marketCommand(["list", "--registry", registry]);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});

test("market rejects available entries without a package source", async () => {
  await withRegistry([
    { id: "empty", name: "Empty", status: "available" }
  ], async (registry) => {
    await marketCommand(["list", "--registry", registry]);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});

test("market rejects checkout links on draft entries", async () => {
  await withRegistry([
    {
      id: "early-sale",
      name: "Early Sale",
      status: "draft",
      checkout_url: "https://example.com/buy"
    }
  ], async (registry) => {
    await marketCommand(["list", "--registry", registry]);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  });
});
