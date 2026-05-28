import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkdownSnippets,
  matchQuery,
  searchAios,
  searchJsonlEntries,
  searchMarkdownDir
} from "../../packages/core/src/search.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-search-test-"));
}

test("matchQuery prefers exact phrase and falls back to all terms", () => {
  assert.deepEqual(matchQuery("alpha beta", "alpha beta"), { matched: true, kind: "phrase", score: 10 });
  assert.deepEqual(matchQuery("alpha then beta", "alpha beta"), { matched: true, kind: "terms", score: 5 });
  assert.deepEqual(matchQuery("alpha only", "alpha beta"), { matched: false, kind: null, score: 0 });
});

test("searchMarkdownDir orders phrase matches before all-term matches", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "terms.md"), "# Notes\n\nalpha later beta\n");
  fs.writeFileSync(path.join(dir, "phrase.md"), "# Notes\n\nalpha beta together\n");

  const results = await searchMarkdownDir(dir, "alpha beta", { sourcePrefix: "vault" });
  assert.deepEqual(results.map((result) => result.file), ["phrase.md", "terms.md"]);
  assert.equal(results[0].matches[0].match, "phrase");
  assert.equal(results[1].matches[0].match, "terms");
});

test("searchMarkdownDir prefers heading/title matches before body-only matches", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "body.md"), "# Body\n\nA body line mentions needle.\n");
  fs.writeFileSync(path.join(dir, "heading.md"), "# Needle Topic\n\nPlain body.\n");

  const results = await searchMarkdownDir(dir, "needle", { sourcePrefix: "vault" });
  assert.equal(results[0].file, "heading.md");
  assert.equal(results[0].matches[0].area, "heading");
});

test("buildMarkdownSnippets returns line windows around matches", () => {
  const snippets = buildMarkdownSnippets("# Title\n\nBefore line\nNeedle line\nAfter line\n", "needle");
  assert.equal(snippets[0].line, 3);
  assert.equal(snippets[0].lineEnd, 5);
  assert.match(snippets[0].content, /Before line/);
  assert.match(snippets[0].content, /Needle line/);
  assert.match(snippets[0].content, /After line/);
});

test("buildMarkdownSnippets falls back to all terms across a file", () => {
  const snippets = buildMarkdownSnippets("# Alpha Notes\n\nMiddle text\nBeta ending\n", "alpha beta");
  assert.equal(snippets.length, 2);
  assert.equal(snippets[0].match, "terms");
  assert.match(snippets[0].content, /Alpha/);
  assert.match(snippets[1].content, /Beta/);
});

test("buildMarkdownSnippets includes frontmatter descriptions", () => {
  const content = "---\ndescription: Searchable planning notes\n---\n# Other\n";
  const snippets = buildMarkdownSnippets(content, "planning");
  assert.equal(snippets[0].area, "description");
  assert.match(snippets[0].content, /Searchable planning notes/);
});

test("searchJsonlEntries reports non-summary matched fields", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "events.jsonl");
  fs.writeFileSync(filePath, JSON.stringify({
    ts: "2026-05-12T10:00:00.000Z",
    type: "note",
    project: "kapa-ai",
    summary: "Follow-up"
  }) + "\n");

  const results = await searchJsonlEntries(filePath, "kapa", { source: "memory/events.jsonl" });
  assert.equal(results.length, 1);
  assert.equal(results[0].matchedField, "project");
  assert.match(results[0].matchedSnippet, /kapa-ai/);
});

test("searchAios supports skills, references, and plugins scopes", async () => {
  const aiosPath = tmpDir();
  fs.mkdirSync(path.join(aiosPath, "skills", "audit"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), "# Audit\n\nReview AIOS health.\n");
  fs.mkdirSync(path.join(aiosPath, "references"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "references", "framework.md"), "# Framework\n\nCaveman notes.\n");
  fs.mkdirSync(path.join(aiosPath, "plugins", "demo"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "plugins", "demo", "manifest.json"), "{\n  \"name\": \"demo-search\"\n}\n");

  const skills = await searchAios({ aiosPath, query: "health", scope: "skills" });
  const references = await searchAios({ aiosPath, query: "caveman", scope: "references" });
  const plugins = await searchAios({ aiosPath, query: "demo-search", scope: "plugins" });

  assert.equal(skills[0].results[0].source, "skills/audit/SKILL.md");
  assert.equal(references[0].results[0].source, "references/framework.md");
  assert.equal(plugins[0].results[0].source, "plugins/demo/manifest.json");
});

test("searchMarkdownDir skips hidden and secret-like files", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".obsidian", "hidden.md"), "# Hidden\n\nneedle\n");
  fs.writeFileSync(path.join(dir, ".env.md"), "needle\n");
  fs.writeFileSync(path.join(dir, "visible.md"), "# Visible\n\nneedle\n");

  const results = await searchMarkdownDir(dir, "needle", { sourcePrefix: "vault" });
  assert.deepEqual(results.map((result) => result.file), ["visible.md"]);
});

test("searchJsonlEntries skips corrupt lines instead of throwing", async () => {
  const dir = tmpDir();
  const filePath = path.join(dir, "events.jsonl");
  // A corrupt line between two valid ones must not crash search — it powers the
  // MCP search_memory tool, the session digest, and the agent SessionStart hook.
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "note", summary: "needle one" }),
      "{ this is not valid json",
      JSON.stringify({ type: "note", summary: "needle two" })
    ].join("\n") + "\n"
  );

  const results = await searchJsonlEntries(filePath, "needle", { source: "memory/events.jsonl" });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.summary), ["needle one", "needle two"]);
});
