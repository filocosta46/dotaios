import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { isHtmlComment, renderTemplate, templateOutputPath } from "../../packages/core/src/render.mjs";

test("renderTemplate fills simple values and vault branches", () => {
  const rendered = renderTemplate("Hi {{user_name}} {{#if vault_path}}at {{vault_path}}{{else}}local{{/if}}", {
    user_name: "Filippo",
    vault_path: "/notes"
  });

  assert.equal(rendered, "Hi Filippo at /notes");
});

test("renderTemplate handles ai_tools loops", () => {
  const rendered = renderTemplate("tools: {{#each ai_tools}}{{/each}}", {
    ai_tools: ["claude-code", "codex"]
  });

  assert.equal(rendered, 'tools: "claude-code", "codex"');
});

test("templateOutputPath maps Cursor template to hidden file", () => {
  assert.equal(templateOutputPath("cursorrules.hbs"), ".cursorrules");
  assert.equal(templateOutputPath("AGENTS.md.hbs"), "AGENTS.md");
});

test("renderTemplate generic {{#if}} works for any key", () => {
  const rendered = renderTemplate("{{#if user_role}}role: {{user_role}}{{else}}no role{{/if}}", {
    user_role: "builder"
  });
  assert.equal(rendered, "role: builder");
});

test("renderTemplate {{#if}} uses else branch when key is absent", () => {
  const rendered = renderTemplate("{{#if user_role}}role: {{user_role}}{{else}}no role{{/if}}", {});
  assert.equal(rendered, "no role");
});

test("renderTemplate treats HTML comment as falsy in {{#if}}", () => {
  const rendered = renderTemplate("{{#if user_name}}hi {{user_name}}{{else}}hi there{{/if}}", {
    user_name: "<!-- Your Name -->"
  });
  assert.equal(rendered, "hi there");
});

test("renderTemplate strips HTML comment in direct {{key}} substitution", () => {
  const rendered = renderTemplate("name: {{user_name}}", {
    user_name: "<!-- Your Name -->"
  });
  assert.equal(rendered, "name: ");
});

test("isHtmlComment identifies HTML comment strings", () => {
  assert.equal(isHtmlComment("<!-- Your Name -->"), true);
  assert.equal(isHtmlComment("<!-- -->"), true);
  assert.equal(isHtmlComment("Filippo"), false);
  assert.equal(isHtmlComment(""), false);
  assert.equal(isHtmlComment(null), false);
});

test("AGENTS.md.hbs Rules section includes dotaios ingest URL routing rule", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );
  assert.match(tpl, /## Rules/);
  assert.match(tpl, /dotaios ingest/);
  assert.match(tpl, /URL/);
  const rulesIdx = tpl.indexOf("## Rules");
  assert.ok(tpl.indexOf("dotaios ingest", rulesIdx) > rulesIdx, "rule must appear under Rules");
});

test("AGENTS.md.hbs Rules section includes the sync-tick and inbox-routing rules", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );
  const rulesIdx = tpl.indexOf("## Rules");
  assert.ok(rulesIdx !== -1, "Rules section exists");
  assert.ok(tpl.indexOf("dotaios sync tick", rulesIdx) > rulesIdx, "sync-tick rule under Rules");
  assert.ok(tpl.indexOf("process-inbox", rulesIdx) > rulesIdx, "inbox-routing rule under Rules");
});

test("process-inbox skill ships in skills/", async () => {
  const content = await fs.readFile(
    path.resolve("skills/process-inbox/SKILL.md"),
    "utf8"
  );
  assert.match(content, /name: process-inbox/);
  assert.match(content, /memory\/inbox/);
});

test("sync-gitignore.template ships in templates/", async () => {
  const file = path.join(new URL("../..", import.meta.url).pathname, "templates", "sync-gitignore.template");
  const content = await fs.readFile(file, "utf8");
  assert.ok(content.includes(".env"));
  assert.ok(content.includes("*.token"));
  assert.ok(content.includes("node_modules/"));
});
