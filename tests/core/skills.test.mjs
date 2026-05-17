import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectSkills, renderSkillsIndex, writeSkillsIndex } from "../../packages/core/src/skills.mjs";

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
