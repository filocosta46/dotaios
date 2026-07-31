import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { dictionary } from "../../website/src/content.js";
import { PUBLIC_OFFER } from "../../website/src/offer.js";
import { validateMarketRegistry } from "../../packages/core/src/market-registry.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("draft website offers expose no purchase path or automatic update claim", async () => {
  for (const language of Object.values(dictionary)) {
    assert.equal(language.consultantPack.action.href, null);
    assert.doesNotMatch(language.consultantPack.action.label, /buy|purchase|compra|acquista/i);
    assert.doesNotMatch(
      JSON.stringify(language.consultantPack),
      /updated weekly|aggiornat[ae] ogni settimana/i
    );
  }

  const publicFiles = await Promise.all([
    fs.readFile(path.join(repoRoot, "README.md"), "utf8"),
    fs.readFile(path.join(repoRoot, "website", "index.html"), "utf8"),
    fs.readFile(path.join(repoRoot, "website", "src", "content.js"), "utf8"),
    fs.readFile(path.join(repoRoot, "website", "public", "registry.json"), "utf8"),
    fs.readFile(path.join(repoRoot, "docs", "adapters.md"), "utf8"),
    fs.readFile(path.join(repoRoot, "docs", "client-support.md"), "utf8"),
    fs.readFile(path.join(repoRoot, "packages", "cli", "src", "commands", "activate.mjs"), "utf8")
  ]);
  const corpus = publicFiles.join("\n");
  assert.doesNotMatch(corpus, /gumroad\.com|updated weekly|refreshed every week/i);
  assert.doesNotMatch(corpus, /every AI reads|no cloud memory|native in every tool/i);
});

test("the public registry contains only schema-valid non-purchasable drafts", async () => {
  const file = path.join(repoRoot, "website", "public", "registry.json");
  const registry = validateMarketRegistry(JSON.parse(await fs.readFile(file, "utf8")), {
    source: file
  });
  assert.equal(registry.entries.length, 1);
  assert.deepEqual(
    {
      id: registry.entries[0].id,
      name: registry.entries[0].name,
      price_eur: registry.entries[0].price_eur
    },
    {
      id: PUBLIC_OFFER.id,
      name: PUBLIC_OFFER.name,
      price_eur: PUBLIC_OFFER.price.amount
    }
  );
  assert.ok(registry.entries.every((entry) => entry.status === "draft"));
  assert.ok(registry.entries.every((entry) => !entry.checkout_url && !entry.gumroad_url));
});

test("public context guidance documents only the current MCP tools and one memory projection", async () => {
  const relativeFiles = [
    "docs/mcp.md",
    "docs/adapters.md",
    "docs/sessions.md",
    "docs/architecture.md",
    "templates/AGENTS.md.hbs",
    "packages/core/src/bridges.mjs"
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
    ["google", "calendar", "agenda"], ["google", "drive", "search"]
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
