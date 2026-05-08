import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, templateOutputPath } from "../../packages/core/src/render.mjs";

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
