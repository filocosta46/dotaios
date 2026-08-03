import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
