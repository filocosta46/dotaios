import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

// The skills DotAIOS itself ships are the ones a brand-new user gets from
// `npx dotaios init`. Routing phrases authored only under `triggers:` are read
// by DotAIOS and by no agent host — Claude Code's documented field is
// `when_to_use`, which it appends to the description in the skill listing the
// model actually routes on. Shipping a skill without it means the new user's
// agents cannot find it, and `dotaios skills sync-triggers` is a migration for
// the user's own folder that never touches these files.

const skillsDir = fileURLToPath(new URL("../../skills", import.meta.url));

async function bundledSkills() {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    let content;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    skills.push({ dir: entry.name, content });
  }
  return skills;
}

test("every bundled skill exposes its routing phrases where hosts read them", async () => {
  const skills = await bundledSkills();
  assert.ok(skills.length > 0, "expected bundled skills to exist");

  const missing = skills
    .filter((skill) => /^triggers:/m.test(skill.content) && !/^when_to_use:/m.test(skill.content))
    .map((skill) => skill.dir);

  assert.deepEqual(
    missing,
    [],
    `these bundled skills declare triggers no host can see. Update their owned frontmatter before release:\n${missing.join("\n")}`
  );
});

test("bundled when_to_use stays in sync with the triggers it is derived from", async () => {
  const drifted = [];

  for (const skill of await bundledSkills()) {
    const triggers = skill.content.match(/^triggers:\s*(.+)$/m)?.[1];
    const whenToUse = skill.content.match(/^when_to_use:\s*(.+)$/m)?.[1];
    if (!triggers || !whenToUse) continue;

    const fromTriggers = triggers.split(",").map((value) => value.trim()).filter(Boolean);
    const fromWhenToUse = whenToUse.split("·").map((value) => value.trim()).filter(Boolean);
    if (fromTriggers.join("|") !== fromWhenToUse.join("|")) drifted.push(skill.dir);
  }

  assert.deepEqual(drifted, [], `when_to_use drifted from triggers in: ${drifted.join(", ")}`);
});
