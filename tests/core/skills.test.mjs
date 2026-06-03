import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectSkills, renderSkillsIndex, renderResolver, writeSkillsIndex } from "../../packages/core/src/skills.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

function makeSkill(skillsDir, dir, name, description) {
  fs.mkdirSync(path.join(skillsDir, dir), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
  );
}

test("collectSkills reads name and description from SKILL.md frontmatter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  const skillsDir = path.join(root, "skills");
  makeSkill(skillsDir, "audit", "audit", "Weekly health check.");
  makeSkill(skillsDir, "plan", "plan-today", "Plan the day.");
  fs.mkdirSync(path.join(skillsDir, "_internal"), { recursive: true });

  const skills = await collectSkills(root);
  assert.equal(skills.length, 2);
  assert.deepEqual(skills.map((s) => s.name), ["audit", "plan-today"]);
  assert.equal(skills[0].description, "Weekly health check.");
  assert.equal(skills[1].dir, "plan");
});

test("collectSkills returns an empty list when there is no skills folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  assert.deepEqual(await collectSkills(root), []);
});

test("renderSkillsIndex lists each skill with run instructions", () => {
  const md = renderSkillsIndex([{ dir: "audit", name: "audit", description: "Health check." }]);
  assert.match(md, /# Installed Skills/);
  assert.match(md, /Any AI agent can run one/i);
  assert.match(md, /## audit/);
  assert.match(md, /Health check\./);
  assert.match(md, /skills\/audit\/SKILL\.md/);
});

test("renderSkillsIndex handles an empty skill set", () => {
  assert.match(renderSkillsIndex([]), /No skills installed yet/);
});

test("writeSkillsIndex writes skills/INDEX.md from the skills on disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  makeSkill(path.join(root, "skills"), "audit", "audit", "Health check.");

  const result = await writeSkillsIndex(root);
  assert.equal(result.count, 1);

  const written = fs.readFileSync(path.join(root, "skills", "INDEX.md"), "utf8");
  assert.match(written, /## audit/);
});

test("collectSkills parses comma-separated triggers, empty when absent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(path.join(skillsDir, "plan"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "plan", "SKILL.md"),
    "---\nname: plan-today\ndescription: Plan the day.\ntriggers: plan my day, what should I work on, structure today\n---\n"
  );
  makeSkill(skillsDir, "audit", "audit", "Health check.");

  const skills = await collectSkills(root);
  const plan = skills.find((s) => s.dir === "plan");
  const audit = skills.find((s) => s.dir === "audit");
  assert.deepEqual(plan.triggers, ["plan my day", "what should I work on", "structure today"]);
  assert.deepEqual(audit.triggers, []);
});

test("renderResolver builds a trigger->skill table and falls back to description", () => {
  const md = renderResolver([
    { dir: "plan", name: "plan-today", description: "Plan the day.", triggers: ["plan my day", "what should I work on"] },
    { dir: "audit", name: "audit", description: "Weekly health check.", triggers: [] }
  ]);
  assert.match(md, /# Skill Resolver/);
  assert.match(md, /plan my day · what should I work on/);
  assert.match(md, /skills\/plan\/SKILL\.md/);
  assert.match(md, /Weekly health check\./); // description fallback for a no-trigger skill
});

test("renderResolver handles an empty skill set", () => {
  assert.match(renderResolver([]), /No skills installed yet/);
});

test("writeSkillsIndex also writes skills/RESOLVER.md", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  makeSkill(path.join(root, "skills"), "audit", "audit", "Health check.");

  await writeSkillsIndex(root);

  const resolver = fs.readFileSync(path.join(root, "skills", "RESOLVER.md"), "utf8");
  assert.match(resolver, /# Skill Resolver/);
  assert.match(resolver, /skills\/audit\/SKILL\.md/);
});

test("bundled save-session skill is shipped and has digest instructions", () => {
  const skillPath = path.join(repoRoot, "skills", "save-session", "SKILL.md");
  const content = fs.readFileSync(skillPath, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.ok(packageJson.files.includes("skills"), "npm package must include bundled skills");
  assert.match(content, /^---\nname: save-session\n/m);
  assert.match(content, /memory\/sessions\/YYYY-MM-DD/);
  assert.match(content, /<!-- digest:start -->/);
  assert.match(content, /<!-- digest:end -->/);
  assert.match(content, /index\.jsonl/);
});

test("bundled skillify skill ships with trigger phrases and an approval gate", () => {
  const content = fs.readFileSync(path.join(repoRoot, "skills", "skillify", "SKILL.md"), "utf8");
  assert.match(content, /^---\nname: skillify\n/m);
  assert.match(content, /^triggers:/m);
  assert.match(content, /approve|approval|ask before saving/i);
});
