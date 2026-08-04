import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { validateMarketRegistry } from "../../packages/core/src/market-registry.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const run = promisify(execFile);

test("commercial website source stays outside the public repository", async () => {
  const { stdout } = await run("git", ["-C", repoRoot, "ls-files", "--", "website"]);
  assert.equal(stdout.trim(), "");
});

test("public claims stay inside the verified product boundary", async () => {
  const relativeFiles = [
    "README.md",
    "docs/adapters.md",
    "docs/client-support.md",
    "docs/getting-started.md",
    "packages/cli/src/commands/activate.mjs",
  ];
  const contents = await Promise.all(
    relativeFiles.map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8"))
  );
  const corpus = contents.join("\n");

  assert.doesNotMatch(corpus, /gumroad\.com|lemonsqueezy\.com|updated weekly|refreshed every week/i);
  assert.doesNotMatch(corpus, /every AI reads|no cloud memory|native in every tool/i);
});

test("the public registry fixture is schema-valid and non-purchasable", async () => {
  const file = path.join(repoRoot, "tests", "fixtures", "market-registry-draft.json");
  const registry = validateMarketRegistry(JSON.parse(await fs.readFile(file, "utf8")), {
    source: file,
  });
  const forbiddenDeliveryFields = [
    "checkout_url",
    "download_url",
    "entitlement_url",
    "git_url",
    "gumroad_url",
    "install_url",
    "license_url",
    "product_id",
  ];

  assert.ok(registry.entries.length > 0);
  for (const entry of registry.entries) {
    assert.match(entry.status, /^(draft|planned)$/);
    for (const field of forbiddenDeliveryFields) assert.equal(entry[field], undefined);
  }
});

test("public context guidance documents only the current MCP tools and one memory projection", async () => {
  const relativeFiles = [
    "docs/mcp.md",
    "docs/adapters.md",
    "docs/sessions.md",
    "docs/architecture.md",
    "templates/AGENTS.md.hbs",
    "packages/core/src/bridges.mjs",
  ];
  const contents = await Promise.all(
    relativeFiles.map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), "utf8"))
  );
  const [mcpDocumentation, , , , agentsTemplate] = contents;
  const toolsSection = mcpDocumentation.split("## Tools")[1].split(/\n## /)[0];
  const documentedTools = [...toolsSection.matchAll(/^- `([a-z_]+)`:/gm)]
    .map((match) => match[1]);
  const corpus = contents.join("\n");
  const retiredToolNames = [
    ["read", "session", "digest"], ["read", "context"], ["list", "skills"],
    ["search", "memory"], ["search", "vault"], ["list", "projects"],
    ["log", "event"], ["google", "status"], ["google", "gmail", "search"],
    ["google", "calendar", "agenda"], ["google", "drive", "search"],
  ].map((parts) => parts.join("_"));

  assert.deepEqual(documentedTools, ["read_working_context", "search_aios", "resolve_skill"]);
  assert.equal(retiredToolNames.some((name) => corpus.includes(name)), false);
  assert.match(
    agentsTemplate,
    /Do not preload `memory\/events\.jsonl`, `memory\/signals\/`, or `memory\/sessions\/`/,
    "the lean router must still enforce the single bounded memory projection"
  );
  assert.doesNotMatch(agentsTemplate, /load the last 50|load the single most recent file/i);
});

test("shipped skills route working-memory reads through the bounded projection", async () => {
  const skillsRoot = path.join(repoRoot, "skills");
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const skillFiles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const file = path.join(skillsRoot, entry.name, "SKILL.md");
      try {
        return { file, content: await fs.readFile(file, "utf8") };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }));
  const directRead = /(?:read|load|scan|review|inspect)[^\n`]*(?:memory\/(?:events\.jsonl|signals|sessions))/i;
  for (const skill of skillFiles.filter(Boolean)) {
    for (const line of skill.content.split(/\r?\n/)) {
      assert.doesNotMatch(line, directRead, `${skill.file} directly reads working memory: ${line}`);
    }
  }
});
