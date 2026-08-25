import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectSkills,
  renderResolver,
  renderResolverBytes,
  renderSkillsIndex,
  renderSkillsIndexBytes,
  writeSkillsIndex
} from "../../packages/core/src/skills.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const exactCli = `npx dotaios@${packageVersion}`;

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
  assert.match(md, new RegExp(`${exactCli.replaceAll(".", "\\.")} activate`));
});

test("renderSkillsIndex handles an empty skill set", () => {
  const md = renderSkillsIndex([]);
  assert.match(md, /No skills installed yet/);
  assert.match(md, new RegExp(`${exactCli.replaceAll(".", "\\.")} skill add <local-folder>`));
  assert.doesNotMatch(md, /`dotaios\s+[a-z]|npx dotaios(?!@)/);
});

test("generated skill catalogs contain no bare or unpinned executable command", () => {
  const skills = [{ dir: "audit", name: "audit", description: "Health check.", triggers: ["audit"] }];
  for (const catalog of [renderSkillsIndex(skills), renderResolver(skills)]) {
    assert.match(catalog, new RegExp(`${exactCli.replaceAll(".", "\\.")} activate`));
    assert.doesNotMatch(catalog, /`dotaios\s+[a-z]/);
    assert.doesNotMatch(catalog, /npx dotaios(?!@)/);
  }
});

test("writeSkillsIndex writes skills/INDEX.md from the skills on disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  makeSkill(path.join(root, "skills"), "audit", "audit", "Health check.");

  const result = await writeSkillsIndex(root);
  assert.equal(result.count, 1);

  const written = fs.readFileSync(path.join(root, "skills", "INDEX.md"), "utf8");
  assert.match(written, /## audit/);
});

test("writeSkillsIndex omits linked top-level skill entries and keeps real siblings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-outside-"));
  const skillsDir = path.join(root, "skills");
  makeSkill(skillsDir, "real-sibling", "real-sibling", "Canonical skill.");
  makeSkill(outside, "outside-canary", "OUTSIDE_SKILL_CANARY", "Must never be read.");
  fs.symlinkSync(
    path.join(outside, "outside-canary"),
    path.join(skillsDir, "linked-entry"),
    "dir",
  );

  const result = await writeSkillsIndex(root);
  const catalogs = [result.path, result.resolverPath].map((filePath) => fs.readFileSync(filePath, "utf8"));

  assert.equal(result.count, 1);
  for (const catalog of catalogs) {
    assert.match(catalog, /real-sibling/);
    assert.doesNotMatch(catalog, /OUTSIDE_SKILL_CANARY|linked-entry/);
  }
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

test("collectSkills preserves quoted comma-separated trigger scalars", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  const skillDir = path.join(root, "skills", "plan");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    '---\nname: plan\ndescription: Plan work.\ntriggers: "plan my day, structure today"\n---\n'
  );

  const [plan] = await collectSkills(root);
  assert.deepEqual(plan.triggers, ["plan my day", "structure today"]);
});

test("collectSkills parses YAML block-list triggers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-"));
  const skillDir = path.join(root, "skills", "audit");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: audit",
      "description: Review the local setup.",
      "triggers:",
      "  - audit my setup",
      '  - "review my setup"',
      "  - health check",
      "---",
      ""
    ].join("\n")
  );

  const [audit] = await collectSkills(root);
  assert.deepEqual(audit.triggers, ["audit my setup", "review my setup", "health check"]);
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

test("catalog byte renderers use unsigned UTF-8 ordering for names and paths", () => {
  const skills = [
    { dir: "z-path", name: "same", description: "Z path.", triggers: [] },
    { dir: "ä-path", name: "same", description: "Opaque path.", triggers: [] },
    { dir: "opaque", name: "ä-skill", description: "Opaque name.", triggers: [] },
    { dir: "lower", name: "z-skill", description: "Lower name.", triggers: [] },
    { dir: "upper", name: "Z-skill", description: "Upper name.", triggers: [] }
  ];

  const index = renderSkillsIndexBytes(skills);
  const resolver = renderResolverBytes(skills);

  assert.ok(Buffer.isBuffer(index));
  assert.ok(Buffer.isBuffer(resolver));
  assert.equal(index.at(-1), 0x0a);
  assert.equal(resolver.at(-1), 0x0a);
  assert.ok(index.indexOf("## Z-skill") < index.indexOf("## z-skill"));
  assert.ok(index.indexOf("## z-skill") < index.indexOf("## ä-skill"));
  assert.ok(index.indexOf("skills/z-path/SKILL.md") < index.indexOf("skills/ä-path/SKILL.md"));
  assert.deepEqual(renderSkillsIndexBytes([...skills].reverse()), index);
  assert.deepEqual(renderResolverBytes([...skills].reverse()), resolver);
});

test("120 real skills render deterministic owned-only catalogs without body injection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-large-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-large-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const skillsDir = path.join(root, "skills");

  for (let index = 119; index >= 0; index -= 1) {
    const suffix = String(index).padStart(3, "0");
    const skillDir = path.join(skillsDir, `skill-${suffix}`);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: skill-${suffix}\ndescription: Owned skill ${suffix}.\ntriggers: run ${suffix}\n---\n\nFULL_SKILL_BODY_CANARY_${suffix}\n`
    );
  }

  for (let index = 0; index < 5; index += 1) {
    const linkedName = `linked-candidate-${index}`;
    makeSkill(outside, linkedName, linkedName, `LINKED_METADATA_CANARY_${index}`);
    fs.symlinkSync(path.join(outside, linkedName), path.join(skillsDir, linkedName), "dir");
  }

  const skills = await collectSkills(root);
  const indexBytes = renderSkillsIndexBytes(skills);
  const resolverBytes = renderResolverBytes(skills);

  assert.equal(skills.length, 120);
  assert.deepEqual(
    skills.map(({ name }) => name),
    Array.from({ length: 120 }, (_, index) => `skill-${String(index).padStart(3, "0")}`)
  );
  for (const catalog of [indexBytes, resolverBytes]) {
    const text = catalog.toString("utf8");
    assert.doesNotMatch(text, /FULL_SKILL_BODY_CANARY|LINKED_METADATA_CANARY|linked-candidate/);
  }
  assert.equal((indexBytes.toString("utf8").match(/^## skill-/gm) || []).length, 120);
  assert.equal((resolverBytes.toString("utf8").match(/\| `skills\/skill-/g) || []).length, 120);
  assert.deepEqual(renderSkillsIndexBytes([...skills].reverse()), indexBytes);
  assert.deepEqual(renderResolverBytes([...skills].reverse()), resolverBytes);
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
