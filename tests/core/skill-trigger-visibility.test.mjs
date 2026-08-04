import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

import {
  collectSkills,
  planTriggerVisibility,
  applyTriggerVisibility
} from "../../packages/core/src/skills.mjs";

// Hosts route on the skill listing they build from SKILL.md frontmatter.
// Claude Code documents `when_to_use` as the field appended to `description`
// in that listing. DotAIOS has always written routing phrases to `triggers:`,
// which no host reads — so the phrases that make `dotaios skills resolve`
// deterministic were invisible to the agents actually choosing the skill.

async function makeAios(skills) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-triggers-"));
  for (const [dir, frontmatter, body = "# Body\n"] of skills) {
    const skillDir = path.join(root, "skills", dir);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  }
  return root;
}

test("collectSkills reads when_to_use alongside triggers", async () => {
  const root = await makeAios([
    ["today", 'name: today\ndescription: Build today\'s plan.\nwhen_to_use: start my day · today\'s plan']
  ]);

  const [skill] = await collectSkills(root);
  assert.equal(skill.dir, "today");
  assert.deepEqual(skill.whenToUse, ["start my day", "today's plan"]);
});

test("collectSkills leaves whenToUse empty when the field is absent", async () => {
  const root = await makeAios([
    ["audit", "name: audit\ndescription: Check the system.\ntriggers: audit my aios, health check"]
  ]);

  const [skill] = await collectSkills(root);
  assert.deepEqual(skill.triggers, ["audit my aios", "health check"]);
  assert.deepEqual(skill.whenToUse, []);
});

test("planTriggerVisibility reports skills whose triggers no host can see", async () => {
  const root = await makeAios([
    ["audit", "name: audit\ndescription: Check the system.\ntriggers: audit my aios, health check"],
    ["today", "name: today\ndescription: Plan today.\nwhen_to_use: start my day"],
    ["plain", "name: plain\ndescription: No routing metadata at all."]
  ]);

  const plan = await planTriggerVisibility(root);

  assert.equal(plan.length, 1, "only the triggers-without-when_to_use skill needs syncing");
  assert.equal(plan[0].dir, "audit");
  assert.equal(plan[0].whenToUse, "audit my aios · health check");
});

test("planTriggerVisibility does not rewrite a skill that already declares when_to_use", async () => {
  const root = await makeAios([
    ["today", "name: today\ndescription: Plan today.\ntriggers: start my day\nwhen_to_use: open today's note"]
  ]);

  assert.deepEqual(await planTriggerVisibility(root), []);
});

test("applyTriggerVisibility writes when_to_use into frontmatter and preserves the body", async () => {
  const root = await makeAios([
    ["audit", "name: audit\ndescription: Check the system.\ntriggers: audit my aios, health check", "# Audit\n\nSteps here.\n"]
  ]);

  const written = await applyTriggerVisibility(root, await planTriggerVisibility(root));
  assert.equal(written.length, 1);

  const content = await fs.readFile(path.join(root, "skills", "audit", "SKILL.md"), "utf8");
  assert.match(content, /^when_to_use: audit my aios · health check$/m);
  assert.match(content, /^triggers: audit my aios, health check$/m, "the original triggers list is preserved");
  assert.match(content, /# Audit\n\nSteps here\./, "the skill body is untouched");

  const [skill] = await collectSkills(root);
  assert.deepEqual(skill.whenToUse, ["audit my aios", "health check"]);
});

test("applyTriggerVisibility is idempotent", async () => {
  const root = await makeAios([
    ["audit", "name: audit\ndescription: Check the system.\ntriggers: audit my aios"]
  ]);

  await applyTriggerVisibility(root, await planTriggerVisibility(root));
  const first = await fs.readFile(path.join(root, "skills", "audit", "SKILL.md"), "utf8");

  assert.deepEqual(await planTriggerVisibility(root), [], "a second plan finds nothing left to do");
  await applyTriggerVisibility(root, await planTriggerVisibility(root));
  const second = await fs.readFile(path.join(root, "skills", "audit", "SKILL.md"), "utf8");

  assert.equal(first, second);
});

// The phrases a person writes are their own words, so the writer has to survive
// punctuation. A skill whose frontmatter stops parsing disappears from the host
// listing entirely — the exact opposite of what syncing triggers is for.
test("applyTriggerVisibility keeps frontmatter parseable when a trigger contains YAML punctuation", async () => {
  const root = await makeAios([
    ["deploy", 'name: deploy\ndescription: Ship it.\ntriggers:\n  - "deploy: prod"\n  - rollback'],
    ["triage", 'name: triage\ndescription: Sort it.\ntriggers:\n  - "tag #urgent"\n  - triage']
  ]);

  await applyTriggerVisibility(root, await planTriggerVisibility(root));

  for (const dir of ["deploy", "triage"]) {
    const content = await fs.readFile(path.join(root, "skills", dir, "SKILL.md"), "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, `${dir} still has frontmatter`);
    assert.doesNotThrow(() => parse(frontmatter[1]), `${dir} frontmatter stays valid YAML`);
  }

  const skills = await collectSkills(root);
  const deploy = skills.find((skill) => skill.dir === "deploy");
  assert.deepEqual(deploy.whenToUse, ["deploy: prod", "rollback"]);
  const triage = skills.find((skill) => skill.dir === "triage");
  assert.deepEqual(triage.whenToUse, ["tag #urgent", "triage"], "a # comment marker is not truncated away");
});

test("applyTriggerVisibility treats $ sequences in a trigger as text, not replacement patterns", async () => {
  const root = await makeAios([
    ["cash", 'name: cash\ndescription: Money.\ntriggers:\n  - "budget $` report"\n  - "$&"\n  - "how much $$ left"']
  ]);

  await applyTriggerVisibility(root, await planTriggerVisibility(root));

  const content = await fs.readFile(path.join(root, "skills", "cash", "SKILL.md"), "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.doesNotThrow(() => parse(frontmatter[1]), "frontmatter stays valid YAML");
  assert.equal(content.match(/^name: cash$/gm).length, 1, "the frontmatter is not duplicated into itself");

  const [skill] = await collectSkills(root);
  assert.deepEqual(skill.whenToUse, ["budget $` report", "$&", "how much $$ left"]);
});

test("applyTriggerVisibility preserves CRLF line endings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-triggers-crlf-"));
  const skillDir = path.join(root, "skills", "crlf");
  await fs.mkdir(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  await fs.writeFile(
    file,
    "---\r\nname: crlf\r\ndescription: Windows.\r\ntriggers: do the thing\r\n---\r\n\r\n# Body\r\n"
  );

  await applyTriggerVisibility(root, await planTriggerVisibility(root));

  const content = await fs.readFile(file, "utf8");
  assert.doesNotMatch(content, /(?<!\r)\n/, "no bare LF is introduced into a CRLF file");
  assert.match(content, /^when_to_use: do the thing\r$/m);
});

test("applyTriggerVisibility never touches a skill outside the supplied plan", async () => {
  const root = await makeAios([
    ["audit", "name: audit\ndescription: Check.\ntriggers: audit my aios"],
    ["other", "name: other\ndescription: Untouched.\ntriggers: something else"]
  ]);

  const plan = (await planTriggerVisibility(root)).filter((entry) => entry.dir === "audit");
  await applyTriggerVisibility(root, plan);

  const other = await fs.readFile(path.join(root, "skills", "other", "SKILL.md"), "utf8");
  assert.doesNotMatch(other, /when_to_use/, "a skill left out of the plan is not rewritten");
});
