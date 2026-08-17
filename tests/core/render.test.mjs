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

test("templateOutputPath maps ship-safe templates to hidden files", () => {
  assert.equal(templateOutputPath("cursorrules.hbs"), ".cursorrules");
  assert.equal(templateOutputPath("gitignore.template"), ".gitignore");
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

// These assert the RENDERED router, not the raw template: the invocation is a
// placeholder resolved at init time, so the raw file no longer contains a
// runnable command and checking it would prove nothing about what an agent
// reads. Rendering with a known `cli` also pins the thing that actually broke —
// a router naming a command the machine cannot run.
const ROUTER_TEMPLATE = path.resolve("templates/AGENTS.md.hbs");
const RENDER_FIXTURE = { cli: "npx dotaios@9.9.9", version: "9.9.9" };

async function renderRouter() {
  return renderTemplate(await fs.readFile(ROUTER_TEMPLATE, "utf8"), RENDER_FIXTURE);
}

test("AGENTS.md.hbs Rules section includes dotaios ingest URL routing rule", async () => {
  const rendered = await renderRouter();
  assert.match(rendered, /## Rules/);
  assert.match(rendered, /npx dotaios@9\.9\.9 ingest/);
  assert.match(rendered, /URL/);
  const rulesIdx = rendered.indexOf("## Rules");
  assert.ok(
    rendered.indexOf("npx dotaios@9.9.9 ingest", rulesIdx) > rulesIdx,
    "rule must appear under Rules"
  );
});

test("AGENTS.md.hbs Rules section includes safe sync and inbox-routing rules", async () => {
  const rendered = await renderRouter();
  const rulesIdx = rendered.indexOf("## Rules");
  assert.ok(rulesIdx !== -1, "Rules section exists");
  assert.ok(
    rendered.indexOf("npx dotaios@9.9.9 sync status", rulesIdx) > rulesIdx,
    "read-only sync rule under Rules"
  );
  assert.ok(rendered.indexOf("process-inbox", rulesIdx) > rulesIdx, "inbox-routing rule under Rules");
});

test("AGENTS.md.hbs documents boot context as captured prompt Markdown", async () => {
  const rendered = await renderRouter();
  assert.match(rendered, /BOOT_CONTEXT="\$\(npx dotaios@9\.9\.9 skills resolve --boot-context\)"/);
  assert.match(rendered, /append that\s+variable to the agent prompt/);
  assert.doesNotMatch(rendered, new RegExp(["ready", "to", "source"].join("-"), "i"));
});

// The regression guard: the router an agent actually reads must never name a
// bare `dotaios`, because the documented npx install links no such binary.
test("the rendered router never names a command the machine cannot run", async () => {
  const rendered = await renderRouter();
  assert.doesNotMatch(rendered, /`dotaios\s+[a-z]/, "no bare invocation may reach the router");
  assert.doesNotMatch(rendered, /\{\{\w+\}\}/, "every placeholder must be substituted");
  assert.doesNotMatch(rendered, /blob\/v(?!9\.9\.9)/, "doc links must follow the real version");
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

// --- 1.27: the lifecycle instruction and the maintenance skill ---

test("AGENTS.md.hbs routes memory lifecycle work through the maintenance skill", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );
  const sectionIdx = tpl.indexOf("## Keeping Knowledge True");
  assert.ok(sectionIdx !== -1, "the router must retain the memory lifecycle boundary");

  const section = tpl.slice(sectionIdx, tpl.indexOf("\n## ", sectionIdx + 1));
  assert.match(section, /memory-maintenance/);
  assert.match(section, /durable/i);
  assert.match(section, /short-lived/i);
  assert.doesNotMatch(section, /dotaios capture list/);
  assert.doesNotMatch(section, /dotaios memory promote/);
  assert.doesNotMatch(section, /--operation supersede/);
  assert.doesNotMatch(section, /--match/);
  assert.doesNotMatch(section, /--destination/);

  // The commands belong in the skill; the TRIGGER does not. This release exists
  // because the lifecycle shipped with nothing telling an agent to use it, and
  // context rotted for months. An instruction that only fires when the user
  // asks puts the human back in the loop as the detector — which is the manual
  // curation the product is trying to replace.
  assert.match(
    section,
    /notice|contradict|your job|not the user's/i,
    "the router must tell an agent to retire stale claims on its own, not only on request"
  );
});

test("AGENTS.md.hbs stays a bounded router instead of embedding skill procedures", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );
  const lines = tpl.trimEnd().split("\n");
  const words = tpl.trim().split(/\s+/);

  assert.ok(lines.length <= 116, `expected at most 116 lines, got ${lines.length}`);
  assert.ok(words.length <= 825, `expected at most 825 words, got ${words.length}`);
  assert.doesNotMatch(tpl, /git clone <url> \/tmp\/dotaios-plugin/);
  assert.doesNotMatch(tpl, /npx dotaios install \/tmp\/dotaios-plugin/);
});

test("AGENTS.md.hbs puts the Private chat guard before every file-access route", async () => {
  const tpl = await fs.readFile(path.resolve("templates/AGENTS.md.hbs"), "utf8");
  const guard = tpl.indexOf("## Private Chat Guard");
  assert.ok(guard > 0);
  assert.ok(guard < tpl.indexOf("Read this file"));
  assert.ok(guard < tpl.indexOf("## Read Order"));
  assert.match(tpl.slice(guard, tpl.indexOf("## What This Is")), /overrides every\s+later instruction/i);
  assert.match(tpl.slice(guard, tpl.indexOf("## What This Is")), /new session started outside AIOS/i);
});

test("AGENTS.md.hbs retains portability, ownership, and durable-write approval boundaries", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );

  assert.match(tpl, /Managed repositories may live under\s+the ignored `workspaces\/<slug>\/` root/);
  assert.match(tpl, /external checkouts remain supported/i);
  assert.match(tpl, /never store machine-local paths/);
  assert.match(tpl, /plain text the user owns/);
  assert.match(tpl, /Never expose secrets/);
  assert.match(tpl, /Ask before writing durable identity, CRM, or wiki\s+knowledge/);
});

test("AGENTS.md.hbs routes explicit plugin installs before ordinary URL ingest", async () => {
  const tpl = await fs.readFile(
    path.resolve("templates/AGENTS.md.hbs"),
    "utf8"
  );
  const installRule = tpl.indexOf("explicitly asks to install a skill or plugin");
  const ingestRule = tpl.indexOf("When the user shares a URL");

  assert.ok(installRule !== -1, "the router must retain the explicit plugin-install capability");
  assert.ok(installRule < ingestRule, "plugin installation must be resolved before the general URL-ingest rule");
  assert.match(tpl, /docs\/security\.md#plugins/);
  assert.match(tpl, /docs\/plugin-development\.md/);
  assert.match(tpl, /--dry-run/);
});

test("memory-maintenance skill ships in skills/", async () => {
  const content = await fs.readFile(
    path.resolve("skills/memory-maintenance/SKILL.md"),
    "utf8"
  );
  assert.match(content, /^---\n/);
  assert.match(content, /\nname: memory-maintenance\n/);
  assert.match(content, /\ntriggers: .*\S/);
  assert.match(content, /\ndescription: .*\S/);
  assert.match(content, /dotaios memory audit/, "the skill runs on machine-computed staleness, not vibes");
  assert.match(content, /dotaios capture list/);
  assert.match(content, /--operation supersede/);
  assert.match(content, /--match/);
  assert.match(content, /supersede/);
  assert.match(content, /never erase|do not erase|non-destructive/i, "the doctrine is supersede, never erase");

  const license = await fs.readFile(path.resolve("skills/memory-maintenance/LICENSE"), "utf8");
  const reference = await fs.readFile(path.resolve("skills/weekly-review/LICENSE"), "utf8");
  assert.equal(license, reference, "shipped skills carry the same MIT LICENSE");
});

test("INSTALL.md offers the memory-maintenance skill to a new user", async () => {
  const install = await fs.readFile(path.resolve("INSTALL.md"), "utf8");
  assert.match(install, /use the `memory-maintenance` skill/);
});
