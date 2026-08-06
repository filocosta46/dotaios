import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { writeSkillsIndex } from "../../packages/core/src/skills.mjs";

test("writeSkillsIndex preserve mode keeps foreign catalogs byte-for-byte and reports both conflicts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-skills-preserve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsDir = path.join(root, "skills");
  const skillDir = path.join(skillsDir, "audit");
  const indexPath = path.join(skillsDir, "INDEX.md");
  const resolverPath = path.join(skillsDir, "RESOLVER.md");
  const foreignIndex = Buffer.from("# Hand-authored index\r\nprivate bytes: \u0000\r\n", "utf8");
  const foreignResolver = Buffer.from("# Hand-authored resolver\nprivate bytes: \u0001\n", "utf8");

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: audit\ndescription: Review this AIOS.\n---\n\n# Audit\n"
  );
  fs.writeFileSync(indexPath, foreignIndex);
  fs.writeFileSync(resolverPath, foreignResolver);

  const result = await writeSkillsIndex(root, { writeMode: "preserve" });

  assert.deepEqual(fs.readFileSync(indexPath), foreignIndex);
  assert.deepEqual(fs.readFileSync(resolverPath), foreignResolver);
  assert.deepEqual(
    result.conflicts.map(({ action, path: conflictPath }) => ({ action, path: conflictPath })),
    [
      { action: "kept", path: indexPath },
      { action: "kept", path: resolverPath }
    ]
  );
});
