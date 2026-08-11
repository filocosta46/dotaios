import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createEvidenceReader } from "../../packages/core/src/evidence-reader.mjs";
import { collectSkills } from "../../packages/core/src/skills.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-safety-"));
}

function writeSkill(root, dir, content = `---\nname: ${dir}\ndescription: Safe skill.\n---\n# ${dir}\n`) {
  const skillDir = path.join(root, "skills", dir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
}

test("skill discovery parses real folded-YAML descriptions from bounded metadata", async () => {
  const root = tmpDir();
  writeSkill(root, "folded", [
    "---",
    "name: folded",
    "description: >",
    "  A folded description spanning",
    "  more than one physical line.",
    "triggers:",
    "  - folded routing",
    "---",
    "# Folded",
    ""
  ].join("\n"));

  const [skill] = await collectSkills(root);
  assert.equal(skill.description, "A folded description spanning more than one physical line.");
  assert.deepEqual(skill.triggers, ["folded routing"]);
});

test("skill discovery preserves the public plain-Markdown skill fallback", async () => {
  const root = tmpDir();
  writeSkill(root, "plain-skill", "# Plain Skill\n\nFollow the reviewed workflow.\n");

  const [skill] = await collectSkills(root);

  assert.deepEqual(skill, {
    dir: "plain-skill",
    name: "plain-skill",
    description: "",
    triggers: [],
    whenToUse: []
  });
});

test("plain-skill fallback still rejects invalid UTF-8 in the bounded prefix", async () => {
  const root = tmpDir();
  writeSkill(root, "plain-invalid", "# Plain Skill\n");
  const skillPath = path.join(root, "skills", "plain-invalid", "SKILL.md");
  const bytes = Buffer.concat([Buffer.from("# Plain Skill\n", "utf8"), Buffer.from([0xff, 0x0a])]);
  fs.writeFileSync(skillPath, bytes);

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_INVALID_UTF8"
  );
  assert.deepEqual(fs.readFileSync(skillPath), bytes);
});

test("skill discovery rejects a linked skills root", async () => {
  const root = tmpDir();
  const outside = tmpDir();
  writeSkill(outside, "outside");
  fs.symlinkSync(path.join(outside, "skills"), path.join(root, "skills"));

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_PATH_UNSAFE"
  );
});

test("skill discovery skips linked top-level entries without reading outside the skills shelf", async () => {
  const root = tmpDir();
  const outside = tmpDir();
  writeSkill(root, "real-sibling");
  writeSkill(outside, "outside-canary", [
    "---",
    "name: OUTSIDE_SKILL_CANARY",
    "description: Must never be read.",
    "---",
    ""
  ].join("\n"));
  fs.symlinkSync(
    path.join(outside, "skills", "outside-canary"),
    path.join(root, "skills", "linked-entry"),
    "dir",
  );

  const skills = await collectSkills(root);

  assert.deepEqual(skills.map(({ dir }) => dir), ["real-sibling"]);
  assert.equal(JSON.stringify(skills).includes("OUTSIDE_SKILL_CANARY"), false);
});

test("skill discovery skips a statically unmanaged directory without a SKILL.md", async () => {
  const root = tmpDir();
  writeSkill(root, "real-sibling");
  fs.mkdirSync(path.join(root, "skills", "proposed"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "proposed", ".gitkeep"), "");

  const skills = await collectSkills(root);

  assert.deepEqual(skills.map(({ dir }) => dir), ["real-sibling"]);
});

test("skill discovery refuses an observed SKILL.md replaced before its bounded read", async (t) => {
  for (const replacement of ["missing", "linked"]) {
    await t.test(replacement, async () => {
      const root = tmpDir();
      const outside = tmpDir();
      writeSkill(root, "raced-skill");
      writeSkill(outside, "outside-canary");
      const skillFile = path.join(root, "skills", "raced-skill", "SKILL.md");
      const reader = createEvidenceReader({ roots: [root] });
      let replaced = false;
      const racingReader = {
        ...reader,
        async inspectEntry(readerRoot, filePath, options) {
          const entry = await reader.inspectEntry(readerRoot, filePath, options);
          if (!replaced && filePath === skillFile) {
            replaced = true;
            fs.unlinkSync(skillFile);
            if (replacement === "linked") {
              fs.symlinkSync(path.join(outside, "skills", "outside-canary", "SKILL.md"), skillFile);
            }
          }
          return entry;
        }
      };

      await assert.rejects(
        () => collectSkills(root, { reader: racingReader, root }),
        (error) => error?.code === "DOTAIOS_EVIDENCE_CHANGED",
      );
    });
  }
});

test("skill discovery rejects a linked SKILL.md final component", async () => {
  const root = tmpDir();
  const outside = path.join(root, "outside.md");
  fs.mkdirSync(path.join(root, "skills", "linked"), { recursive: true });
  fs.writeFileSync(outside, "---\nname: outside\ndescription: OUTSIDE_SKILL_CANARY\n---\n");
  fs.symlinkSync(outside, path.join(root, "skills", "linked", "SKILL.md"));

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_PATH_UNSAFE"
  );
});

test("skill discovery rejects invalid UTF-8 and preserves the source bytes", async () => {
  const root = tmpDir();
  writeSkill(root, "invalid");
  const skillPath = path.join(root, "skills", "invalid", "SKILL.md");
  const bytes = Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]);
  fs.writeFileSync(skillPath, bytes);

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_INVALID_UTF8"
  );
  assert.deepEqual(fs.readFileSync(skillPath), bytes);
});

test("skill discovery fails closed on malformed routing metadata", async () => {
  const root = tmpDir();
  writeSkill(root, "malformed", "---\nname: malformed\ndescription: [unterminated\n---\n");

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_SKILL_METADATA_INVALID"
  );
});

test("skill discovery fails closed on an oversized skill source", async () => {
  const root = tmpDir();
  writeSkill(
    root,
    "oversized",
    `---\nname: oversized\ndescription: Oversized source.\n---\n${"x".repeat(8 * 1024 * 1024)}`
  );

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_FILE_TOO_LARGE"
  );
});

test("skill discovery fails closed at 513 skill directories", async () => {
  const root = tmpDir();
  for (let index = 0; index < 513; index += 1) writeSkill(root, `skill-${String(index).padStart(3, "0")}`);

  await assert.rejects(
    () => collectSkills(root),
    (error) => error?.code === "DOTAIOS_EVIDENCE_DIRECTORY_TOO_LARGE"
  );
});
